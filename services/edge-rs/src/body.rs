//! Body plumbing: stream request and response bodies, never buffer them (except
//! the one cache fill of at most 512 KiB).

use crate::cache::MAX_CACHE_ENTRY_BYTES;
use bytes::{Bytes, BytesMut};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::{Body, Frame, Incoming, SizeHint};
use std::pin::Pin;
use std::task::{Context, Poll};

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type RBody = UnsyncBoxBody<Bytes, BoxError>;

pub fn full(bytes: impl Into<Bytes>) -> RBody {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed_unsync()
}

pub fn empty() -> RBody {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed_unsync()
}

/// An incoming request body that fails once more than `limit` bytes have passed.
pub struct LimitedBody {
    inner: Incoming,
    limit: f64,
    seen: f64,
}

impl LimitedBody {
    pub fn new(inner: Incoming, limit: f64) -> LimitedBody {
        LimitedBody {
            inner,
            limit,
            seen: 0.0,
        }
    }
}

impl Body for LimitedBody {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        match Pin::new(&mut self.inner).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    self.seen += data.len() as f64;
                    if self.seen > self.limit {
                        return Poll::Ready(Some(Err("request body too large".into())));
                    }
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(e.into()))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Collects up to one cache entry's actual bytes while the body streams past.
/// Content-Length is only an early rejection: a lying origin cannot make us
/// allocate an unbounded buffer.
pub struct Fill {
    parts: Vec<Bytes>,
    bytes: u64,
    fits: bool,
    put: Option<Box<dyn FnOnce(Bytes) + Send>>,
}

impl Fill {
    pub fn new(put: impl FnOnce(Bytes) + Send + 'static) -> Fill {
        Fill {
            parts: Vec::new(),
            bytes: 0,
            fits: true,
            put: Some(Box::new(put)),
        }
    }

    fn push(&mut self, chunk: &Bytes) {
        if self.fits && self.bytes + chunk.len() as u64 <= MAX_CACHE_ENTRY_BYTES {
            self.parts.push(chunk.clone());
            self.bytes += chunk.len() as u64;
        } else {
            self.fits = false;
            // Drop retained chunks as soon as this no longer fits.
            self.parts.clear();
        }
    }

    pub fn flush(&mut self) {
        if !self.fits {
            return;
        }
        let mut buffered = BytesMut::with_capacity(self.bytes as usize);
        for part in &self.parts {
            buffered.extend_from_slice(part);
        }
        if let Some(put) = self.put.take() {
            put(buffered.freeze());
        }
    }
}

/// How the upstream response body ended.
pub enum End {
    /// Fully streamed (or stopped at the byte cap) after this many bytes.
    Done(u64),
    /// The client went away mid-body.
    Aborted(u64),
    /// The upstream failed mid-body.
    Failed(u64),
}

/// The upstream response body on its way to the client: enforces the byte cap, feeds
/// the cache fill, and reports how it ended through `on_end` so the request log carries
/// a real full duration (#31). There is no deadline here: the request timeout covers the
/// time to response headers only, so long-lived streams (SSE) keep working.
pub struct ProxyBody {
    inner: Incoming,
    cap: Option<f64>,
    sent: u64,
    fill: Option<Fill>,
    on_end: Option<Box<dyn FnOnce(End) + Send>>,
    host: String,
    done: bool,
    _guards: Vec<Box<dyn std::any::Any + Send>>,
}

impl ProxyBody {
    pub fn new(
        inner: Incoming,
        host: &str,
        cap: Option<f64>,
        fill: Option<Fill>,
        on_end: impl FnOnce(End) + Send + 'static,
        guards: Vec<Box<dyn std::any::Any + Send>>,
    ) -> ProxyBody {
        ProxyBody {
            inner,
            cap,
            sent: 0,
            fill,
            on_end: Some(Box::new(on_end)),
            host: host.to_string(),
            done: false,
            _guards: guards,
        }
    }

    fn finish(&mut self, how: fn(u64) -> End) {
        if let Some(on_end) = self.on_end.take() {
            on_end(how(self.sent));
        }
    }
}

impl Drop for ProxyBody {
    fn drop(&mut self) {
        self.finish(End::Aborted);
    }
}

impl Body for ProxyBody {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let this = &mut *self;
        if this.done {
            return Poll::Ready(None);
        }
        loop {
            match Pin::new(&mut this.inner).poll_frame(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(None) => {
                    this.done = true;
                    if let Some(fill) = this.fill.as_mut() {
                        fill.flush();
                    }
                    this.finish(End::Done);
                    return Poll::Ready(None);
                }
                Poll::Ready(Some(Err(error))) => {
                    this.done = true;
                    this.finish(End::Failed);
                    return Poll::Ready(Some(Err(error.into())));
                }
                Poll::Ready(Some(Ok(frame))) => {
                    let Some(data) = frame.data_ref() else {
                        continue;
                    }; // trailers are not forwarded
                    this.sent += data.len() as u64;
                    if let Some(cap) = this.cap {
                        if this.sent as f64 > cap {
                            eprintln!("response body cap ({cap}B) exceeded for {}", this.host);
                            this.done = true;
                            this.finish(End::Done);
                            return Poll::Ready(Some(Err("response exceeded byte cap".into())));
                        }
                    }
                    if let Some(fill) = this.fill.as_mut() {
                        fill.push(data);
                    }
                    // hyper stops polling once a content-length body has been fully written, so
                    // the end is detected here rather than waiting for a final empty poll.
                    if hyper::body::Body::is_end_stream(&this.inner) {
                        this.done = true;
                        if let Some(fill) = this.fill.as_mut() {
                            fill.flush();
                        }
                        this.finish(End::Done);
                    }
                    return Poll::Ready(Some(Ok(frame)));
                }
            }
        }
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Keeps the connection's idle timer off while a response is being produced or streamed:
/// the idle timeout only applies to a connection waiting for its next request.
pub struct Held {
    inner: RBody,
    _hold: crate::idle::IdleHold,
}

impl Held {
    pub fn new(inner: RBody, hold: crate::idle::IdleHold) -> Held {
        Held { inner, _hold: hold }
    }
}

impl Body for Held {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        Pin::new(&mut self.inner).poll_frame(cx)
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}
