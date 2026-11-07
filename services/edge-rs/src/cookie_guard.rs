//! Cross-account cookie guard (backend mode, Sproutboat Cloud).
//!
//! Tenant apps live at `<app>.<account>.<appsDomain>`. Until the apps domain is on the Public
//! Suffix List a browser treats every account as one site, so one account's app could set a
//! cookie for `.<appsDomain>` or `.<other-account>.<appsDomain>` (cookie tossing). The boundary
//! is per account, like `<worker>.<account>.workers.dev`: apps of one account may share cookies
//! on `<account>.<appsDomain>`, nothing wider and nothing sideways.
//!
//! A `Set-Cookie` without a `Domain` attribute is host-only and always passes. One with a
//! `Domain` passes only when it is the account scope or a suffix of the request host that is
//! still inside it; otherwise the whole cookie is dropped (never rewritten). Hosts outside the
//! apps domain (custom domains) are not touched. Prefixes (`__Host-`, `__Secure-`) are not
//! inspected. Cookies a page sets with `document.cookie` never pass through here.

use hyper::header::{HeaderMap, HeaderValue};

/// What a request host means to the guard.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Scope {
    /// Not under the apps domain (a custom domain): nothing is inspected.
    Outside,
    /// Under the apps domain with no account label (the apex itself): no `Domain` is allowed.
    NoAccount,
    /// `<account>.<appsDomain>`: the widest `Domain` a cookie may name.
    Account(String),
}

/// `host` is lowercase without a port; `apps_domain` is lowercase without dots at the ends.
pub(crate) fn scope_of(host: &str, apps_domain: &str) -> Scope {
    if host == apps_domain {
        return Scope::NoAccount;
    }
    let Some(prefix) = host
        .strip_suffix(apps_domain)
        .and_then(|p| p.strip_suffix('.'))
    else {
        return Scope::Outside;
    };
    // The label right below the apps domain is the account.
    let account = prefix.rsplit('.').next().unwrap_or(prefix);
    if account.is_empty() {
        return Scope::NoAccount;
    }
    Scope::Account(format!("{account}.{apps_domain}"))
}

fn domain_allowed(domain: &str, host: &str, scope: &str) -> bool {
    let inside = domain == scope
        || domain
            .strip_suffix(scope)
            .is_some_and(|p| p.ends_with('.') && p.len() > 1);
    let of_host = host == domain || host.strip_suffix(domain).is_some_and(|p| p.ends_with('.'));
    inside && of_host
}

/// Whether one `Set-Cookie` line may pass for `host`.
fn cookie_allowed(line: &str, host: &str, scope: &Scope) -> bool {
    let mut allowed = true;
    for attr in line.split(';').skip(1) {
        let (key, value) = attr.split_once('=').unwrap_or((attr, ""));
        if !key.trim().eq_ignore_ascii_case("domain") {
            continue;
        }
        let value = value.trim().to_ascii_lowercase();
        let domain = value.strip_prefix('.').unwrap_or(&value);
        allowed &= match scope {
            Scope::Account(scope) => domain_allowed(domain, host, scope),
            _ => false,
        };
    }
    allowed
}

/// Drops the cookies `host` may not set; returns how many were dropped.
pub(crate) fn guard_set_cookies(headers: &mut HeaderMap, host: &str, apps_domain: &str) -> u64 {
    let scope = scope_of(host, apps_domain);
    if scope == Scope::Outside || !headers.contains_key("set-cookie") {
        return 0;
    }
    let cookies: Vec<HeaderValue> = headers.get_all("set-cookie").iter().cloned().collect();
    headers.remove("set-cookie");
    let mut stripped = 0;
    for cookie in cookies {
        // Not text: it cannot be inspected, so it is not passed on.
        let ok = cookie
            .to_str()
            .is_ok_and(|line| cookie_allowed(line, host, &scope));
        if ok {
            headers.append("set-cookie", cookie);
        } else {
            stripped += 1;
        }
    }
    stripped
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPS: &str = "sproutboat.app";

    fn run(host: &str, lines: &[&str]) -> (Vec<String>, u64) {
        let mut h = HeaderMap::new();
        for l in lines {
            h.append("set-cookie", HeaderValue::from_str(l).unwrap());
        }
        let n = guard_set_cookies(&mut h, host, APPS);
        let got = h
            .get_all("set-cookie")
            .iter()
            .map(|v| v.to_str().unwrap().to_string())
            .collect();
        (got, n)
    }

    fn kept(host: &str, line: &str) -> bool {
        run(host, &[line]).1 == 0
    }

    const HOST: &str = "blog.acme.sproutboat.app";

    #[test]
    fn scopes() {
        assert_eq!(scope_of(APPS, APPS), Scope::NoAccount);
        assert_eq!(scope_of("evil-sproutboat.app", APPS), Scope::Outside);
        assert_eq!(scope_of("example.com", APPS), Scope::Outside);
        assert_eq!(
            scope_of(HOST, APPS),
            Scope::Account("acme.sproutboat.app".into())
        );
        assert_eq!(
            scope_of("a.b.acme.sproutboat.app", APPS),
            Scope::Account("acme.sproutboat.app".into())
        );
        assert_eq!(
            scope_of("acme.sproutboat.app", APPS),
            Scope::Account("acme.sproutboat.app".into())
        );
    }

    #[test]
    fn same_account_parent_is_kept() {
        assert!(kept(HOST, "a=1; Domain=acme.sproutboat.app; Path=/"));
        assert!(kept(HOST, "a=1; Domain=.acme.sproutboat.app"));
        assert!(kept(HOST, "a=1; Domain=blog.acme.sproutboat.app"));
        assert!(kept(
            "a.b.acme.sproutboat.app",
            "a=1; Domain=b.acme.sproutboat.app"
        ));
        assert!(kept(
            "acme.sproutboat.app",
            "a=1; Domain=acme.sproutboat.app"
        ));
    }

    #[test]
    fn wider_sideways_and_unrelated_are_stripped() {
        assert!(!kept(HOST, "a=1; Domain=sproutboat.app"));
        assert!(!kept(HOST, "a=1; Domain=.sproutboat.app"));
        assert!(!kept(HOST, "a=1; Domain=other.sproutboat.app"));
        assert!(!kept(HOST, "a=1; Domain=shop.acme.sproutboat.app"));
        assert!(!kept(HOST, "a=1; Domain=x.other.sproutboat.app"));
        assert!(!kept(HOST, "a=1; Domain=example.com"));
        assert!(!kept(HOST, "a=1; Domain=app"));
        assert!(!kept(HOST, "a=1; Domain=evilacme.sproutboat.app"));
        assert!(!kept(HOST, "a=1; Domain=com"));
        assert!(!kept(HOST, "a=1; Domain="));
        assert!(!kept(HOST, "a=1; Domain=..acme.sproutboat.app"));
        assert!(!kept(HOST, "a=1; Domain=acme.sproutboat.app."));
        // a repeated attribute: every one must pass (browsers keep the last)
        assert!(!kept(
            HOST,
            "a=1; Domain=acme.sproutboat.app; Domain=sproutboat.app"
        ));
        assert!(!kept(
            HOST,
            "a=1; Domain=sproutboat.app; Domain=acme.sproutboat.app"
        ));
        // the apex has no account to share with
        assert!(!kept(APPS, "a=1; Domain=sproutboat.app"));
    }

    #[test]
    fn no_domain_is_untouched() {
        let line = "sid=x; Path=/; HttpOnly; Secure; SameSite=Lax";
        assert_eq!(run(HOST, &[line]), (vec![line.to_string()], 0));
        assert_eq!(run(APPS, &["a=1; Path=/"]).1, 0);
        // a value that merely contains "domain" is not the attribute
        assert!(kept(HOST, "domain=sproutboat.app; Path=/"));
        assert!(kept(HOST, "a=Domain=sproutboat.app"));
    }

    #[test]
    fn case_and_whitespace_are_normalised() {
        assert!(kept(HOST, "a=1; DOMAIN = .ACME.SproutBoat.App ; Path=/"));
        assert!(kept(HOST, "a=1;domain=Acme.sproutboat.app"));
        assert!(!kept(HOST, "a=1;DoMaIn=SPROUTBOAT.APP"));
    }

    #[test]
    fn prefixes_are_left_alone() {
        assert!(kept(HOST, "__Host-a=1; Path=/; Secure"));
        assert!(kept(
            HOST,
            "__Secure-a=1; Domain=acme.sproutboat.app; Secure"
        ));
        assert!(!kept(HOST, "__Secure-a=1; Domain=sproutboat.app; Secure"));
    }

    #[test]
    fn several_headers_keep_order_and_count() {
        let (got, n) = run(
            HOST,
            &[
                "a=1; Domain=sproutboat.app",
                "b=2",
                "c=3; Domain=other.sproutboat.app; Path=/",
                "d=4; Domain=.acme.sproutboat.app",
            ],
        );
        assert_eq!(got, ["b=2", "d=4; Domain=.acme.sproutboat.app"]);
        assert_eq!(n, 2);
    }

    #[test]
    fn custom_domains_are_untouched() {
        let line = "a=1; Domain=sproutboat.app";
        assert_eq!(run("shop.example.com", &[line]), (vec![line.into()], 0));
        assert_eq!(run("evil-sproutboat.app", &[line]).1, 0);
    }

    #[test]
    fn non_text_values_are_dropped() {
        let mut h = HeaderMap::new();
        h.append("set-cookie", HeaderValue::from_bytes(b"a=\xff").unwrap());
        h.append("set-cookie", HeaderValue::from_static("b=2"));
        assert_eq!(guard_set_cookies(&mut h, HOST, APPS), 1);
        assert_eq!(h.get_all("set-cookie").iter().count(), 1);
    }
}
