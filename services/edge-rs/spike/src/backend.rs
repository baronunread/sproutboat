//! A 28-byte answer, like design 10's hello module, so the TLS front is what is measured.
//! `GET /__headers` echoes the request line and headers (to check what the edge forwards).
use bytes::Bytes;
use http_body_util::Full;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use std::convert::Infallible;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let addr = std::env::args().nth(1).unwrap_or_else(|| "127.0.0.1:8600".into());
    let l = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("backend on {addr}");
    loop {
        let (s, _) = l.accept().await.unwrap();
        let _ = s.set_nodelay(true);
        tokio::spawn(async move {
            let svc = service_fn(|r: Request<hyper::body::Incoming>| async move {
                let body = if r.uri().path() == "/__headers" {
                    let mut t = format!("{} {}\n", r.method(), r.uri());
                    for (k, v) in r.headers() {
                        t.push_str(&format!("{}: {}\n", k, v.to_str().unwrap_or("?")));
                    }
                    Bytes::from(t)
                } else {
                    Bytes::from_static(b"hello from the backend app\n")
                };
                Ok::<_, Infallible>(Response::new(Full::new(body)))
            });
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(s), svc).await;
        });
    }
}
