//! The outbound side of `fetch()`: resolve, vet every answer, connect to a vetted
//! address (never the name), verify TLS against the name, relay one request.
//! Mirrors `vettedFetch` in `egress.ts`, plus a small connection pool (Bun's
//! `fetch` keeps connections alive; so does this, keyed by name, address and port
//! so that a TLS session verified for one name is never reused for another).

use crate::addr::egress_refusal;
use crate::resolve::{is_ip_literal, Resolve};
use bytes::Bytes;
use http_body_util::Full;
use hyper::body::{Body, Frame, Incoming, SizeHint};
use hyper::client::conn::http1::SendRequest;
use hyper::header::{HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, Version};
use hyper_util::rt::TokioIo;
use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;
use url::{Position, Url};

/// What Bun's `fetch` says when a connection is refused; kept so the broker sees the
/// same text.
pub const BUN_CONNECT_FAILED: &str = "Unable to connect. Is the computer able to access the url?";
/// Bun's `fetch` adds these when the caller sent none.
pub const DEFAULT_USER_AGENT: &str = "Bun/1.4.4";

const IDLE_TTL: Duration = Duration::from_secs(15);
const MAX_IDLE_PER_KEY: usize = 64;
const MAX_KEYS: usize = 512;

type Sender = SendRequest<Full<Bytes>>;

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
struct PoolKey {
    tls: bool,
    name: String,
    ip: IpAddr,
    port: u16,
}

struct Idle {
    sender: Sender,
    since: Instant,
}

#[derive(Default)]
pub struct Pool {
    map: Mutex<HashMap<PoolKey, Vec<Idle>>>,
}

impl Pool {
    fn take(&self, key: &PoolKey) -> Option<Sender> {
        let mut map = self.map.lock().unwrap();
        let list = map.get_mut(key)?;
        while let Some(idle) = list.pop() {
            if idle.since.elapsed() < IDLE_TTL && !idle.sender.is_closed() {
                return Some(idle.sender);
            }
        }
        map.remove(key);
        None
    }

    fn put(&self, key: PoolKey, sender: Sender) {
        if sender.is_closed() {
            return;
        }
        let mut map = self.map.lock().unwrap();
        if map.len() > MAX_KEYS {
            map.retain(|_, v| {
                v.retain(|i| i.since.elapsed() < IDLE_TTL && !i.sender.is_closed());
                !v.is_empty()
            });
        }
        let list = map.entry(key).or_default();
        list.retain(|i| i.since.elapsed() < IDLE_TTL && !i.sender.is_closed());
        if list.len() < MAX_IDLE_PER_KEY {
            list.push(Idle {
                sender,
                since: Instant::now(),
            });
        }
    }
}

/// The upstream's body. Hands its connection back to the pool once fully read.
pub struct Guarded {
    inner: Incoming,
    home: Option<(Arc<Pool>, PoolKey, Sender)>,
}

impl Guarded {
    fn release(&mut self) {
        if let Some((pool, key, sender)) = self.home.take() {
            pool.put(key, sender);
        }
    }
}

impl Body for Guarded {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, hyper::Error>>> {
        let this = self.get_mut();
        let polled = Pin::new(&mut this.inner).poll_frame(cx);
        match &polled {
            Poll::Ready(None) => this.release(),
            Poll::Ready(Some(Ok(_))) if this.inner.is_end_stream() => this.release(),
            Poll::Ready(Some(Err(_))) => this.home = None,
            _ => {}
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Shared client state: TLS config and pool.
pub struct Client {
    pub tls: TlsConnector,
    pool: Arc<Pool>,
}

impl Client {
    pub fn new() -> Client {
        Client {
            tls: TlsConnector::from(Arc::new(tls_config())),
            pool: Arc::new(Pool::default()),
        }
    }
}

impl Default for Client {
    fn default() -> Self {
        Client::new()
    }
}

/// The built-in roots; `SB_CA_BUNDLE` (a PEM file) adds roots, never removes any
/// and never turns verification off (same as the embedded client's and tcp.ts).
pub fn tls_config() -> ClientConfig {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    if let Ok(path) = std::env::var("SB_CA_BUNDLE") {
        if !path.is_empty() {
            use tokio_rustls::rustls::pki_types::{pem::PemObject, CertificateDer};
            if let Ok(iter) = CertificateDer::pem_file_iter(&path) {
                for cert in iter.flatten() {
                    let _ = roots.add(cert);
                }
            }
        }
    }
    let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
    let mut cfg = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    cfg
}

/// Policy and plumbing one request needs.
pub struct Vetting<'a> {
    pub resolver: &'a dyn Resolve,
    pub allow: &'a [String],
    pub strict: bool,
}

/// A connect that never opened (nothing was sent): try the next address.
fn is_connect_failure(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::NetworkUnreachable
            | io::ErrorKind::HostUnreachable
    )
}

fn connect_error_text(e: &io::Error) -> String {
    let code = match e.kind() {
        io::ErrorKind::ConnectionRefused => "ECONNREFUSED",
        io::ErrorKind::NetworkUnreachable => "ENETUNREACH",
        io::ErrorKind::HostUnreachable => "EHOSTUNREACH",
        io::ErrorKind::TimedOut => "ETIMEDOUT",
        io::ErrorKind::ConnectionReset => "ECONNRESET",
        io::ErrorKind::AddrNotAvailable => "EADDRNOTAVAIL",
        _ => "ConnectionFailed",
    };
    format!("{code}: {BUN_CONNECT_FAILED}")
}

/// What the broker's `fetch()` sends, after the header rules in `http.rs`.
pub struct Outbound {
    pub method: Method,
    pub headers: HeaderMap,
    pub body: Bytes,
}

/// Resolve, vet, then fetch from a vetted address. `Err` carries the message for the
/// 502 body: the refusal text, `could not resolve <host>`, or the connect / TLS /
/// protocol failure.
pub async fn vetted_fetch(
    client: &Client,
    url: &Url,
    out: &Outbound,
    vetting: &Vetting<'_>,
) -> Result<Response<Guarded>, String> {
    let host_text = url.host_str().unwrap_or("").to_string();
    let name = host_text
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let answers = vetting
        .resolver
        .resolve(&name)
        .await
        .map_err(|_| format!("could not resolve {host_text}"))?;
    let mut refusal: Option<String> = None;
    let mut vetted: Vec<IpAddr> = Vec::new();
    for a in &answers {
        match egress_refusal(&host_text, &a.text, vetting.allow, vetting.strict) {
            None => {
                if let Some(ip) = a.ip {
                    vetted.push(ip);
                }
            }
            Some(why) => {
                refusal.get_or_insert(why);
            }
        }
    }
    if vetted.is_empty() {
        return Err(refusal.unwrap_or_else(|| format!("could not resolve {host_text}")));
    }
    let tls = url.scheme() == "https";
    let port = url
        .port_or_known_default()
        .unwrap_or(if tls { 443 } else { 80 });
    let sni = if is_ip_literal(&name) {
        None
    } else {
        Some(name.clone())
    };
    // Like the Bun service: move on to the next address only when one cannot be
    // connected to; nothing has been sent yet, so a retry cannot repeat a request.
    let mut last: Option<String> = None;
    for ip in vetted {
        let key = PoolKey {
            tls,
            name: name.clone(),
            ip,
            port,
        };
        match send_via(client, &key, sni.as_deref(), url, out).await {
            Ok(res) => return Ok(res),
            Err(SendError::Connect(e)) => last = Some(connect_error_text(&e)),
            Err(SendError::Fatal(m)) => return Err(m),
        }
    }
    Err(last.unwrap_or_else(|| format!("could not resolve {host_text}")))
}

enum SendError {
    /// The connection could not be opened (try the next address if the kind allows).
    Connect(io::Error),
    Fatal(String),
}

async fn open(client: &Client, key: &PoolKey, sni: Option<&str>) -> Result<Sender, SendError> {
    let tcp = TcpStream::connect(SocketAddr::new(key.ip, key.port))
        .await
        .map_err(|e| {
            if is_connect_failure(&e) {
                SendError::Connect(e)
            } else {
                SendError::Fatal(connect_error_text(&e))
            }
        })?;
    let _ = tcp.set_nodelay(true);
    if key.tls {
        let server_name = match sni {
            Some(n) => ServerName::try_from(n.to_string())
                .map_err(|_| SendError::Fatal(format!("invalid server name {n}")))?,
            None => ServerName::IpAddress(key.ip.into()),
        };
        let stream = client
            .tls
            .connect(server_name, tcp)
            .await
            .map_err(|e| SendError::Fatal(format!("TLS handshake failed: {e}")))?;
        handshake(stream).await
    } else {
        handshake(tcp).await
    }
}

async fn handshake<T>(io: T) -> Result<Sender, SendError>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (sender, conn) = hyper::client::conn::http1::Builder::new()
        .handshake(TokioIo::new(io))
        .await
        .map_err(|e| SendError::Fatal(format!("upstream handshake failed: {e}")))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    Ok(sender)
}

fn build_request(url: &Url, out: &Outbound) -> Request<Full<Bytes>> {
    let target = &url[Position::BeforePath..Position::AfterQuery];
    let target = if target.is_empty() { "/" } else { target };
    let mut req = Request::new(Full::new(out.body.clone()));
    *req.method_mut() = out.method.clone();
    *req.uri_mut() = target.parse().unwrap_or_else(|_| "/".parse().unwrap());
    *req.headers_mut() = out.headers.clone();
    req
}

async fn send_via(
    client: &Client,
    key: &PoolKey,
    sni: Option<&str>,
    url: &Url,
    out: &Outbound,
) -> Result<Response<Guarded>, SendError> {
    let close = wants_close(&out.headers);
    // A pooled connection may have been closed by the server while idle: that shows up
    // as a cancelled request before any response byte, and one fresh attempt is safe.
    let mut reused = if close { None } else { client.pool.take(key) };
    loop {
        let was_reused = reused.is_some();
        let mut sender = match reused.take() {
            Some(s) => s,
            None => open(client, key, sni).await?,
        };
        if sender.ready().await.is_err() {
            if was_reused {
                continue;
            }
            return Err(SendError::Fatal("upstream connection closed".into()));
        }
        match sender.send_request(build_request(url, out)).await {
            Ok(res) => {
                let (parts, body) = res.into_parts();
                let reusable =
                    !close && parts.version == Version::HTTP_11 && !wants_close(&parts.headers);
                let mut guarded = Guarded {
                    inner: body,
                    home: reusable.then(|| (client.pool.clone(), key.clone(), sender)),
                };
                if guarded.inner.is_end_stream() {
                    guarded.release();
                }
                return Ok(Response::from_parts(parts, guarded));
            }
            Err(e) => {
                let stale = e.is_canceled() || e.is_incomplete_message() || e.is_closed();
                if was_reused && stale {
                    continue;
                }
                return Err(SendError::Fatal(format!("upstream request failed: {e}")));
            }
        }
    }
}

fn wants_close(headers: &HeaderMap) -> bool {
    headers.get_all(hyper::header::CONNECTION).iter().any(|v| {
        v.to_str()
            .map(|s| s.split(',').any(|t| t.trim().eq_ignore_ascii_case("close")))
            .unwrap_or(false)
    })
}

/// Fold repeated headers into one value joined with ", " (what a `Headers` object
/// does), except `set-cookie`, which stays one entry per cookie.
pub fn fold_headers(src: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::new();
    for name in src.keys() {
        if name == hyper::header::SET_COOKIE {
            for v in src.get_all(name) {
                out.append(name.clone(), v.clone());
            }
            continue;
        }
        let values: Vec<&[u8]> = src.get_all(name).iter().map(|v| v.as_bytes()).collect();
        let joined = values.join(&b", "[..]);
        if let Ok(v) = HeaderValue::from_bytes(&joined) {
            out.insert(name.clone(), v);
        }
    }
    out
}

pub fn header_name(s: &str) -> HeaderName {
    HeaderName::from_bytes(s.as_bytes()).expect("static header name")
}
