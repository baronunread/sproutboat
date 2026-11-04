//! Connection idle timeout. Bun closes a connection that has seen no traffic
//! for `idleTimeout` seconds (at most 255); the edge picks a value long enough
//! that its own request deadline always fires first. `IdleIo` reproduces that
//! per-connection behaviour for a hyper connection, including `server.timeout(
//! request, 0)` (used for direct transfers) via an [`IdleHold`].

use hyper::rt::{Read, ReadBufCursor, Write};
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{ready, Context, Poll};
use std::time::Duration;
use tokio::time::{Instant, Sleep};

/// Bun's per-connection idle timeout is a whole number of seconds, at most 255.
const IDLE_MAX_SECONDS: f64 = 255.0;

/// The idle timeout for the edge's connections, in seconds.
pub fn edge_idle_timeout_seconds(request_timeout_ms: f64) -> u64 {
    (IDLE_MAX_SECONDS).min((request_timeout_ms / 1000.0).ceil() + 5.0) as u64
}

/// While held, the connection's idle timer is off (the holder enforces its own deadline).
#[derive(Clone, Default)]
pub struct IdleControl {
    holds: Arc<AtomicUsize>,
}

pub struct IdleHold(Arc<AtomicUsize>);

impl IdleControl {
    pub fn hold(&self) -> IdleHold {
        self.holds.fetch_add(1, Ordering::Relaxed);
        IdleHold(self.holds.clone())
    }
    fn held(&self) -> bool {
        self.holds.load(Ordering::Relaxed) > 0
    }
}

impl Drop for IdleHold {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

pub struct IdleIo<T> {
    inner: T,
    timeout: Duration,
    sleep: Pin<Box<Sleep>>,
    last_activity: Instant,
    control: IdleControl,
}

impl<T> IdleIo<T> {
    pub fn new(inner: T, timeout: Duration, control: IdleControl) -> Self {
        let now = Instant::now();
        IdleIo {
            inner,
            timeout,
            sleep: Box::pin(tokio::time::sleep_until(now + timeout)),
            last_activity: now,
            control,
        }
    }

    /// Called when the inner I/O is pending: error out once the connection has been quiet too long.
    fn check_idle(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        if self.control.held() {
            self.last_activity = Instant::now();
            return Ok(());
        }
        loop {
            let deadline = self.last_activity + self.timeout;
            if self.sleep.deadline() != deadline {
                self.sleep.as_mut().reset(deadline);
            }
            if self.sleep.as_mut().poll(cx).is_pending() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "connection idle timeout",
                ));
            }
        }
    }
}

impl<T: Read + Unpin> Read for IdleIo<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: ReadBufCursor<'_>,
    ) -> Poll<io::Result<()>> {
        let this = &mut *self;
        match Pin::new(&mut this.inner).poll_read(cx, buf) {
            Poll::Ready(result) => {
                this.last_activity = Instant::now();
                Poll::Ready(result)
            }
            Poll::Pending => match this.check_idle(cx) {
                Ok(()) => Poll::Pending,
                Err(e) => Poll::Ready(Err(e)),
            },
        }
    }
}

impl<T: Write + Unpin> Write for IdleIo<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = &mut *self;
        match Pin::new(&mut this.inner).poll_write(cx, buf) {
            Poll::Ready(result) => {
                this.last_activity = Instant::now();
                Poll::Ready(result)
            }
            Poll::Pending => match this.check_idle(cx) {
                Ok(()) => Poll::Pending,
                Err(e) => Poll::Ready(Err(e)),
            },
        }
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let r = ready!(Pin::new(&mut self.inner).poll_flush(cx));
        Poll::Ready(r)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = &mut *self;
        match Pin::new(&mut this.inner).poll_write_vectored(cx, bufs) {
            Poll::Ready(result) => {
                this.last_activity = Instant::now();
                Poll::Ready(result)
            }
            Poll::Pending => match this.check_idle(cx) {
                Ok(()) => Poll::Pending,
                Err(e) => Poll::Ready(Err(e)),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connections_stay_open_past_the_request_deadline() {
        assert_eq!(edge_idle_timeout_seconds(30_000.0), 35);
        assert_eq!(edge_idle_timeout_seconds(1_500.0), 7);
    }

    #[test]
    fn a_request_timeout_beyond_the_maximum_is_clamped() {
        assert_eq!(edge_idle_timeout_seconds(600_000.0), 255);
    }

    #[tokio::test(start_paused = true)]
    async fn quiet_connections_time_out_and_holds_pause_the_timer() {
        use tokio::io::AsyncReadExt;
        let (client, server) = tokio::io::duplex(64);
        let control = IdleControl::default();
        let io = hyper_util::rt::TokioIo::new(server);
        let mut idle =
            hyper_util::rt::TokioIo::new(IdleIo::new(io, Duration::from_secs(5), control.clone()));
        let hold = control.hold();
        let mut byte = [0u8; 1];
        // Held: no timeout even after a long quiet period.
        assert!(
            tokio::time::timeout(Duration::from_secs(60), idle.read(&mut byte))
                .await
                .is_err()
        );
        drop(hold);
        let err = idle.read(&mut byte).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        drop(client);
    }
}
