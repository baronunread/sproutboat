//! The supervisor sidecar. The Bun edge embeds the supervisor pool; the Rust edge
//! does not port it. It runs `services/supervisor/src/sidecar.ts` under Bun as a
//! child process (same process group and cgroup) and talks JSON to it over a unix
//! socket. The child is started lazily, the first time anything needs the pool, so
//! deployments served purely by sproutd never start Bun. If it dies it is restarted
//! with backoff and the last timed-route list is replayed.

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Method, Request};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::UnixStream;
use tokio::process::Command;
use tokio::sync::watch;
use tokio::time::Instant;

/// How long a request waits for the sidecar to be up (a first start includes Bun's own start).
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const STOP_GRACE: Duration = Duration::from_secs(3);
/// DEVIATION (documented in DEVIATIONS.md): a resolved endpoint is reused this long. Every
/// resolution refreshes the pool's `lastUsedAt`, so idle eviction still sees live traffic.
pub const ENDPOINT_TTL: Duration = Duration::from_secs(1);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Clone)]
pub struct Endpoint {
    pub url: String,
    pub transfer_url: Option<String>,
    pub cold_start: bool,
    pub startup_ms: f64,
    pub boot_ms: f64,
    pub edge_token: Option<String>,
}

impl Endpoint {
    fn parse(body: &[u8]) -> Result<Endpoint, String> {
        let v: Value =
            serde_json::from_slice(body).map_err(|e| format!("bad sidecar reply: {e}"))?;
        let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Ok(Endpoint {
            url: text("url").ok_or("bad sidecar reply: no url")?,
            transfer_url: text("transferUrl"),
            cold_start: v.get("coldStart").and_then(Value::as_bool).unwrap_or(false),
            startup_ms: v.get("startupMs").and_then(Value::as_f64).unwrap_or(0.0),
            boot_ms: v.get("bootMs").and_then(Value::as_f64).unwrap_or(0.0),
            edge_token: text("edgeToken"),
        })
    }
}

struct Inner {
    started: AtomicBool,
    socket: PathBuf,
    /// 0 while the sidecar is down; otherwise the generation of the running one.
    ready: watch::Sender<u64>,
    stop: watch::Sender<bool>,
    edge_url: Mutex<Option<String>>,
    last_timed: Mutex<Vec<Value>>,
    secret: Mutex<Option<(u64, String)>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct Sidecar {
    inner: Arc<Inner>,
}

fn bun_binary() -> String {
    if let Some(bun) = std::env::var("SPROUTBOAT_BUN")
        .ok()
        .filter(|v| !v.is_empty())
    {
        return bun;
    }
    let packaged = "/opt/sproutboat/bun/bin/bun";
    if std::path::Path::new(packaged).exists() {
        return packaged.to_string();
    }
    "bun".to_string()
}

fn sidecar_script() -> String {
    if let Some(script) = std::env::var("SPROUTBOAT_SIDECAR_SCRIPT")
        .ok()
        .filter(|v| !v.is_empty())
    {
        return script;
    }
    let relative = "services/supervisor/src/sidecar.ts";
    if std::path::Path::new(relative).exists() {
        return relative.to_string();
    }
    // Not run from the repo root: look next to the binary (services/edge-rs/target/<profile>/).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(found) = exe
            .ancestors()
            .skip(1)
            .map(|a| a.join(relative))
            .find(|p| p.exists())
        {
            return found.display().to_string();
        }
    }
    // Last resort: the checkout this binary was built from (development, or a copied binary).
    let built_from =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../supervisor/src/sidecar.ts");
    if built_from.exists() {
        return built_from.display().to_string();
    }
    relative.to_string()
}

impl Sidecar {
    pub fn new() -> Sidecar {
        let socket = std::env::var("SPROUTBOAT_SIDECAR_SOCKET")
            .ok()
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::temp_dir().join(format!("sproutboat-sidecar-{}.sock", std::process::id()))
            });
        Sidecar {
            inner: Arc::new(Inner {
                started: AtomicBool::new(false),
                socket,
                ready: watch::channel(0).0,
                stop: watch::channel(false).0,
                edge_url: Mutex::new(None),
                last_timed: Mutex::new(Vec::new()),
                secret: Mutex::new(None),
                task: Mutex::new(None),
            }),
        }
    }

    /// Brokers read `SPROUTBOAT_EDGE_URL`; the edge sets it once its listener is bound.
    pub fn set_edge_url(&self, url: String) {
        *lock(&self.inner.edge_url) = Some(url);
    }

    /// Has anything asked for the sidecar yet? Disposal needs nothing running if not.
    pub fn is_started(&self) -> bool {
        self.inner.started.load(Ordering::Acquire)
    }

    fn ensure_started(&self) {
        if self.inner.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let handle = tokio::spawn(supervise(self.inner.clone()));
        *lock(&self.inner.task) = Some(handle);
    }

    async fn wait_ready(&self) -> Result<u64, String> {
        self.ensure_started();
        let mut rx = self.inner.ready.subscribe();
        let wait = async {
            loop {
                let generation = *rx.borrow_and_update();
                if generation != 0 {
                    return Ok(generation);
                }
                if rx.changed().await.is_err() {
                    return Err("sidecar stopped".to_string());
                }
            }
        };
        match tokio::time::timeout(READY_TIMEOUT, wait).await {
            Ok(r) => r,
            Err(_) => Err("sidecar did not become ready".to_string()),
        }
    }

    /// One JSON request over the unix socket: (status, body).
    pub async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<(u16, Bytes), String> {
        let mut attempts = 0;
        loop {
            attempts += 1;
            self.wait_ready().await?;
            match self.try_call(&method, path, body).await {
                Ok(r) => return Ok(r),
                // The child may have died between readiness and connect; one more look.
                Err(e) if attempts < 2 && e.starts_with("connect:") => {
                    tokio::time::sleep(Duration::from_millis(100)).await
                }
                Err(e) => return Err(e),
            }
        }
    }

    async fn try_call(
        &self,
        method: &Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<(u16, Bytes), String> {
        let stream = UnixStream::connect(&self.inner.socket)
            .await
            .map_err(|e| format!("connect: {e}"))?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|e| format!("sidecar handshake: {e}"))?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let payload = body.map_or_else(Bytes::new, |v| Bytes::from(v.to_string()));
        let request = Request::builder()
            .method(method.clone())
            .uri(path)
            .header("host", "sidecar")
            .header("content-type", "application/json")
            .header("content-length", payload.len())
            .body(Full::new(payload))
            .map_err(|e| e.to_string())?;
        let response = sender
            .send_request(request)
            .await
            .map_err(|e| format!("sidecar request: {e}"))?;
        let status = response.status().as_u16();
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|e| format!("sidecar body: {e}"))?
            .to_bytes();
        Ok((status, bytes))
    }

    fn error_of(status: u16, body: &[u8]) -> String {
        serde_json::from_slice::<Value>(body)
            .ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| format!("sidecar answered {status}"))
    }

    /// `pool.endpoint(...)`; `runtime` is `Route::runtime_json()`.
    pub async fn endpoint(
        &self,
        runtime: &Value,
        dispatch_disabled: bool,
    ) -> Result<Endpoint, String> {
        let mut body = runtime.clone();
        if dispatch_disabled {
            body["dispatchDisabled"] = Value::Bool(true);
        }
        let (status, bytes) = self.call(Method::POST, "/endpoint", Some(&body)).await?;
        if status != 200 {
            return Err(Self::error_of(status, &bytes));
        }
        Endpoint::parse(&bytes)
    }

    pub async fn touch(&self, runtime: &Value) {
        if let Err(error) = self.call(Method::POST, "/touch", Some(runtime)).await {
            eprintln!("sidecar touch failed: {error}");
        }
    }

    /// Dispose a sprout. Nothing to do if the pool was never started.
    pub async fn dispose(&self, sprout_path: &str) {
        if !self.is_started() {
            return;
        }
        let body = serde_json::json!({ "sproutPath": sprout_path });
        if let Err(error) = self.call(Method::POST, "/dispose", Some(&body)).await {
            eprintln!("sidecar dispose failed: {error}");
        }
    }

    /// `pool.reconcileTimed`. The list is remembered and replayed if the sidecar restarts.
    /// An empty list needs no sidecar that is not already running.
    pub async fn reconcile(&self, sprouts: Vec<Value>) {
        *lock(&self.inner.last_timed) = sprouts.clone();
        if sprouts.is_empty() && !self.is_started() {
            return;
        }
        let body = Value::Array(sprouts);
        match self.call(Method::POST, "/reconcile", Some(&body)).await {
            Ok((200, _)) => {}
            Ok((status, bytes)) => eprintln!(
                "timed route reconcile failed: {}",
                Self::error_of(status, &bytes)
            ),
            Err(error) => eprintln!("timed route reconcile failed: {error}"),
        }
    }

    pub async fn stats(&self) -> Result<Bytes, String> {
        let (status, bytes) = self.call(Method::GET, "/stats", None).await?;
        if status != 200 {
            return Err(Self::error_of(status, &bytes));
        }
        Ok(bytes)
    }

    /// `isEdgeSecret(value)`. The secret is fixed for a sidecar's lifetime, so once the
    /// sidecar has confirmed a value it is compared locally from then on.
    pub async fn is_edge_secret(&self, value: &str) -> bool {
        let generation = *self.inner.ready.borrow();
        if let Some((known, secret)) = lock(&self.inner.secret).as_ref() {
            if *known == generation && constant_time_eq(secret.as_bytes(), value.as_bytes()) {
                return true;
            }
        }
        let body = serde_json::json!({ "value": value });
        let Ok((200, bytes)) = self
            .call(Method::POST, "/is-edge-secret", Some(&body))
            .await
        else {
            return false;
        };
        let ok = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v["ok"].as_bool())
            .unwrap_or(false);
        if ok && generation != 0 {
            *lock(&self.inner.secret) = Some((generation, value.to_string()));
        }
        ok
    }

    /// Stop the sidecar: SIGTERM (it disposes every sprout), a short wait, then kill.
    pub async fn shutdown(&self) {
        self.inner.stop.send_replace(true);
        let task = lock(&self.inner.task).take();
        if let Some(task) = task {
            let _ = task.await;
        }
        let _ = std::fs::remove_file(&self.inner.socket);
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Keep one sidecar child alive until told to stop.
async fn supervise(inner: Arc<Inner>) {
    let mut stop = inner.stop.subscribe();
    let mut generation = 0u64;
    let mut backoff = Duration::from_millis(250);
    loop {
        if *stop.borrow() {
            return;
        }
        generation += 1;
        let spawned_at = Instant::now();
        let mut command = Command::new(bun_binary());
        command
            .arg(sidecar_script())
            .env("SPROUTBOAT_SIDECAR_SOCKET", &inner.socket)
            .env("SPROUTBOAT_SIDECAR_EXIT_ON_STDIN_EOF", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        let edge_url = lock(&inner.edge_url).clone();
        if let Some(url) =
            edge_url.filter(|_| std::env::var("SPROUTBOAT_EDGE_URL").map_or(true, |v| v.is_empty()))
        {
            command.env("SPROUTBOAT_EDGE_URL", url);
        }
        match command.spawn() {
            Err(error) => eprintln!("sidecar could not be started: {error}"),
            Ok(mut child) => {
                let _stdin = child.stdin.take(); // dropped (EOF) if this process dies
                let (ready_tx, mut ready_rx) = watch::channel(false);
                if let Some(stdout) = child.stdout.take() {
                    tokio::spawn(async move {
                        let mut lines = BufReader::new(stdout).lines();
                        while let Ok(Some(line)) = lines.next_line().await {
                            if line == "sidecar ready" {
                                let _ = ready_tx.send(true);
                            } else {
                                println!("{line}");
                            }
                        }
                    });
                }
                let announce = async {
                    loop {
                        if *ready_rx.borrow_and_update() {
                            return true;
                        }
                        if ready_rx.changed().await.is_err() {
                            return false;
                        }
                    }
                };
                tokio::pin!(announce);
                let mut up = false;
                let startup_deadline = tokio::time::sleep(READY_TIMEOUT);
                tokio::pin!(startup_deadline);
                let status = loop {
                    tokio::select! {
                        biased;
                        _ = stop.changed() => {
                            terminate(&mut child).await;
                            inner.ready.send_replace(0);
                            return;
                        }
                        status = child.wait() => break status,
                        ok = &mut announce, if !up => {
                            if ok {
                                up = true;
                                *lock(&inner.secret) = None;
                                inner.ready.send_replace(generation);
                                replay_timed(&inner);
                            } else {
                                up = true; // stdout closed: the exit arm will report it
                            }
                        }
                        _ = &mut startup_deadline, if !up => {
                            eprintln!("sidecar did not announce readiness in {READY_TIMEOUT:?}; restarting it");
                            terminate(&mut child).await;
                        }
                    }
                };
                inner.ready.send_replace(0);
                eprintln!(
                    "sidecar exited ({}); restarting",
                    status.map_or_else(|e| e.to_string(), |s| s.to_string())
                );
            }
        }
        if spawned_at.elapsed() > Duration::from_secs(30) {
            backoff = Duration::from_millis(250);
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = stop.changed() => return,
        }
        backoff = (backoff * 2).min(Duration::from_secs(10));
    }
}

/// A restarted sidecar has lost the timed-route list; hand it the latest one again.
fn replay_timed(inner: &Arc<Inner>) {
    let list = lock(&inner.last_timed).clone();
    if list.is_empty() {
        return;
    }
    let sidecar = Sidecar {
        inner: inner.clone(),
    };
    tokio::spawn(async move {
        let body = Value::Array(list);
        if let Err(error) = sidecar.call(Method::POST, "/reconcile", Some(&body)).await {
            eprintln!("timed route reconcile failed: {error}");
        }
    });
}

async fn terminate(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        // SAFETY: plain kill(2) on a pid we own and have not yet reaped.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
    if tokio::time::timeout(STOP_GRACE, child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
}

/// Resolved endpoints, per runtime identity, reused for at most [`ENDPOINT_TTL`].
///
/// DEVIATION from the Bun edge (which asks the in-process pool on every request):
/// asking a separate process for each request would add a round trip to the hot
/// path, so an endpoint is cached for one second. Each fresh resolution still
/// refreshes the pool's `lastUsedAt`, so busy sprouts are not idle-evicted.
/// A connect error to the sprout invalidates the entry. `coldStart`, `startupMs`
/// and `bootMs` are only reported to the request that actually triggered the spawn.
///
/// A resolution (which may wait through a cold start) runs as its own task. Callers only
/// wait for its answer, so a client hanging up never cancels or wedges it: the next
/// request joins the same start.
#[derive(Default)]
pub struct EndpointCache {
    slots: Mutex<HashMap<String, Arc<Mutex<Slot>>>>,
}

type Answer = Option<Result<Endpoint, String>>;

#[derive(Default)]
struct Slot {
    sprout_path: String,
    cached: Option<(Instant, Endpoint)>,
    pending: Option<watch::Receiver<Answer>>,
}

/// One caller's view of a resolution.
pub struct Resolution {
    rx: watch::Receiver<Answer>,
    /// This caller started the resolution (and so owns the cold-start fields).
    pub leader: bool,
}

impl Resolution {
    pub async fn wait(&mut self) -> Result<Endpoint, String> {
        let answer = loop {
            if let Some(answer) = self.rx.borrow_and_update().clone() {
                break answer;
            }
            if self.rx.changed().await.is_err() {
                return Err("endpoint resolution aborted".to_string());
            }
        };
        answer.map(|endpoint| {
            if self.leader {
                endpoint
            } else {
                Endpoint {
                    cold_start: false,
                    startup_ms: 0.0,
                    boot_ms: 0.0,
                    ..endpoint
                }
            }
        })
    }

    /// A handle that can be awaited after this caller is gone (to log what it started).
    pub fn detach(&self) -> Resolution {
        Resolution {
            rx: self.rx.clone(),
            leader: self.leader,
        }
    }
}

impl EndpointCache {
    pub fn new() -> EndpointCache {
        EndpointCache::default()
    }

    fn slot(&self, key: &str, sprout_path: &str) -> Arc<Mutex<Slot>> {
        lock(&self.slots)
            .entry(key.to_string())
            .or_insert_with(|| {
                Arc::new(Mutex::new(Slot {
                    sprout_path: sprout_path.to_string(),
                    ..Slot::default()
                }))
            })
            .clone()
    }

    /// Concurrent callers for one identity share one resolution: the first starts it (and may
    /// wait through a cold start), the rest wait for its answer.
    pub fn begin(
        &self,
        sidecar: &Sidecar,
        key: &str,
        sprout_path: &str,
        runtime: &Value,
    ) -> Resolution {
        let (sidecar, runtime) = (sidecar.clone(), runtime.clone());
        self.begin_with(key, sprout_path, move || async move {
            sidecar.endpoint(&runtime, false).await
        })
    }

    fn begin_with<F, Fut>(&self, key: &str, sprout_path: &str, resolve: F) -> Resolution
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Endpoint, String>> + Send + 'static,
    {
        let slot = self.slot(key, sprout_path);
        let mut guard = lock(&slot);
        if let Some((at, endpoint)) = &guard.cached {
            if at.elapsed() < ENDPOINT_TTL {
                let (_tx, rx) = watch::channel(Some(Ok(endpoint.clone())));
                return Resolution { rx, leader: false };
            }
        }
        if let Some(rx) = &guard.pending {
            return Resolution {
                rx: rx.clone(),
                leader: false,
            };
        }
        guard.cached = None;
        let (tx, rx) = watch::channel(None);
        guard.pending = Some(rx.clone());
        let future = resolve();
        let slot = slot.clone();
        tokio::spawn(async move {
            let answer = future.await;
            {
                let mut slot = lock(&slot);
                slot.pending = None;
                if let Ok(endpoint) = &answer {
                    slot.cached = Some((Instant::now(), endpoint.clone()));
                }
            }
            tx.send_replace(Some(answer));
        });
        Resolution { rx, leader: true }
    }

    pub async fn invalidate(&self, key: &str) {
        let slot = lock(&self.slots).get(key).cloned();
        if let Some(slot) = slot {
            lock(&slot).cached = None;
        }
    }

    /// Forget every identity of one artifact (its route changed or was removed).
    pub fn forget_sprout(&self, sprout_path: &str) {
        lock(&self.slots).retain(|_, slot| lock(slot).sprout_path != sprout_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_reply_parses() {
        let e = Endpoint::parse(
            br#"{"url":"http://127.0.0.1:1","transferUrl":"http://127.0.0.1:2","coldStart":true,"startupMs":12.5,"bootMs":3,"edgeToken":"t"}"#,
        )
        .unwrap();
        assert_eq!(e.url, "http://127.0.0.1:1");
        assert_eq!(e.transfer_url.as_deref(), Some("http://127.0.0.1:2"));
        assert!(e.cold_start);
        assert_eq!(
            (e.startup_ms, e.boot_ms, e.edge_token.as_deref()),
            (12.5, 3.0, Some("t"))
        );
        let bare = Endpoint::parse(
            br#"{"url":"http://127.0.0.1:1","coldStart":false,"startupMs":0,"bootMs":0}"#,
        )
        .unwrap();
        assert!(bare.transfer_url.is_none() && bare.edge_token.is_none());
        assert!(Endpoint::parse(b"{}").is_err());
    }

    #[test]
    fn constant_time_compare() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    fn endpoint(cold: bool) -> Endpoint {
        Endpoint {
            url: "http://127.0.0.1:1".into(),
            transfer_url: None,
            cold_start: cold,
            startup_ms: 5.0,
            boot_ms: 2.0,
            edge_token: None,
        }
    }

    // Defect: a client that hung up during a cold start left every later request to the host
    // waiting forever. The resolution is its own task now: it survives its first caller.
    #[tokio::test]
    async fn resolution_survives_the_caller_that_started_it() {
        let cache = EndpointCache::new();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let make = |calls: Arc<std::sync::atomic::AtomicUsize>| {
            move || async move {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(80)).await;
                Ok(endpoint(true))
            }
        };
        let first = cache.begin_with("k", "/p", make(calls.clone()));
        assert!(first.leader);
        let mut watcher = first.detach();
        drop(first); // the client hung up
        let mut second = cache.begin_with("k", "/p", make(calls.clone()));
        assert!(!second.leader);
        let got = tokio::time::timeout(Duration::from_secs(2), second.wait())
            .await
            .expect("the second request must not hang")
            .unwrap();
        assert!(!got.cold_start, "only the starter reports the cold start");
        // The hung-up request can still learn what it started, to log it.
        let started = watcher.wait().await.unwrap();
        assert!(started.cold_start && started.startup_ms == 5.0);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_failed_resolution_is_not_cached() {
        let cache = EndpointCache::new();
        let mut failing = cache.begin_with("k", "/p", || async { Err("boom".to_string()) });
        assert_eq!(failing.wait().await.unwrap_err(), "boom");
        let mut retry = cache.begin_with("k", "/p", || async { Ok(endpoint(true)) });
        assert!(retry.leader);
        assert!(retry.wait().await.unwrap().cold_start);
    }

    // Defect: `watch::Sender::send` drops the value when no receiver is alive, so a sidecar that
    // became ready after the only waiting request hung up never looked ready.
    #[test]
    fn readiness_is_recorded_without_any_waiter() {
        let sidecar = Sidecar::new();
        sidecar.inner.ready.send_replace(7);
        assert_eq!(*sidecar.inner.ready.subscribe().borrow(), 7);
    }

    #[tokio::test]
    async fn disposing_and_empty_reconciles_never_start_the_sidecar() {
        let sidecar = Sidecar::new();
        sidecar.dispose("/x").await;
        sidecar.reconcile(vec![]).await;
        assert!(!sidecar.is_started());
        sidecar.shutdown().await; // no-op
    }
}
