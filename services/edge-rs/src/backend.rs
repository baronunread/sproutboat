//! Backend mode (`SPROUTBOAT_EDGE_BACKEND`): the edge serves static assets from a host copy
//! named by a route snapshot and forwards everything else, HTTP and WebSocket, to a loopback
//! backend with the client's Host and path. No sidecar, no activation spool, no response cache.
//! Community mode never reaches any of this.

use crate::app::lock;
use crate::assets::{
    cache_control_backend, parse_range, AssetEntry, ByteRange, Manifest, NotFound,
};
use crate::body::{empty, full, RBody};
use crate::config::Config;
use crate::idle::IdleControl;
use crate::proxy::{
    apply_header_rules, file_body, forward_to_backend, put_header, read_small, redirect_response,
    reject, text, ReqCtx, SMALL_ASSET_BYTES,
};
use crate::reload::{self, Check, Loaded};
use crate::util::{decode_uri_component, header_joined, now_ms};
use crate::websocket::is_websocket_upgrade;
use bytes::Bytes;
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use serde::Deserialize;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

// ---------------------------------------------------------------- snapshot

#[derive(Deserialize)]
struct RawSnapshot {
    version: u64,
    #[serde(default)]
    apps: Vec<RawApp>,
}

#[derive(Deserialize)]
struct RawApp {
    hostname: String,
    #[serde(default)]
    app_id: String,
    #[serde(default)]
    path: Option<String>,
    manifest: String,
    blobs: String,
}

/// One route of the snapshot: a hostname, optionally a path prefix, and where its manifest and
/// its blobs are.
#[derive(Debug, PartialEq)]
pub struct SnapshotApp {
    pub hostname: String,
    /// `None` is the bare hostname (every path); otherwise a valid prefix (`/docs`).
    pub path: Option<String>,
    pub app_id: String,
    pub manifest: PathBuf,
    pub blobs: PathBuf,
}

/// Whether `prefix` is a valid route prefix: one to eight `/segment`s, at most 200 bytes, no
/// trailing slash; a segment is `[A-Za-z0-9._~%-]+` (not `.` or `..`) and `%` only as `%XX`.
pub fn valid_route_prefix(prefix: &str) -> bool {
    let Some(rest) = prefix.strip_prefix('/') else {
        return false;
    };
    if prefix.len() > 200 {
        return false;
    }
    let mut count = 0;
    for segment in rest.split('/') {
        count += 1;
        let b = segment.as_bytes();
        if count > 8 || b.is_empty() || segment == "." || segment == ".." {
            return false;
        }
        let mut i = 0;
        while i < b.len() {
            match b[i] {
                b'%' => {
                    if i + 2 >= b.len()
                        || !b[i + 1].is_ascii_hexdigit()
                        || !b[i + 2].is_ascii_hexdigit()
                    {
                        return false;
                    }
                    i += 3;
                    continue;
                }
                c if c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'~' | b'-') => {}
                _ => return false,
            }
            i += 1;
        }
    }
    true
}

/// `{version:1, apps:[{hostname, path?, app_id, manifest, blobs}]}`. An entry whose `path` is
/// not a valid prefix (or whose whole key is over 255 bytes) is logged and skipped.
pub fn parse_snapshot(text: &str) -> Result<Vec<SnapshotApp>, String> {
    let raw: RawSnapshot =
        serde_json::from_str(text).map_err(|e| format!("invalid route snapshot: {e}"))?;
    if raw.version != 1 {
        return Err(format!(
            "invalid route snapshot: unsupported version {}",
            raw.version
        ));
    }
    raw.apps
        .into_iter()
        .map(|app| {
            let hostname = app.hostname.trim().to_lowercase();
            if hostname.is_empty() || app.manifest.is_empty() || app.blobs.is_empty() {
                return Err(
                    "invalid route snapshot: an app needs hostname, manifest and blobs".into(),
                );
            }
            if let Some(path) = &app.path {
                if !valid_route_prefix(path) || hostname.len() + path.len() > 255 {
                    eprintln!(
                        "route snapshot: skipping {hostname}{path} ({}): invalid path prefix",
                        app.app_id
                    );
                    return Ok(None);
                }
            }
            Ok(Some(SnapshotApp {
                hostname,
                path: app.path,
                app_id: app.app_id,
                manifest: PathBuf::from(app.manifest),
                blobs: PathBuf::from(app.blobs),
            }))
        })
        .filter_map(|r| r.transpose())
        .collect()
}

/// What the edge serves for one route (a hostname, or a hostname and a path prefix).
pub struct HostAssets {
    pub manifest: Arc<Manifest>,
    pub blobs: PathBuf,
}

/// The route table: hostname -> its entries, the bare one (`None`) and the path-prefixed ones.
type Hosts = HashMap<String, Vec<(Option<String>, Arc<HostAssets>)>>;

/// The entry for a request path: the longest matching prefix, else the bare entry. The path is
/// the raw request path (no query, not decoded). A prefix matches when the path equals it or
/// continues with `/`; candidates are tried from the full path up one segment at a time.
fn match_route<'a, T>(entries: &'a [(Option<String>, T)], path: &str) -> Option<&'a T> {
    let find = |prefix: Option<&str>| {
        entries
            .iter()
            .find(|(p, _)| p.as_deref() == prefix)
            .map(|(_, v)| v)
    };
    if entries.iter().any(|(p, _)| p.is_some()) {
        let mut candidate = path.trim_end_matches('/');
        while !candidate.is_empty() {
            if let Some(found) = find(Some(candidate)) {
                return Some(found);
            }
            candidate = &candidate[..candidate.rfind('/').unwrap_or(0)];
        }
    }
    find(None)
}

// --------------------------------------------------------------------- LRU

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Enc {
    Identity,
    Br,
    Gz,
}

pub type BlobKey = (String, Enc);

/// Bytes-bounded least-recently-used cache. Keys are content hashes, so nothing is invalidated.
/// `order` holds (key, tick) pairs; a pair whose tick is not the entry's current one is stale.
pub struct Lru {
    cap: u64,
    used: u64,
    tick: u64,
    map: HashMap<BlobKey, (Bytes, u64)>,
    order: VecDeque<(BlobKey, u64)>,
}

impl Lru {
    pub fn new(cap: u64) -> Lru {
        Lru {
            cap,
            used: 0,
            tick: 0,
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    pub fn get(&mut self, key: &BlobKey) -> Option<Bytes> {
        let (bytes, at) = self.map.get_mut(key)?;
        self.tick += 1;
        *at = self.tick;
        let out = bytes.clone();
        self.order.push_back((key.clone(), self.tick));
        if self.order.len() > self.map.len() * 2 + 32 {
            let map = &self.map;
            self.order
                .retain(|(k, t)| map.get(k).is_some_and(|(_, cur)| cur == t));
        }
        Some(out)
    }

    pub fn insert(&mut self, key: BlobKey, bytes: Bytes) {
        let len = bytes.len() as u64;
        if len > self.cap {
            return;
        }
        if let Some((old, _)) = self.map.remove(&key) {
            self.used -= old.len() as u64;
        }
        while self.used + len > self.cap && self.evict() {}
        self.tick += 1;
        self.used += len;
        self.order.push_back((key.clone(), self.tick));
        self.map.insert(key, (bytes, self.tick));
    }

    /// Drop the least recently used entry; false when there is none.
    fn evict(&mut self) -> bool {
        while let Some((key, at)) = self.order.pop_front() {
            if self.map.get(&key).is_some_and(|(_, cur)| *cur == at) {
                if let Some((bytes, _)) = self.map.remove(&key) {
                    self.used -= bytes.len() as u64;
                }
                return true;
            }
        }
        false
    }

    #[cfg(test)]
    fn used(&self) -> u64 {
        self.used
    }
}

// ----------------------------------------------------------------- Backend

pub struct Backend {
    hosts: RwLock<Arc<Hosts>>,
    loaded: Mutex<Loaded>,
    last_check_ms: AtomicU64,
    /// Parsed manifests by path: manifests are content-addressed, so a path never changes meaning.
    manifests: Mutex<HashMap<PathBuf, Arc<Manifest>>>,
    cache: Option<Mutex<Lru>>,
    entry_cap: u64,
}

impl Backend {
    /// `None` unless `SPROUTBOAT_EDGE_BACKEND` is set.
    pub fn new(cfg: &Config) -> Option<Backend> {
        cfg.backend.as_ref()?;
        Some(Backend {
            hosts: RwLock::new(Arc::new(HashMap::new())),
            loaded: Mutex::new(Loaded::default()),
            last_check_ms: AtomicU64::new(0),
            manifests: Mutex::new(HashMap::new()),
            cache: (cfg.asset_cache_bytes > 0).then(|| Mutex::new(Lru::new(cfg.asset_cache_bytes))),
            entry_cap: cfg.asset_cache_entry_bytes,
        })
    }

    /// The entry serving `path` (raw, without query) on `host`, if any.
    pub fn assets_for(&self, host: &str, path: &str) -> Option<Arc<HostAssets>> {
        let hosts = self.hosts.read().unwrap_or_else(|e| e.into_inner()).clone();
        match_route(hosts.get(host)?, path).cloned()
    }

    async fn manifest(&self, path: &Path) -> Result<Arc<Manifest>, String> {
        if let Some(found) = lock(&self.manifests).get(path) {
            return Ok(found.clone());
        }
        let text = tokio::fs::read_to_string(path)
            .await
            .map_err(|e| e.to_string())?;
        let manifest = Arc::new(Manifest::parse_backend(&text)?);
        lock(&self.manifests).insert(path.to_path_buf(), manifest.clone());
        Ok(manifest)
    }

    /// Read the snapshot and every manifest it names. A bad manifest logs and its hostname is
    /// left out (so it is forwarded); a bad snapshot is an error and the old one stays.
    /// The `Loaded` is `None` when a manifest failed: the stamp is then not recorded, so the
    /// poll reads the snapshot again next tick and a manifest that appears later recovers its host.
    async fn read(&self, path: &Path) -> Result<(Hosts, Option<Loaded>), String> {
        let stamp = reload::stamp_of(path).await?;
        if !stamp.exists {
            return Ok((Hosts::new(), Some(Loaded::default())));
        }
        let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
        let text = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
        let mut hosts = Hosts::new();
        let mut used: Vec<PathBuf> = Vec::new();
        let mut failed = false;
        for app in parse_snapshot(text)? {
            match self.manifest(&app.manifest).await {
                Ok(manifest) => {
                    used.push(app.manifest);
                    let blobs = app.blobs;
                    let entries = hosts.entry(app.hostname).or_default();
                    // an exactly shared route keeps its first app
                    if !entries.iter().any(|(p, _)| *p == app.path) {
                        entries.push((app.path, Arc::new(HostAssets { manifest, blobs })));
                    }
                }
                Err(error) => {
                    failed = true;
                    eprintln!(
                        "asset manifest load failed for {} ({}): {error}",
                        app.hostname, app.app_id
                    );
                }
            }
        }
        // Only manifests that parsed are ever cached, and a parsed one stays while it is named.
        lock(&self.manifests).retain(|p, _| used.contains(p));
        let loaded = (!failed).then(|| reload::loaded(stamp, &bytes, now_ms()));
        Ok((hosts, loaded))
    }

    fn swap(&self, hosts: Hosts, loaded: Option<Loaded>) {
        *self.hosts.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(hosts);
        if let Some(loaded) = loaded {
            *lock(&self.loaded) = loaded;
        }
    }

    /// SIGHUP and startup: reload unconditionally; a missing file means no assets.
    pub async fn reload(&self, path: &Path) -> Result<(), String> {
        let (hosts, loaded) = self.read(path).await?;
        self.swap(hosts, loaded);
        Ok(())
    }

    /// The mtime poll (see `reload.rs`), throttled to once per 250 ms and also run per request.
    pub async fn refresh(&self, path: &Path) -> Result<(), String> {
        let now = now_ms();
        let last = self.last_check_ms.load(Ordering::Acquire);
        if now.saturating_sub(last) < 250
            || self
                .last_check_ms
                .compare_exchange(last, now, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return Ok(());
        }
        let known = *lock(&self.loaded);
        match reload::check(path, &known, now).await? {
            Check::Same => {}
            Check::Settled => {
                let mut current = lock(&self.loaded);
                if *current == known {
                    current.racy = false;
                }
            }
            Check::Reload => self.reload(path).await?,
        }
        Ok(())
    }

    fn cache_get(&self, hash: &str, enc: Enc) -> Option<Bytes> {
        let cache = self.cache.as_ref()?;
        lock(cache).get(&(hash.to_string(), enc))
    }

    fn cacheable(&self, size: u64) -> bool {
        self.cache.is_some() && size <= self.entry_cap
    }

    fn cache_put(&self, hash: &str, enc: Enc, bytes: Bytes) {
        if let Some(cache) = &self.cache {
            lock(cache).insert((hash.to_string(), enc), bytes);
        }
    }
}

// ----------------------------------------------------------------- matching

/// What a GET or HEAD for a host with assets turns into.
#[derive(Debug)]
pub enum Plan<'a> {
    Forward,
    Redirect(u16, String),
    Serve {
        key: String,
        entry: &'a AssetEntry,
        status: u16,
        /// The path `_headers` rules are matched against.
        rules_path: String,
    },
}

/// The nearest `name` (`404.html`, `index.html`) at or above the directory of `path`.
pub fn nearest(manifest: &Manifest, path: &str, name: &str) -> Option<String> {
    let mut dir = &path[..path.rfind('/').map_or(0, |i| i + 1)];
    loop {
        let key = format!("{dir}{name}");
        if manifest.files.contains_key(&key) {
            return Some(key);
        }
        if dir.len() <= 1 {
            return None;
        }
        dir = &dir[..dir[..dir.len() - 1].rfind('/').map_or(0, |i| i + 1)];
    }
}

pub fn plan<'a>(manifest: &'a Manifest, decoded: &str) -> Plan<'a> {
    if let Some((status, location)) = manifest.redirect(decoded) {
        return Plan::Redirect(status, location);
    }
    if manifest.is_sprout_first(decoded) {
        return Plan::Forward;
    }
    let (key, status, rules_path) = match manifest.resolve_key(decoded) {
        Some(key) => (key, 200, decoded.to_string()),
        None => {
            let (name, status) = match manifest.not_found {
                NotFound::Page404 => ("404.html", 404),
                NotFound::SinglePageApplication => ("index.html", 200),
                NotFound::None => return Plan::Forward,
            };
            match nearest(manifest, decoded, name) {
                Some(key) => (key.clone(), status, key),
                None => return Plan::Forward,
            }
        }
    };
    match manifest.files.get(&key) {
        Some(entry) => Plan::Serve {
            key,
            entry,
            status,
            rules_path,
        },
        None => Plan::Forward,
    }
}

/// The precompressed variant to send: `br` over `gzip`, only for a coding the client lists with
/// q > 0, and never for a ranged request.
pub fn select_encoding(entry: &AssetEntry, accept: Option<&str>, ranged: bool) -> Enc {
    let accepted = |name: &str| {
        accept.is_some_and(|h| {
            h.split(',').any(|item| {
                let mut parts = item.split(';');
                if !parts.next().unwrap_or("").trim().eq_ignore_ascii_case(name) {
                    return false;
                }
                parts.all(|p| match p.trim().split_once('=') {
                    Some((k, v)) if k.trim().eq_ignore_ascii_case("q") => {
                        v.trim().parse::<f64>().is_ok_and(|q| q > 0.0)
                    }
                    _ => true,
                })
            })
        })
    };
    if ranged {
        Enc::Identity
    } else if entry.br.is_some() && accepted("br") {
        Enc::Br
    } else if entry.gz.is_some() && accepted("gzip") {
        Enc::Gz
    } else {
        Enc::Identity
    }
}

/// `If-None-Match` as a list; weak validators match, `*` matches anything.
pub fn etag_matches(header: &str, etag: &str) -> bool {
    header.split(',').any(|item| {
        let item = item.trim();
        item == "*" || item.strip_prefix("W/").unwrap_or(item) == etag
    })
}

/// `<blobs>/<hash>`, for a hash that is a plain file name.
fn blob_path(blobs: &Path, hash: &str) -> Option<PathBuf> {
    let plain = !hash.is_empty()
        && hash.len() <= 128
        && hash
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    plain.then(|| blobs.join(hash))
}

// ------------------------------------------------------------------ handler

/// A request in backend mode, after the checks every mode shares.
pub async fn handle(
    c: ReqCtx,
    ctl: &IdleControl,
    req: Request<Incoming>,
    pathname: String,
    search: String,
) -> Response<RBody> {
    let app = c.app.clone();
    let method = req.method().clone();
    let assets = match &app.backend {
        Some(b)
            if (method == Method::GET || method == Method::HEAD)
                && !is_websocket_upgrade(&method, req.headers()) =>
        {
            b.assets_for(&c.host, &pathname)
        }
        _ => None,
    };
    if let (Some(assets), Some(backend)) = (assets, &app.backend) {
        let Some(decoded) = decode_uri_component(&pathname) else {
            return reject(
                &app,
                c.started,
                &req,
                c.path.clone(),
                400,
                "bad request",
                "bad-request",
                false,
            );
        };
        match plan(&assets.manifest, &decoded) {
            Plan::Forward => {}
            Plan::Redirect(status, location) => {
                c.log(
                    c.event(status, c.elapsed())
                        .num("reqBytes", c.req_bytes)
                        .int("resBytes", 0)
                        .str("cacheStatus", "asset"),
                );
                return redirect_response(status, &location);
            }
            Plan::Serve {
                key,
                entry,
                status,
                rules_path,
            } => {
                return serve(
                    &c,
                    req.headers(),
                    backend,
                    &assets,
                    (&key, entry, status, &rules_path),
                )
                .await;
            }
        }
    }
    forward_to_backend(c, ctl, req, &pathname, &search).await
}

/// Answer from an asset: validators, headers, a variant or a range, and the bytes.
async fn serve(
    c: &ReqCtx,
    headers: &hyper::HeaderMap,
    backend: &Backend,
    assets: &HostAssets,
    (key, entry, status, rules_path): (&str, &AssetEntry, u16, &str),
) -> Response<RBody> {
    let log_asset = |status: u16, sent: u64| {
        c.log(
            c.event(status, c.elapsed())
                .num("reqBytes", c.req_bytes)
                .int("resBytes", sent)
                .str("cacheStatus", "asset"),
        );
    };
    let range_header = header_joined(headers, "range");
    let accept = header_joined(headers, "accept-encoding");
    let mut enc = select_encoding(entry, accept.as_deref(), range_header.is_some());
    let variant_hash = |enc: Enc| match enc {
        Enc::Identity => Some(entry.hash.as_str()),
        Enc::Br => entry.br.as_ref().map(|v| v.hash.as_str()),
        Enc::Gz => entry.gz.as_ref().map(|v| v.hash.as_str()),
    };
    // A variant named by the manifest but absent from disk: serve the identity bytes instead.
    if enc != Enc::Identity {
        let vh = variant_hash(enc).unwrap_or("");
        let present = backend.cache_get(vh, enc).is_some()
            || blob_path(&assets.blobs, vh)
                .and_then(|p| std::fs::metadata(p).ok())
                .is_some_and(|m| m.is_file());
        if !present {
            c.log(
                c.event(200, c.elapsed())
                    .num("reqBytes", c.req_bytes)
                    .str("error", "asset variant file missing")
                    .str("errorKind", "asset-variant-missing")
                    .str("hash", vh),
            );
            enc = Enc::Identity;
        }
    }
    let (hash, suffix, coding) = match enc {
        Enc::Identity => (entry.hash.as_str(), "", None),
        Enc::Br => (
            entry.br.as_ref().map_or("", |v| v.hash.as_str()),
            "-br",
            Some("br"),
        ),
        Enc::Gz => (
            entry.gz.as_ref().map_or("", |v| v.hash.as_str()),
            "-gz",
            Some("gzip"),
        ),
    };
    let etag = format!("\"{}{suffix}\"", entry.hash);
    let cache_control = cache_control_backend(key, &entry.content_type);
    let varies = entry.br.is_some() || entry.gz.is_some();

    // Validators only mean something for the page itself, not for a 404 stand-in.
    if status == 200
        && header_joined(headers, "if-none-match").is_some_and(|h| etag_matches(&h, &etag))
    {
        log_asset(304, 0);
        let mut res = Response::new(empty());
        *res.status_mut() = StatusCode::NOT_MODIFIED;
        let h = res.headers_mut();
        put_header(h, "etag", &etag);
        put_header(h, "cache-control", cache_control);
        if varies {
            put_header(h, "vary", "accept-encoding");
        }
        return res;
    }

    let missing = || {
        c.log(
            c.event(500, c.elapsed())
                .num("reqBytes", c.req_bytes)
                .str("error", "asset file missing")
                .str("errorKind", "asset-missing")
                .str("hash", hash),
        );
        text(500, "asset missing")
    };
    let head = c.method == Method::HEAD;
    let path = blob_path(&assets.blobs, hash);
    // The blob itself decides the length served (the manifest size is not trusted).
    let mut cached = backend.cache_get(hash, enc);
    let mut size = cached.as_ref().map(|b| b.len() as u64);
    if size.is_none() {
        let Some(p) = &path else { return missing() };
        let Some(len) = std::fs::metadata(p)
            .ok()
            .filter(|m| m.is_file())
            .map(|m| m.len())
        else {
            return missing();
        };
        if !head && backend.cacheable(len) {
            let read = if len <= SMALL_ASSET_BYTES {
                read_small(p, 0, len)
            } else {
                tokio::fs::read(p).await
            };
            let Ok(bytes) = read else {
                return missing();
            };
            let bytes = Bytes::from(bytes);
            backend.cache_put(hash, enc, bytes.clone());
            size = Some(bytes.len() as u64);
            cached = Some(bytes);
        } else {
            size = Some(len);
        }
    }
    let size = size.unwrap_or(0);

    let mut res = Response::new(empty());
    let h = res.headers_mut();
    put_header(h, "content-type", &entry.content_type);
    put_header(h, "etag", &etag);
    put_header(h, "cache-control", cache_control);
    if let Some(coding) = coding {
        put_header(h, "content-encoding", coding);
    }
    if varies {
        put_header(h, "vary", "accept-encoding");
    }
    if entry.content_type == "application/octet-stream" {
        let name = key.rsplit('/').next().unwrap_or("");
        put_header(h, "content-disposition", &format!("filename=\"{name}\""));
    }
    apply_header_rules(h, &assets.manifest.headers, rules_path, true);
    if varies {
        // A rule may have replaced or dropped it: a cache must still key on the encoding.
        let current = h
            .get_all("vary")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .collect::<Vec<_>>()
            .join(", ");
        let listed = current.split(',').any(|t| {
            let t = t.trim();
            t == "*" || t.eq_ignore_ascii_case("accept-encoding")
        });
        if !listed {
            let value = if current.is_empty() {
                "accept-encoding".to_string()
            } else {
                format!("{current}, accept-encoding")
            };
            put_header(h, "vary", &value);
        }
    }

    let range = if status == 200 {
        parse_range(range_header.as_deref(), size)
    } else {
        ByteRange::Full
    };
    let (mut status, mut start, mut length) = (status, 0u64, size);
    match range {
        ByteRange::Partial(s, e) => {
            (status, start, length) = (206, s, e - s + 1);
            put_header(h, "content-range", &format!("bytes {s}-{e}/{size}"));
            put_header(h, "accept-ranges", "bytes");
        }
        ByteRange::Unsatisfiable => {
            (status, length) = (416, 0);
            put_header(h, "content-range", &format!("bytes */{size}"));
            put_header(h, "accept-ranges", "bytes");
        }
        ByteRange::Full => {
            if status == 200 && enc == Enc::Identity {
                put_header(h, "accept-ranges", "bytes");
            }
        }
    }
    put_header(h, "content-length", &length.to_string());
    *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    if head || length == 0 {
        log_asset(status, length);
        return res;
    }
    if let Some(bytes) = cached {
        let end = (start + length).min(bytes.len() as u64) as usize;
        let body = bytes.slice((start as usize).min(end)..end);
        log_asset(status, body.len() as u64);
        *res.body_mut() = full(body);
        return res;
    }
    let Some(p) = path else { return missing() };
    if length <= SMALL_ASSET_BYTES {
        let Ok(bytes) = read_small(&p, start, length) else {
            return missing();
        };
        log_asset(status, bytes.len() as u64);
        *res.body_mut() = full(bytes);
        return res;
    }
    let Ok(mut file) = tokio::fs::File::open(&p).await else {
        return missing();
    };
    if start > 0 {
        use tokio::io::AsyncSeekExt;
        let _ = file.seek(std::io::SeekFrom::Start(start)).await;
    }
    log_asset(status, length);
    *res.body_mut() = file_body(file, length);
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::App;
    use crate::logs::LogSink;
    use crate::routes::Routes;
    use http_body_util::{BodyExt, Full};
    use hyper::server::conn::http1;
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;
    use std::net::SocketAddr;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    fn manifest(text: &str) -> Manifest {
        Manifest::parse_backend(text).unwrap()
    }

    fn files(keys: &[&str]) -> String {
        let one = |k: &&str| format!(r#""{k}":{{"hash":"h","size":1,"type":"text/html"}}"#);
        keys.iter().map(one).collect::<Vec<_>>().join(",")
    }

    #[test]
    fn snapshot_shape() {
        let text = r#"{"version":1,"apps":[{"hostname":"Sproutboat.COM","app_id":"a_1","manifest":"/m/x.json","blobs":"/b"}]}"#;
        let apps = parse_snapshot(text).unwrap();
        assert_eq!(
            apps,
            [SnapshotApp {
                hostname: "sproutboat.com".into(),
                path: None,
                app_id: "a_1".into(),
                manifest: "/m/x.json".into(),
                blobs: "/b".into()
            }]
        );
        assert!(parse_snapshot(r#"{"version":1,"apps":[]}"#)
            .unwrap()
            .is_empty());
        assert!(parse_snapshot(r#"{"version":1}"#).unwrap().is_empty());
        assert!(parse_snapshot(r#"{"version":2,"apps":[]}"#).is_err());
        assert!(parse_snapshot(r#"[]"#).is_err());
        assert!(parse_snapshot(
            r#"{"version":1,"apps":[{"hostname":"","manifest":"m","blobs":"b"}]}"#
        )
        .is_err());
        assert!(parse_snapshot(r#"{"version":1,"apps":[{"hostname":"a"}]}"#).is_err());
    }

    #[test]
    fn snapshot_paths() {
        let entry = |path: &str| {
            format!(r#"{{"hostname":"H.test","app_id":"a","manifest":"m","blobs":"b"{path}}}"#)
        };
        let one = |path: &str| {
            parse_snapshot(&format!(
                r#"{{"version":1,"apps":[{}]}}"#,
                entry(&format!(r#","path":"{path}""#))
            ))
            .unwrap()
        };
        // valid: kept as written (case-sensitive), absent = bare
        assert_eq!(one("/docs")[0].path.as_deref(), Some("/docs"));
        assert_eq!(
            one("/Docs/a.b_c~d-e%2F")[0].path.as_deref(),
            Some("/Docs/a.b_c~d-e%2F")
        );
        let bare = parse_snapshot(&format!(r#"{{"version":1,"apps":[{}]}}"#, entry(""))).unwrap();
        assert_eq!(
            (bare[0].hostname.as_str(), bare[0].path.clone()),
            ("h.test", None)
        );
        // invalid: logged and skipped, the other entries stay
        for bad in [
            "",
            "/",
            "docs",
            "/docs/",
            "//x",
            "/a//b",
            "/./x",
            "/../x",
            "/a b",
            "/a?b",
            "/%zz",
            "/%2",
            "/%",
            "/a/b/c/d/e/f/g/h/i",
            "/é",
        ] {
            assert!(one(bad).is_empty(), "{bad:?} should be skipped");
        }
        assert_eq!(one("/a/b/c/d/e/f/g/h").len(), 1);
        assert!(one(&format!("/{}", "a".repeat(200))).is_empty());
        assert_eq!(one(&format!("/{}", "a".repeat(199))).len(), 1);
        let mixed = parse_snapshot(&format!(
            r#"{{"version":1,"apps":[{},{},{}]}}"#,
            entry(r#","path":"/ok""#),
            entry(r#","path":"/bad/""#),
            entry("")
        ))
        .unwrap();
        let paths: Vec<_> = mixed.iter().map(|a| a.path.as_deref()).collect();
        assert_eq!(paths, [Some("/ok"), None]);
    }

    #[test]
    fn longest_prefix_matching() {
        let table = |names: &[Option<&str>]| -> Vec<(Option<String>, String)> {
            names
                .iter()
                .map(|p| (p.map(String::from), p.unwrap_or("bare").to_string()))
                .collect()
        };
        let full = table(&[Some("/docs/api"), None, Some("/docs")]);
        let at = |path: &str| match_route(&full, path).map(String::as_str);
        assert_eq!(at("/"), Some("bare"));
        assert_eq!(at("/x"), Some("bare"));
        assert_eq!(at("/docs"), Some("/docs"));
        assert_eq!(at("/docs/"), Some("/docs"));
        assert_eq!(at("/docs/a"), Some("/docs"));
        assert_eq!(at("/docs/api"), Some("/docs/api"));
        assert_eq!(at("/docs/api/x"), Some("/docs/api"));
        assert_eq!(at("/docs/apix"), Some("/docs"));
        assert_eq!(at("/docsx"), Some("bare"));
        assert_eq!(at("/doc"), Some("bare"));
        assert_eq!(at("/Docs"), Some("bare"));
        assert_eq!(at("/x/docs"), Some("bare"));
        // not decoded
        assert_eq!(at("/%64ocs"), Some("bare"));
        let no_bare = table(&[Some("/docs"), Some("/docs/api")]);
        assert_eq!(match_route(&no_bare, "/x"), None);
        assert_eq!(match_route(&no_bare, "/"), None);
        assert_eq!(match_route(&no_bare, "/docsx"), None);
        assert_eq!(
            match_route(&no_bare, "/docs/x").map(String::as_str),
            Some("/docs")
        );
    }

    #[test]
    fn lru_evicts_the_least_recently_used() {
        let key = |n: &str| (n.to_string(), Enc::Identity);
        let mut lru = Lru::new(10);
        lru.insert(key("a"), Bytes::from_static(b"1234"));
        lru.insert(key("b"), Bytes::from_static(b"1234"));
        assert!(lru.get(&key("a")).is_some()); // a is now newer than b
        lru.insert(key("c"), Bytes::from_static(b"1234")); // 12 > 10: b goes
        assert!(lru.get(&key("b")).is_none());
        assert!(lru.get(&key("a")).is_some() && lru.get(&key("c")).is_some());
        assert_eq!(lru.used(), 8);
        // the encoding is part of the key
        assert!(lru.get(&("a".to_string(), Enc::Br)).is_none());
        // a blob larger than the whole cache is not kept; replacing keeps the count right
        lru.insert(key("big"), Bytes::from(vec![0; 11]));
        assert!(lru.get(&key("big")).is_none());
        lru.insert(key("a"), Bytes::from_static(b"12"));
        assert_eq!(lru.used(), 6);
        // hot reads do not grow the order list without bound
        for _ in 0..1000 {
            lru.get(&key("a"));
        }
        assert!(lru.order.len() < 100);
        // a zero-sized cache keeps nothing
        let mut off = Lru::new(0);
        off.insert(key("a"), Bytes::from_static(b"1"));
        assert!(off.get(&key("a")).is_none());
    }

    #[test]
    fn if_none_match_lists_and_weak_tags() {
        let tag = "\"abc\"";
        assert!(etag_matches("\"abc\"", tag));
        assert!(etag_matches("W/\"abc\"", tag));
        assert!(etag_matches("\"x\", \"abc\"", tag));
        assert!(etag_matches("\"x\" ,W/\"abc\" , \"y\"", tag));
        assert!(etag_matches("*", tag));
        assert!(!etag_matches("\"abcd\"", tag));
        assert!(!etag_matches("\"abc-br\"", tag));
        assert!(!etag_matches("", tag));
    }

    #[test]
    fn nearest_page_walks_up_the_directories() {
        let m = manifest(&format!(
            r#"{{"notFound":"404-page","runSproutFirst":false,"files":{{{}}}}}"#,
            files(&[
                "/404.html",
                "/ikada/404.html",
                "/docs/index.html",
                "/index.html"
            ])
        ));
        let near = |p: &str, n: &str| nearest(&m, p, n);
        assert_eq!(
            near("/ikada/x", "404.html").as_deref(),
            Some("/ikada/404.html")
        );
        assert_eq!(
            near("/ikada/a/b/c", "404.html").as_deref(),
            Some("/ikada/404.html")
        );
        assert_eq!(
            near("/ikada/a/", "404.html").as_deref(),
            Some("/ikada/404.html")
        );
        assert_eq!(near("/other/x", "404.html").as_deref(), Some("/404.html"));
        assert_eq!(near("/x", "404.html").as_deref(), Some("/404.html"));
        assert_eq!(
            near("/docs/a/b", "index.html").as_deref(),
            Some("/docs/index.html")
        );
        assert_eq!(
            near("/elsewhere/a", "index.html").as_deref(),
            Some("/index.html")
        );
        assert_eq!(
            near("/ikada/x", "index.html").as_deref(),
            Some("/index.html")
        );
        let bare = manifest(r#"{"notFound":"404-page","runSproutFirst":false,"files":{}}"#);
        assert_eq!(nearest(&bare, "/a/b", "404.html"), None);
    }

    #[test]
    fn plans_follow_the_manifest() {
        let with = |nf: &str| {
            manifest(&format!(
                r#"{{"notFound":"{nf}","runSproutFirst":["/api/**","/"],"redirects":[{{"from":"/old","to":"/new","status":301}}],"files":{{{}}}}}"#,
                files(&["/index.html", "/404.html", "/a.html"])
            ))
        };
        let m = with("404-page");
        assert!(matches!(plan(&m, "/old"), Plan::Redirect(301, l) if l == "/new"));
        assert!(matches!(plan(&m, "/api/x"), Plan::Forward));
        assert!(matches!(plan(&m, "/"), Plan::Forward)); // sprout first, though / resolves
        assert!(
            matches!(plan(&m, "/a"), Plan::Serve { status: 200, ref key, .. } if key == "/a.html")
        );
        assert!(
            matches!(plan(&m, "/nope"), Plan::Serve { status: 404, ref key, .. } if key == "/404.html")
        );
        let m = with("single-page-application");
        assert!(
            matches!(plan(&m, "/nope"), Plan::Serve { status: 200, ref key, .. } if key == "/index.html")
        );
        assert!(matches!(plan(&with("none"), "/nope"), Plan::Forward));
    }

    fn entry(br: bool, gz: bool) -> AssetEntry {
        let v = |h: &str| format!(r#"{{"hash":"{h}","size":1}}"#);
        let mut json = String::from(r#"{"hash":"h","size":9,"type":"text/html""#);
        if br {
            json += &format!(r#","br":{}"#, v("b"));
        }
        if gz {
            json += &format!(r#","gz":{}"#, v("g"));
        }
        serde_json::from_str(&(json + "}")).unwrap()
    }

    #[test]
    fn encoding_selection() {
        let both = entry(true, true);
        let pick = |e: &AssetEntry, ae: Option<&str>| select_encoding(e, ae, false);
        assert_eq!(pick(&both, Some("gzip, deflate, br")), Enc::Br);
        assert_eq!(pick(&both, Some("gzip")), Enc::Gz);
        assert_eq!(pick(&both, Some("br;q=0, gzip;q=0.5")), Enc::Gz);
        assert_eq!(pick(&both, Some("br;q=0, gzip;q=0")), Enc::Identity);
        assert_eq!(pick(&both, Some("BR")), Enc::Br);
        assert_eq!(pick(&both, Some("identity")), Enc::Identity);
        assert_eq!(pick(&both, Some("br;q=bad")), Enc::Identity);
        assert_eq!(pick(&both, None), Enc::Identity);
        assert_eq!(pick(&entry(false, true), Some("br, gzip")), Enc::Gz);
        assert_eq!(pick(&entry(true, false), Some("gzip")), Enc::Identity);
        assert_eq!(pick(&entry(false, false), Some("br, gzip")), Enc::Identity);
        assert_eq!(
            select_encoding(&both, Some("br, gzip"), true),
            Enc::Identity
        );
    }

    // ---- the whole path: a real backend, a snapshot on disk, the edge's own service

    struct Reply {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Reply {
        fn h(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(n, _)| n.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.body).into_owned()
        }
    }

    /// One request over a fresh connection, the way a proxy in front would send it.
    async fn send(
        edge: SocketAddr,
        method: &str,
        path: &str,
        host: &str,
        extra: &[(&str, &str)],
        body: &str,
    ) -> Reply {
        let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
        for (n, v) in extra {
            req += &format!("{n}: {v}\r\n");
        }
        if !body.is_empty() {
            req += &format!("Content-Length: {}\r\n", body.len());
        }
        req += "\r\n";
        req += body;
        let mut stream = TcpStream::connect(edge).await.unwrap();
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&raw[..split]).into_owned();
        let mut lines = head.split("\r\n");
        let status = lines
            .next()
            .unwrap()
            .split(' ')
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let headers = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(n, v)| (n.trim().to_string(), v.trim().to_string()))
            .collect();
        Reply {
            status,
            headers,
            body: raw[split + 4..].to_vec(),
        }
    }

    /// A backend that answers with what it was sent.
    async fn echo_backend() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let service = service_fn(|req: Request<Incoming>| async move {
                        let (parts, body) = req.into_parts();
                        let body = body
                            .collect()
                            .await
                            .map(|b| b.to_bytes())
                            .unwrap_or_default();
                        let names: Vec<&str> = parts.headers.keys().map(|n| n.as_str()).collect();
                        let said = format!(
                            "backend {} {} host={} body={} headers={}",
                            parts.method,
                            parts.uri,
                            parts
                                .headers
                                .get("host")
                                .and_then(|h| h.to_str().ok())
                                .unwrap_or(""),
                            String::from_utf8_lossy(&body),
                            names.join(",")
                        );
                        Ok::<_, std::convert::Infallible>(
                            Response::builder()
                                .header("x-backend", "1")
                                .body(Full::new(Bytes::from(said)))
                                .unwrap_or_default(),
                        )
                    });
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        addr
    }

    struct Edge {
        addr: SocketAddr,
        app: Arc<App>,
        dir: tempfile::TempDir,
    }

    const HTML: &str = "text/html; charset=utf-8";

    fn put_blob(dir: &Path, name: &str, bytes: &[u8]) {
        std::fs::write(dir.join("blobs").join(name), bytes).unwrap();
    }

    async fn start_edge(backend: SocketAddr, extra_env: &[(&str, String)]) -> Edge {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("blobs")).unwrap();
        std::fs::create_dir_all(root.join("manifests")).unwrap();
        put_blob(root, "idx00001", b"<h1>home</h1>");
        put_blob(root, "idxbr001", b"BR-bytes");
        put_blob(root, "idxgz001", b"GZ-bytes");
        put_blob(root, "data0001", b"0123456789");
        put_blob(root, "js000001", b"console.log(1)");
        put_blob(root, "ikadaidx", b"ikada home");
        put_blob(root, "ikada404", b"ikada missing");
        put_blob(root, "root0404", b"root missing");
        put_blob(root, "docsidx1", b"docs index");
        put_blob(root, "pathroot", b"path root app");
        put_blob(root, "pathdocs", b"path docs app");
        put_blob(root, "docs0404", b"docs missing");
        put_blob(root, "rul00001", b"rules identity");
        put_blob(root, "rulbr001", b"RULES-BR");
        put_blob(root, "novar001", b"no variant on disk");
        std::fs::write(root.join("blobs/big00001"), vec![7u8; 300_000]).unwrap();
        let file = |hash: &str, ty: &str, more: &str| {
            format!(r#"{{"hash":"{hash}","size":1,"type":"{ty}"{more}}}"#)
        };
        let main = format!(
            r#"{{"notFound":"404-page","runSproutFirst":["/api/**"],
            "files":{{
              "/index.html":{},
              "/data.txt":{},
              "/_astro/app.a1b2c3d4.js":{},
              "/ikada/index.html":{},
              "/ikada/404.html":{},
              "/404.html":{},
              "/big.bin":{},
              "/ghost.txt":{},
              "/rules.html":{},
              "/novar.html":{}
            }},
            "headers":[{{"pattern":"/data.txt","set":[["x-custom","yes"]],"unset":[]}},
              {{"pattern":"/rules.html","set":[["Vary","Origin"],["Content-Encoding","gzip"],["x-rule","1"]],"unset":[]}},
              {{"pattern":"/rules.html","set":[],"unset":["Content-Encoding"]}}],
            "redirects":[{{"from":"/old","to":"/data.txt","status":301}}]}}"#,
            file(
                "idx00001",
                HTML,
                r#","br":{"hash":"idxbr001","size":8},"gz":{"hash":"idxgz001","size":8}"#
            ),
            file("data0001", "text/plain; charset=utf-8", ""),
            file("js000001", "text/javascript", ""),
            file("ikadaidx", HTML, ""),
            file("ikada404", HTML, ""),
            file("root0404", HTML, ""),
            file("big00001", "application/octet-stream", ""),
            file("ghost001", "text/plain", ""),
            file("rul00001", HTML, r#","br":{"hash":"rulbr001","size":8}"#),
            file("novar001", HTML, r#","br":{"hash":"nobr00001","size":8}"#),
        );
        let spa = format!(
            r#"{{"notFound":"single-page-application","runSproutFirst":false,"files":{{"/index.html":{},"/docs/index.html":{}}}}}"#,
            file("idx00001", HTML, ""),
            file("docsidx1", HTML, ""),
        );
        let none = format!(
            r#"{{"notFound":"none","runSproutFirst":false,"files":{{"/index.html":{}}}}}"#,
            file("idx00001", HTML, ""),
        );
        let path_root = format!(
            r#"{{"notFound":"404-page","runSproutFirst":false,"files":{{"/other":{},"/404.html":{},"/docsx":{}}}}}"#,
            file("pathroot", HTML, ""),
            file("root0404", HTML, ""),
            file("pathroot", HTML, ""),
        );
        let path_docs = format!(
            r#"{{"notFound":"404-page","runSproutFirst":false,"files":{{"/docs/x":{},"/docs/404.html":{}}}}}"#,
            file("pathdocs", HTML, ""),
            file("docs0404", HTML, ""),
        );
        let m = |n: &str| root.join("manifests").join(n).display().to_string();
        std::fs::write(m("path-root.json"), path_root).unwrap();
        std::fs::write(m("path-docs.json"), path_docs).unwrap();
        std::fs::write(m("main.json"), main).unwrap();
        std::fs::write(m("spa.json"), spa).unwrap();
        std::fs::write(m("none.json"), none).unwrap();
        std::fs::write(m("bad.json"), "{not json").unwrap();
        let blobs = root.join("blobs").display().to_string();
        let app_entry = |host: &str, manifest: String| {
            format!(
                r#"{{"hostname":"{host}","app_id":"{host}_1","manifest":"{manifest}","blobs":"{blobs}"}}"#
            )
        };
        let path_entry = |path: &str, manifest: String| {
            format!(
                r#"{{"hostname":"paths.test","path":"{path}","app_id":"p{path}","manifest":"{manifest}","blobs":"{blobs}"}}"#
            )
        };
        let snapshot = format!(
            r#"{{"version":1,"apps":[{},{},{},{},{},{},{}]}}"#,
            app_entry("main.test", m("main.json")),
            app_entry("spa.test", m("spa.json")),
            app_entry("none.test", m("none.json")),
            app_entry("bad.test", m("bad.json")),
            app_entry("gone.test", m("nothing.json")),
            app_entry("paths.test", m("path-root.json")),
            path_entry("/docs", m("path-docs.json")),
        );
        let routes = root.join("routes.json");
        std::fs::write(&routes, snapshot).unwrap();
        let mut env: HashMap<String, String> = HashMap::from([
            ("PORT".into(), "0".into()),
            (
                "SPROUTBOAT_EDGE_BACKEND".into(),
                format!("http://{backend}"),
            ),
            (
                "SPROUTBOAT_ROUTE_SNAPSHOT".into(),
                routes.display().to_string(),
            ),
            ("SPROUTBOAT_ASSET_CACHE_ENTRY_BYTES".into(), "2048".into()),
        ]);
        env.extend(extra_env.iter().map(|(k, v)| (k.to_string(), v.clone())));
        let cfg = Config::from_lookup(|n| env.get(n).cloned()).unwrap();
        let app = App::new(
            cfg,
            Routes::default(),
            Loaded::default(),
            LogSink::disabled(),
        );
        app.reload_routes().await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(crate::server::serve(app.clone(), listener));
        Edge { addr, app, dir }
    }

    #[tokio::test]
    async fn backend_mode_end_to_end() {
        let backend = echo_backend().await;
        let edge = start_edge(backend, &[]).await;
        let get = |host: &'static str,
                   path: &'static str,
                   extra: &'static [(&'static str, &'static str)]| {
            send(edge.addr, "GET", path, host, extra, "")
        };

        // a hit: validators, cache policy, content type verbatim, variants advertised
        let r = get("main.test", "/", &[]).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.text(), "<h1>home</h1>");
        assert_eq!(r.h("etag"), Some("\"idx00001\""));
        assert_eq!(
            r.h("cache-control"),
            Some("public, max-age=0, must-revalidate")
        );
        assert_eq!(r.h("content-type"), Some(HTML));
        assert_eq!(r.h("content-length"), Some("13"));
        assert_eq!(r.h("vary"), Some("accept-encoding"));
        assert_eq!(r.h("accept-ranges"), Some("bytes"));
        assert_eq!(r.h("content-encoding"), None);
        assert_eq!(r.h("last-modified"), None);
        assert!(edge
            .app
            .backend
            .as_ref()
            .unwrap()
            .cache_get("idx00001", Enc::Identity)
            .is_some());
        // it now comes from memory
        std::fs::remove_file(edge.dir.path().join("blobs/idx00001")).unwrap();
        assert_eq!(
            get("main.test", "/index.html", &[]).await.text(),
            "<h1>home</h1>"
        );

        // _headers and fingerprinted names
        let r = get("main.test", "/data.txt", &[]).await;
        assert_eq!(
            (r.h("x-custom"), r.h("cache-control")),
            (Some("yes"), Some("public, max-age=86400"))
        );
        assert_eq!(r.h("vary"), None);
        let r = get("main.test", "/_astro/app.a1b2c3d4.js", &[]).await;
        assert_eq!(
            r.h("cache-control"),
            Some("public, max-age=31536000, immutable")
        );
        let r = get("main.test", "/old", &[]).await;
        assert_eq!((r.status, r.h("location")), (301, Some("/data.txt")));

        // conditional requests: exact, list, weak, star; vary and policy ride on the 304
        for inm in [
            "\"idx00001\"",
            "\"nope\", \"idx00001\"",
            "W/\"idx00001\"",
            "*",
        ] {
            let r = send(
                edge.addr,
                "GET",
                "/",
                "main.test",
                &[("If-None-Match", inm)],
                "",
            )
            .await;
            assert_eq!(r.status, 304, "{inm}");
            assert!(r.body.is_empty());
            assert_eq!(r.h("etag"), Some("\"idx00001\""));
            assert_eq!(r.h("vary"), Some("accept-encoding"));
            assert_eq!(
                r.h("cache-control"),
                Some("public, max-age=0, must-revalidate")
            );
        }
        let r = get("main.test", "/", &[("If-None-Match", "\"other\"")]).await;
        assert_eq!(r.status, 200);

        // ranges
        let r = get("main.test", "/data.txt", &[("Range", "bytes=2-4")]).await;
        assert_eq!((r.status, r.text()), (206, "234".to_string()));
        assert_eq!(r.h("content-range"), Some("bytes 2-4/10"));
        assert_eq!(r.h("content-length"), Some("3"));
        let r = get("main.test", "/data.txt", &[("Range", "bytes=20-")]).await;
        assert_eq!(r.status, 416);
        assert_eq!(r.h("content-range"), Some("bytes */10"));
        let r = get("main.test", "/data.txt", &[("Range", "bytes=0-1,4-5")]).await;
        assert_eq!((r.status, r.body.len()), (200, 10));

        // precompressed variants; a ranged request gets the identity bytes
        let r = get("main.test", "/", &[("Accept-Encoding", "gzip, br")]).await;
        assert_eq!(
            (r.text(), r.h("content-encoding")),
            ("BR-bytes".to_string(), Some("br"))
        );
        assert_eq!(r.h("etag"), Some("\"idx00001-br\""));
        assert_eq!(r.h("vary"), Some("accept-encoding"));
        assert_eq!(r.h("content-length"), Some("8"));
        assert_eq!(r.h("accept-ranges"), None);
        let r = get("main.test", "/", &[("Accept-Encoding", "gzip;q=0.8")]).await;
        assert_eq!(
            (r.text(), r.h("content-encoding")),
            ("GZ-bytes".to_string(), Some("gzip"))
        );
        assert_eq!(r.h("etag"), Some("\"idx00001-gz\""));
        let r = get("main.test", "/", &[("Accept-Encoding", "br;q=0, gzip;q=0")]).await;
        assert_eq!(
            (r.status, r.h("content-encoding"), r.h("vary")),
            (200, None, Some("accept-encoding"))
        );
        let r = get(
            "main.test",
            "/",
            &[("Accept-Encoding", "br"), ("Range", "bytes=0-3")],
        )
        .await;
        assert_eq!((r.status, r.text()), (206, "<h1>".to_string()));
        assert_eq!(r.h("content-encoding"), None);
        let r = get(
            "main.test",
            "/",
            &[
                ("Accept-Encoding", "br"),
                ("If-None-Match", "\"idx00001-br\""),
            ],
        )
        .await;
        assert_eq!((r.status, r.h("vary")), (304, Some("accept-encoding")));

        // HEAD: headers only, with the length
        let r = send(edge.addr, "HEAD", "/", "main.test", &[], "").await;
        assert_eq!(
            (r.status, r.h("content-length"), r.body.len()),
            (200, Some("13"), 0)
        );

        // misses: nearest 404.html with 404; SPA fallback; none forwards
        let r = get("main.test", "/ikada/nope/deeper", &[]).await;
        assert_eq!((r.status, r.text()), (404, "ikada missing".to_string()));
        assert_eq!(r.h("content-type"), Some(HTML));
        let r = get("main.test", "/elsewhere", &[]).await;
        assert_eq!((r.status, r.text()), (404, "root missing".to_string()));
        let r = get("main.test", "/ikada/nope", &[("If-None-Match", "*")]).await;
        assert_eq!(r.status, 404); // a stand-in page is never a 304
        let r = get("spa.test", "/docs/a/b", &[]).await;
        assert_eq!((r.status, r.text()), (200, "docs index".to_string()));
        let r = get("spa.test", "/anything", &[]).await;
        assert_eq!((r.status, r.text()), (200, "<h1>home</h1>".to_string()));
        let r = get("none.test", "/nope", &[]).await;
        assert!(
            r.text().starts_with("backend GET /nope host=none.test"),
            "{}",
            r.text()
        );
        assert_eq!(r.h("x-backend"), Some("1"));

        // a big blob streams from disk, whole and ranged
        let r = get("main.test", "/big.bin", &[]).await;
        assert_eq!((r.status, r.body.len()), (200, 300_000));
        assert_eq!(r.h("content-disposition"), Some("filename=\"big.bin\""));
        let r = get("main.test", "/big.bin", &[("Range", "bytes=299990-")]).await;
        assert_eq!((r.status, r.body.len()), (206, 10));
        assert!(edge
            .app
            .backend
            .as_ref()
            .unwrap()
            .cache_get("big00001", Enc::Identity)
            .is_none());

        // _headers cannot replace the encoding or the Vary of a precompressed response
        let r = get("main.test", "/rules.html", &[("Accept-Encoding", "br")]).await;
        assert_eq!(
            (r.text(), r.h("content-encoding")),
            ("RULES-BR".to_string(), Some("br"))
        );
        assert_eq!(
            (r.h("vary"), r.h("x-rule")),
            (Some("Origin, accept-encoding"), Some("1"))
        );
        let r = get("main.test", "/rules.html", &[]).await;
        assert_eq!(
            (r.text(), r.h("content-encoding")),
            ("rules identity".to_string(), None)
        );
        assert_eq!(r.h("vary"), Some("Origin, accept-encoding"));

        // a variant named by the manifest but missing on disk falls back to the identity bytes
        let r = get("main.test", "/novar.html", &[("Accept-Encoding", "br")]).await;
        assert_eq!(
            (r.status, r.text()),
            (200, "no variant on disk".to_string())
        );
        assert_eq!(
            (r.h("content-encoding"), r.h("vary")),
            (None, Some("accept-encoding"))
        );
        assert_eq!(r.h("etag"), Some("\"novar001\""));

        // a blob that is not on disk
        let r = get("main.test", "/ghost.txt", &[]).await;
        assert_eq!((r.status, r.text()), (500, "asset missing".to_string()));

        // path routes: two manifests on one host, the longest prefix picks the manifest
        let r = get("paths.test", "/docs/x", &[]).await;
        assert_eq!((r.status, r.text()), (200, "path docs app".to_string()));
        let r = get("paths.test", "/other", &[]).await;
        assert_eq!((r.status, r.text()), (200, "path root app".to_string()));
        let r = get("paths.test", "/docs/nope", &[]).await;
        assert_eq!((r.status, r.text()), (404, "docs missing".to_string()));
        let r = get("paths.test", "/docsx", &[]).await;
        assert_eq!((r.status, r.text()), (200, "path root app".to_string()));
        let r = get("paths.test", "/nope", &[]).await;
        assert_eq!((r.status, r.text()), (404, "root missing".to_string()));
        let r = get("paths.test", "/docs/x?q=/other", &[]).await;
        assert_eq!((r.status, r.text()), (200, "path docs app".to_string()));
        // the prefix is not stripped: the docs manifest has no /x
        let r = get("paths.test", "/x", &[]).await;
        assert_eq!(r.status, 404);

        // forwards: runSproutFirst path, POST with its body, unknown host, bad manifests, hop-by-hop
        let r = get("main.test", "/api/users?x=1", &[]).await;
        assert!(
            r.text()
                .starts_with("backend GET /api/users?x=1 host=main.test"),
            "{}",
            r.text()
        );
        let r = send(
            edge.addr,
            "POST",
            "/index.html",
            "main.test",
            &[],
            "payload",
        )
        .await;
        assert!(
            r.text()
                .contains("backend POST /index.html host=main.test body=payload"),
            "{}",
            r.text()
        );
        for host in ["nobody.test", "bad.test", "gone.test"] {
            let r = get(host, "/index.html", &[]).await;
            assert!(
                r.text().starts_with("backend GET /index.html"),
                "{host}: {}",
                r.text()
            );
        }
        let r = get(
            "main.test",
            "/api/x",
            &[
                ("Keep-Alive", "timeout=5"),
                ("Proxy-Connection", "keep-alive"),
                ("X-Keep", "1"),
            ],
        )
        .await;
        let names = r.text().rsplit("headers=").next().unwrap().to_string();
        let names: Vec<&str> = names.split(',').collect();
        assert!(
            names.contains(&"x-keep") && names.contains(&"host"),
            "{names:?}"
        );
        assert!(
            !names.contains(&"keep-alive") && !names.contains(&"proxy-connection"),
            "{names:?}"
        );
        assert!(!names.contains(&"connection"), "{names:?}");
        // the deployment domain is not special here
        let r = get("sproutboat.local", "/", &[]).await;
        assert!(r.text().starts_with("backend GET /"), "{}", r.text());
    }

    #[tokio::test]
    async fn cache_off_and_a_dead_backend() {
        // nothing listens here
        let dead = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap()
        };
        let edge = start_edge(dead, &[("SPROUTBOAT_ASSET_CACHE_BYTES", "0".into())]).await;
        let r = send(edge.addr, "GET", "/", "main.test", &[], "").await;
        assert_eq!((r.status, r.text()), (200, "<h1>home</h1>".to_string()));
        assert!(edge.app.backend.as_ref().unwrap().cache.is_none());
        let r = send(edge.addr, "GET", "/api/x", "main.test", &[], "").await;
        assert_eq!(
            (r.status, r.text()),
            (502, "backend unavailable".to_string())
        );
        let r = send(edge.addr, "POST", "/x", "nobody.test", &[], "body").await;
        assert_eq!(
            (r.status, r.text()),
            (502, "backend unavailable".to_string())
        );
    }

    #[tokio::test]
    async fn a_manifest_that_appears_later_recovers_its_host() {
        let backend = echo_backend().await;
        let edge = start_edge(backend, &[]).await;
        let root = edge.dir.path();
        let later = root.join("manifests/later.json");
        let blobs = root.join("blobs").display().to_string();
        let path = root.join("routes.json");
        std::fs::write(
            &path,
            format!(r#"{{"version":1,"apps":[{{"hostname":"late.test","app_id":"l","manifest":"{}","blobs":"{blobs}"}}]}}"#, later.display()),
        )
        .unwrap();
        edge.app.reload_routes().await.unwrap();
        let backend_state = edge.app.backend.as_ref().unwrap();
        assert!(backend_state.assets_for("late.test", "/").is_none());
        let r = send(edge.addr, "GET", "/index.html", "late.test", &[], "").await;
        assert!(r.text().starts_with("backend GET"), "{}", r.text());
        std::fs::write(
            &later,
            r#"{"notFound":"none","runSproutFirst":false,"files":{"/index.html":{"hash":"idx00001","size":1,"type":"text/html"}}}"#,
        )
        .unwrap();
        // the snapshot file itself did not change: the poll still retries it
        for _ in 0..3 {
            backend_state.last_check_ms.store(0, Ordering::Release);
            backend_state.refresh(&path).await.unwrap();
        }
        assert!(backend_state.assets_for("late.test", "/").is_some());
        assert!(lock(&backend_state.manifests).contains_key(&later));
    }

    #[tokio::test]
    async fn the_snapshot_is_reloaded() {
        let backend = echo_backend().await;
        let edge = start_edge(backend, &[]).await;
        let backend_state = edge.app.backend.as_ref().unwrap();
        assert!(backend_state.assets_for("main.test", "/").is_some());
        assert!(backend_state.assets_for("bad.test", "/").is_none());
        let path = edge.dir.path().join("routes.json");
        let manifest = edge
            .dir
            .path()
            .join("manifests/none.json")
            .display()
            .to_string();
        let blobs = edge.dir.path().join("blobs").display().to_string();
        std::fs::write(
            &path,
            format!(r#"{{"version":1,"apps":[{{"hostname":"new.test","app_id":"n","manifest":"{manifest}","blobs":"{blobs}"}}]}}"#),
        )
        .unwrap();
        edge.app.reload_routes().await.unwrap();
        let backend_state = edge.app.backend.as_ref().unwrap();
        assert!(backend_state.assets_for("main.test", "/").is_none());
        assert!(backend_state.assets_for("new.test", "/").is_some());
        // a broken snapshot keeps what is loaded; a missing one means no assets
        std::fs::write(&path, "{").unwrap();
        assert!(edge.app.reload_routes().await.is_err());
        assert!(edge
            .app
            .backend
            .as_ref()
            .unwrap()
            .assets_for("new.test", "/")
            .is_some());
        std::fs::remove_file(&path).unwrap();
        edge.app.reload_routes().await.unwrap();
        assert!(edge
            .app
            .backend
            .as_ref()
            .unwrap()
            .assets_for("new.test", "/")
            .is_none());
    }
}
