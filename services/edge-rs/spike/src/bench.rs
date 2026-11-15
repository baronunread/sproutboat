//! Load client for the TLS front benchmark (closed loop; prints one JSON line).
//!
//! bench MODE --addr HOST:PORT [--tls] [--h 1|2] [--sni-fmt NAME] [--accounts N] [--n N]
//!       [--warm N] [--conns N] [--streams N]
//!   MODE lat  one connection, sequential requests: p50/p99 latency
//!   MODE thr  --conns connections (h2: --streams in flight on each): requests per second
//!   MODE hs   a new connection per request, no session resumption: handshake and total time
//! `--sni-fmt` is the server name (and Host); a `{}` in it becomes the 5-digit index i % accounts.
use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::Request;
use hyper_util::rt::{TokioExecutor, TokioIo};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerifier, ServerCertVerified};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1).cloned())
}
fn num(name: &str, default: usize) -> usize {
    arg(name).and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[derive(Debug)]
struct NoVerify(Arc<rustls::crypto::CryptoProvider>);
impl ServerCertVerifier for NoVerify {
    fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[derive(Clone)]
struct Target {
    addr: String,
    tls: Option<TlsConnector>,
    h2: bool,
    sni_fmt: String,
    accounts: usize,
}

impl Target {
    fn sni(&self, i: usize) -> String {
        self.sni_fmt.replace("{}", &format!("{:05}", i % self.accounts.max(1)))
    }
}

enum Sender {
    H1(hyper::client::conn::http1::SendRequest<Empty<Bytes>>),
    H2(hyper::client::conn::http2::SendRequest<Empty<Bytes>>),
}

/// Connect (TCP + TLS if asked) and run the HTTP handshake. Returns the sender and the time TCP+TLS took.
async fn connect(t: &Target, i: usize) -> Result<(Sender, u128), String> {
    let started = Instant::now();
    let tcp = TcpStream::connect(&t.addr).await.map_err(|e| e.to_string())?;
    let _ = tcp.set_nodelay(true);
    macro_rules! finish {
        ($io:expr, $hs:expr) => {{
            let io = $io;
            let hs_us = started.elapsed().as_micros();
            let sender = if t.h2 {
                let (s, c) = hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(io)).await.map_err(|e| e.to_string())?;
                tokio::spawn(async move { let _ = c.await; });
                Sender::H2(s)
            } else {
                let (s, c) = hyper::client::conn::http1::handshake(TokioIo::new(io)).await.map_err(|e| e.to_string())?;
                tokio::spawn(async move { let _ = c.await; });
                Sender::H1(s)
            };
            let _ = $hs;
            Ok((sender, hs_us))
        }};
    }
    match &t.tls {
        Some(c) => {
            let name = ServerName::try_from(t.sni(i)).map_err(|e| e.to_string())?;
            let tls = c.connect(name, tcp).await.map_err(|e| format!("tls: {e}"))?;
            finish!(tls, 0)
        }
        None => finish!(tcp, 0),
    }
}

async fn request(s: &mut Sender, host: &str) -> Result<u16, String> {
    let (status, body) = match s {
        Sender::H1(s) => {
            let req = Request::get("/").header("host", host).body(Empty::<Bytes>::new()).unwrap();
            s.ready().await.map_err(|e| e.to_string())?;
            let r = s.send_request(req).await.map_err(|e| e.to_string())?;
            (r.status().as_u16(), r.into_body())
        }
        Sender::H2(s) => {
            let req = Request::get(format!("https://{host}/")).body(Empty::<Bytes>::new()).unwrap();
            s.ready().await.map_err(|e| e.to_string())?;
            let r = s.send_request(req).await.map_err(|e| e.to_string())?;
            (r.status().as_u16(), r.into_body())
        }
    };
    let _ = body.collect().await.map_err(|e| e.to_string())?;
    Ok(status)
}

fn pct(v: &mut [u128], p: f64) -> u128 {
    if v.is_empty() { return 0; }
    v.sort_unstable();
    v[(((v.len() - 1) as f64) * p).round() as usize]
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let mode = std::env::args().nth(1).expect("mode: lat | thr | hs");
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let h2 = num("--h", 1) == 2;
    let tls = if std::env::args().any(|a| a == "--tls") {
        let mut c = ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions().unwrap()
            .dangerous().with_custom_certificate_verifier(Arc::new(NoVerify(provider.clone())))
            .with_no_client_auth();
        c.alpn_protocols = vec![if h2 { b"h2".to_vec() } else { b"http/1.1".to_vec() }];
        c.resumption = rustls::client::Resumption::disabled();
        Some(TlsConnector::from(Arc::new(c)))
    } else { None };
    let t = Target {
        addr: arg("--addr").expect("--addr"),
        tls,
        h2,
        sni_fmt: arg("--sni-fmt").unwrap_or_else(|| "hello.acct-{}.sproutboat.app".into()),
        accounts: num("--accounts", 1),
    };
    let (n, warm) = (num("--n", 10000), num("--warm", 0));
    let errors = Arc::new(AtomicUsize::new(0));
    match mode.as_str() {
        "lat" => {
            let host = t.sni(0);
            let (mut s, _) = connect(&t, 0).await.expect("connect");
            let mut lat = Vec::with_capacity(n);
            for i in 0..warm + n {
                let st = Instant::now();
                if request(&mut s, &host).await != Ok(200) { errors.fetch_add(1, Ordering::Relaxed); }
                if i >= warm { lat.push(st.elapsed().as_micros()); }
            }
            let mean = lat.iter().sum::<u128>() / lat.len().max(1) as u128;
            println!("{{\"mode\":\"lat\",\"n\":{n},\"p50_us\":{},\"p99_us\":{},\"mean_us\":{mean},\"errors\":{}}}", pct(&mut lat, 0.5), pct(&mut lat, 0.99), errors.load(Ordering::Relaxed));
        }
        "thr" => {
            let conns = num("--conns", 32);
            let streams = if h2 { num("--streams", 8) } else { 1 };
            let per = n / (conns * streams).max(1);
            let started = Instant::now();
            let mut tasks = Vec::new();
            for c in 0..conns {
                let t = t.clone();
                let errors = errors.clone();
                let host = t.sni(c);
                let (sender, _) = connect(&t, c).await.expect("connect");
                match sender {
                    Sender::H1(s) => {
                        tasks.push(tokio::spawn(async move {
                            let mut s = Sender::H1(s);
                            let mut lat = Vec::with_capacity(per);
                            for _ in 0..per {
                                let st = Instant::now();
                                if request(&mut s, &host).await != Ok(200) { errors.fetch_add(1, Ordering::Relaxed); }
                                lat.push(st.elapsed().as_micros());
                            }
                            lat
                        }));
                    }
                    Sender::H2(s) => {
                        for _ in 0..streams {
                            let (s, host, errors) = (s.clone(), host.clone(), errors.clone());
                            tasks.push(tokio::spawn(async move {
                                let mut s = Sender::H2(s);
                                let mut lat = Vec::with_capacity(per);
                                for _ in 0..per {
                                    let st = Instant::now();
                                    if request(&mut s, &host).await != Ok(200) { errors.fetch_add(1, Ordering::Relaxed); }
                                    lat.push(st.elapsed().as_micros());
                                }
                                lat
                            }));
                        }
                    }
                }
            }
            let mut all = Vec::new();
            for t in tasks { all.extend(t.await.unwrap()); }
            let secs = started.elapsed().as_secs_f64();
            println!("{{\"mode\":\"thr\",\"requests\":{},\"rps\":{:.0},\"p50_us\":{},\"p99_us\":{},\"errors\":{}}}", all.len(), all.len() as f64 / secs, pct(&mut all, 0.5), pct(&mut all, 0.99), errors.load(Ordering::Relaxed));
        }
        "hs" => {
            let conns = num("--conns", 1);
            let next = Arc::new(AtomicUsize::new(0));
            let mut tasks = Vec::new();
            let started = Instant::now();
            for _ in 0..conns {
                let (t, next, errors) = (t.clone(), next.clone(), errors.clone());
                tasks.push(tokio::spawn(async move {
                    let (mut hs, mut total) = (Vec::new(), Vec::new());
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        if i >= n { break; }
                        let st = Instant::now();
                        match connect(&t, i).await {
                            Ok((mut s, hs_us)) => {
                                if request(&mut s, &t.sni(i)).await != Ok(200) { errors.fetch_add(1, Ordering::Relaxed); }
                                hs.push(hs_us);
                                total.push(st.elapsed().as_micros());
                            }
                            Err(_) => { errors.fetch_add(1, Ordering::Relaxed); }
                        }
                    }
                    (hs, total)
                }));
            }
            let (mut hs, mut total) = (Vec::new(), Vec::new());
            for t in tasks { let (a, b) = t.await.unwrap(); hs.extend(a); total.extend(b); }
            let secs = started.elapsed().as_secs_f64();
            println!("{{\"mode\":\"hs\",\"connections\":{},\"per_sec\":{:.0},\"connect_p50_us\":{},\"connect_p99_us\":{},\"total_p50_us\":{},\"total_p99_us\":{},\"errors\":{}}}", hs.len(), hs.len() as f64 / secs, pct(&mut hs, 0.5), pct(&mut hs, 0.99), pct(&mut total, 0.5), pct(&mut total, 0.99), errors.load(Ordering::Relaxed));
        }
        other => panic!("unknown mode {other}"),
    }
}
