//! The request handler: everything the Bun edge's `fetch` does, in the same order
//! (route refresh, pool stats, host lookup, direct transfers,
//! static assets, the GET cache, the supervisor endpoint, service-binding
//! vouching, WebSockets, and the timed, capped, logged reverse proxy).

use crate::app::App;
use crate::assets::{cache_control_for, match_headers, parse_range, ByteRange, HeaderRule};
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
    server_config, try_socket_slot, WS_CONNECT_TIMEOUT,
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
pub(crate) const INTERNAL_REQUEST_HEADERS: [&str; 4] = [
    "x-sb-edge-secret",
    "x-sb-edge-token",
    "x-sb-binding-call",
    "x-sb-url",
];
const TEXT: &str = "text/plain;charset=utf-8";

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
pub(crate) struct ReqCtx {
    pub(crate) app: Arc<App>,
    pub(crate) started: Instant,
    pub(crate) host: String,
    pub(crate) method: Method,
    pub(crate) req_bytes: f64,
    pub(crate) path: Option<String>,
}

impl ReqCtx {
    pub(crate) fn elapsed(&self) -> u64 {
        (self.started.elapsed().as_secs_f64() * 1000.0).round() as u64
    }
    pub(crate) fn log(&self, event: Event) {
        self.app.log.write(&event, self.path.as_deref());
    }
    /// `{hostname, method, status, durationMs}`, the start of nearly every event.
    pub(crate) fn event(&self, status: u16, duration_ms: u64) -> Event {
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

pub(crate) fn text(status: u16, body: &'static str) -> Response<RBody> {
    response(status, Some(TEXT), full(body))
}

/// What Bun answers when the fetch handler throws.
fn something_went_wrong() -> Response<RBody> {
    response(500, Some("text/plain"), full("Something went wrong!"))
}

/// A request refused before routing: a small plain-text answer (never an HTML error page)
/// and a log line. `close` drops the connection afterwards (an unread oversized body).
#[allow(clippy::too_many_arguments)]
pub(crate) fn reject(
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

/// Does the request carry any header a forwarding proxy adds?
fn has_proxy_headers(headers: &HeaderMap) -> bool {
    [
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "forwarded",
        "via",
    ]
    .iter()
    .any(|name| headers.contains_key(*name))
}

/// A sprout's `Set-Cookie` lines, made safe to hand to a browser: the `Domain` attribute is
/// removed (the cookie stays host-only) and platform session cookies are dropped.
fn clean_set_cookie(value: &str) -> Option<String> {
    let mut parts = value.split(';');
    let first = parts.next().unwrap_or("");
    let name = first
        .split('=')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if name.starts_with("__secure-better-auth") || name.starts_with("better-auth.") {
        return None;
    }
    let mut out = String::from(first);
    for attr in parts {
        let key = attr.split('=').next().unwrap_or("").trim();
        if key.eq_ignore_ascii_case("domain") {
            continue;
        }
        out.push(';');
        out.push_str(attr);
    }
    Some(out)
}

fn clean_set_cookies(headers: &mut HeaderMap) {
    if !headers.contains_key("set-cookie") {
        return;
    }
    let cookies: Vec<HeaderValue> = headers.get_all("set-cookie").iter().cloned().collect();
    headers.remove("set-cookie");
    for cookie in cookies {
        let cleaned = match cookie.to_str() {
            Ok(text) => clean_set_cookie(text).and_then(|t| HeaderValue::from_str(&t).ok()),
            // Not text: cannot be inspected, so it is not passed on.
            Err(_) => None,
        };
        if let Some(value) = cleaned {
            headers.append("set-cookie", value);
        }
    }
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

/// Assets up to this size are read in one go instead of streamed.
pub(crate) const SMALL_ASSET_BYTES: u64 = 256 * 1024;

/// Set a response header, skipping a name or value that is not valid.
pub(crate) fn put_header(h: &mut HeaderMap, name: &str, value: &str) {
    if let (Ok(n), Ok(v)) = (
        HeaderName::from_bytes(name.as_bytes()),
        HeaderValue::from_str(value),
    ) {
        h.insert(n, v);
    }
}

/// Every matching `_headers` block, in file order: a later rule overrides or unsets an earlier one.
/// `protect_encoding` (backend mode) also keeps a rule from setting or unsetting `content-encoding`.
pub(crate) fn apply_header_rules(
    h: &mut HeaderMap,
    rules: &[HeaderRule],
    pathname: &str,
    protect_encoding: bool,
) {
    let protected =
        |n: &HeaderName| is_framing_header(n) || (protect_encoding && n == "content-encoding");
    for rule in match_headers(rules, pathname) {
        // Framing headers belong to the edge: a rule cannot change or drop them.
        for name in &rule.unset {
            if let Ok(n) = HeaderName::from_bytes(name.to_lowercase().as_bytes()) {
                if !protected(&n) {
                    h.remove(n);
                }
            }
        }
        for (name, value) in &rule.set {
            let lower = name.to_lowercase();
            if HeaderName::from_bytes(lower.as_bytes()).is_ok_and(|n| protected(&n)) {
                continue;
            }
            put_header(h, &lower, value);
        }
    }
}

/// A `_redirects` answer.
pub(crate) fn redirect_response(status: u16, location: &str) -> Response<RBody> {
    let mut res = Response::new(empty());
    *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::FOUND);
    // Bun sends header text as latin1 bytes when it can.
    let bytes: Vec<u8> = if location.chars().all(|c| (c as u32) < 256) {
        location.chars().map(|c| c as u32 as u8).collect()
    } else {
        location.as_bytes().to_vec()
    };
    match HeaderValue::from_bytes(&bytes) {
        Ok(v) => {
            res.headers_mut().insert("location", v);
            res
        }
        Err(_) => something_went_wrong(),
    }
}

/// The next `length` bytes of an opened file as a streamed body (64 KiB chunks).
pub(crate) fn file_body(file: tokio::fs::File, length: u64) -> RBody {
    let stream = tokio_util::io::ReaderStream::with_capacity(
        tokio::io::AsyncReadExt::take(file, length),
        64 * 1024,
    );
    http_body_util::StreamBody::new(futures_util::TryStreamExt::map_ok(
        futures_util::TryStreamExt::map_err(stream, |e| -> crate::body::BoxError { Box::new(e) }),
        hyper::body::Frame::data,
    ))
    .boxed_unsync()
}

/// `length` bytes of the file from `start`.
pub(crate) fn read_small(
    path: &std::path::Path,
    start: u64,
    length: u64,
) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek};
    let mut file = std::fs::File::open(path)?;
    if start > 0 {
        file.seek(std::io::SeekFrom::Start(start))?;
    }
    let mut buf = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut buf)?;
    Ok(buf)
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
    // Backend mode: assets from the snapshot, everything else to the backend. No pool, no sprouts.
    if app.backend.is_some() {
        return crate::backend::handle(c, &ctl, req, pathname, search).await;
    }
    // #30 - runtime-lifecycle gauges, loopback only (edge binds 127.0.0.1).
    // Answered only to a loopback peer asking by a loopback name: through the proxy (Caddy is a
    // loopback peer too) the Host is a deployment hostname, so this falls through to routing.
    let local_host = header_joined(req.headers(), "host").is_some_and(|h| is_local_host(&h));
    if pathname == "/__sb/pool"
        && peer.to_canonical().is_loopback()
        && local_host
        && !has_proxy_headers(req.headers())
    {
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
                return redirect_response(status, &location);
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
                // Plain std::fs on the worker: a stat and a small read of a hot file take a few
                // microseconds, while each tokio::fs call is a spawn_blocking thread hop.
                let meta = match &file_path {
                    Some(p) => std::fs::metadata(p).ok(),
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
                let put = put_header;
                put(h, "content-type", &entry.content_type);
                put(h, "etag", &etag);
                put(h, "content-length", &size.to_string());
                put(h, "cache-control", cache_control_for(key));
                if entry.content_type == "application/octet-stream" {
                    let name = key.rsplit('/').next().unwrap_or("");
                    put(h, "content-disposition", &format!("filename=\"{name}\""));
                }
                apply_header_rules(h, &manifest.headers, &decoded, false);

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
                if length <= SMALL_ASSET_BYTES {
                    let read = file_path
                        .as_deref()
                        .and_then(|p| read_small(p, start, length).ok());
                    let Some(bytes) = read else {
                        return text(500, "internal error");
                    };
                    log_asset(status, bytes.len() as u64);
                    *res.body_mut() = full(bytes);
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
                *res.body_mut() = file_body(file, length);
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
        base: base.unwrap_or_default().trim_end_matches('/').to_string(),
        route: Some(route.clone()),
        cold: Some(Cold::of(&endpoint)),
        edge_token: endpoint.edge_token.clone(),
        direct_transfer,
    };

    // #48 - a service-binding call arrives from the caller's broker with a credential the sidecar
    // vouches for: the broker's own one, good only for the hosts its app declares. The edge vouches
    // for the call to the callee with the callee's own token, so the callee
    // sees the caller's URL and reports a thrown error back. Nobody else can send or receive these
    // headers. `Headers#get` joins a repeated field with ", ", so a credential sent twice never matches.
    let secret = header_joined(req.headers(), "x-sb-edge-secret");
    let binding_call = match secret {
        Some(value) => app.sidecar.verify_binding_call(&value, &host).await,
        None => false,
    };
    let caller_url = header_joined(req.headers(), "x-sb-url")
        .filter(|v| !v.is_empty())
        .and_then(|v| HeaderValue::from_str(&v).ok());

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
    base: String,
    /// The supervisor route; `None` for the backend of backend mode.
    route: Option<Arc<Route>>,
    cold: Option<Cold>,
    edge_token: Option<String>,
    direct_transfer: bool,
}

impl Target {
    fn is_backend(&self) -> bool {
        self.route.is_none()
    }

    fn error_texts(&self) -> (&'static str, &'static str) {
        if self.is_backend() {
            ("backend unavailable", "backend unavailable")
        } else {
            ("sprout failure", "sprout failed")
        }
    }
}

/// Backend mode: relay the request (HTTP or WebSocket) to the backend with the client's Host and
/// path, answering 502 `backend unavailable` when it cannot be reached.
pub(crate) async fn forward_to_backend(
    c: ReqCtx,
    ctl: &IdleControl,
    req: Request<Incoming>,
    pathname: &str,
    search: &str,
) -> Response<RBody> {
    let Some(base) = c.app.cfg.backend.clone() else {
        return text(502, "backend unavailable");
    };
    let target = Target {
        base,
        route: None,
        cold: None,
        edge_token: None,
        direct_transfer: false,
    };
    if is_websocket_upgrade(req.method(), req.headers()) {
        let mut forwarded = req.headers().clone();
        for name in INTERNAL_REQUEST_HEADERS {
            forwarded.remove(name);
        }
        return websocket(
            &c,
            ctl,
            req,
            &target,
            &target_string(pathname, search),
            forwarded,
        )
        .await;
    }
    proxy_http(
        c,
        req,
        target,
        pathname,
        search,
        None,
        false,
        None,
        Vec::new(),
    )
    .await
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
    // The client's handshake is checked, and a slot taken, before the sprout is bothered.
    let Some(accept) = accept_key_for(req.headers()) else {
        return refusal(400, "WebSocket upgrade failed");
    };
    let Some(slot) = try_socket_slot() else {
        return refusal(503, "too many open WebSockets");
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
        Err(_) if target.is_backend() => return refusal(502, "backend unavailable"),
        Err(_) => return refusal(502, "the sprout did not accept the WebSocket"),
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
    let keep_alive = target.route.clone().map(|route| (app.clone(), route));
    let c = c.clone();
    tokio::spawn(async move {
        let _hold: IdleHold = hold;
        let _guard = guard;
        let _slot = slot;
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
                if connect && target.is_backend() {
                    abort.armed = false;
                    eprintln!("backend unavailable for {host}: {error}");
                    return proxy_failure(
                        &c,
                        &target,
                        502,
                        error_body,
                        error_log_text,
                        "backend-unavailable",
                    );
                }
                if let (true, Some(route)) = (connect, target.route.clone()) {
                    app.endpoints.invalidate(&route.key).await;
                    // The sprout may have just died; nothing was sent, so a body-less request can re-resolve once.
                    if bodyless && attempt == 0 {
                        attempt += 1;
                        match app
                            .endpoints
                            .begin(&app.sidecar, &route.key, &route.sprout_path, &route.runtime)
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
                let noun = if target.is_backend() {
                    "backend"
                } else {
                    "sprout"
                };
                eprintln!("{noun} failure for {host}: {error}");
                return proxy_failure(&c, &target, 502, error_body, error_log_text, "proxy");
            }
            Err(_) => {
                abort.armed = false;
                let noun = if target.is_backend() {
                    "backend"
                } else {
                    "sprout"
                };
                eprintln!("{noun} timed out for {host}: the operation timed out");
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
    let backend = target.is_backend();
    let cache_status: Option<&'static str> = (parts.method == Method::GET || backend).then(|| {
        if backend {
            "dynamic"
        } else if cache_key.is_some() {
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
    let uncaught = rparts.headers.contains_key("x-sb-uncaught")
        || (status == 500
            && !rparts.headers.contains_key("content-type")
            && header_joined(&rparts.headers, "content-length").as_deref() == Some("21"));
    let mut headers = std::mem::take(&mut rparts.headers);
    let hop: Vec<HeaderName> = headers
        .keys()
        .filter(|n| is_hop_by_hop(n))
        .cloned()
        .collect();
    for name in hop {
        headers.remove(name);
    }
    // Cookie hygiene is Community's; a backend's cookies go through as they are, except that on
    // Cloud app hosts a cookie may not reach beyond its own account (see cookie_guard).
    let mut cookies_stripped = 0;
    if !backend {
        clean_set_cookies(&mut headers);
    } else if let Some(apps) = &app.cfg.apps_domain {
        cookies_stripped = crate::cookie_guard::guard_set_cookies(&mut headers, &host, apps);
    }
    // A callee's error, for the caller's broker only: it carries the message.
    if !binding_call {
        headers.remove("x-sb-uncaught");
    }
    headers.remove("x-sb-cpu-ms");
    if let Some(cpu) = cpu_ms {
        if let Ok(v) = HeaderValue::from_str(&to_fixed3(cpu)) {
            headers.insert("x-sb-cpu-ms", v);
        }
    }
    if let Some(status) = cache_status.filter(|_| !backend) {
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
                let current = route.as_ref().is_some_and(|route| {
                    app.routes()
                        .get(&host)
                        .is_some_and(|r| Arc::ptr_eq(r, route))
                });
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
            event = event.undef_str("cacheStatus", cache_status);
            if cookies_stripped > 0 {
                event = event.int("cookiesStripped", cookies_stripped);
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

#[cfg(test)]
mod hardening_tests {
    use super::*;

    #[test]
    fn pool_refuses_proxy_headers() {
        let mut h = HeaderMap::new();
        h.insert("host", HeaderValue::from_static("localhost"));
        assert!(!has_proxy_headers(&h));
        for name in [
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
            "forwarded",
            "via",
        ] {
            let mut with = h.clone();
            with.insert(name, HeaderValue::from_static("x"));
            assert!(has_proxy_headers(&with), "{name}");
        }
    }

    #[test]
    fn cookie_domain_is_dropped() {
        assert_eq!(
            clean_set_cookie("a=b; Domain=example.com; Path=/; Secure").as_deref(),
            Some("a=b; Path=/; Secure")
        );
        assert_eq!(
            clean_set_cookie("a=b;path=/;DOMAIN = .example.com ;HttpOnly").as_deref(),
            Some("a=b;path=/;HttpOnly")
        );
        assert_eq!(
            clean_set_cookie("a=b; Path=/; domain=x.test").as_deref(),
            Some("a=b; Path=/")
        );
        assert_eq!(
            clean_set_cookie("a=b; Path=/; Max-Age=5").as_deref(),
            Some("a=b; Path=/; Max-Age=5")
        );
    }

    #[test]
    fn session_cookies_are_dropped() {
        assert_eq!(
            clean_set_cookie("__Secure-better-auth.session_token=x; Path=/"),
            None
        );
        assert_eq!(clean_set_cookie("better-auth.session_token=x"), None);
        assert_eq!(clean_set_cookie(" Better-Auth.x=1; Domain=a.b"), None);
        assert!(clean_set_cookie("my-better-auth=1").is_some());
    }

    #[test]
    fn set_cookie_lines_are_cleaned_in_place() {
        let mut h = HeaderMap::new();
        h.append(
            "set-cookie",
            HeaderValue::from_static("a=1; Domain=x.test; Path=/"),
        );
        h.append(
            "set-cookie",
            HeaderValue::from_static("better-auth.session_token=z"),
        );
        h.append("set-cookie", HeaderValue::from_static("b=2"));
        clean_set_cookies(&mut h);
        let got: Vec<&str> = h
            .get_all("set-cookie")
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect();
        assert_eq!(got, ["a=1; Path=/", "b=2"]);
    }
}
