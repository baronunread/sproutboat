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
}
