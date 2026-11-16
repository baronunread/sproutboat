//! SPIKE (plan 022 decision 8): the edge terminates TLS itself, so Caddy could leave.
//!
//! Three parts, all off unless `SPROUTBOAT_TLS_LISTEN` is set:
//! - [`CertStore`]: certificates chosen by SNI from the files the lego issuer already writes
//!   (`<cert dir>/<account>/{fullchain,privkey}.pem`), loaded on first use, re-read when the
//!   files change.
//! - an HTTPS listener (h1 + h2 by ALPN) that sets the forwarded headers Caddy sets today and
//!   hands the request to the unchanged edge `handle`;
//! - a port-80 listener: ACME HTTP-01 answers and the HTTP to HTTPS redirect.
//!
//! Custom domains are issued on demand (see `acme.rs`) behind an `ask` URL, like Caddy.

use crate::acme::Acme;
use crate::app::App;
use crate::body::RBody;
use crate::idle::{edge_idle_timeout_seconds, IdleControl, IdleIo};
use crate::proxy::handle;
use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderValue, HOST};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls::ServerConfig;
use std::collections::HashMap;
use std::convert::Infallible;
use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio_rustls::LazyConfigAcceptor;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a handshake for a not-yet-issued custom domain may wait for its certificate.
const ISSUE_WAIT: Duration = Duration::from_secs(60);
pub const MAX_TLS_CONNECTIONS: usize = 8192;

// ------------------------------------------------------------------ settings

#[derive(Debug, Clone)]
pub struct Settings {
    pub listen: SocketAddr,
    /// Port 80: ACME HTTP-01 and the redirect. `None` = no plaintext listener.
    pub http_listen: Option<SocketAddr>,
    pub cert_dir: PathBuf,
    /// `sproutboat.app`: names `<x>.<account>.<this>` use the account's wildcard files.
    pub app_domain: String,
    /// How often a loaded certificate's files are stat'ed again (hot reload latency).
    pub check_every: Duration,
    /// Load every certificate under `cert_dir` at start instead of on first use.
    pub preload: bool,
    pub ask_url: Option<String>,
    pub acme_directory: Option<String>,
    pub acme_root_ca: Option<PathBuf>,
    pub acme_contact: Option<String>,
    pub acme_renew_after: Duration,
    pub acme_max_per_hour: usize,
    /// Terminator mode: after the handshake, pump the decrypted bytes to this plain edge
    /// (h1 only) instead of serving HTTP here. The key-isolation variant of the design.
    pub pump_to: Option<SocketAddr>,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

impl Settings {
    /// `None` when `SPROUTBOAT_TLS_LISTEN` is unset (the edge stays plain HTTP, as shipped).
    pub fn from_env() -> Result<Option<Settings>, String> {
        let Some(listen) = env("SPROUTBOAT_TLS_LISTEN") else {
            return Ok(None);
        };
        let addr = |name: &str, raw: &str| {
            raw.parse::<SocketAddr>()
                .map_err(|e| format!("invalid {name}: {raw} ({e})"))
        };
        let secs = |name: &str, default: u64| {
            env(name)
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(default)
        };
        Ok(Some(Settings {
            listen: addr("SPROUTBOAT_TLS_LISTEN", &listen)?,
            http_listen: match env("SPROUTBOAT_TLS_HTTP_LISTEN") {
                Some(raw) => Some(addr("SPROUTBOAT_TLS_HTTP_LISTEN", &raw)?),
                None => None,
            },
            cert_dir: PathBuf::from(
                env("SPROUTBOAT_TLS_CERT_DIR")
                    .unwrap_or_else(|| "/var/lib/sproutboat-cloud/certs".into()),
            ),
            app_domain: env("SPROUTBOAT_TLS_APP_DOMAIN")
                .unwrap_or_else(|| "sproutboat.app".into())
                .trim_matches('.')
                .to_lowercase(),
            check_every: Duration::from_secs(secs("SPROUTBOAT_TLS_CHECK_SECS", 10)),
            preload: env("SPROUTBOAT_TLS_PRELOAD").is_some_and(|v| v == "1"),
            ask_url: env("SPROUTBOAT_TLS_ASK_URL"),
            acme_directory: env("SPROUTBOAT_TLS_ACME_DIRECTORY"),
            acme_root_ca: env("SPROUTBOAT_TLS_ACME_ROOT_CA").map(PathBuf::from),
            acme_contact: env("SPROUTBOAT_TLS_ACME_CONTACT"),
            acme_renew_after: Duration::from_secs(secs(
                "SPROUTBOAT_TLS_ACME_RENEW_AFTER_SECS",
                60 * 86_400,
            )),
            acme_max_per_hour: secs("SPROUTBOAT_TLS_ACME_MAX_PER_HOUR", 20) as usize,
            pump_to: match env("SPROUTBOAT_TLS_PUMP_TO") {
                Some(raw) => Some(addr("SPROUTBOAT_TLS_PUMP_TO", &raw)?),
                None => None,
            },
        }))
    }
}

// ---------------------------------------------------------------- cert store

struct Slot {
    key: Arc<CertifiedKey>,
    cert_mtime: SystemTime,
    key_mtime: SystemTime,
    /// Milliseconds since the store started when the files were last stat'ed.
    checked_ms: AtomicU64,
}

/// Where a server name's certificate lives.
#[derive(Debug, PartialEq, Eq)]
pub enum Place {
    /// `<x>.<account>.<app domain>`: the account's wildcard.
    Account(String),
    /// Anything else that is a plain hostname: a custom domain.
    Host(String),
}

pub struct CertStore {
    dir: PathBuf,
    app_domain: String,
    check_every: Duration,
    started: Instant,
    provider: Arc<CryptoProvider>,
    slots: RwLock<HashMap<String, Slot>>,
    pub loads: AtomicU64,
}

impl fmt::Debug for CertStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "CertStore({})", self.dir.display())
    }
}

fn valid_label(l: &str) -> bool {
    let b = l.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
}

/// A lowercase DNS name with valid labels, as it must be before it becomes part of a path.
pub fn valid_hostname(name: &str) -> bool {
    name.len() <= 253 && !name.is_empty() && name.split('.').all(valid_label)
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

impl CertStore {
    pub fn new(settings: &Settings, provider: Arc<CryptoProvider>) -> CertStore {
        CertStore {
            dir: settings.cert_dir.clone(),
            app_domain: settings.app_domain.clone(),
            check_every: settings.check_every,
            started: Instant::now(),
            provider,
            slots: RwLock::new(HashMap::new()),
            loads: AtomicU64::new(0),
        }
    }

    pub fn classify(&self, name: &str) -> Option<Place> {
        let name = name.strip_suffix('.').unwrap_or(name);
        if !valid_hostname(name) {
            return None;
        }
        match name
            .strip_suffix(&self.app_domain)
            .and_then(|r| r.strip_suffix('.'))
        {
            Some(prefix) => {
                // `<x>.<account>` exactly: two labels. A deeper name has no certificate.
                let mut it = prefix.split('.');
                match (it.next(), it.next(), it.next()) {
                    (Some(_), Some(account), None) => Some(Place::Account(account.to_string())),
                    _ => None,
                }
            }
            None if name == self.app_domain => None,
            None => Some(Place::Host(name.to_string())),
        }
    }

    fn dir_of(&self, place: &Place) -> PathBuf {
        match place {
            Place::Account(a) => self.dir.join(a),
            Place::Host(h) => self.dir.join("hosts").join(h),
        }
    }

    fn slot_key(place: &Place) -> String {
        match place {
            Place::Account(a) => format!("a:{a}"),
            Place::Host(h) => format!("h:{h}"),
        }
    }

    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// The certificate for `name`, loading or re-loading it from disk when needed.
    pub fn get(&self, name: &str) -> Option<Arc<CertifiedKey>> {
        let place = self.classify(name)?;
        let key = Self::slot_key(&place);
        let now = self.now_ms();
        {
            let slots = self.slots.read().unwrap_or_else(|e| e.into_inner());
            if let Some(slot) = slots.get(&key) {
                let last = slot.checked_ms.load(Ordering::Relaxed);
                if now.saturating_sub(last) < self.check_every.as_millis() as u64 {
                    return Some(slot.key.clone());
                }
            }
        }
        // Not loaded, or due for a look at the files.
        let dir = self.dir_of(&place);
        let (cert_path, key_path) = (dir.join("fullchain.pem"), dir.join("privkey.pem"));
        let stamps = mtime(&cert_path).zip(mtime(&key_path));
        let existing = {
            let slots = self.slots.read().unwrap_or_else(|e| e.into_inner());
            slots
                .get(&key)
                .map(|s| (s.key.clone(), s.cert_mtime, s.key_mtime))
        };
        let Some((cm, km)) = stamps else {
            // Files gone: keep serving what is loaded until the process restarts.
            return existing.map(|(k, ..)| k);
        };
        if let Some((k, ocm, okm)) = &existing {
            if *ocm == cm && *okm == km {
                if let Some(slot) = self
                    .slots
                    .read()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&key)
                {
                    slot.checked_ms.store(now, Ordering::Relaxed);
                }
                return Some(k.clone());
            }
        }
        match self.load(&cert_path, &key_path) {
            Ok(loaded) => {
                self.loads.fetch_add(1, Ordering::Relaxed);
                let loaded = Arc::new(loaded);
                self.slots
                    .write()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(
                        key,
                        Slot {
                            key: loaded.clone(),
                            cert_mtime: cm,
                            key_mtime: km,
                            checked_ms: AtomicU64::new(now),
                        },
                    );
                Some(loaded)
            }
            Err(error) => {
                // Half-written pair (cert renewed, key not yet) or garbage: keep the old one
                // and look again at the next check.
                eprintln!("tls: {} not loaded: {error}", dir.display());
                existing.map(|(k, ..)| k)
            }
        }
    }

    fn load(&self, cert_path: &Path, key_path: &Path) -> Result<CertifiedKey, String> {
        let chain = CertificateDer::pem_file_iter(cert_path)
            .map_err(|e| format!("fullchain.pem: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("fullchain.pem: {e}"))?;
        let key =
            PrivateKeyDer::from_pem_file(key_path).map_err(|e| format!("privkey.pem: {e}"))?;
        // `from_der` checks that the key belongs to the leaf, which is what stops a mismatched
        // pair (the issuer copies the two files one after the other) from being served.
        CertifiedKey::from_der(chain, key, &self.provider).map_err(|e| e.to_string())
    }

    /// Load everything under the directory now. Returns how many certificates are loaded.
    pub fn preload(&self) -> usize {
        let mut n = 0;
        let mut names = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&self.dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name == "hosts" {
                    if let Ok(hosts) = std::fs::read_dir(e.path()) {
                        names.extend(
                            hosts
                                .flatten()
                                .map(|h| h.file_name().to_string_lossy().to_string()),
                        );
                    }
                } else if valid_label(&name) {
                    names.push(format!("x.{name}.{}", self.app_domain));
                }
            }
        }
        for name in names {
            if self.get(&name).is_some() {
                n += 1;
            }
        }
        n
    }

    pub fn loaded(&self) -> usize {
        self.slots.read().unwrap_or_else(|e| e.into_inner()).len()
    }
}

impl ResolvesServerCert for CertStore {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        self.get(&hello.server_name()?.to_ascii_lowercase())
    }
}

// ------------------------------------------------------------ the TLS server

struct TlsCtx {
    pump_to: Option<SocketAddr>,
    config: Arc<ServerConfig>,
    store: Arc<CertStore>,
    acme: Option<Arc<Acme>>,
}

pub fn server_config(
    store: Arc<CertStore>,
    provider: Arc<CryptoProvider>,
) -> Result<ServerConfig, String> {
    let mut config = ServerConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_cert_resolver(store);
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    // Session tickets (what Caddy gives returning browsers): rotated by rustls itself.
    config.ticketer = rustls::crypto::ring::Ticketer::new().map_err(|e| e.to_string())?;
    Ok(config)
}

/// Start the TLS listener, the port-80 listener and the ACME renewal loop; returns when the
/// edge is shutting down.
pub async fn run(app: Arc<App>, settings: Settings) -> Result<(), String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let store = Arc::new(CertStore::new(&settings, provider.clone()));
    if settings.preload {
        let n = store.preload();
        println!("tls: preloaded {n} certificates ({} slots)", store.loaded());
    }
    let challenges: Arc<Mutex<HashMap<String, String>>> = Arc::default();
    let acme = match (&settings.acme_directory, &settings.ask_url) {
        (Some(_), Some(_)) => Some(Acme::new(&settings, store.clone(), challenges.clone())),
        (Some(_), None) => {
            return Err("SPROUTBOAT_TLS_ACME_DIRECTORY needs SPROUTBOAT_TLS_ASK_URL: on-demand issuance without an allow check is refused".into())
        }
        _ => None,
    };
    let mut config = server_config(store.clone(), provider)?;
    if settings.pump_to.is_some() {
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
    }
    let ctx = Arc::new(TlsCtx {
        pump_to: settings.pump_to,
        config: Arc::new(config),
        store,
        acme: acme.clone(),
    });

    let tls_listener = TcpListener::bind(settings.listen)
        .await
        .map_err(|e| format!("tls: cannot bind {}: {e}", settings.listen))?;
    println!(
        "tls: listening on {} (h1, h2)",
        tls_listener.local_addr().map_or(settings.listen, |a| a)
    );
    let https_port = tls_listener.local_addr().map_or(443, |a| a.port());

    if let Some(addr) = settings.http_listen {
        let l = TcpListener::bind(addr)
            .await
            .map_err(|e| format!("tls: cannot bind {addr}: {e}"))?;
        println!(
            "tls: http redirect + acme-01 on {}",
            l.local_addr().map_or(addr, |a| a)
        );
        tokio::spawn(serve_http_front(app.clone(), l, challenges, https_port));
    }
    if let Some(acme) = acme {
        tokio::spawn(acme.renew_loop(settings.acme_renew_after, app.shutdown.subscribe()));
    }
    serve_tls(app, tls_listener, ctx).await;
    Ok(())
}

async fn serve_tls(app: Arc<App>, listener: TcpListener, ctx: Arc<TlsCtx>) {
    let mut shutdown = app.shutdown.subscribe();
    let slots = Arc::new(Semaphore::new(MAX_TLS_CONNECTIONS));
    loop {
        let permit = tokio::select! {
            p = slots.clone().acquire_owned() => match p { Ok(p) => p, Err(_) => return },
            _ = shutdown.changed() => return,
        };
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let (app, ctx) = (app.clone(), ctx.clone());
                    tokio::spawn(async move {
                        let _permit = permit;
                        serve_tls_connection(app, ctx, stream).await;
                    });
                }
                Err(error) => {
                    eprintln!("tls accept failed: {error}");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
            _ = shutdown.changed() => return,
        }
    }
}

async fn serve_tls_connection(app: Arc<App>, ctx: Arc<TlsCtx>, tcp: TcpStream) {
    let _guard = app.in_flight.enter();
    let _ = tcp.set_nodelay(true);
    let peer = tcp
        .peer_addr()
        .map_or(IpAddr::from([0, 0, 0, 0]), |a| a.ip());

    // Read the ClientHello first, so a custom domain can be issued before the handshake answers.
    let acceptor = LazyConfigAcceptor::new(rustls::server::Acceptor::default(), tcp);
    let Ok(Ok(start)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor).await else {
        return;
    };
    let sni = start
        .client_hello()
        .server_name()
        .map(|s| s.to_ascii_lowercase());
    if let (Some(name), Some(acme)) = (&sni, &ctx.acme) {
        if matches!(ctx.store.classify(name), Some(Place::Host(_))) && ctx.store.get(name).is_none()
        {
            // Caddy does the same: the first handshake for an allowed name waits for issuance.
            match tokio::time::timeout(ISSUE_WAIT, acme.ensure(name)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => eprintln!("tls: {name}: {error}"),
                Err(_) => eprintln!("tls: {name}: issuance took longer than {ISSUE_WAIT:?}"),
            }
        }
    }
    let Ok(Ok(tls)) =
        tokio::time::timeout(HANDSHAKE_TIMEOUT, start.into_stream(ctx.config.clone())).await
    else {
        return;
    };
    if let Some(upstream) = ctx.pump_to {
        // Terminator mode: TLS only. No HTTP is parsed here; bytes go to the edge unchanged.
        let mut tls = tls;
        if let Ok(mut up) = TcpStream::connect(upstream).await {
            let _ = up.set_nodelay(true);
            let _ = tokio::io::copy_bidirectional(&mut tls, &mut up).await;
        }
        return;
    }
    let h2 = tls.get_ref().1.alpn_protocol() == Some(b"h2".as_slice());
    let control = IdleControl::default();
    let idle = Duration::from_secs(edge_idle_timeout_seconds(app.cfg.request_timeout_ms));
    let io = IdleIo::new(TokioIo::new(tls), idle, control.clone());
    let mut shutdown = app.shutdown.subscribe();
    let service = {
        let app = app.clone();
        service_fn(move |req| front(app.clone(), control.clone(), peer, req))
    };
    if h2 {
        let conn = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
            .timer(TokioTimer::new())
            .max_concurrent_streams(250)
            .keep_alive_interval(Some(Duration::from_secs(30)))
            .keep_alive_timeout(Duration::from_secs(20))
            .serve_connection(io, service);
        tokio::pin!(conn);
        tokio::select! {
            result = conn.as_mut() => {
                if let Err(error) = result {
                    if !error.is_closed() && !error.is_canceled() { eprintln!("h2 connection error: {error}"); }
                }
            }
            _ = shutdown.changed() => {
                conn.as_mut().graceful_shutdown();
                let _ = conn.await;
            }
        }
    } else {
        let conn = hyper::server::conn::http1::Builder::new()
            .timer(TokioTimer::new())
            .header_read_timeout(Duration::from_secs(30))
            .serve_connection(io, service)
            .with_upgrades();
        tokio::pin!(conn);
        tokio::select! {
            result = conn.as_mut() => {
                if let Err(error) = result {
                    if !error.is_incomplete_message() && !error.is_closed() { eprintln!("connection error: {error}"); }
                }
            }
            _ = shutdown.changed() => {
                conn.as_mut().graceful_shutdown();
                let _ = conn.await;
            }
        }
    }
}

/// What Caddy's `reverse_proxy` does for us today, now ours: a request from the internet has
/// its forwarded headers replaced (never trusted), and an h2 request gets the `Host` the rest
/// of the edge expects.
async fn front(
    app: Arc<App>,
    ctl: IdleControl,
    peer: IpAddr,
    mut req: Request<Incoming>,
) -> Result<Response<RBody>, Infallible> {
    if !req.headers().contains_key(HOST) {
        if let Some(authority) = req.uri().authority().map(|a| a.as_str().to_string()) {
            if let Ok(v) = HeaderValue::from_str(&authority) {
                req.headers_mut().insert(HOST, v);
            }
        }
    }
    let host = req
        .headers()
        .get(HOST)
        .and_then(|h| h.to_str().ok())
        .map(str::to_string);
    let headers = req.headers_mut();
    for name in [
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "forwarded",
        "x-real-ip",
    ] {
        headers.remove(name);
    }
    if let Ok(v) = HeaderValue::from_str(&peer.to_canonical().to_string()) {
        headers.insert("x-forwarded-for", v);
    }
    headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
    if let Some(Ok(v)) = host.as_deref().map(HeaderValue::from_str) {
        headers.insert("x-forwarded-host", v);
    }
    handle(app, ctl, peer, req).await
}

// ----------------------------------------------------- port 80: ACME + redirect

async fn serve_http_front(
    app: Arc<App>,
    listener: TcpListener,
    challenges: Arc<Mutex<HashMap<String, String>>>,
    https_port: u16,
) {
    let mut shutdown = app.shutdown.subscribe();
    let slots = Arc::new(Semaphore::new(2048));
    loop {
        let permit = tokio::select! {
            p = slots.clone().acquire_owned() => match p { Ok(p) => p, Err(_) => return },
            _ = shutdown.changed() => return,
        };
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let challenges = challenges.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        let service = service_fn(move |req| {
                            let c = challenges.clone();
                            async move { Ok::<_, Infallible>(http_front(&c, https_port, &req)) }
                        });
                        let conn = hyper::server::conn::http1::Builder::new()
                            .timer(TokioTimer::new())
                            .header_read_timeout(Duration::from_secs(10))
                            .serve_connection(TokioIo::new(stream), service);
                        let _ = tokio::time::timeout(Duration::from_secs(30), conn).await;
                    });
                }
                Err(error) => {
                    eprintln!("http accept failed: {error}");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
            _ = shutdown.changed() => return,
        }
    }
}

fn http_front(
    challenges: &Mutex<HashMap<String, String>>,
    https_port: u16,
    req: &Request<Incoming>,
) -> Response<Full<Bytes>> {
    let plain = |status: u16, body: &'static str| {
        Response::builder()
            .status(status)
            .header("content-type", "text/plain; charset=utf-8")
            .body(Full::new(Bytes::from_static(body.as_bytes())))
            .unwrap_or_default()
    };
    let path = req.uri().path();
    if let Some(token) = path.strip_prefix("/.well-known/acme-challenge/") {
        let found = challenges
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(token)
            .cloned();
        return match found {
            Some(key_auth) => Response::builder()
                .status(200)
                .header("content-type", "text/plain")
                .body(Full::new(Bytes::from(key_auth)))
                .unwrap_or_default(),
            None => plain(404, "not found"),
        };
    }
    let Some(host) = req.headers().get(HOST).and_then(|h| h.to_str().ok()) else {
        return plain(400, "bad request");
    };
    // The host without its port; a bracketed IPv6 literal keeps its brackets.
    let bare = match host.strip_prefix('[') {
        Some(_) => host
            .split_once(']')
            .map_or(host, |(h, _)| &host[..=h.len()]),
        None => host.split(':').next().unwrap_or(host),
    };
    let authority_ok = bare
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || b".-[]:".contains(&c));
    if bare.is_empty() || !authority_ok {
        return plain(400, "bad request");
    }
    let port = if https_port == 443 {
        String::new()
    } else {
        format!(":{https_port}")
    };
    let target = req.uri().path_and_query().map_or("/", |p| p.as_str());
    // 308 keeps the method, like Caddy's automatic redirect.
    Response::builder()
        .status(308)
        .header("location", format!("https://{bare}{port}{target}"))
        .header("content-length", "0")
        .body(Full::new(Bytes::new()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(dir: &Path) -> Settings {
        Settings {
            listen: "127.0.0.1:0".parse().unwrap(),
            http_listen: None,
            cert_dir: dir.to_path_buf(),
            app_domain: "sproutboat.app".into(),
            check_every: Duration::from_millis(0),
            preload: false,
            ask_url: None,
            acme_directory: None,
            acme_root_ca: None,
            acme_contact: None,
            acme_renew_after: Duration::from_secs(1),
            acme_max_per_hour: 20,
            pump_to: None,
        }
    }

    fn write_pair(dir: &Path, names: &[&str]) {
        let key = rcgen::KeyPair::generate().unwrap();
        let params =
            rcgen::CertificateParams::new(names.iter().map(|s| s.to_string()).collect::<Vec<_>>())
                .unwrap();
        let cert = params.self_signed(&key).unwrap();
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("fullchain.pem"), cert.pem()).unwrap();
        std::fs::write(dir.join("privkey.pem"), key.serialize_pem()).unwrap();
    }

    fn store(dir: &Path) -> CertStore {
        CertStore::new(
            &settings(dir),
            Arc::new(rustls::crypto::ring::default_provider()),
        )
    }

    #[test]
    fn classifies_names() {
        let s = store(Path::new("/nonexistent"));
        assert_eq!(
            s.classify("hello.acme.sproutboat.app"),
            Some(Place::Account("acme".into()))
        );
        assert_eq!(
            s.classify("hello.acme.sproutboat.app."),
            Some(Place::Account("acme".into()))
        );
        // one label deeper, the bare account name, the apex: no certificate
        assert_eq!(s.classify("a.b.acme.sproutboat.app"), None);
        assert_eq!(s.classify("acme.sproutboat.app"), None);
        assert_eq!(s.classify("sproutboat.app"), None);
        assert_eq!(
            s.classify("example.com"),
            Some(Place::Host("example.com".into()))
        );
        // names that would escape the directory
        assert_eq!(s.classify("../etc"), None);
        assert_eq!(s.classify("a/b.example.com"), None);
        assert_eq!(s.classify("x.%2e%2e.sproutboat.app"), None);
        assert_eq!(s.classify(""), None);
        // case is the caller's job (the resolver lowercases)
        assert_eq!(s.classify("Example.com"), None);
    }

    #[test]
    fn loads_lazily_and_reloads_on_change() {
        let tmp = tempfile::tempdir().unwrap();
        write_pair(&tmp.path().join("acme"), &["*.acme.sproutboat.app"]);
        let s = store(tmp.path());
        assert_eq!(s.loaded(), 0);
        let first = s.get("hello.acme.sproutboat.app").unwrap();
        assert_eq!(s.loaded(), 1);
        assert!(s.get("hello.nobody.sproutboat.app").is_none());
        // untouched files: same Arc, no reload
        let again = s.get("hello.acme.sproutboat.app").unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        assert_eq!(s.loads.load(Ordering::Relaxed), 1);
        // renewal: new files, newer mtimes
        std::thread::sleep(Duration::from_millis(20));
        write_pair(&tmp.path().join("acme"), &["*.acme.sproutboat.app"]);
        let renewed = s.get("hello.acme.sproutboat.app").unwrap();
        assert!(!Arc::ptr_eq(&first, &renewed));
        assert_eq!(s.loads.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn a_mismatched_pair_keeps_the_old_certificate() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("acme");
        write_pair(&dir, &["*.acme.sproutboat.app"]);
        let s = store(tmp.path());
        let first = s.get("x.acme.sproutboat.app").unwrap();
        // the issuer has copied the new certificate but not yet the new key
        std::thread::sleep(Duration::from_millis(20));
        let other = tempfile::tempdir().unwrap();
        write_pair(other.path(), &["*.acme.sproutboat.app"]);
        std::fs::copy(
            other.path().join("fullchain.pem"),
            dir.join("fullchain.pem"),
        )
        .unwrap();
        let kept = s.get("x.acme.sproutboat.app").unwrap();
        assert!(Arc::ptr_eq(&first, &kept), "must keep serving the old pair");
        // the key lands: now it loads
        std::fs::copy(other.path().join("privkey.pem"), dir.join("privkey.pem")).unwrap();
        let now = s.get("x.acme.sproutboat.app").unwrap();
        assert!(!Arc::ptr_eq(&first, &now));
    }

    #[test]
    fn preload_loads_accounts_and_hosts() {
        let tmp = tempfile::tempdir().unwrap();
        write_pair(&tmp.path().join("a1"), &["*.a1.sproutboat.app"]);
        write_pair(&tmp.path().join("a2"), &["*.a2.sproutboat.app"]);
        write_pair(&tmp.path().join("hosts/example.com"), &["example.com"]);
        let s = store(tmp.path());
        assert_eq!(s.preload(), 3);
        assert_eq!(s.loaded(), 3);
    }
}
