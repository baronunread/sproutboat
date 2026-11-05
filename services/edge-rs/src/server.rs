//! The accept loop and per-connection HTTP/1.1 serving, with graceful shutdown.

use crate::app::App;
use crate::idle::{edge_idle_timeout_seconds, IdleControl, IdleIo};
use crate::proxy::handle;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

/// Connections served at once; accepting waits when the process is at the limit.
pub const MAX_CONNECTIONS: usize = 8192;

/// Accept until shutdown is signalled; connections already open are left to finish.
pub async fn serve(app: Arc<App>, listener: TcpListener) {
    serve_limited(app, listener, MAX_CONNECTIONS).await
}

pub async fn serve_limited(app: Arc<App>, listener: TcpListener, max_connections: usize) {
    let mut shutdown = app.shutdown.subscribe();
    let slots = Arc::new(Semaphore::new(max_connections));
    loop {
        let permit = tokio::select! {
            permit = slots.clone().acquire_owned() => match permit {
                Ok(permit) => permit,
                Err(_) => return,
            },
            _ = shutdown.changed() => return,
        };
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let app = app.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        serve_connection(app, stream).await;
                    });
                }
                Err(error) => {
                    // EMFILE and friends: back off instead of spinning.
                    eprintln!("accept failed: {error}");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
            _ = shutdown.changed() => return,
        }
    }
}

async fn serve_connection(app: Arc<App>, stream: TcpStream) {
    let _guard = app.in_flight.enter();
    let _ = stream.set_nodelay(true);
    let peer = stream
        .peer_addr()
        .map_or(std::net::IpAddr::from([0, 0, 0, 0]), |a| a.ip());
    let control = IdleControl::default();
    let idle = Duration::from_secs(edge_idle_timeout_seconds(app.cfg.request_timeout_ms));
    let io = IdleIo::new(TokioIo::new(stream), idle, control.clone());
    let mut shutdown = app.shutdown.subscribe();
    let service = {
        let app = app.clone();
        service_fn(move |req| handle(app.clone(), control.clone(), peer, req))
    };
    let conn = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(Duration::from_secs(30))
        .serve_connection(io, service)
        .with_upgrades();
    tokio::pin!(conn);
    tokio::select! {
        result = conn.as_mut() => {
            if let Err(error) = result {
                if !error.is_incomplete_message() && !error.is_closed() {
                    eprintln!("connection error: {error}");
                }
            }
        }
        _ = shutdown.changed() => {
            conn.as_mut().graceful_shutdown();
            let _ = conn.await;
        }
    }
}
