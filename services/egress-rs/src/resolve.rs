//! Name resolution, injectable so tests (and the differential harness) can stand in
//! for DNS. The service resolves once per request, vets the answers, and connects to
//! a vetted address: it never hands the name to a connector.

use crate::addr::ip_text;
use std::future::Future;
use std::io;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Semaphore;

/// One answer: the address, and its text as the allow-list and the refusal see it.
/// `ip` is `None` for text that looks like an address but does not parse (a scoped
/// IPv6 such as `fe80::1%eth0`): such an answer is always refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    pub ip: Option<IpAddr>,
    pub text: String,
}

pub type ResolveFuture<'a> = Pin<Box<dyn Future<Output = io::Result<Vec<Answer>>> + Send + 'a>>;

pub trait Resolve: Send + Sync {
    /// `host` has no brackets. Answers keep the resolver's order.
    fn resolve<'a>(&'a self, host: &'a str) -> ResolveFuture<'a>;
}

/// Looks like an IP literal for `net.isIP`: a strict IPv4 or any IPv6 text, zone id included.
pub fn is_ip_literal(host: &str) -> bool {
    host.parse::<std::net::Ipv4Addr>().is_ok()
        || host.contains(':')
            && (host.parse::<std::net::Ipv6Addr>().is_ok() || scoped(host).is_some())
}

/// `fe80::1%eth0` -> the part before `%`, when it is an IPv6 address.
fn scoped(host: &str) -> Option<&str> {
    let (addr, zone) = host.split_once('%')?;
    (!zone.is_empty() && addr.parse::<std::net::Ipv6Addr>().is_ok()).then_some(addr)
}

/// The literal's own answer, text unchanged (what `dns.lookup` does for a literal).
pub fn literal_answer(host: &str) -> Option<Answer> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Some(Answer {
            ip: Some(ip),
            text: host.to_string(),
        });
    }
    if host.contains(':') && scoped(host).is_some() {
        return Some(Answer {
            ip: None,
            text: host.to_string(),
        });
    }
    None
}

/// Longest a system lookup may take before the request is answered with a failure.
pub const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
/// Lookups in flight at once. A lookup runs on the blocking pool and cannot be
/// cancelled, so its slot is held until it really finishes, not until it times out.
pub const MAX_LOOKUPS: usize = 64;

fn lookup_slots() -> &'static Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(|| Arc::new(Semaphore::new(MAX_LOOKUPS)))
}

/// Run `work` holding a slot from `slots`, giving up after `limit` (slot wait included).
pub async fn bounded<T, F>(slots: Arc<Semaphore>, limit: Duration, work: F) -> io::Result<T>
where
    T: Send + 'static,
    F: Future<Output = io::Result<T>> + Send + 'static,
{
    let timed_out = || io::Error::new(io::ErrorKind::TimedOut, "name resolution timed out");
    let permit = tokio::time::timeout(limit, slots.acquire_owned())
        .await
        .map_err(|_| timed_out())?
        .map_err(|_| timed_out())?;
    let task = tokio::spawn(async move {
        let out = work.await;
        drop(permit);
        out
    });
    match tokio::time::timeout(limit, task).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => Err(io::Error::other(e)),
        Err(_) => Err(timed_out()),
    }
}

/// The system resolver (getaddrinfo), literals answered without a lookup.
pub struct SystemResolver;

impl Resolve for SystemResolver {
    fn resolve<'a>(&'a self, host: &'a str) -> ResolveFuture<'a> {
        Box::pin(async move {
            if let Some(a) = literal_answer(host) {
                return Ok(vec![a]);
            }
            let name = host.to_string();
            let found = bounded(lookup_slots().clone(), LOOKUP_TIMEOUT, async move {
                let mut seen: Vec<IpAddr> = Vec::new();
                for sa in tokio::net::lookup_host((name.as_str(), 0)).await? {
                    let ip = sa.ip();
                    if !seen.contains(&ip) {
                        seen.push(ip);
                    }
                }
                Ok(seen)
            })
            .await?;
            if found.is_empty() {
                return Err(io::Error::new(io::ErrorKind::NotFound, "no addresses"));
            }
            Ok(found
                .into_iter()
                .map(|ip| Answer {
                    ip: Some(ip),
                    text: ip_text(ip),
                })
                .collect())
        })
    }
}

/// A fixed table, for tests.
pub struct StaticResolver(pub Vec<(String, Vec<String>)>);

impl Resolve for StaticResolver {
    fn resolve<'a>(&'a self, host: &'a str) -> ResolveFuture<'a> {
        Box::pin(async move {
            if let Some(a) = literal_answer(host) {
                return Ok(vec![a]);
            }
            let Some((_, list)) = self.0.iter().find(|(h, _)| h == host) else {
                return Err(io::Error::new(io::ErrorKind::NotFound, "unknown host"));
            };
            Ok(list
                .iter()
                .map(|t| Answer {
                    ip: t.parse().ok(),
                    text: t.clone(),
                })
                .collect())
        })
    }
}

/// Test builds: asks `GET <stub>/resolve?host=NAME` (a JSON array of address texts),
/// so a harness can count lookups and change the answer between them.
#[cfg(feature = "test-resolver")]
pub struct HttpStubResolver(pub String);

#[cfg(feature = "test-resolver")]
impl Resolve for HttpStubResolver {
    fn resolve<'a>(&'a self, host: &'a str) -> ResolveFuture<'a> {
        Box::pin(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            if let Some(a) = literal_answer(host) {
                return Ok(vec![a]);
            }
            let base = self.0.trim_start_matches("http://").trim_end_matches('/');
            let mut s = tokio::net::TcpStream::connect(base).await?;
            let req = format!(
                "GET /resolve?host={host} HTTP/1.1\r\nHost: {base}\r\nConnection: close\r\n\r\n"
            );
            s.write_all(req.as_bytes()).await?;
            let mut buf = Vec::new();
            s.read_to_end(&mut buf).await?;
            let text = String::from_utf8_lossy(&buf).to_string();
            let body = text.split_once("\r\n\r\n").map(|x| x.1).unwrap_or("");
            let list: Vec<String> = serde_json::from_str(body)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            if list.is_empty() {
                return Err(io::Error::new(io::ErrorKind::NotFound, "no addresses"));
            }
            Ok(list
                .into_iter()
                .map(|t| Answer {
                    ip: t.parse().ok(),
                    text: t,
                })
                .collect())
        })
    }
}

/// The resolver the binary uses.
pub fn default_resolver() -> Box<dyn Resolve> {
    #[cfg(feature = "test-resolver")]
    if let Ok(stub) = std::env::var("SB_EGRESS_TEST_RESOLVER") {
        if !stub.is_empty() {
            return Box::new(HttpStubResolver(stub));
        }
    }
    Box::new(SystemResolver)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literals_answer_themselves() {
        assert!(is_ip_literal("1.2.3.4"));
        assert!(is_ip_literal("::1"));
        assert!(is_ip_literal("fe80::1%eth0"));
        assert!(!is_ip_literal("0177.0.0.1"));
        assert!(!is_ip_literal("example.com"));
        let a = literal_answer("::ffff:7f00:1").unwrap();
        assert_eq!(a.text, "::ffff:7f00:1");
        assert!(a.ip.is_some());
        assert_eq!(literal_answer("fe80::1%eth0").unwrap().ip, None);
        assert_eq!(literal_answer("example.com"), None);
    }

    #[tokio::test]
    async fn slow_lookup_times_out() {
        let slots = Arc::new(Semaphore::new(1));
        let r = bounded(slots.clone(), Duration::from_millis(100), async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Ok(())
        })
        .await;
        assert_eq!(r.unwrap_err().kind(), io::ErrorKind::TimedOut);
        // The slot stays taken while the stuck lookup runs, so a second one times out too.
        let r = bounded(slots, Duration::from_millis(100), async { Ok(()) }).await;
        assert_eq!(r.unwrap_err().kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn system_resolver_does_not_look_up_literals() {
        let r = SystemResolver.resolve("10.1.2.3").await.unwrap();
        assert_eq!(
            r,
            vec![Answer {
                ip: Some("10.1.2.3".parse().unwrap()),
                text: "10.1.2.3".into()
            }]
        );
    }
}
