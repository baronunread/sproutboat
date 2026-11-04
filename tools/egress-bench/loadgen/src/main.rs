//! Closed-loop HTTP/1.1 load generator. See ../README.md (tools/edge-bench).
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper::Request;
use hyper_util::rt::TokioIo;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::rustls::client::danger::{HandshakeSignatureValid, ServerCertVerifier, ServerCertVerified};
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::{self, ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio_rustls::TlsConnector;

#[derive(Debug)]
struct NoVerify(Arc<rustls::crypto::CryptoProvider>);
impl ServerCertVerifier for NoVerify {
    fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

struct Opts {
    url: String,
    host_header: String,
    conns: usize,
    duration: f64,
    warmup: f64,
    tls: bool,
    json: bool,
    keepalive: bool,
    pids: Vec<u32>,
    threads: usize,
    headers: Vec<(String, String)>,
    method: String,
}

fn parse() -> Opts {
    let mut o = Opts { url: String::new(), host_header: String::new(), conns: 1, duration: 10.0, warmup: 2.0, tls: false, json: false, keepalive: true, pids: vec![], threads: 2, headers: vec![], method: "GET".into() };
    let mut a = std::env::args().skip(1);
    while let Some(x) = a.next() {
        let mut v = |n: &str| a.next().unwrap_or_else(|| { eprintln!("{n} needs a value"); std::process::exit(2) });
        match x.as_str() {
            "--url" => o.url = v("--url"),
            "--host-header" => o.host_header = v("--host-header"),
            "--conns" => o.conns = v("--conns").parse().expect("--conns"),
            "--duration" => o.duration = v("--duration").parse().expect("--duration"),
            "--warmup" => o.warmup = v("--warmup").parse().expect("--warmup"),
            "--threads" => o.threads = v("--threads").parse().expect("--threads"),
            "--pid" => o.pids = v("--pid").split(',').filter(|s| !s.is_empty()).map(|s| if s == "self" { std::process::id() } else { s.parse().expect("--pid") }).collect(),
            "--tls-insecure" => o.tls = true,
            "--no-keepalive" => o.keepalive = false,
            "--json" => o.json = true,
            "--header" => { let h = v("--header"); let (k, val) = h.split_once(':').expect("--header 'name: value'"); o.headers.push((k.trim().to_string(), val.trim().to_string())); }
            "--method" => o.method = v("--method"),
            _ => { eprintln!("unknown arg {x}\nusage: loadgen --url URL --host-header H --conns C --duration S --warmup S [--tls-insecure] [--no-keepalive] [--pid P,P2] [--threads N] [--json]"); std::process::exit(2) }
        }
    }
    if o.url.is_empty() { eprintln!("--url required"); std::process::exit(2) }
    o
}

/// (host, port, path) from http(s)://host[:port][/path]
fn split_url(u: &str) -> (String, u16, String) {
    let (default_port, rest) = if let Some(r) = u.strip_prefix("https://") { (443, r) } else if let Some(r) = u.strip_prefix("http://") { (80, r) } else { (80, u) };
    let (auth, path) = match rest.find('/') { Some(i) => (&rest[..i], &rest[i..]), None => (rest, "/") };
    match auth.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().expect("port"), path.to_string()),
        None => (auth.to_string(), default_port, path.to_string()),
    }
}

#[derive(Default)]
struct Stats { lat: Vec<u32>, errors: u64, non2xx: u64, total: u64 }

type Sender = hyper::client::conn::http1::SendRequest<Empty<Bytes>>;

async fn connect(addr: &(String, u16), tls: &Option<(TlsConnector, ServerName<'static>)>) -> Result<Sender, Box<dyn std::error::Error + Send + Sync>> {
    let tcp = TcpStream::connect((addr.0.as_str(), addr.1)).await?;
    tcp.set_nodelay(true)?;
    match tls {
        Some((c, sni)) => handshake(c.connect(sni.clone(), tcp).await?).await,
        None => handshake(tcp).await,
    }
}
async fn handshake<T: AsyncRead + AsyncWrite + Unpin + Send + 'static>(io: T) -> Result<Sender, Box<dyn std::error::Error + Send + Sync>> {
    let (s, conn) = hyper::client::conn::http1::handshake(TokioIo::new(io)).await?;
    tokio::spawn(async move { let _ = conn.await; });
    Ok(s)
}

async fn worker(headers: Vec<(String, String)>, method: String, addr: (String, u16), path: String, host: String, tls: Option<(TlsConnector, ServerName<'static>)>, keepalive: bool, measure_start: Instant, end: Instant, stop: Arc<AtomicBool>) -> Stats {
    let mut st = Stats::default();
    let mut sender: Option<Sender> = None;
    while Instant::now() < end && !stop.load(Ordering::Relaxed) {
        let t0 = Instant::now();
        if sender.is_none() {
            match connect(&addr, &tls).await {
                Ok(s) => sender = Some(s),
                Err(_) => { if t0 >= measure_start { st.errors += 1; } tokio::time::sleep(Duration::from_millis(10)).await; continue; }
            }
        }
        let mut b = Request::builder().method(method.as_str()).uri(path.as_str()).header("host", host.as_str());
        for (k, v) in &headers { b = b.header(k.as_str(), v.as_str()); }
        if !keepalive { b = b.header("connection", "close"); }
        let req = b.body(Empty::<Bytes>::new()).unwrap();
        let s = sender.as_mut().unwrap();
        let res: Result<u16, ()> = async {
            let r = s.send_request(req).await.map_err(|_| ())?;
            let code = r.status().as_u16();
            r.into_body().collect().await.map_err(|_| ())?;
            Ok(code)
        }.await;
        let dt = t0.elapsed();
        let counted = t0 >= measure_start;
        match res {
            Ok(code) => {
                if counted { st.total += 1; st.lat.push(dt.as_micros().min(u32::MAX as u128) as u32); if !(200..300).contains(&code) { st.non2xx += 1; } }
                if !keepalive { sender = None; }
            }
            Err(_) => { if counted { st.errors += 1; } sender = None; }
        }
    }
    st
}

/// utime+stime clock ticks from /proc/<pid>/stat (Linux). Assumes CLK_TCK=100.
fn cpu_ticks(pid: u32) -> Option<u64> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &s[s.rfind(')')? + 2..]; // fields from #3 (state)
    let f: Vec<&str> = rest.split_whitespace().collect();
    Some(f.get(11)?.parse::<u64>().ok()? + f.get(12)?.parse::<u64>().ok()?)
}

fn pct(v: &[u32], p: f64) -> u32 {
    if v.is_empty() { return 0; }
    let i = (((v.len() as f64) * p / 100.0).ceil() as usize).clamp(1, v.len()) - 1;
    v[i]
}

fn main() {
    let o = parse();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(o.threads).enable_all().build().unwrap();
    rt.block_on(run(o));
}

async fn run(o: Opts) {
    let (host, port, path) = split_url(&o.url);
    let host_header = if o.host_header.is_empty() { host.clone() } else { o.host_header.clone() };
    let tls = if o.tls {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut cfg = ClientConfig::builder_with_provider(provider.clone()).with_safe_default_protocol_versions().unwrap()
            .dangerous().with_custom_certificate_verifier(Arc::new(NoVerify(provider))).with_no_client_auth();
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        let sni_name = host_header.rsplit_once(':').map(|(h, _)| h).filter(|_| !host_header.contains(']')).unwrap_or(&host_header).to_string();
        let sni = ServerName::try_from(sni_name).expect("sni");
        Some((TlsConnector::from(Arc::new(cfg)), sni))
    } else { None };

    let now = Instant::now();
    let measure_start = now + Duration::from_secs_f64(o.warmup);
    let end = measure_start + Duration::from_secs_f64(o.duration);
    let stop = Arc::new(AtomicBool::new(false));
    let mut hs = Vec::new();
    for _ in 0..o.conns {
        hs.push(tokio::spawn(worker(o.headers.clone(), o.method.clone(), (host.clone(), port), path.clone(), host_header.clone(), tls.clone(), o.keepalive, measure_start, end, stop.clone())));
    }
    tokio::time::sleep_until(measure_start.into()).await;
    let before: Vec<Option<u64>> = o.pids.iter().map(|p| cpu_ticks(*p)).collect();
    tokio::time::sleep_until(end.into()).await;
    let after: Vec<Option<u64>> = o.pids.iter().map(|p| cpu_ticks(*p)).collect();
    let measured_secs = (Instant::now().min(end + Duration::from_millis(50)) - measure_start).as_secs_f64().max(o.duration);
    stop.store(true, Ordering::Relaxed);

    let mut all = Stats::default();
    for h in hs {
        if let Ok(s) = h.await { all.lat.extend(s.lat); all.errors += s.errors; all.non2xx += s.non2xx; all.total += s.total; }
    }
    all.lat.sort_unstable();
    let n = all.lat.len();
    let rps = n as f64 / measured_secs;
    let mean = if n > 0 { all.lat.iter().map(|x| *x as f64).sum::<f64>() / n as f64 } else { 0.0 };

    // CPU per request, only if every pid sampled (Linux).
    let mut cpu_json = String::from("null");
    let mut cpu_note = String::new();
    if !o.pids.is_empty() {
        if before.iter().chain(after.iter()).all(|x| x.is_some()) && n > 0 {
            let mut per = Vec::new();
            let mut tot = 0u64;
            for (i, p) in o.pids.iter().enumerate() {
                let d = after[i].unwrap().saturating_sub(before[i].unwrap()) * 10_000; // ticks(100Hz) -> us
                tot += d;
                per.push(format!("\"{p}\":{:.2}", d as f64 / n as f64));
            }
            cpu_json = format!("{{\"combined_us_per_req\":{:.2},\"per_pid_us_per_req\":{{{}}}}}", tot as f64 / n as f64, per.join(","));
            cpu_note = format!("cpu_us_per_req combined={:.2}", tot as f64 / n as f64);
        } else {
            cpu_note = "cpu: unavailable (needs Linux /proc)".into();
        }
    }

    if o.json {
        println!("{{\"conns\":{},\"duration_s\":{:.3},\"requests\":{},\"rps\":{:.1},\"mean_us\":{:.1},\"p50_us\":{},\"p90_us\":{},\"p99_us\":{},\"p999_us\":{},\"max_us\":{},\"errors\":{},\"non2xx\":{},\"keepalive\":{},\"tls\":{},\"cpu\":{}}}",
            o.conns, measured_secs, n, rps, mean, pct(&all.lat, 50.0), pct(&all.lat, 90.0), pct(&all.lat, 99.0), pct(&all.lat, 99.9), all.lat.last().copied().unwrap_or(0), all.errors, all.non2xx, o.keepalive, o.tls, cpu_json);
    } else {
        println!("conns={} reqs={} rps={:.1} mean={:.0}us p50={}us p90={}us p99={}us p99.9={}us max={}us errors={} non2xx={} {}",
            o.conns, n, rps, mean, pct(&all.lat, 50.0), pct(&all.lat, 90.0), pct(&all.lat, 99.0), pct(&all.lat, 99.9), all.lat.last().copied().unwrap_or(0), all.errors, all.non2xx, cpu_note);
    }
}
