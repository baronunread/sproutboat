//! Design 05, option A: a route with a `backend` is forwarded to sproutd's
//! frontend instead of starting a sprout. This module validates that entry.

use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq)]
pub struct Backend {
    pub url: String,
}

fn loopback() -> &'static Regex {
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| {
        Regex::new(r"^http://(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$").expect("static regex")
    })
}

/// A backend entry from routes.json, or `None` when it is not a loopback sproutd URL.
pub fn parse_backend(value: &Value) -> Option<Backend> {
    let object = value.as_object()?;
    if object.get("kind")?.as_str()? != "sproutd" {
        return None;
    }
    let url = object.get("url")?.as_str()?;
    loopback().is_match(url).then(|| Backend {
        url: url.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_loopback_sproutd_urls() {
        for url in [
            "http://127.0.0.1:8080",
            "http://localhost:1",
            "http://[::1]:65535",
        ] {
            let parsed = parse_backend(&json!({ "kind": "sproutd", "url": url }));
            assert_eq!(
                parsed,
                Some(Backend {
                    url: url.to_string()
                }),
                "{url}"
            );
        }
    }

    #[test]
    fn refuses_everything_else() {
        for value in [
            json!({ "kind": "sproutd", "url": "http://10.0.0.1:80" }),
            json!({ "kind": "sproutd", "url": "https://127.0.0.1:80" }),
            json!({ "kind": "sproutd", "url": "http://127.0.0.1" }),
            json!({ "kind": "sproutd", "url": "http://127.0.0.1:80/" }),
            json!({ "kind": "sproutd", "url": "http://127.0.0.1:123456" }),
            json!({ "kind": "sproutd", "url": "http://evil.test:80" }),
            json!({ "kind": "sproutd", "url": "http://127.0.0.1:80\n" }),
            json!({ "kind": "other", "url": "http://127.0.0.1:80" }),
            json!({ "kind": "sproutd" }),
            json!({ "kind": "sproutd", "url": 1 }),
            json!(null),
            json!("http://127.0.0.1:80"),
            json!([]),
        ] {
            assert_eq!(parse_backend(&value), None, "{value}");
        }
    }
}
