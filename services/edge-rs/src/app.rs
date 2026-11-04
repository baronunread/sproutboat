//! Shared state: configuration, the live route snapshot and how it is swapped,
//! the asset-manifest cache, the response cache, the log, the sidecar and the
//! upstream HTTP client.

use crate::assets::Manifest;
use crate::body::{BoxError, RBody};
use crate::cache::EdgeCache;
use crate::config::Config;
use crate::logs::LogSink;
use crate::routes::{load_routes, timed_sprouts, Routes};
use crate::sidecar::{EndpointCache, Sidecar};
use crate::util::now_ms;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Duration;
use tokio::sync::{watch, Notify};

pub type UpstreamClient = Client<HttpConnector, RBody>;

pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Counts live connections (and relayed WebSockets) so shutdown can drain them.
#[derive(Default)]
pub struct InFlight {
    count: AtomicUsize,
    changed: Notify,
}

pub struct InFlightGuard(Arc<InFlight>);

impl InFlight {
    pub fn enter(self: &Arc<Self>) -> InFlightGuard {
        self.count.fetch_add(1, Ordering::AcqRel);
        InFlightGuard(self.clone())
    }

    /// Resolves once nothing is in flight, or after `limit`.
    pub async fn drain(&self, limit: Duration) {
        let wait = async {
            loop {
                let notified = self.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self.count.load(Ordering::Acquire) == 0 {
                    return;
                }
                notified.await;
            }
        };
        let _ = tokio::time::timeout(limit, wait).await;
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.count.fetch_sub(1, Ordering::AcqRel);
        self.0.changed.notify_waiters();
    }
}

pub struct App {
    pub cfg: Config,
    routes: RwLock<Arc<Routes>>,
    routes_mtime_ms: Mutex<f64>,
    last_route_check_ms: AtomicU64,
    pub cache: Option<Mutex<EdgeCache>>,
    manifests: Mutex<HashMap<String, Option<Arc<Manifest>>>>,
    pub log: LogSink,
    pub sidecar: Sidecar,
    pub endpoints: EndpointCache,
    pub client: UpstreamClient,
    pub shutdown: watch::Sender<bool>,
    pub in_flight: Arc<InFlight>,
}

/// `stat().mtimeMs`; a missing file is 0.
pub async fn snapshot_mtime(path: &std::path::Path) -> Result<f64, String> {
    match tokio::fs::metadata(path).await {
        Ok(meta) => {
            let modified = meta.modified().map_err(|e| e.to_string())?;
            Ok(modified
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0.0, |d| d.as_secs_f64() * 1000.0))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0.0),
        Err(e) => Err(e.to_string()),
    }
}

pub async fn read_routes(path: &std::path::Path) -> Result<Routes, String> {
    let text = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| e.to_string())?;
    load_routes(&text)
}

fn build_client() -> UpstreamClient {
    let mut connector = HttpConnector::new();
    connector.set_nodelay(true);
    connector.set_connect_timeout(Some(Duration::from_secs(10)));
    Client::builder(TokioExecutor::new())
        // Backends are loopback servers that may close idle keep-alive connections early.
        .pool_idle_timeout(Duration::from_secs(4))
        .pool_max_idle_per_host(256)
        .build(connector)
}

impl App {
    pub fn new(cfg: Config, routes: Routes, routes_mtime_ms: f64, log: LogSink) -> Arc<App> {
        let cache = cfg.cache_enabled.then(|| Mutex::new(EdgeCache::default()));
        Arc::new(App {
            cfg,
            routes: RwLock::new(Arc::new(routes)),
            routes_mtime_ms: Mutex::new(routes_mtime_ms),
            last_route_check_ms: AtomicU64::new(0),
            cache,
            manifests: Mutex::new(HashMap::new()),
            log,
            sidecar: Sidecar::new(),
            endpoints: EndpointCache::new(),
            client: build_client(),
            shutdown: watch::channel(false).0,
            in_flight: Arc::new(InFlight::default()),
        })
    }

    pub fn routes(&self) -> Arc<Routes> {
        self.routes
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Static-asset manifest of a deployment, loaded on first use and dropped when its
    /// route changes. `None` = no `assets.json` next to the artifact (or unreadable).
    pub fn manifest_for(&self, sprout_path: &str) -> Option<Arc<Manifest>> {
        if let Some(found) = lock(&self.manifests).get(sprout_path) {
            return found.clone();
        }
        let path = std::path::Path::new(sprout_path)
            .parent()
            .map(|d| d.join("assets.json"));
        let mut manifest = None;
        if let Some(path) = path.filter(|p| p.exists()) {
            match std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|t| Manifest::parse(&t))
            {
                Ok(m) => manifest = Some(Arc::new(m)),
                Err(error) => eprintln!("asset manifest load failed for {sprout_path}: {error}"),
            }
        }
        lock(&self.manifests).insert(sprout_path.to_string(), manifest.clone());
        manifest
    }

    pub fn purge_cache_host(&self, host: &str) {
        if let Some(cache) = &self.cache {
            lock(cache).purge_host(host);
        }
    }

    /// Swap in a new route snapshot: dispose sprouts whose route changed or was removed.
    /// HTTP-only sprouts are not pre-spawned: they cold-start on their first request and
    /// stay eligible for idle eviction. The timed-route reconciliation is the exception.
    pub async fn swap_routes(self: &Arc<Self>, next: Routes, next_mtime_ms: f64) {
        let previous = self.routes();
        let mut disposals = Vec::new();
        for (hostname, route) in previous.iter() {
            let upcoming = next.get(hostname);
            if route.backend.is_some() {
                // Nothing of ours runs for it: no sprout to dispose, no asset manifest, nothing cached.
                if upcoming.is_none_or(|n| n.backend != route.backend) {
                    self.purge_cache_host(hostname);
                }
                continue;
            }
            if upcoming.is_none_or(|n| route.runtime_changed(n)) {
                let path = route.sprout_path.clone();
                self.endpoints.forget_sprout(&path);
                lock(&self.manifests).remove(&path);
                self.purge_cache_host(hostname); // a new version must not serve the old one's cached responses
                disposals.push(path);
            }
        }
        // Publish the snapshot first, then dispose. Bun disposes and swaps in one synchronous step;
        // here a dispose is a round trip to the sidecar, and requests that still saw the old
        // route during it would start the sprout again right after it was disposed (it would
        // linger until idle eviction).
        *self.routes.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(next);
        *lock(&self.routes_mtime_ms) = next_mtime_ms;
        futures_util::future::join_all(disposals.iter().map(|p| self.sidecar.dispose(p))).await;
        self.reconcile_timed();
    }

    /// Wake (or release) the timer-driven sprouts of the current snapshot, in the background.
    pub fn reconcile_timed(self: &Arc<Self>) {
        let app = self.clone();
        tokio::spawn(async move {
            let routes = app.routes();
            let timed = tokio::task::spawn_blocking(move || timed_sprouts(&routes))
                .await
                .unwrap_or_default();
            app.sidecar.reconcile(timed).await;
        });
    }

    /// Reload when the file's mtime moved forward. Throttled to once per 250 ms and
    /// triggered per request, belt-and-braces to SIGHUP (the authoritative path).
    pub async fn refresh_routes(self: &Arc<Self>) -> Result<(), String> {
        let now = now_ms();
        let last = self.last_route_check_ms.load(Ordering::Acquire);
        if now.saturating_sub(last) < 250
            || self
                .last_route_check_ms
                .compare_exchange(last, now, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return Ok(());
        }
        let current = snapshot_mtime(&self.cfg.routes_path).await?;
        let known = *lock(&self.routes_mtime_ms);
        if current > known {
            let next = read_routes(&self.cfg.routes_path).await?;
            self.swap_routes(next, current).await;
        }
        Ok(())
    }

    /// SIGHUP: reload unconditionally; a missing file means no routes.
    pub async fn reload_routes(self: &Arc<Self>) -> Result<(), String> {
        let mtime = snapshot_mtime(&self.cfg.routes_path).await?;
        let next = if mtime > 0.0 {
            read_routes(&self.cfg.routes_path).await?
        } else {
            Routes::default()
        };
        self.swap_routes(next, mtime).await;
        Ok(())
    }
}

#[allow(dead_code)]
type _Unused = BoxError;
