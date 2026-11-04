//! #38: a small in-memory edge response cache (port of `cache.ts`). One
//! process, one node. Only anonymous GETs whose response explicitly opts in
//! (`Cache-Control: public` with `max-age` / `s-maxage`) are stored, bounded by
//! an entry count and a total-byte cap, evicted oldest-first (FIFO).

use crate::util::{header_joined, js_number, now_ms};
use bytes::Bytes;
use hyper::header::{HeaderMap, HeaderName, HeaderValue};
use hyper::Method;
use regex::Regex;
use std::collections::{HashMap, VecDeque};
use std::sync::OnceLock;

pub const MAX_CACHE_ENTRY_BYTES: u64 = 512 * 1024;

/// Only anonymous GETs without a request revalidation directive may read or fill the cache.
pub fn cache_request_eligible(method: &Method, headers: &HeaderMap) -> bool {
    if method != Method::GET {
        return false;
    }
    if headers.contains_key("authorization") || headers.contains_key("cookie") {
        return false;
    }
    ![
        "cache-control",
        "pragma",
        "if-match",
        "if-modified-since",
        "if-none-match",
        "if-unmodified-since",
        "range",
    ]
    .iter()
    .any(|name| headers.contains_key(*name))
}

struct Rx {
    opt_out: Regex,
    public: Regex,
    s_maxage: Regex,
    max_age: Regex,
}

fn rx() -> &'static Rx {
    static RX: OnceLock<Rx> = OnceLock::new();
    RX.get_or_init(|| {
        let directive = |name: &str| {
            Regex::new(&format!(r"(?:^|,)\s*{name}\s*=\s*([^,]+)\s*")).expect("static regex")
        };
        Rx {
            opt_out: Regex::new(
                r#"(^|,)\s*(no-store|private|no-cache)(?:\s*=\s*(?:"[^"]*"|[^,]+))?\s*(,|$)"#,
            )
            .expect("static regex"),
            public: Regex::new(r"(?i)(^|,)\s*public\s*(?:,|$)").expect("static regex"),
            s_maxage: directive("s-maxage"),
            max_age: directive("max-age"),
        }
    })
}

/// `Some(Some(n))` a single well-formed value, `Some(None)` malformed or repeated, `None` absent.
fn directive(rx: &Regex, cc: &str) -> Option<Option<f64>> {
    let values: Vec<&str> = rx
        .captures_iter(cc)
        .filter_map(|c| c.get(1))
        .map(|m| m.as_str())
        .collect();
    match values.as_slice() {
        [] => None,
        [one] if !one.is_empty() && one.bytes().all(|b| b.is_ascii_digit()) => {
            Some(Some(js_number(one)))
        }
        _ => Some(None),
    }
}

/// Seconds a response may be cached, or `None` if it must not be.
pub fn cacheable_for_seconds(cache_control: Option<&str>) -> Option<f64> {
    let cc = cache_control.filter(|c| !c.is_empty())?.to_lowercase();
    let rx = rx();
    if rx.opt_out.is_match(&cc) {
        return None;
    }
    let s_max_age = directive(&rx.s_maxage, &cc);
    let max_age = directive(&rx.max_age, &cc);
    if matches!(s_max_age, Some(None)) || matches!(max_age, Some(None)) {
        return None;
    }
    let seconds = s_max_age
        .flatten()
        .or(max_age.flatten())
        .unwrap_or(f64::NAN);
    (seconds.is_finite() && seconds > 0.0).then_some(seconds)
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub struct CachePolicy {
    pub expires_at: f64,
    pub response_date_ms: f64,
}

/// A response must opt into our narrow shared-cache subset explicitly.
pub fn cache_response_eligible(headers: &HeaderMap, now: u64) -> Option<CachePolicy> {
    let control = header_joined(headers, "cache-control").filter(|c| !c.is_empty())?;
    if !rx().public.is_match(&control) {
        return None;
    }
    // Variants are not keyed, so a Vary field always bypasses; so do cookies and an existing Age.
    if headers.contains_key("vary")
        || headers.contains_key("set-cookie")
        || headers.contains_key("age")
    {
        return None;
    }
    let seconds = cacheable_for_seconds(Some(&control))?;
    let now = now as f64;
    let date_ms = match header_joined(headers, "date").filter(|d| !d.is_empty()) {
        Some(d) => httpdate::parse_http_date(&d)
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(f64::NAN, |d| d.as_millis() as f64),
        None => now,
    };
    if !date_ms.is_finite() || date_ms > now {
        return None;
    }
    let expires_at = date_ms + seconds * 1000.0;
    (now < expires_at).then_some(CachePolicy {
        expires_at,
        response_date_ms: date_ms,
    })
}

const CACHEABLE_STATUS: [u16; 5] = [200, 203, 301, 404, 410];

#[derive(Clone)]
pub struct CachedResponse {
    pub status: u16,
    pub headers: Vec<(HeaderName, HeaderValue)>,
    pub body: Bytes,
    pub expires_at: f64,
    pub stored_at: u64,
    pub age_at_store: u64,
}

struct Slot {
    entry: CachedResponse,
    seq: u64,
}

pub struct EdgeCache {
    entries: HashMap<String, Slot>,
    order: VecDeque<(String, u64)>,
    next_seq: u64,
    bytes: u64,
    max_entries: usize,
    max_bytes: u64,
    max_entry_bytes: u64,
}

impl Default for EdgeCache {
    fn default() -> Self {
        Self::new(500, 64 * 1024 * 1024, MAX_CACHE_ENTRY_BYTES)
    }
}

impl EdgeCache {
    pub fn new(max_entries: usize, max_bytes: u64, max_entry_bytes: u64) -> Self {
        EdgeCache {
            entries: HashMap::new(),
            order: VecDeque::new(),
            next_seq: 0,
            bytes: 0,
            max_entries,
            max_bytes,
            max_entry_bytes,
        }
    }

    pub fn key(host: &str, method: &str, path: &str) -> String {
        format!("{method} {host} {path}")
    }

    pub fn get(&mut self, key: &str, now: u64) -> Option<CachedResponse> {
        let slot = self.entries.get(key)?;
        if slot.entry.expires_at <= now as f64 {
            let removed = self.entries.remove(key)?;
            self.bytes -= removed.entry.body.len() as u64;
            return None;
        }
        Some(slot.entry.clone())
    }

    /// Store if the status is cacheable and the body fits one entry. Returns stored?.
    pub fn set(
        &mut self,
        key: &str,
        status: u16,
        headers: Vec<(HeaderName, HeaderValue)>,
        body: Bytes,
        age_at_store: u64,
        expires_at: f64,
    ) -> bool {
        if !CACHEABLE_STATUS.contains(&status) || body.len() as u64 > self.max_entry_bytes {
            return false;
        }
        let len = body.len() as u64;
        let entry = CachedResponse {
            status,
            headers,
            body,
            expires_at,
            stored_at: now_ms(),
            age_at_store,
        };
        // Like a JS Map, replacing a key keeps its original queue position.
        match self.entries.get_mut(key) {
            Some(slot) => {
                self.bytes -= slot.entry.body.len() as u64;
                slot.entry = entry;
            }
            None => {
                let seq = self.next_seq;
                self.next_seq += 1;
                self.order.push_back((key.to_string(), seq));
                self.entries.insert(key.to_string(), Slot { entry, seq });
            }
        }
        self.bytes += len;
        while self.entries.len() > self.max_entries || self.bytes > self.max_bytes {
            let Some((oldest, seq)) = self.order.pop_front() else {
                break;
            };
            if self.entries.get(&oldest).is_some_and(|s| s.seq == seq) {
                if let Some(removed) = self.entries.remove(&oldest) {
                    self.bytes -= removed.entry.body.len() as u64;
                }
            }
        }
        true
    }

    /// Drop every entry for one host: called when its deployment changes.
    pub fn purge_host(&mut self, host: &str) {
        let doomed: Vec<String> = self
            .entries
            .keys()
            .filter(|k| k.split(' ').nth(1) == Some(host))
            .cloned()
            .collect();
        for key in doomed {
            if let Some(removed) = self.entries.remove(&key) {
                self.bytes -= removed.entry.body.len() as u64;
            }
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn cacheable_for_seconds_honours_max_age_and_opt_outs() {
        assert_eq!(cacheable_for_seconds(None), None);
        assert_eq!(cacheable_for_seconds(Some("max-age=60")), Some(60.0));
        assert_eq!(
            cacheable_for_seconds(Some("public, max-age=300")),
            Some(300.0)
        );
        assert_eq!(
            cacheable_for_seconds(Some("max-age=60, s-maxage=120")),
            Some(120.0)
        );
        assert_eq!(cacheable_for_seconds(Some("no-store")), None);
        assert_eq!(cacheable_for_seconds(Some("private, max-age=60")), None);
        assert_eq!(cacheable_for_seconds(Some("no-cache")), None);
        assert_eq!(cacheable_for_seconds(Some("max-age=0")), None);
        assert_eq!(cacheable_for_seconds(Some("public, max-age=10junk")), None);
        assert_eq!(
            cacheable_for_seconds(Some("public, max-age=10, max-age=20")),
            None
        );
        assert_eq!(
            cacheable_for_seconds(Some("public, private=\"x\", max-age=60")),
            None
        );
    }

    #[test]
    fn shared_cache_only_accepts_anonymous_requests_without_revalidation() {
        let get = Method::GET;
        assert!(cache_request_eligible(&get, &headers(&[])));
        for (k, v) in [
            ("authorization", "Bearer secret"),
            ("cookie", "session=secret"),
            ("cache-control", "no-cache"),
            ("pragma", "no-cache"),
            ("range", "bytes=0-1"),
            ("if-none-match", "\"v1\""),
        ] {
            assert!(!cache_request_eligible(&get, &headers(&[(k, v)])), "{k}");
        }
        assert!(!cache_request_eligible(&Method::HEAD, &headers(&[])));
    }

    #[test]
    fn shared_cache_requires_public_and_refuses_variants_and_cookies() {
        let now = 1_767_225_660_000u64; // 2026-01-01T00:01:00Z
        let f = now as f64;
        assert_eq!(
            cache_response_eligible(&headers(&[("cache-control", "max-age=60")]), now),
            None
        );
        assert_eq!(
            cache_response_eligible(&headers(&[("cache-control", "public, max-age=60")]), now),
            Some(CachePolicy {
                expires_at: f + 60_000.0,
                response_date_ms: f
            })
        );
        assert_eq!(
            cache_response_eligible(
                &headers(&[
                    ("cache-control", "public, max-age=60"),
                    ("vary", "accept-language")
                ]),
                now
            ),
            None
        );
        assert_eq!(
            cache_response_eligible(
                &headers(&[
                    ("cache-control", "public, max-age=60"),
                    ("set-cookie", "s=x")
                ]),
                now
            ),
            None
        );
        assert_eq!(
            cache_response_eligible(
                &headers(&[("cache-control", "public, no-store, max-age=60")]),
                now
            ),
            None
        );
        assert_eq!(
            cache_response_eligible(
                &headers(&[("cache-control", "public, max-age=60"), ("age", "1")]),
                now
            ),
            None
        );
        assert_eq!(
            cache_response_eligible(
                &headers(&[
                    ("cache-control", "public, max-age=60"),
                    ("date", "Thu, 01 Jan 2026 00:00:30 GMT")
                ]),
                now
            ),
            Some(CachePolicy {
                expires_at: f + 30_000.0,
                response_date_ms: f - 30_000.0
            })
        );
        // a date in the future is refused
        assert_eq!(
            cache_response_eligible(
                &headers(&[
                    ("cache-control", "public, max-age=60"),
                    ("date", "Thu, 01 Jan 2026 01:00:00 GMT")
                ]),
                now
            ),
            None
        );
    }

    fn body(n: usize) -> Bytes {
        Bytes::from(vec![0u8; n])
    }
    fn far() -> f64 {
        now_ms() as f64 + 60_000.0
    }

    #[test]
    fn stores_serves_and_expires() {
        let mut cache = EdgeCache::new(10, 1 << 20, 1 << 20);
        let key = EdgeCache::key("app.test", "GET", "/x");
        let now = now_ms();
        assert!(cache.set(&key, 200, vec![], body(3), 0, now as f64 + 5_000.0));
        assert_eq!(cache.get(&key, now).map(|c| c.status), Some(200));
        assert!(cache.get(&key, now + 5_001).is_none());
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn keeps_the_origin_freshness_deadline_when_a_fill_completes_late() {
        let mut cache = EdgeCache::new(10, 1 << 20, 1 << 20);
        cache.set("late", 200, vec![], body(1), 3, 5_000.0);
        assert_eq!(cache.get("late", 4_999).map(|c| c.age_at_store), Some(3));
        assert!(cache.get("late", 5_000).is_none());
    }

    #[test]
    fn refuses_uncacheable_status_and_oversized_bodies_and_evicts_oldest() {
        let mut cache = EdgeCache::new(2, 1 << 20, 4);
        let t = far();
        assert!(!cache.set("a", 500, vec![], body(2), 0, t));
        assert!(!cache.set("b", 200, vec![], body(8), 0, t));
        assert!(cache.set("k1", 200, vec![], body(2), 0, t));
        assert!(cache.set("k2", 200, vec![], body(2), 0, t));
        assert!(cache.set("k3", 200, vec![], body(2), 0, t));
        assert!(cache.get("k1", now_ms()).is_none());
        assert_eq!(cache.get("k3", now_ms()).map(|c| c.status), Some(200));
    }

    #[test]
    fn replacing_a_key_keeps_its_queue_position() {
        let mut cache = EdgeCache::new(2, 1 << 20, 100);
        let t = far();
        cache.set("k1", 200, vec![], body(1), 0, t);
        cache.set("k2", 200, vec![], body(1), 0, t);
        cache.set("k1", 200, vec![], body(2), 0, t);
        cache.set("k3", 200, vec![], body(1), 0, t); // evicts k1, the oldest by first insertion
        assert!(cache.get("k1", now_ms()).is_none());
        assert!(cache.get("k2", now_ms()).is_some());
    }

    #[test]
    fn byte_cap_evicts() {
        let mut cache = EdgeCache::new(100, 5, 100);
        let t = far();
        cache.set("a", 200, vec![], body(3), 0, t);
        cache.set("b", 200, vec![], body(3), 0, t);
        assert!(cache.get("a", now_ms()).is_none());
        assert!(cache.get("b", now_ms()).is_some());
    }

    #[test]
    fn purge_host_drops_only_that_hosts_entries() {
        let mut cache = EdgeCache::default();
        let t = far();
        cache.set(
            &EdgeCache::key("a.test", "GET", "/x"),
            200,
            vec![],
            body(2),
            0,
            t,
        );
        cache.set(
            &EdgeCache::key("a.test", "GET", "/y"),
            200,
            vec![],
            body(2),
            0,
            t,
        );
        cache.set(
            &EdgeCache::key("b.test", "GET", "/x"),
            200,
            vec![],
            body(2),
            0,
            t,
        );
        cache.purge_host("a.test");
        assert!(cache
            .get(&EdgeCache::key("a.test", "GET", "/x"), now_ms())
            .is_none());
        assert!(cache
            .get(&EdgeCache::key("b.test", "GET", "/x"), now_ms())
            .is_some());
        assert_eq!(cache.len(), 1);
    }
}
