//! The route snapshot (`routes.json`): loader and validation exactly as the Bun
//! edge's `loadRoutes`, plus the timed-bindings hint used for reconciliation.

use regex::Regex;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};

#[derive(Debug, Clone, PartialEq)]
pub struct R2 {
    pub owner_id: String,
    pub resource_ids: Vec<String>,
    pub do_store_id: Option<String>,
}

impl R2 {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("ownerId".into(), Value::String(self.owner_id.clone()));
        m.insert(
            "resourceIds".into(),
            Value::Array(
                self.resource_ids
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
        if let Some(id) = &self.do_store_id {
            m.insert("doStoreId".into(), Value::String(id.clone()));
        }
        Value::Object(m)
    }
}

/// `secrets_path` / `secrets_hash` are present when the project has at least one
/// secret (#2). `services` (#48) maps a service binding to the hostname it calls.
#[derive(Debug, Clone)]
pub struct Route {
    pub sprout_path: String,
    pub secrets_path: Option<String>,
    pub secrets_hash: Option<String>,
    pub services: Option<Vec<(String, String)>>,
    pub r2: Option<R2>,
    /// `runtime_json()`, computed once at load: what the sidecar is asked about.
    pub runtime: Value,
    /// The runtime identity as a string: the key of the edge's endpoint cache.
    pub key: String,
}

impl Route {
    pub fn services_json(&self) -> Value {
        match &self.services {
            None => Value::Null,
            Some(pairs) => Value::Object(
                pairs
                    .iter()
                    .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                    .collect(),
            ),
        }
    }

    /// The runtime identity the supervisor pool keys a sprout by, as the JSON the sidecar takes.
    pub fn runtime_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("sproutPath".into(), Value::String(self.sprout_path.clone()));
        m.insert(
            "secretsPath".into(),
            self.secrets_path.clone().map_or(Value::Null, Value::String),
        );
        m.insert("services".into(), self.services_json());
        m.insert(
            "r2".into(),
            self.r2.as_ref().map_or(Value::Null, R2::to_json),
        );
        Value::Object(m)
    }

    /// Whether a running sprout of the old route is stale for the new one.
    pub fn runtime_changed(&self, next: &Route) -> bool {
        next.sprout_path != self.sprout_path
            || next.secrets_hash != self.secrets_hash
            || next.r2 != self.r2
            || next.services != self.services
    }
}

/// Hostname -> route, remembering file order (the pool wakes timed sprouts in that order).
#[derive(Default)]
pub struct Routes {
    by_host: HashMap<String, Arc<Route>>,
    order: Vec<String>,
}

impl Routes {
    pub fn get(&self, host: &str) -> Option<&Arc<Route>> {
        self.by_host.get(host)
    }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &Arc<Route>)> {
        self.order
            .iter()
            .filter_map(|h| self.by_host.get_key_value(h))
    }
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.order.len()
    }
    fn insert(&mut self, host: String, route: Route) {
        if self.by_host.insert(host.clone(), Arc::new(route)).is_none() {
            self.order.push(host);
        }
    }
}

fn host_rx() -> &'static Regex {
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| Regex::new(r"^[a-z0-9.-]+$").expect("static regex"))
}
fn binding_rx() -> &'static Regex {
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| Regex::new(r"^[A-Z][A-Z0-9_]*$").expect("static regex"))
}
fn resource_rx() -> &'static Regex {
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| Regex::new(r"^r2_[a-f0-9]{24}$").expect("static regex"))
}
fn do_store_rx() -> &'static Regex {
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| Regex::new(r"^do_[a-f0-9]{24}$").expect("static regex"))
}

const INVALID: &str = "invalid route snapshot";

/// Parse and validate a snapshot. Any malformed entry fails the whole snapshot.
pub fn load_routes(text: &str) -> Result<Routes, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let Value::Array(entries) = value else {
        return Err(INVALID.into());
    };
    let mut result = Routes::default();
    for entry in &entries {
        let obj = entry.as_object().ok_or(INVALID)?;
        let hostname = obj.get("hostname").and_then(Value::as_str).ok_or(INVALID)?;
        let sprout_path = obj
            .get("sproutPath")
            .and_then(Value::as_str)
            .ok_or(INVALID)?;
        if !host_rx().is_match(hostname) || !sprout_path.starts_with('/') {
            return Err(INVALID.into());
        }
        let secrets_path = obj
            .get("secretsPath")
            .and_then(Value::as_str)
            .filter(|p| p.starts_with('/'))
            .map(str::to_string);
        // Only well-formed binding -> hostname pairs survive; a bad entry drops that one binding.
        let mut services = None;
        if let Some(Value::Object(map)) = obj.get("services") {
            let pairs: Vec<(String, String)> = map
                .iter()
                .filter_map(|(binding, host)| {
                    let host = host.as_str()?;
                    (binding_rx().is_match(binding) && host_rx().is_match(host))
                        .then(|| (binding.clone(), host.to_string()))
                })
                .collect();
            if !pairs.is_empty() {
                services = Some(pairs);
            }
        }
        let owner_id = obj
            .get("ownerId")
            .and_then(Value::as_str)
            .filter(|id| id.encode_utf16().count() <= 256 && !id.contains('\0'));
        let resource_ids: Vec<String> = match obj.get("r2ResourceIds") {
            Some(Value::Array(ids)) => ids
                .iter()
                .filter_map(Value::as_str)
                .filter(|id| resource_rx().is_match(id))
                .map(str::to_string)
                .collect(),
            _ => Vec::new(),
        };
        let r2 = owner_id.map(|owner| R2 {
            owner_id: owner.to_string(),
            resource_ids,
            do_store_id: obj
                .get("doStoreId")
                .and_then(Value::as_str)
                .filter(|id| do_store_rx().is_match(id))
                .map(str::to_string),
        });
        let mut route = Route {
            sprout_path: sprout_path.to_string(),
            secrets_path,
            secrets_hash: obj
                .get("secretsHash")
                .and_then(Value::as_str)
                .map(str::to_string),
            services,
            r2,
            runtime: Value::Null,
            key: String::new(),
        };
        route.runtime = route.runtime_json();
        route.key = route.runtime.to_string();
        result.insert(hostname.to_string(), route);
    }
    Ok(result)
}

/// Timed work is broker-originated, so its sprout must be woken independently of
/// HTTP traffic. A malformed or missing bindings file is not a reason to pin an app.
pub fn has_timed_bindings(sprout_path: &str) -> bool {
    let Some(dir) = Path::new(sprout_path).parent() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(dir.join("bindings.json")) else {
        return false;
    };
    let Ok(Value::Object(bindings)) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    ["queues", "crons", "do"]
        .iter()
        .any(|k| matches!(bindings.get(*k), Some(Value::Array(a)) if !a.is_empty()))
}

/// The routes whose sprout must stay up for cron / queue / alarm dispatch, as
/// the sidecar's `/reconcile` body.
pub fn timed_sprouts(routes: &Routes) -> Vec<Value> {
    routes
        .iter()
        .filter(|(_, r)| has_timed_bindings(&r.sprout_path))
        .map(|(_, r)| r.runtime_json())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(json: &str) -> Routes {
        load_routes(json).unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn loads_a_minimal_route() {
        let routes = ok(r#"[{"hostname":"app.test","sproutPath":"/a/sprout"}]"#);
        let r = routes.get("app.test").unwrap();
        assert_eq!(r.sprout_path, "/a/sprout");
        assert!(r.secrets_path.is_none() && r.services.is_none() && r.r2.is_none());
    }

    #[test]
    fn rejects_malformed_snapshots() {
        for bad in [
            r#"{}"#,
            r#"[1]"#,
            r#"[{"hostname":"App.test","sproutPath":"/a"}]"#,
            r#"[{"hostname":"a b","sproutPath":"/a"}]"#,
            r#"[{"hostname":"a.test","sproutPath":"relative"}]"#,
            r#"[{"hostname":"a.test"}]"#,
            r#"[{"hostname":1,"sproutPath":"/a"}]"#,
            r#"not json"#,
        ] {
            assert!(load_routes(bad).is_err(), "{bad}");
        }
        assert_eq!(
            load_routes("{}").err().as_deref(),
            Some("invalid route snapshot")
        );
    }

    #[test]
    fn secrets_path_must_be_absolute_and_hash_a_string() {
        let routes = ok(
            r#"[{"hostname":"a.test","sproutPath":"/a","secretsPath":"rel","secretsHash":"h"},
                {"hostname":"b.test","sproutPath":"/a","secretsPath":"/s.json","secretsHash":7}]"#,
        );
        let a = routes.get("a.test").unwrap();
        assert_eq!(
            (a.secrets_path.clone(), a.secrets_hash.clone()),
            (None, Some("h".into()))
        );
        let b = routes.get("b.test").unwrap();
        assert_eq!(
            (b.secrets_path.clone(), b.secrets_hash.clone()),
            (Some("/s.json".into()), None)
        );
    }

    #[test]
    fn services_keep_only_well_formed_pairs() {
        let routes = ok(
            r#"[{"hostname":"a.test","sproutPath":"/a","services":{"AUTH":"auth.test","bad":"x.test","API":"BAD HOST","N":5}}]"#,
        );
        assert_eq!(
            routes.get("a.test").unwrap().services,
            Some(vec![("AUTH".to_string(), "auth.test".to_string())])
        );
        let none = ok(r#"[{"hostname":"a.test","sproutPath":"/a","services":{"bad":"x"}}]"#);
        assert!(none.get("a.test").unwrap().services.is_none());
    }

    #[test]
    fn r2_needs_an_owner_and_filters_ids() {
        let routes = ok(&format!(
            r#"[{{"hostname":"a.test","sproutPath":"/a","ownerId":"u1","r2ResourceIds":["r2_{h}","nope",3],"doStoreId":"do_{h}"}},
                {{"hostname":"b.test","sproutPath":"/a","r2ResourceIds":["r2_{h}"]}},
                {{"hostname":"c.test","sproutPath":"/a","ownerId":"u\u0000x"}},
                {{"hostname":"d.test","sproutPath":"/a","ownerId":"u1","doStoreId":"do_bad"}}]"#,
            h = "a".repeat(24)
        ));
        let a = routes.get("a.test").unwrap().r2.clone().unwrap();
        assert_eq!(a.owner_id, "u1");
        assert_eq!(a.resource_ids, vec![format!("r2_{}", "a".repeat(24))]);
        assert_eq!(a.do_store_id, Some(format!("do_{}", "a".repeat(24))));
        assert!(routes.get("b.test").unwrap().r2.is_none());
        assert!(routes.get("c.test").unwrap().r2.is_none());
        assert_eq!(
            routes
                .get("d.test")
                .unwrap()
                .r2
                .clone()
                .unwrap()
                .do_store_id,
            None
        );
    }

    #[test]
    fn an_unknown_backend_field_is_ignored_like_any_other_extra_field() {
        // The Bun edge reads only the fields it knows; there is no route kind but the supervisor's.
        let routes = ok(
            r#"[{"hostname":"a.test","sproutPath":"/a","backend":{"kind":"other","url":"x"}},
                {"hostname":"b.test","sproutPath":"/b","backend":null}]"#,
        );
        assert_eq!(routes.iter().count(), 2);
    }

    #[test]
    fn file_order_is_kept_and_duplicates_overwrite_in_place() {
        let routes = ok(
            r#"[{"hostname":"b.test","sproutPath":"/1"},{"hostname":"a.test","sproutPath":"/2"},{"hostname":"b.test","sproutPath":"/3"}]"#,
        );
        let order: Vec<_> = routes
            .iter()
            .map(|(h, r)| (h.clone(), r.sprout_path.clone()))
            .collect();
        assert_eq!(
            order,
            [
                ("b.test".to_string(), "/3".to_string()),
                ("a.test".to_string(), "/2".to_string())
            ]
        );
        assert_eq!(routes.len(), 2);
    }

    #[test]
    fn timed_bindings_hint() {
        let dir = tempfile::tempdir().unwrap();
        let sprout = dir.path().join("sprout");
        let path = sprout.to_str().unwrap();
        assert!(!has_timed_bindings(path)); // no bindings.json
        let write = |s: &str| std::fs::write(dir.path().join("bindings.json"), s).unwrap();
        write("not json");
        assert!(!has_timed_bindings(path));
        write(r#"{"queues":[],"crons":[],"do":[]}"#);
        assert!(!has_timed_bindings(path));
        write(r#"{"crons":[{"schedule":"* * * * *"}]}"#);
        assert!(has_timed_bindings(path));
        write(r#"{"do":[1]}"#);
        assert!(has_timed_bindings(path));
        write(r#"{"queues":"yes"}"#);
        assert!(!has_timed_bindings(path));
        write("null");
        assert!(!has_timed_bindings(path));
    }

    #[test]
    fn timed_sprouts_carry_the_runtime_identity() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("bindings.json"), r#"{"crons":[1]}"#).unwrap();
        let sprout = dir.path().join("sprout");
        let json = format!(
            r#"[{{"hostname":"t.test","sproutPath":"{p}","secretsPath":"/s.json","services":{{"A":"a.test"}}}}]"#,
            p = sprout.display()
        );
        let timed = timed_sprouts(&ok(&json));
        assert_eq!(timed.len(), 1);
        assert_eq!(timed[0]["secretsPath"], "/s.json");
        assert_eq!(timed[0]["services"]["A"], "a.test");
        assert!(timed[0]["r2"].is_null());
    }

    #[test]
    fn runtime_change_detection() {
        let a = &ok(r#"[{"hostname":"a.test","sproutPath":"/a","secretsHash":"1"}]"#);
        let b = &ok(r#"[{"hostname":"a.test","sproutPath":"/a","secretsHash":"2"}]"#);
        let c = &ok(
            r#"[{"hostname":"a.test","sproutPath":"/a","secretsHash":"1","services":{"X":"y.test"}}]"#,
        );
        let (ra, rb, rc) = (
            a.get("a.test").unwrap(),
            b.get("a.test").unwrap(),
            c.get("a.test").unwrap(),
        );
        assert!(ra.runtime_changed(rb));
        assert!(ra.runtime_changed(rc)); // a changed services map disposes (the Bun edge missed this)
    }
}
