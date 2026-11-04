//! Trivial keep-alive upstream: GET / -> small fixed JSON. No logging.
//! Usage: fake-upstream [--port N] [--bind ADDR] [--any] [--cache-control]
//! `--cache-control` marks every answer `public, max-age=3600` so the edge cache keeps it.
use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::convert::Infallible;
use tokio::net::TcpListener;

const BODY: &str = r#"{"ok":true,"app":"bench","message":"hello from the trivial upstream","n":1234567890,"pad":"xxxxxxxxxxxxxxxxxxxx"}"#;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let mut port = 0u16;
    let mut bind = "127.0.0.1".to_string();
    let mut any = false;
    let mut cache = false;
    let mut a = std::env::args().skip(1);
    while let Some(x) = a.next() {
        match x.as_str() {
            "--port" => port = a.next().and_then(|v| v.parse().ok()).expect("--port N"),
            "--bind" => bind = a.next().expect("--bind ADDR"),
            "--any" => any = true,
            "--cache-control" => cache = true,
            _ => {
                eprintln!("unknown arg {x}");
                std::process::exit(2);
            }
        }
    }
    let l = TcpListener::bind((bind.as_str(), port)).await.expect("bind");
    println!("fake-upstream listening on http://{}", l.local_addr().unwrap());
    loop {
        let Ok((s, _)) = l.accept().await else { continue };
        let _ = s.set_nodelay(true);
        tokio::spawn(async move {
            let svc = service_fn(move |req: Request<Incoming>| async move {
                // --any: any host/path/method answers; default: only GET /.
                let ok = any || (req.method() == hyper::Method::GET && req.uri().path() == "/");
                let mut r = Response::new(Full::new(Bytes::from_static(BODY.as_bytes())));
                if !ok {
                    *r.status_mut() = StatusCode::NOT_FOUND;
                }
                r.headers_mut().insert("content-type", "application/json".parse().unwrap());
                if cache {
                    r.headers_mut().insert("cache-control", "public, max-age=3600".parse().unwrap());
                }
                Ok::<_, Infallible>(r)
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(s), svc)
                .await;
        });
    }
}
