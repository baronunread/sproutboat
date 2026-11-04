//! The request handler: everything the Bun edge's `fetch` does, in the same order
//! (route refresh, pool stats, host lookup, backend routes, direct transfers,
//! static assets, the GET cache, the supervisor endpoint, service-binding
//! vouching, WebSockets, and the timed, capped, logged reverse proxy).

use crate::app::App;
use crate::assets::{cache_control_for, match_headers, parse_range, ByteRange};
use crate::body::{empty, full, End, Fill, Held, LimitedBody, ProxyBody, RBody};
use crate::cache::{cache_request_eligible, cache_response_eligible, EdgeCache};
use crate::idle::{IdleControl, IdleHold};
use crate::logs::Event;
use crate::routes::Route;
use crate::sidecar::{Endpoint, Resolution};
use crate::util::{
    decode_uri_component, header_joined, is_framing_header, is_hop_by_hop, js_number,
    normalize_url, now_ms, parse_target, to_fixed3,
};
use crate::websocket::{
    accept_key_for, connect_upstream, is_websocket_upgrade, offered_protocols, relay,
    server_config, WS_CONNECT_TIMEOUT,
};
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::header::{HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode, Uri};
use hyper_util::rt::TokioIo;
use std::convert::Infallible;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::WebSocketStream;

/// The edge's service-binding headers (#48), which only the edge may set toward a sprout.
const INTERNAL_REQUEST_HEADERS: [&str; 4] = [
    "x-sb-edge-secret",
    "x-sb-edge-token",
    "x-sb-binding-call",
    "x-sb-url",
];
const TEXT: &str = "text/plain;charset=utf-8";

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Backend,
    Sprout,
}

/// The cold-start fields of the request that triggered a spawn.
#[derive(Clone)]
struct Cold {
    cold_start: bool,
    startup_ms: Option<f64>,
    boot_ms: Option<f64>,
}

impl Cold {
    fn of(endpoint: &Endpoint) -> Cold {
        Cold {
            cold_start: endpoint.cold_start,
            startup_ms: endpoint.cold_start.then_some(endpoint.startup_ms),
            boot_ms: endpoint.cold_start.then_some(endpoint.boot_ms),
        }
    }
    fn push(cold: &Option<Cold>, event: Event) -> Event {
        match cold {
            None => event,
            Some(c) => event
                .bool("coldStart", c.cold_start)
                .opt_num("startupMs", c.startup_ms)
                .opt_num("bootMs", c.boot_ms),
        }
    }
}

/// What every log line of one request shares.
#[derive(Clone)]
struct ReqCtx {
    app: Arc<App>,
    started: Instant,
    host: String,
    method: Method,
    req_bytes: f64,
    path: Option<String>,
}

impl ReqCtx {
    fn elapsed(&self) -> u64 {
        (self.started.elapsed().as_secs_f64() * 1000.0).round() as u64
    }
    fn log(&self, event: Event) {
        self.app.log.write(&event, self.path.as_deref());
    }
    /// `{hostname, method, status, durationMs}`, the start of nearly every event.
    fn event(&self, status: u16, duration_ms: u64) -> Event {
        Event::new()
            .str("hostname", &self.host)
            .str("method", self.method.as_str())
            .int("status", status as u64)
            .int("durationMs", duration_ms)
    }
}

fn response(status: u16, content_type: Option<&str>, body: RBody) -> Response<RBody> {
    let mut builder = Response::builder().status(status);
    if let Some(ct) = content_type {
        builder = builder.header("content-type", ct);
    }
    builder
        .body(body)
        .unwrap_or_else(|_| Response::new(empty()))
}

fn text(status: u16, body: &'static str) -> Response<RBody> {
    response(status, Some(TEXT), full(body))
}

/// What Bun answers when the fetch handler throws.
fn something_went_wrong() -> Response<RBody> {
    response(500, Some("text/plain"), full("Something went wrong!"))
}

/// A request refused before routing: a small plain-text answer (never an HTML error page)
/// and a log line. `close` drops the connection afterwards (an unread oversized body).
#[allow(clippy::too_many_arguments)]
fn reject(
    app: &Arc<App>,
    started: Instant,
    req: &Request<Incoming>,
    path: Option<String>,
    status: u16,
    body: &'static str,
    kind: &str,
    close: bool,
) -> Response<RBody> {
    let host = header_joined(req.headers(), "host")
        .and_then(|h| h.split(':').next().map(str::to_lowercase))
        .filter(|h| !h.is_empty());
    let req_bytes = header_joined(req.headers(), "content-length").map_or(0.0, |v| js_number(&v));
    let event = Event::new()
        .opt_str("hostname", host.as_deref())
        .str("method", req.method().as_str())
        .int("status", status as u64)
        .int(
            "durationMs",
            (started.elapsed().as_secs_f64() * 1000.0).round() as u64,
        )
        .num("reqBytes", if req_bytes.is_nan() { 0.0 } else { req_bytes })
        .str("errorKind", kind);
    app.log.write(&event, path.as_deref());
    let mut res = text(status, body);
    if close {
        res.headers_mut()
            .insert("connection", HeaderValue::from_static("close"));
    }
    res
}

/// Is the Host header one of the loopback names (any port)?
fn is_local_host(raw: &str) -> bool {
    let name = match raw.strip_prefix('[') {
        Some(rest) => rest.split_once(']').map_or(rest, |(h, _)| h),
        None => raw.split(':').next().unwrap_or(""),
    };
    matches!(
        name.to_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    )
}

fn is_transfer_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/__sb/r2/transfer/") else {
        return false;
    };
    let Some((binding, id)) = rest.split_once('/') else {
        return false;
    };
    let mut chars = binding.chars();
    chars.next().is_some_and(|c| c.is_ascii_uppercase())
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && id.len() == 24
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub async fn handle(
    app: Arc<App>,
    ctl: IdleControl,
    peer: IpAddr,
    req: Request<Incoming>,
) -> Result<Response<RBody>, Infallible> {
    let hold = ctl.hold();
    let res = handle_request(app, ctl, peer, req).await;
    Ok(res.map(|body| Held::new(body, hold).boxed_unsync()))
}

async fn handle_request(
    app: Arc<App>,
    ctl: IdleControl,
    peer: IpAddr,
    req: Request<Incoming>,
) -> Response<RBody> {
    let started = Instant::now();
    let headers = req.headers();
    // The path every refusal below logs, when the target parses at all.
    let parsed = req
        .uri()
        .path_and_query()
        .and_then(|p| parse_target(p.as_str()));
    let early_path: Option<String> = parsed
        .as_ref()
        .map(|(pathname, _)| pathname.chars().take(512).collect());
    // Refused before routing: a missing or empty Host, an oversized body, an unparseable target.
    if headers.get("host").is_none_or(|h| h.as_bytes().is_empty()) {
        return reject(
            &app,
            started,
            &req,
            early_path.clone(),
            400,
            "bad request",
            "bad-request",
            true,
        );
    }
    let req_bytes = header_joined(headers, "content-length").map_or(0.0, |v| js_number(&v));
    let req_bytes = if req_bytes.is_nan() { 0.0 } else { req_bytes };
    if req_bytes > app.cfg.max_body_bytes {
        return reject(
            &app,
            started,
            &req,
            early_path.clone(),
            413,
            "payload too large",
            "payload-too-large",
            true,
        );
    }
    let Some((pathname, search)) = parsed else {
        return reject(
            &app,
            started,
            &req,
            early_path.clone(),
            400,
            "bad request",
            "bad-request",
            true,
        );
    };
    let host: Option<String> =
        header_joined(headers, "host").and_then(|h| h.split(':').next().map(str::to_lowercase));
    let c = ReqCtx {
        app: app.clone(),
        started,
        host: host.clone().unwrap_or_default(),
        method: req.method().clone(),
        req_bytes,
        path: Some(pathname.chars().take(512).collect()),
    };

    if let Err(error) = app.refresh_routes().await {
        eprintln!("route snapshot reload failed: {error}");
    }
    // #30 - runtime-lifecycle gauges, loopback only (edge binds 127.0.0.1).
    // Answered only to a loopback peer asking by a loopback name: through the proxy (Caddy is a
    // loopback peer too) the Host is a deployment hostname, so this falls through to routing.
    let local_host = header_joined(req.headers(), "host").is_some_and(|h| is_local_host(&h));
    if pathname == "/__sb/pool" && peer.to_canonical().is_loopback() && local_host {
        return match app.sidecar.stats().await {
            Ok(bytes) => response(200, Some("application/json;charset=utf-8"), full(bytes)),
            Err(error) => {
                eprintln!("pool stats unavailable: {error}");
                response(
                    503,
                    Some("application/json;charset=utf-8"),
                    full(serde_json::json!({ "error": error }).to_string()),
                )
            }
        };
    }
    let route = match host.as_deref().filter(|h| !h.is_empty()) {
        Some(h) => app.routes().get(h).cloned(),
        None => None,
    };
    let Some(route) = route else {
        // The bare deployment domain has no content of its own unless an owner has attached it
        // to a project (allowed for the apex + www). Otherwise, send it to the dashboard.
        if host.as_deref() == Some(app.cfg.deployment_domain.as_str()) {
            c.log(c.event(302, c.elapsed()).num("reqBytes", req_bytes));
            return match normalize_url(&app.cfg.dashboard_url) {
                Some(location) => {
                    let mut res = Response::new(empty());
                    *res.status_mut() = StatusCode::FOUND;
                    if let Ok(v) = HeaderValue::from_str(&location) {
                        res.headers_mut().insert("location", v);
                    }
                    res
                }
                None => something_went_wrong(),
            };
        }
        c.log(
            Event::new()
                .opt_str("hostname", host.as_deref().filter(|h| !h.is_empty()))
                .str("method", c.method.as_str())
                .int("status", 404)
                .int("durationMs", c.elapsed())
                .num("reqBytes", req_bytes)
                .str("errorKind", "no-route"),
        );
        return text(404, "unknown deployment");
    };
    let host = c.host.clone();

    if let Some(backend) = &route.backend {
        let target = Target {
            kind: Kind::Backend,
            base: backend.url.trim_end_matches('/').to_string(),
            route: route.clone(),
            cold: None,
            edge_token: None,
            direct_transfer: false,
        };
        let mut forwarded = req.headers().clone();
        for name in INTERNAL_REQUEST_HEADERS {
            forwarded.remove(name);
        }
        if is_websocket_upgrade(req.method(), &forwarded) {
            return websocket(
                &c,
                &ctl,
                req,
                &target,
                &target_string(&pathname, &search),
                forwarded,
            )
            .await;
        }
        return proxy_http(
            c,
            req,
            target,
            &pathname,
            &search,
            None,
            false,
            None,
            Vec::new(),
        )
        .await;
    }

    let direct_transfer = is_transfer_path(&pathname);
    let mut guards: Vec<Box<dyn std::any::Any + Send>> = Vec::new();

    // Static assets, served edge-first (Cloudflare's default).
    if !direct_transfer && (req.method() == Method::GET || req.method() == Method::HEAD) {
        let manifest = app.manifest_for(&route.sprout_path);
        let Some(decoded) = decode_uri_component(&pathname) else {
            return reject(
                &app,
                started,
                &req,
                c.path.clone(),
                400,
                "bad request",
                "bad-request",
                false,
            );
        };
        if let Some(manifest) = &manifest {
            if let Some((status, location)) = manifest.redirect(&decoded) {
                c.log(
                    c.event(status, c.elapsed())
                        .num("reqBytes", req_bytes)
                        .int("resBytes", 0)
                        .str("cacheStatus", "asset"),
                );
                let mut res = Response::new(empty());
                *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::FOUND);
                // Bun sends header text as latin1 bytes when it can.
                let bytes: Vec<u8> = if location.chars().all(|c| (c as u32) < 256) {
                    location.chars().map(|c| c as u32 as u8).collect()
                } else {
                    location.clone().into_bytes()
                };
                return match HeaderValue::from_bytes(&bytes) {
                    Ok(v) => {
                        res.headers_mut().insert("location", v);
                        res
                    }
                    Err(_) => something_went_wrong(),
                };
            }
            let key = manifest.resolve_key(&decoded);
            let entry = key
                .as_ref()
                .filter(|k| !manifest.is_sprout_first(k))
                .and_then(|k| manifest.files.get(k));
            if let (Some(entry), Some(key)) = (entry, key.as_ref()) {
                let etag = format!("\"{}\"", entry.hash);
                if header_joined(req.headers(), "if-none-match").as_deref() == Some(etag.as_str()) {
                    c.log(
                        c.event(304, c.elapsed())
                            .num("reqBytes", req_bytes)
                            .int("resBytes", 0)
                            .str("cacheStatus", "asset"),
                    );
                    let mut res = Response::new(empty());
                    *res.status_mut() = StatusCode::NOT_MODIFIED;
                    if let Ok(v) = HeaderValue::from_str(&etag) {
                        res.headers_mut().insert("etag", v);
                    }
                    return res;
                }
                let file_path = std::path::Path::new(&route.sprout_path)
                    .parent()
                    .map(|d| d.join("assets").join(key.trim_start_matches('/')));
                // The file on disk decides the length, as Bun.file did (the manifest size is not trusted).
                let meta = match &file_path {
                    Some(p) => tokio::fs::metadata(p).await.ok(),
                    None => None,
                };
                let Some(meta) = meta.filter(|m| m.is_file()) else {
                    c.log(
                        c.event(500, c.elapsed())
                            .num("reqBytes", req_bytes)
                            .str("error", "asset file missing")
                            .str("errorKind", "asset-missing"),
                    );
                    return text(500, "internal error");
                };
                let size = meta.len();
                let mut res = Response::new(empty());
                let h = res.headers_mut();
                let put = |h: &mut HeaderMap, name: &str, value: &str| {
                    if let (Ok(n), Ok(v)) = (
                        HeaderName::from_bytes(name.as_bytes()),
                        HeaderValue::from_str(value),
                    ) {
                        h.insert(n, v);
                    }
                };
                put(h, "content-type", &entry.content_type);
                put(h, "etag", &etag);
                put(h, "content-length", &size.to_string());
                put(h, "cache-control", cache_control_for(key));
                if entry.content_type == "application/octet-stream" {
                    let name = key.rsplit('/').next().unwrap_or("");
                    put(h, "content-disposition", &format!("filename=\"{name}\""));
                }
                // Every matching `_headers` block, in file order: a later rule overrides or unsets an earlier one.
                for rule in match_headers(&manifest.headers, &decoded) {
                    // Framing headers belong to the edge: a rule cannot change or drop them.
                    for name in &rule.unset {
                        if let Ok(n) = HeaderName::from_bytes(name.to_lowercase().as_bytes()) {
                            if !is_framing_header(&n) {
                                h.remove(n);
                            }
                        }
                    }
                    for (name, value) in &rule.set {
                        let lower = name.to_lowercase();
                        if HeaderName::from_bytes(lower.as_bytes())
                            .is_ok_and(|n| is_framing_header(&n))
                        {
                            continue;
                        }
                        put(h, &lower, value);
                    }
                }

                let range = parse_range(header_joined(req.headers(), "range").as_deref(), size);
                let (mut status, mut start, mut length) = (200u16, 0u64, size);
                match range {
                    ByteRange::Partial(s, e) => {
                        (status, start, length) = (206, s, e - s + 1);
                        put(res.headers_mut(), "content-length", &length.to_string());
                        put(
                            res.headers_mut(),
                            "content-range",
                            &format!("bytes {s}-{e}/{}", size),
                        );
                        put(res.headers_mut(), "accept-ranges", "bytes");
                    }
                    ByteRange::Unsatisfiable => {
                        (status, length) = (416, 0);
                        put(res.headers_mut(), "content-length", "0");
                        put(
                            res.headers_mut(),
                            "content-range",
                            &format!("bytes */{}", size),
                        );
                    }
                    ByteRange::Full => {}
                }
                *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
                let log_asset = |status: u16, sent: u64| {
                    c.log(
                        c.event(status, c.elapsed())
                            .num("reqBytes", req_bytes)
                            .int("resBytes", sent)
                            .str("cacheStatus", "asset"),
                    );
                };
                if req.method() == Method::HEAD || length == 0 {
                    log_asset(status, length);
                    return res;
                }
                let file = match file_path {
                    Some(p) => tokio::fs::File::open(p).await.ok(),
                    None => None,
                };
                let Some(mut file) = file else {
                    return text(500, "internal error");
                };
                if start > 0 {
                    use tokio::io::AsyncSeekExt;
                    let _ = file.seek(std::io::SeekFrom::Start(start)).await;
                }
                log_asset(status, length);
                let stream = tokio_util::io::ReaderStream::with_capacity(
                    tokio::io::AsyncReadExt::take(file, length),
                    64 * 1024,
                );
                *res.body_mut() =
                    http_body_util::StreamBody::new(futures_util::TryStreamExt::map_ok(
                        futures_util::TryStreamExt::map_err(stream, |e| -> crate::body::BoxError {
                            Box::new(e)
                        }),
                        hyper::body::Frame::data,
                    ))
                    .boxed_unsync();
                return res;
            }
        }
    }

    // Decide before lookup as well as insertion. A credentialed request must never consume an
    // anonymous shared entry, even if the origin later sends public Cache-Control by mistake.
    let cache_eligible = !direct_transfer
        && app.cache.is_some()
        && cache_request_eligible(req.method(), req.headers());
    let cache_key =
        cache_eligible.then(|| EdgeCache::key(&host, "GET", &format!("{pathname}{search}")));
    if let (Some(key), Some(cache)) = (&cache_key, &app.cache) {
        let hit = crate::app::lock(cache).get(key, now_ms());
        if let Some(hit) = hit {
            c.log(
                c.event(hit.status, c.elapsed())
                    .num("reqBytes", req_bytes)
                    .int("resBytes", hit.body.len() as u64)
                    .str("cacheStatus", "hit"),
            );
            let mut res = Response::new(full(hit.body.clone()));
            *res.status_mut() = StatusCode::from_u16(hit.status).unwrap_or(StatusCode::OK);
            for (name, value) in &hit.headers {
                res.headers_mut().append(name.clone(), value.clone());
            }
            let age = hit.age_at_store + now_ms().saturating_sub(hit.stored_at) / 1000;
            if let Ok(v) = HeaderValue::from_str(&age.to_string()) {
                res.headers_mut().insert("age", v);
            }
            res.headers_mut()
                .insert("sb-cache", HeaderValue::from_static("HIT"));
            return res;
        }
    }

    // The resolution (a possible cold start) runs on its own task. If this client hangs up while
    // it is awaited, the start carries on for the next request and the hang-up is logged (499)
    // once it is known whether this request was the one that started the sprout.
    let mut resolution =
        app.endpoints
            .begin(&app.sidecar, &route.key, &route.sprout_path, &route.runtime);
    let mut hung_up = ResolveAbort {
        c: c.clone(),
        resolution: Some(resolution.detach()),
    };
    let endpoint = match resolution.wait().await {
        Ok(endpoint) => endpoint,
        Err(error) => {
            hung_up.resolution = None;
            return sprout_unavailable(&c, &host, &error);
        }
    };
    hung_up.resolution = None;
    if direct_transfer && endpoint.transfer_url.is_none() {
        c.log(
            c.event(503, c.elapsed())
                .num("reqBytes", req_bytes)
                .str("error", "direct transfers unavailable")
                .str("errorKind", "transfer-unavailable"),
        );
        return text(503, "direct transfers unavailable");
    }
    let base = if direct_transfer {
        endpoint.transfer_url.clone()
    } else {
        Some(endpoint.url.clone())
    };
    if direct_transfer {
        guards.push(Box::new(TransferGuard::start(app.clone(), route.clone())));
    }
    let target = Target {
        kind: Kind::Sprout,
        base: base.unwrap_or_default().trim_end_matches('/').to_string(),
        route: route.clone(),
        cold: Some(Cold::of(&endpoint)),
        edge_token: endpoint.edge_token.clone(),
        direct_transfer,
    };

    // #48 - a service-binding call arrives from the caller's broker with the edge's secret.
    // The edge vouches for it to the callee with the callee's own token, so the callee sees the
    // caller's URL and reports a thrown error back. Nobody else can send or receive these headers.
    let secret = req
        .headers()
        .get("x-sb-edge-secret")
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
    let binding_call = match secret {
        Some(value) => app.sidecar.is_edge_secret(&value).await,
        None => false,
    };
    let caller_url = req
        .headers()
        .get("x-sb-url")
        .filter(|v| !v.is_empty())
        .cloned();

    // A WebSocket handshake: the sprout accepts a socket of its own first, then the client is
    // upgraded and messages are relayed. The sprout is kept warm while it is open.
    if !direct_transfer && is_websocket_upgrade(req.method(), req.headers()) {
        let mut forwarded = req.headers().clone();
        for name in INTERNAL_REQUEST_HEADERS {
            forwarded.remove(name);
        }
        vouch(
            &mut forwarded,
            binding_call,
            target.edge_token.as_deref(),
            caller_url.as_ref(),
        );
        return websocket(
            &c,
            &ctl,
            req,
            &target,
            &target_string(&pathname, &search),
            forwarded,
        )
        .await;
    }

    let cache_key = cache_key.filter(|_| req.method() == Method::GET);
    proxy_http(
        c,
        req,
        target,
        &pathname,
        &search,
        cache_key,
        binding_call,
        caller_url,
        guards,
    )
    .await
}

fn target_string(pathname: &str, search: &str) -> String {
    format!("{pathname}{search}")
}

fn sprout_unavailable(c: &ReqCtx, host: &str, error: &str) -> Response<RBody> {
    eprintln!("sprout unavailable for {host}: {error}");
    c.log(
        c.event(502, c.elapsed())
            .num("reqBytes", c.req_bytes)
            .null("ttfbMs")
            .str("error", "sprout unavailable")
            .str("errorKind", "sprout-unavailable"),
    );
    text(502, "sprout failed")
}

/// Add the edge's vouching headers for a service-binding call.
fn vouch(
    headers: &mut HeaderMap,
    binding_call: bool,
    edge_token: Option<&str>,
    caller_url: Option<&HeaderValue>,
) {
    if !binding_call {
        return;
    }
    let Some(token) = edge_token.filter(|t| !t.is_empty()) else {
        return;
    };
    headers.insert("x-sb-binding-call", HeaderValue::from_static("1"));
    if let Ok(v) = HeaderValue::from_str(token) {
        headers.insert("x-sb-edge-token", v);
    }
    if let Some(url) = caller_url {
        headers.insert("x-sb-url", url.clone());
    }
}

/// While a direct transfer is open its sprout is touched every 30 s, up to the transfer deadline.
struct TransferGuard(tokio::task::JoinHandle<()>);

impl TransferGuard {
    fn start(app: Arc<App>, route: Arc<Route>) -> TransferGuard {
        let deadline = Duration::from_secs_f64(app.cfg.transfer_timeout_ms / 1000.0 + 1.0);
        TransferGuard(tokio::spawn(async move {
            let end = tokio::time::sleep(deadline);
            tokio::pin!(end);
            let mut tick = tokio::time::interval(Duration::from_secs(30));
            tick.tick().await;
            loop {
                tokio::select! {
                    _ = tick.tick() => app.sidecar.touch(&route.runtime).await,
                    _ = &mut end => return,
                }
            }
        }))
    }
}

impl Drop for TransferGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct Target {
    kind: Kind,
    base: String,
    route: Arc<Route>,
    cold: Option<Cold>,
    edge_token: Option<String>,
    direct_transfer: bool,
}

impl Target {
    fn error_texts(&self) -> (&'static str, &'static str) {
        match self.kind {
            Kind::Backend => ("sproutd failure", "sproutd failed"),
            Kind::Sprout => ("sprout failure", "sprout failed"),
        }
    }
}

/// Logs a 499 if the client went away before the upstream answered (the handler future is
/// dropped when the connection closes): nobody is waiting for the answer.
struct AbortGuard {
    c: ReqCtx,
    cold: Option<Cold>,
    armed: bool,
}

impl Drop for AbortGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let event = self
            .c
            .event(499, self.c.elapsed())
            .num("reqBytes", self.c.req_bytes)
            .null("ttfbMs");
        self.c.log(
            Cold::push(&self.cold, event)
                .str("error", "client closed the request")
                .str("errorKind", "client-closed"),
        );
    }
}

/// Armed while a request waits for its sprout to resolve. Dropped then, the client has gone:
/// log the 499 once the (still running) resolution says whether this request started it.
struct ResolveAbort {
    c: ReqCtx,
    resolution: Option<Resolution>,
}

impl Drop for ResolveAbort {
    fn drop(&mut self) {
        let Some(mut resolution) = self.resolution.take() else {
            return;
        };
        let c = self.c.clone();
        tokio::spawn(async move {
            let cold = match resolution.wait().await {
                Ok(endpoint) => Some(Cold::of(&endpoint)),
                Err(_) => None,
            };
            drop(AbortGuard {
                c,
                cold,
                armed: true,
            });
        });
    }
}

/// Open the sprout's WebSocket, then upgrade the client and relay.
async fn websocket(
    c: &ReqCtx,
    ctl: &IdleControl,
    mut req: Request<Incoming>,
    target: &Target,
    path_and_query: &str,
    forwarded: HeaderMap,
) -> Response<RBody> {
    let app = &c.app;
    let authority = target.base.trim_start_matches("http://").to_string();
    let refusal = |status: u16, body: &'static str| {
        let event = c.event(status, c.elapsed()).num("reqBytes", c.req_bytes);
        c.log(
            Cold::push(&target.cold, event)
                .str("error", "websocket refused")
                .str("errorKind", "websocket-refused"),
        );
        text(status, body)
    };
    let upstream = match connect_upstream(
        &authority,
        path_and_query,
        &forwarded,
        &offered_protocols(&forwarded),
        WS_CONNECT_TIMEOUT,
    )
    .await
    {
        Ok(u) => u,
        Err(_) => return refusal(502, "the sprout did not accept the WebSocket"),
    };
    let Some(accept) = accept_key_for(req.headers()) else {
        drop(upstream);
        return refusal(400, "WebSocket upgrade failed");
    };
    let on_upgrade = hyper::upgrade::on(&mut req);
    let mut res = Response::new(empty());
    *res.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    let h = res.headers_mut();
    h.insert("connection", HeaderValue::from_static("Upgrade"));
    h.insert("upgrade", HeaderValue::from_static("websocket"));
    if let Ok(v) = HeaderValue::from_str(&accept) {
        h.insert("sec-websocket-accept", v);
    }
    if let Some(protocol) = upstream
        .protocol
        .as_deref()
        .and_then(|p| HeaderValue::from_str(p).ok())
    {
        h.insert("sec-websocket-protocol", protocol);
    }
    let event = c.event(101, c.elapsed()).num("reqBytes", c.req_bytes);
    c.log(Cold::push(&target.cold, event));

    let hold = ctl.hold();
    let guard = app.in_flight.enter();
    let shutdown = app.shutdown.subscribe();
    let keep_alive = (target.kind == Kind::Sprout).then(|| (app.clone(), target.route.clone()));
    let c = c.clone();
    tokio::spawn(async move {
        let _hold: IdleHold = hold;
        let _guard = guard;
        let Ok(upgraded) = on_upgrade.await else {
            return;
        };
        let client = WebSocketStream::from_raw_socket(
            TokioIo::new(upgraded),
            Role::Server,
            Some(server_config()),
        )
        .await;
        let closed = relay(
            client,
            upstream.socket,
            move || {
                if let Some((app, route)) = keep_alive.clone() {
                    tokio::spawn(async move { app.sidecar.touch(&route.runtime).await });
                }
            },
            shutdown,
        )
        .await;
        // The second line of a socket: the 101 above says it opened, this says how long it
        // lived, how many payload bytes crossed (reqBytes from the client, resBytes to it) and who ended it.
        c.log(
            c.event(101, c.elapsed())
                .int("reqBytes", closed.from_client)
                .int("resBytes", closed.to_client)
                .str("closedBy", closed.by)
                .opt_num("closeCode", closed.code.map(f64::from)),
        );
    });
    res
}

/// The headers sent to the upstream: the client's, minus the edge-only and hop-by-hop ones.
fn upstream_request_headers(
    original: &HeaderMap,
    method: &Method,
    binding_call: bool,
    edge_token: Option<&str>,
    caller_url: Option<&HeaderValue>,
) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(original.len() + 3);
    let bodyless = method == Method::GET || method == Method::HEAD;
    for (name, value) in original {
        if is_hop_by_hop(name)
            || name == "expect"
            || INTERNAL_REQUEST_HEADERS.contains(&name.as_str())
            || (bodyless && name == "content-length")
        {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    vouch(&mut out, binding_call, edge_token, caller_url);
    out
}

#[allow(clippy::too_many_arguments)]
async fn proxy_http(
    c: ReqCtx,
    req: Request<Incoming>,
    mut target: Target,
    pathname: &str,
    search: &str,
    cache_key: Option<String>,
    binding_call: bool,
    caller_url: Option<HeaderValue>,
    mut guards: Vec<Box<dyn std::any::Any + Send>>,
) -> Response<RBody> {
    let app = c.app.clone();
    let host = c.host.clone();
    let direct_transfer = target.direct_transfer;
    let (parts, incoming) = req.into_parts();
    let bodyless = parts.method == Method::GET || parts.method == Method::HEAD;
    let mut body =
        (!bodyless).then(|| LimitedBody::new(incoming, app.cfg.max_body_bytes).boxed_unsync());
    let timeout_ms = if direct_transfer {
        app.cfg.transfer_timeout_ms
    } else {
        app.cfg.request_timeout_ms
    };
    let deadline = Instant::now() + Duration::from_secs_f64(timeout_ms / 1000.0);
    let (error_log_text, error_body) = target.error_texts();
    let mut abort = AbortGuard {
        c: c.clone(),
        cold: target.cold.clone(),
        armed: true,
    };
    let path_and_query = format!("{pathname}{search}");
    let mut attempt = 0;

    let upstream = loop {
        let headers = upstream_request_headers(
            &parts.headers,
            &parts.method,
            binding_call,
            target.edge_token.as_deref(),
            caller_url.as_ref(),
        );
        let uri: Uri = match format!("{}{}", target.base, path_and_query).parse() {
            Ok(u) => u,
            Err(_) => {
                abort.armed = false;
                return proxy_failure(&c, &target, 502, error_body, error_log_text, "proxy");
            }
        };
        let mut request = Request::new(body.take().unwrap_or_else(empty));
        *request.method_mut() = parts.method.clone();
        *request.uri_mut() = uri;
        *request.headers_mut() = headers;
        match tokio::time::timeout_at(deadline, app.client.request(request)).await {
            Ok(Ok(response)) => break response,
            Ok(Err(error)) => {
                let connect = error.is_connect();
                if connect && target.kind == Kind::Sprout {
                    app.endpoints.invalidate(&target.route.key).await;
                    // The sprout may have just died; nothing was sent, so a body-less request can re-resolve once.
                    if bodyless && attempt == 0 {
                        attempt += 1;
                        match app
                            .endpoints
                            .begin(
                                &app.sidecar,
                                &target.route.key,
                                &target.route.sprout_path,
                                &target.route.runtime,
                            )
                            .wait()
                            .await
                        {
                            Ok(endpoint) => {
                                target.base = if direct_transfer {
                                    endpoint.transfer_url.clone().unwrap_or_default()
                                } else {
                                    endpoint.url.clone()
                                }
                                .trim_end_matches('/')
                                .to_string();
                                target.edge_token = endpoint.edge_token.clone();
                                if endpoint.cold_start {
                                    target.cold = Some(Cold::of(&endpoint));
                                    abort.cold = target.cold.clone();
                                }
                                continue;
                            }
                            Err(error) => {
                                abort.armed = false;
                                return sprout_unavailable(&c, &host, &error);
                            }
                        }
                    }
                }
                abort.armed = false;
                eprintln!(
                    "{} failure for {host}: {error}",
                    if target.kind == Kind::Sprout {
                        "sprout"
                    } else {
                        "sproutd"
                    }
                );
                return proxy_failure(&c, &target, 502, error_body, error_log_text, "proxy");
            }
            Err(_) => {
                abort.armed = false;
                eprintln!(
                    "{} timed out for {host}: the operation timed out",
                    if target.kind == Kind::Sprout {
                        "sprout"
                    } else {
                        "sproutd"
                    }
                );
                return proxy_failure(
                    &c,
                    &target,
                    504,
                    "request timed out",
                    "request timed out",
                    "timed-out",
                );
            }
        }
    };
    abort.armed = false;
    let ttfb = c.elapsed();
    let (mut rparts, rbody) = upstream.into_parts();
    let status = rparts.status.as_u16();
    // #28 - per-invocation CPU time the sprout self-reports.
    let cpu_ms = header_joined(&rparts.headers, "x-sb-cpu-ms")
        .map(|h| js_number(&h))
        .filter(|n| n.is_finite());
    // A missing content-length is unknown, not 0: it must not slip past the size caps.
    let declared =
        header_joined(&rparts.headers, "content-length").map_or(f64::NAN, |h| js_number(&h));
    if !direct_transfer && declared.is_finite() && declared > app.cfg.response_max_bytes {
        let event = c
            .event(502, ttfb)
            .int("ttfbMs", ttfb)
            .num("reqBytes", c.req_bytes)
            .num("resBytes", declared);
        c.log(
            Cold::push(&target.cold, event)
                .str("error", "response too large")
                .str("errorKind", "response-too-large"),
        );
        return text(502, "response too large");
    }

    let cache_policy = cache_key
        .as_ref()
        .and_then(|_| cache_response_eligible(&rparts.headers, now_ms()));
    let cache_status: Option<&'static str> =
        (parts.method == Method::GET && target.kind == Kind::Sprout).then(|| {
            if cache_key.is_some() {
                if cache_policy.is_none() {
                    "dynamic"
                } else {
                    "miss"
                }
            } else {
                "bypass"
            }
        });

    // The runtime's answer to a handler that threw: the `x-sb-uncaught` marker (service-binding
    // calls only), or else its signature, a bare 500 with no content-type whose body is
    // "Internal Server Error" (21 bytes). Feeds `tail`'s `exception` outcome.
    let uncaught = target.kind == Kind::Sprout
        && (rparts.headers.contains_key("x-sb-uncaught")
            || (status == 500
                && !rparts.headers.contains_key("content-type")
                && header_joined(&rparts.headers, "content-length").as_deref() == Some("21")));
    let mut headers = std::mem::take(&mut rparts.headers);
    let hop: Vec<HeaderName> = headers
        .keys()
        .filter(|n| is_hop_by_hop(n))
        .cloned()
        .collect();
    for name in hop {
        headers.remove(name);
    }
    // A callee's error, for the caller's broker only: it carries the message.
    if !binding_call || target.kind == Kind::Backend {
        headers.remove("x-sb-uncaught");
    }
    headers.remove("x-sb-cpu-ms");
    if let Some(cpu) = cpu_ms {
        if let Ok(v) = HeaderValue::from_str(&to_fixed3(cpu)) {
            headers.insert("x-sb-cpu-ms", v);
        }
    }
    if let Some(status) = cache_status {
        headers.insert(
            "sb-cache",
            HeaderValue::from_static(if status == "dynamic" {
                "DYNAMIC"
            } else if status == "miss" {
                "MISS"
            } else {
                "BYPASS"
            }),
        );
    }

    let fill = match (&cache_key, cache_policy) {
        (Some(key), Some(policy))
            if !declared.is_finite() || declared <= crate::cache::MAX_CACHE_ENTRY_BYTES as f64 =>
        {
            let cache_headers: Vec<(HeaderName, HeaderValue)> = headers
                .iter()
                .filter(|(n, _)| *n != "sb-cache" && *n != "x-sb-cpu-ms")
                .map(|(n, v)| (n.clone(), v.clone()))
                .collect();
            let (app, route, key, host) =
                (app.clone(), target.route.clone(), key.clone(), host.clone());
            Some(Fill::new(move |buffered: Bytes| {
                // A route reload purges before it swaps. Do not let an old, in-flight response
                // repopulate that new deployment's cache.
                let current = app
                    .routes()
                    .get(&host)
                    .is_some_and(|r| Arc::ptr_eq(r, &route));
                let now = now_ms();
                if current && (now as f64) < policy.expires_at {
                    if let Some(cache) = &app.cache {
                        let age = ((now as f64 - policy.response_date_ms) / 1000.0)
                            .floor()
                            .max(0.0) as u64;
                        crate::app::lock(cache).set(
                            &key,
                            status,
                            cache_headers,
                            buffered,
                            age,
                            policy.expires_at,
                        );
                    }
                }
            }))
        }
        _ => None,
    };

    // #31 - log once the response body has actually finished streaming, so durationMs is the
    // full request duration and resBytes the real count.
    let on_end = {
        let (c, cold) = (c.clone(), target.cold.clone());
        let kind = target.kind;
        move |end: End| {
            let (bytes, how) = match end {
                End::Done(b) => (b, 0),
                End::Aborted(b) => (b, 1),
                End::Failed(b) => (b, 2),
            };
            if how == 1 {
                // The client hung up mid-body: nobody is waiting for the rest.
                let event = c
                    .event(499, c.elapsed())
                    .num("reqBytes", c.req_bytes)
                    .int("ttfbMs", ttfb);
                c.log(
                    Cold::push(&cold, event)
                        .int("resBytes", bytes)
                        .str("error", "client closed the request")
                        .str("errorKind", "client-closed"),
                );
                return;
            }
            if how == 2 {
                let event = c
                    .event(status, c.elapsed())
                    .int("ttfbMs", ttfb)
                    .num("reqBytes", c.req_bytes);
                c.log(
                    Cold::push(&cold, event)
                        .int("resBytes", bytes)
                        .str("error", "upstream failed mid-body")
                        .str("errorKind", "proxy"),
                );
                return;
            }
            let mut event = c
                .event(status, c.elapsed())
                .int("ttfbMs", ttfb)
                .num("reqBytes", c.req_bytes)
                .num(
                    "resBytes",
                    if declared.is_finite() {
                        declared
                    } else {
                        bytes as f64
                    },
                );
            event = Cold::push(&cold, event).opt_num("cpuMs", cpu_ms);
            if status >= 500 {
                event = event.str("errorKind", "upstream-5xx");
            }
            if uncaught {
                event = event.bool("uncaught", true);
            }
            if kind == Kind::Sprout {
                event = event.undef_str("cacheStatus", cache_status);
            }
            c.log(event);
        }
    };
    let cap = (!direct_transfer).then_some(app.cfg.response_max_bytes);
    let mut res = Response::new(empty());
    *res.status_mut() = rparts.status;
    if hyper::body::Body::is_end_stream(&rbody) {
        // Nothing will be streamed (HEAD, 204, 304, empty): finish now rather than rely on a poll.
        let mut fill = fill;
        if let Some(fill) = fill.as_mut() {
            fill.flush();
        }
        on_end(End::Done(0));
        *res.headers_mut() = headers;
        return res;
    }
    guards.shrink_to_fit();
    *res.body_mut() = ProxyBody::new(rbody, &host, cap, fill, on_end, guards).boxed_unsync();
    *res.headers_mut() = headers;
    res
}

fn proxy_failure(
    c: &ReqCtx,
    target: &Target,
    status: u16,
    body: &'static str,
    error: &'static str,
    kind: &'static str,
) -> Response<RBody> {
    let event = c
        .event(status, c.elapsed())
        .num("reqBytes", c.req_bytes)
        .null("ttfbMs");
    c.log(
        Cold::push(&target.cold, event)
            .str("error", error)
            .str("errorKind", kind),
    );
    text(status, body)
}
