//! SPIKE: on-demand ACME for custom domains, with Caddy's contract.
//!
//! A handshake for a name that has no certificate yet asks `GET <ask url>?domain=<name>`
//! (any 2xx allows, anything else denies; this is Caddy's `on_demand_tls { ask }`), and only
//! then orders one with HTTP-01 (answered by the port-80 listener in `tls.rs`). The first
//! handshake waits for the certificate, like Caddy. Everything is bounded: one order per name
//! at a time, a negative cache for denials, a backoff after failures, a global per-hour cap.
//!
//! Wildcards under the apps domain are never ordered here: lego owns them.

use crate::tls::{valid_hostname, CertStore, Place, Settings};
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use instant_acme::{
    Account, AccountCredentials, AuthorizationStatus, ChallengeType, Identifier, NewAccount,
    NewOrder, OrderStatus, RetryPolicy,
};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{watch, OnceCell};

const DENY_TTL: Duration = Duration::from_secs(60);
const MAX_TRACKED: usize = 10_000;

pub struct Acme {
    directory: String,
    root_ca: Option<PathBuf>,
    contact: Option<String>,
    ask_url: String,
    max_per_hour: usize,
    cert_dir: PathBuf,
    store: Arc<CertStore>,
    challenges: Arc<Mutex<HashMap<String, String>>>,
    account: OnceCell<Account>,
    ask_client: Client<HttpConnector, Empty<Bytes>>,
    /// One order per name at a time.
    inflight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    denied: Mutex<HashMap<String, Instant>>,
    /// name -> (consecutive failures, retry not before)
    failures: Mutex<HashMap<String, (u32, Instant)>>,
    ordered: Mutex<VecDeque<Instant>>,
}

/// Bound a map that an attacker's choice of server name could otherwise grow.
fn trim<V>(m: &mut HashMap<String, V>) {
    if m.len() > MAX_TRACKED {
        m.clear();
    }
}

impl Acme {
    pub fn new(
        settings: &Settings,
        store: Arc<CertStore>,
        challenges: Arc<Mutex<HashMap<String, String>>>,
    ) -> Arc<Acme> {
        Arc::new(Acme {
            directory: settings.acme_directory.clone().unwrap_or_default(),
            root_ca: settings.acme_root_ca.clone(),
            contact: settings.acme_contact.clone(),
            ask_url: settings.ask_url.clone().unwrap_or_default(),
            max_per_hour: settings.acme_max_per_hour,
            cert_dir: settings.cert_dir.clone(),
            store,
            challenges,
            account: OnceCell::new(),
            ask_client: Client::builder(TokioExecutor::new()).build(HttpConnector::new()),
            inflight: Mutex::default(),
            denied: Mutex::default(),
            failures: Mutex::default(),
            ordered: Mutex::default(),
        })
    }

    /// Caddy's `ask`: a 2xx answer allows the name.
    async fn allowed(&self, name: &str) -> Result<bool, String> {
        let sep = if self.ask_url.contains('?') { '&' } else { '?' };
        let uri: hyper::Uri = format!("{}{sep}domain={name}", self.ask_url)
            .parse()
            .map_err(|e| format!("bad ask url: {e}"))?;
        let res = tokio::time::timeout(Duration::from_secs(5), self.ask_client.get(uri))
            .await
            .map_err(|_| "ask timed out".to_string())?
            .map_err(|e| format!("ask failed: {e}"))?;
        let ok = res.status().is_success();
        let _ = res.into_body().collect().await; // drain so the connection can be reused
        Ok(ok)
    }

    /// Make sure `name` has a certificate in the store: ask, then order. `Err` says why not.
    pub async fn ensure(&self, name: &str) -> Result<(), String> {
        if !valid_hostname(name) || !name.contains('.') || name.parse::<std::net::IpAddr>().is_ok()
        {
            return Err("not an orderable name".into());
        }
        if !matches!(self.store.classify(name), Some(Place::Host(_))) {
            return Err("names under the apps domain are lego's".into());
        }
        if let Some(at) = self
            .denied
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(name)
        {
            if at.elapsed() < DENY_TTL {
                return Err("denied recently".into());
            }
        }
        if let Some((_, not_before)) = self
            .failures
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(name)
        {
            if Instant::now() < *not_before {
                return Err("backing off after a failed order".into());
            }
        }
        // One order per name: later handshakes wait on the first, then find the certificate.
        let gate = self
            .inflight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(name.to_string())
            .or_default()
            .clone();
        let _held = gate.lock().await;
        if self.store.get(name).is_some() {
            return Ok(());
        }
        // Ask only now, inside the gate: N parallel first handshakes make one ask, not N.
        if !self.allowed(name).await? {
            let mut d = self.denied.lock().unwrap_or_else(|e| e.into_inner());
            trim(&mut d);
            d.insert(name.to_string(), Instant::now());
            return Err("ask refused the name".into());
        }
        self.order(name).await
    }

    /// The order itself, behind the hourly cap and the failure backoff.
    async fn order(&self, name: &str) -> Result<(), String> {
        {
            let mut o = self.ordered.lock().unwrap_or_else(|e| e.into_inner());
            while o
                .front()
                .is_some_and(|t| t.elapsed() > Duration::from_secs(3600))
            {
                o.pop_front();
            }
            if o.len() >= self.max_per_hour {
                return Err(format!("hourly order cap ({}) reached", self.max_per_hour));
            }
            o.push_back(Instant::now());
        }
        match self.issue(name).await {
            Ok(()) => {
                self.failures
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(name);
                // The store picks the new files up through its normal path.
                self.store
                    .get(name)
                    .map(|_| ())
                    .ok_or_else(|| "issued but not loadable".into())
            }
            Err(error) => {
                let mut f = self.failures.lock().unwrap_or_else(|e| e.into_inner());
                trim(&mut f);
                let n = f.get(name).map_or(0, |(n, _)| *n) + 1;
                // 1 min, 2, 4 ... capped at 1 h: far below Let's Encrypt's own "5 failures an hour".
                let wait = Duration::from_secs((60u64 << (n - 1).min(6)).min(3600));
                f.insert(name.to_string(), (n, Instant::now() + wait));
                Err(error)
            }
        }
    }

    async fn account(&self) -> Result<&Account, String> {
        self.account
            .get_or_try_init(|| async {
                let file = self.cert_dir.join("acme-account.json");
                let builder = || match &self.root_ca {
                    Some(root) => Account::builder_with_root(root),
                    None => Account::builder(),
                };
                if let Ok(raw) = std::fs::read(&file) {
                    let creds: AccountCredentials = serde_json::from_slice(&raw)
                        .map_err(|e| format!("acme-account.json: {e}"))?;
                    return builder()
                        .map_err(|e| e.to_string())?
                        .from_credentials(creds)
                        .await
                        .map_err(|e| e.to_string());
                }
                let contact = self.contact.as_ref().map(|c| format!("mailto:{c}"));
                let contacts: Vec<&str> = contact.iter().map(String::as_str).collect();
                let (account, creds) = builder()
                    .map_err(|e| e.to_string())?
                    .create(
                        &NewAccount {
                            contact: &contacts,
                            terms_of_service_agreed: true,
                            only_return_existing: false,
                        },
                        self.directory.clone(),
                        None,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                write_private(
                    &file,
                    &serde_json::to_vec(&creds).map_err(|e| e.to_string())?,
                )?;
                Ok(account)
            })
            .await
    }

    async fn issue(&self, name: &str) -> Result<(), String> {
        let account = self.account().await?;
        let mut order = account
            .new_order(&NewOrder::new(&[Identifier::Dns(name.to_string())]))
            .await
            .map_err(|e| format!("new order: {e}"))?;
        let mut tokens = Vec::new();
        let result = async {
            let mut authorizations = order.authorizations();
            while let Some(authz) = authorizations.next().await {
                let mut authz = authz.map_err(|e| format!("authorization: {e}"))?;
                match authz.status {
                    AuthorizationStatus::Pending => {}
                    AuthorizationStatus::Valid => continue,
                    other => return Err(format!("authorization is {other:?}")),
                }
                let mut challenge = authz
                    .challenge(ChallengeType::Http01)
                    .ok_or("the CA offers no http-01 challenge")?;
                let token = challenge.token.clone();
                self.challenges
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(
                        token.clone(),
                        challenge.key_authorization().as_str().to_string(),
                    );
                tokens.push(token);
                challenge
                    .set_ready()
                    .await
                    .map_err(|e| format!("challenge: {e}"))?;
            }
            let status = order
                .poll_ready(&RetryPolicy::default())
                .await
                .map_err(|e| format!("validation: {e}"))?;
            if status != OrderStatus::Ready {
                return Err(format!("order is {status:?}, not ready"));
            }
            let key_pem = order
                .finalize()
                .await
                .map_err(|e| format!("finalize: {e}"))?;
            let chain = order
                .poll_certificate(&RetryPolicy::default())
                .await
                .map_err(|e| format!("certificate: {e}"))?;
            Ok((key_pem, chain))
        }
        .await;
        {
            let mut c = self.challenges.lock().unwrap_or_else(|e| e.into_inner());
            for t in &tokens {
                c.remove(t);
            }
        }
        let (key_pem, chain) = result?;
        let dir = self.cert_dir.join("hosts").join(name);
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        // Key first: the store refuses a certificate whose key it cannot match, so an observer
        // between the two renames keeps the old pair.
        write_private(&dir.join("privkey.pem"), key_pem.as_bytes())?;
        write_private(&dir.join("fullchain.pem"), chain.as_bytes())?;
        println!("acme: issued {name}");
        Ok(())
    }

    /// Renew by age (60 of 90 days by default). The name is asked about again: a name the
    /// platform no longer wants is left to expire.
    pub async fn renew_loop(
        self: Arc<Self>,
        renew_after: Duration,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let every = (renew_after / 4).clamp(Duration::from_secs(2), Duration::from_secs(3600));
        loop {
            tokio::select! {
                _ = tokio::time::sleep(every) => {}
                _ = shutdown.changed() => return,
            }
            let Ok(rd) = std::fs::read_dir(self.cert_dir.join("hosts")) else {
                continue;
            };
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let age = std::fs::metadata(entry.path().join("fullchain.pem"))
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok());
                if age.is_some_and(|a| a >= renew_after) {
                    match self.allowed(&name).await {
                        Ok(true) => match self.order(&name).await {
                            Ok(()) => println!("acme: renewed {name}"),
                            Err(error) => eprintln!("acme: renewing {name}: {error}"),
                        },
                        Ok(false) => eprintln!("acme: {name} is no longer allowed, not renewing"),
                        Err(error) => eprintln!("acme: {name}: {error}"),
                    }
                }
            }
        }
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| format!("{}: {e}", tmp.display()))?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}
