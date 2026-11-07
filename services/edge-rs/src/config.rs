//! Environment configuration: the same variables, defaults and fallbacks as the Bun edge.

use crate::util::js_number;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub bind_host: String,
    pub routes_path: PathBuf,
    pub log_path: Option<String>,
    pub request_timeout_ms: f64,
    pub transfer_timeout_ms: f64,
    pub max_body_bytes: f64,
    pub response_max_bytes: f64,
    pub cache_enabled: bool,
    pub deployment_domain: String,
    pub dashboard_url: String,
    pub activation_dir: Option<String>,
    /// Backend mode: the loopback http base (`http://127.0.0.1:8600`) everything that is not a
    /// static asset is forwarded to. `None` is the Community edge.
    pub backend: Option<String>,
    /// Backend mode: total bytes of the asset LRU (0 = off).
    pub asset_cache_bytes: u64,
    /// Backend mode: the largest single blob the LRU keeps.
    pub asset_cache_entry_bytes: u64,
    /// Backend mode: the Cloud apps domain (`sproutboat.app`). When set, `Set-Cookie` lines on
    /// hosts under it may not name a `Domain` wider than their own account
    /// (`<account>.<apps domain>`). `None` (unset) is off.
    pub apps_domain: Option<String>,
}

/// A non-negative whole number; unset, empty and garbage fall back, and an explicit 0 stays 0.
fn bytes_or(get: &impl Fn(&str) -> Option<String>, name: &str, fallback: u64) -> u64 {
    let n = env_or_empty(get, name).map_or(f64::NAN, |v| js_number(&v));
    if n.is_finite() && n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&n) {
        n as u64
    } else {
        fallback
    }
}

/// `SPROUTBOAT_EDGE_BACKEND`: an http URL on a loopback host, nothing else. Returns the base
/// without a trailing slash.
fn backend_base(raw: &str) -> Result<String, String> {
    let invalid = || {
        format!("invalid SPROUTBOAT_EDGE_BACKEND: {raw} (want a loopback http URL such as http://127.0.0.1:8600)")
    };
    let url = url::Url::parse(raw).map_err(|_| invalid())?;
    let loopback = match url.host() {
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if url.scheme() != "http"
        || !loopback
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let host = url.host_str().ok_or_else(invalid)?;
    Ok(format!(
        "http://{host}:{}",
        url.port_or_known_default().unwrap_or(80)
    ))
}

/// `process.env.X || fallback`: unset and empty both fall back.
fn env_or_empty(get: &impl Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    get(name).filter(|v| !v.is_empty())
}

/// `Number(env) || fallback`: NaN and 0 fall back.
fn number_or(get: &impl Fn(&str) -> Option<String>, name: &str, fallback: f64) -> f64 {
    let n = get(name).map_or(f64::NAN, |v| js_number(&v));
    if n.is_nan() || n == 0.0 {
        fallback
    } else {
        n
    }
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        Config::from_lookup(|name| std::env::var(name).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Config, String> {
        let port = match env_or_empty(&get, "PORT") {
            None => 8080,
            Some(raw) => {
                let n = js_number(&raw);
                if n.fract() != 0.0 || !(0.0..=65535.0).contains(&n) {
                    return Err(format!("invalid PORT: {raw}"));
                }
                n as u16
            }
        };
        let routes_path = {
            let raw = env_or_empty(&get, "SPROUTBOAT_ROUTE_SNAPSHOT")
                .unwrap_or_else(|| "routes.json".into());
            std::path::absolute(&raw).unwrap_or_else(|_| PathBuf::from(raw))
        };
        // Bun rejects request bodies above its own server limit before fetch() runs.
        let configured = get("SPROUTBOAT_EDGE_MAX_BODY_BYTES").map_or(f64::NAN, |v| js_number(&v));
        let max_body_bytes = if configured.is_finite()
            && configured.fract() == 0.0
            && configured > 0.0
            && configured <= 9_007_199_254_740_991.0
        {
            configured
        } else {
            5.0 * 1024.0 * 1024.0 * 1024.0
        };
        let deployment_domain = env_or_empty(&get, "SPROUTBOAT_DEPLOYMENT_DOMAIN")
            .unwrap_or_else(|| "sproutboat.local".into())
            .to_lowercase();
        let dashboard = env_or_empty(&get, "SPROUTBOAT_DASHBOARD_URL")
            .unwrap_or_else(|| format!("https://dashboard.{deployment_domain}"));
        let dashboard_url = dashboard
            .strip_suffix('/')
            .unwrap_or(&dashboard)
            .to_string();
        let backend = match env_or_empty(&get, "SPROUTBOAT_EDGE_BACKEND") {
            Some(raw) => Some(backend_base(&raw)?),
            None => None,
        };
        let apps_domain = env_or_empty(&get, "SPROUTBOAT_EDGE_APPS_DOMAIN")
            .map(|raw| raw.trim().trim_matches('.').to_lowercase())
            .filter(|d| !d.is_empty())
            .filter(|_| backend.is_some());
        Ok(Config {
            port,
            bind_host: env_or_empty(&get, "SPROUTBOAT_BIND_HOST")
                .unwrap_or_else(|| "127.0.0.1".into()),
            routes_path,
            log_path: env_or_empty(&get, "SPROUTBOAT_LOG_PATH"),
            request_timeout_ms: number_or(&get, "SPROUTBOAT_REQUEST_TIMEOUT_MS", 30_000.0),
            transfer_timeout_ms: number_or(&get, "SPROUTBOAT_TRANSFER_TIMEOUT_MS", 10.0 * 60_000.0),
            max_body_bytes,
            response_max_bytes: number_or(
                &get,
                "SPROUTBOAT_RESPONSE_MAX_BYTES",
                512.0 * 1024.0 * 1024.0,
            ),
            cache_enabled: get("SPROUTBOAT_EDGE_CACHE").as_deref() != Some("off"),
            deployment_domain,
            dashboard_url,
            activation_dir: env_or_empty(&get, "SPROUTBOAT_ACTIVATION_DIR"),
            backend,
            apps_domain,
            asset_cache_bytes: bytes_or(&get, "SPROUTBOAT_ASSET_CACHE_BYTES", 64 * 1024 * 1024),
            asset_cache_entry_bytes: bytes_or(
                &get,
                "SPROUTBOAT_ASSET_CACHE_ENTRY_BYTES",
                256 * 1024,
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(pairs: &[(&str, &str)]) -> Result<Config, String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|name| map.get(name).cloned())
    }

    #[test]
    fn defaults_match_the_bun_edge() {
        let c = config(&[]).unwrap();
        assert_eq!((c.port, c.bind_host.as_str()), (8080, "127.0.0.1"));
        assert_eq!(c.request_timeout_ms, 30_000.0);
        assert_eq!(c.transfer_timeout_ms, 600_000.0);
        assert_eq!(c.max_body_bytes, 5.0 * 1024.0 * 1024.0 * 1024.0);
        assert_eq!(c.response_max_bytes, 512.0 * 1024.0 * 1024.0);
        assert!(c.cache_enabled);
        assert_eq!(c.deployment_domain, "sproutboat.local");
        assert_eq!(c.dashboard_url, "https://dashboard.sproutboat.local");
        assert!(c.routes_path.is_absolute() && c.routes_path.ends_with("routes.json"));
    }

    #[test]
    fn zero_and_garbage_fall_back_and_port_zero_is_allowed() {
        let c = config(&[
            ("PORT", "0"),
            ("SPROUTBOAT_REQUEST_TIMEOUT_MS", "0"),
            ("SPROUTBOAT_TRANSFER_TIMEOUT_MS", "soon"),
            ("SPROUTBOAT_EDGE_MAX_BODY_BYTES", "-5"),
            ("SPROUTBOAT_RESPONSE_MAX_BYTES", ""),
        ])
        .unwrap();
        assert_eq!(c.port, 0);
        assert_eq!(c.request_timeout_ms, 30_000.0);
        assert_eq!(c.transfer_timeout_ms, 600_000.0);
        assert_eq!(c.max_body_bytes, 5.0 * 1024.0 * 1024.0 * 1024.0);
        assert_eq!(c.response_max_bytes, 512.0 * 1024.0 * 1024.0);
        assert!(config(&[("PORT", "abc")]).is_err());
    }

    #[test]
    fn overrides_and_dashboard_trailing_slash() {
        let c = config(&[
            ("SPROUTBOAT_DEPLOYMENT_DOMAIN", "Sb.Test"),
            ("SPROUTBOAT_EDGE_MAX_BODY_BYTES", "100"),
            ("SPROUTBOAT_EDGE_CACHE", "off"),
            ("SPROUTBOAT_LOG_PATH", "/tmp/x.ndjson"),
        ])
        .unwrap();
        assert_eq!(c.deployment_domain, "sb.test");
        assert_eq!(c.dashboard_url, "https://dashboard.sb.test");
        assert_eq!(c.max_body_bytes, 100.0);
        assert!(!c.cache_enabled);
        let c = config(&[("SPROUTBOAT_DASHBOARD_URL", "https://dash.example/app/")]).unwrap();
        assert_eq!(c.dashboard_url, "https://dash.example/app");
    }

    #[test]
    fn apps_domain_is_backend_mode_only_and_normalised() {
        let apps = |pairs: &[(&str, &str)]| config(pairs).unwrap().apps_domain;
        let b = ("SPROUTBOAT_EDGE_BACKEND", "http://127.0.0.1:8600");
        assert_eq!(apps(&[b]), None);
        assert_eq!(apps(&[b, ("SPROUTBOAT_EDGE_APPS_DOMAIN", "")]), None);
        assert_eq!(
            apps(&[b, ("SPROUTBOAT_EDGE_APPS_DOMAIN", " .SproutBoat.app. ")]).as_deref(),
            Some("sproutboat.app")
        );
        // without a backend the guard is off, so Community behaviour cannot change
        assert_eq!(
            apps(&[("SPROUTBOAT_EDGE_APPS_DOMAIN", "sproutboat.app")]),
            None
        );
    }

    #[test]
    fn backend_is_a_loopback_http_url() {
        let c = config(&[]).unwrap();
        assert_eq!(c.backend, None);
        assert_eq!(c.asset_cache_bytes, 64 * 1024 * 1024);
        assert_eq!(c.asset_cache_entry_bytes, 256 * 1024);
        let ok = |raw: &str| config(&[("SPROUTBOAT_EDGE_BACKEND", raw)]).unwrap().backend;
        assert_eq!(
            ok("http://127.0.0.1:8600").as_deref(),
            Some("http://127.0.0.1:8600")
        );
        assert_eq!(
            ok("http://127.0.0.1:8600/").as_deref(),
            Some("http://127.0.0.1:8600")
        );
        assert_eq!(
            ok("http://localhost:9").as_deref(),
            Some("http://localhost:9")
        );
        assert_eq!(
            ok("http://[::1]:8600").as_deref(),
            Some("http://[::1]:8600")
        );
        assert_eq!(
            ok("http://127.0.0.1").as_deref(),
            Some("http://127.0.0.1:80")
        );
        for bad in [
            "https://127.0.0.1:8600",
            "http://10.0.0.1:8600",
            "http://example.com",
            "127.0.0.1:8600",
            "http://127.0.0.1:8600/x",
            "http://u:p@127.0.0.1:8600",
            "http://127.0.0.1:8600/?a=1",
        ] {
            let err = config(&[("SPROUTBOAT_EDGE_BACKEND", bad)]).unwrap_err();
            assert!(
                err.starts_with("invalid SPROUTBOAT_EDGE_BACKEND"),
                "{bad}: {err}"
            );
        }
    }

    #[test]
    fn asset_cache_sizes() {
        let c = config(&[
            ("SPROUTBOAT_ASSET_CACHE_BYTES", "0"),
            ("SPROUTBOAT_ASSET_CACHE_ENTRY_BYTES", "1024"),
        ])
        .unwrap();
        assert_eq!((c.asset_cache_bytes, c.asset_cache_entry_bytes), (0, 1024));
        let c = config(&[
            ("SPROUTBOAT_ASSET_CACHE_BYTES", "lots"),
            ("SPROUTBOAT_ASSET_CACHE_ENTRY_BYTES", "-1"),
        ])
        .unwrap();
        assert_eq!(
            (c.asset_cache_bytes, c.asset_cache_entry_bytes),
            (64 * 1024 * 1024, 256 * 1024)
        );
    }
}
