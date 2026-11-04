//! Small ports of JavaScript built-ins the Bun edge leans on (`Number()`,
//! `toFixed`, `decodeURIComponent`, `Date#toISOString`, `new URL(...)`), so the
//! Rust edge answers the same way for the same bytes.

use hyper::header::{HeaderMap, HeaderName};
use std::time::{SystemTime, UNIX_EPOCH};

/// `Number(string)`: whitespace-trimmed, empty is 0, `0x`/`0o`/`0b` prefixes,
/// `Infinity`, otherwise a decimal literal; anything else is NaN.
pub fn js_number(input: &str) -> f64 {
    let s = input.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if s.is_empty() {
        return 0.0;
    }
    let radix_of = |p: &str| match p {
        "0x" | "0X" => Some(16),
        "0o" | "0O" => Some(8),
        "0b" | "0B" => Some(2),
        _ => None,
    };
    if s.len() > 2 {
        if let Some(radix) = s.get(..2).and_then(radix_of) {
            return match u128::from_str_radix(&s[2..], radix) {
                Ok(v) => v as f64,
                Err(_) => f64::NAN,
            };
        }
    }
    let (sign, body) = match s.as_bytes()[0] {
        b'-' => (-1.0, &s[1..]),
        b'+' => (1.0, &s[1..]),
        _ => (1.0, s),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    let ok = !body.is_empty()
        && body
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
        && body.bytes().any(|b| b.is_ascii_digit());
    if !ok {
        return f64::NAN;
    }
    match body.parse::<f64>() {
        Ok(v) => sign * v,
        Err(_) => f64::NAN,
    }
}

/// `String(number)` for the values the request log carries.
pub fn js_number_string(v: f64) -> String {
    if v.is_nan() || v.is_infinite() {
        return "null".to_string(); // JSON.stringify
    }
    if v == 0.0 {
        return "0".to_string();
    }
    if v.fract() == 0.0 && v.abs() < 1e21 {
        return format!("{v:.0}");
    }
    format!("{v}")
}

/// `Number.prototype.toFixed(3)` (round half up on the exact binary value).
pub fn to_fixed3(v: f64) -> String {
    let negative = v < 0.0;
    let exact = format!("{:.40}", v.abs());
    let (int_part, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut digits: Vec<u8> = int_part.bytes().chain(frac.bytes().take(3)).collect();
    let round_up = frac.as_bytes().get(3).is_some_and(|d| *d >= b'5');
    if round_up {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, b'1');
                break;
            }
            i -= 1;
            if digits[i] == b'9' {
                digits[i] = b'0';
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let split = digits.len() - 3;
    let mut out = String::with_capacity(digits.len() + 2);
    if negative {
        out.push('-');
    }
    out.push_str(std::str::from_utf8(&digits[..split]).unwrap_or("0"));
    out.push('.');
    out.push_str(std::str::from_utf8(&digits[split..]).unwrap_or("000"));
    out
}

/// `decodeURIComponent`; `None` where JavaScript throws a `URIError`.
pub fn decode_uri_component(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let byte_at = |i: usize| -> Option<u8> {
        if bytes.get(i) != Some(&b'%') {
            return None;
        }
        Some(hex(*bytes.get(i + 1)?)? * 16 + hex(*bytes.get(i + 2)?)?)
    };
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let first = byte_at(i)?;
        if first < 0x80 {
            out.push(first);
            i += 3;
            continue;
        }
        let extra = match first {
            0xC0..=0xDF => 1,
            0xE0..=0xEF => 2,
            0xF0..=0xF7 => 3,
            _ => return None,
        };
        out.push(first);
        i += 3;
        for _ in 0..extra {
            let next = byte_at(i)?;
            if next & 0xC0 != 0x80 {
                return None;
            }
            out.push(next);
            i += 3;
        }
    }
    String::from_utf8(out).ok()
}

/// The WHATWG-normalised `(pathname, search)` of a request target, as
/// `new URL(request.url)` yields them (dot segments and `%2e` resolved).
pub fn parse_target(target: &str) -> Option<(String, String)> {
    if !target.starts_with('/') {
        return None;
    }
    let url = url::Url::parse(&format!("http://localhost{target}")).ok()?;
    let search = match url.query() {
        Some(q) if !q.is_empty() => format!("?{q}"),
        _ => String::new(),
    };
    Some((url.path().to_string(), search))
}

/// `Response.redirect(url)` normalises its argument like `new URL(url).href`.
pub fn normalize_url(input: &str) -> Option<String> {
    url::Url::parse(input).ok().map(|u| u.to_string())
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `new Date().toISOString()` for a unix time in milliseconds.
pub fn iso8601(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// `Headers#get`: repeated fields are joined with ", ".
pub fn header_joined(headers: &HeaderMap, name: &str) -> Option<String> {
    let mut values = headers.get_all(name).iter();
    let first = values.next()?;
    let mut out = String::from_utf8_lossy(first.as_bytes()).into_owned();
    for v in values {
        out.push_str(", ");
        out.push_str(&String::from_utf8_lossy(v.as_bytes()));
    }
    Some(out)
}

/// Hop-by-hop fields a proxy must not copy between connections.
pub fn is_hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-connection"
            | "transfer-encoding"
            | "te"
            | "trailer"
            | "upgrade"
    )
}

/// Fields that frame or route the message on its own connection (the hop-by-hop ones plus the
/// body length and range). The edge owns these: a static-asset `_headers` rule must not set or
/// unset them, or the body no longer matches the framing.
pub fn is_framing_header(name: &HeaderName) -> bool {
    is_hop_by_hop(name) || matches!(name.as_str(), "content-length" | "content-range")
}

#[cfg(test)]
mod tests {
    use super::*;

    // A path that starts with // is a path, not an authority: it is kept as received.
    #[test]
    fn leading_double_slash_stays_a_path() {
        assert_eq!(
            parse_target("//seen//x?a=1"),
            Some(("//seen//x".to_string(), "?a=1".to_string()))
        );
        assert_eq!(
            parse_target("//docs/"),
            Some(("//docs/".to_string(), String::new()))
        );
    }

    #[test]
    fn framing_headers_are_not_rule_overridable() {
        for name in [
            "content-length",
            "content-range",
            "transfer-encoding",
            "connection",
            "keep-alive",
            "upgrade",
            "te",
            "trailer",
            "proxy-connection",
        ] {
            assert!(is_framing_header(&HeaderName::from_static(name)), "{name}");
        }
        for name in [
            "content-type",
            "cache-control",
            "etag",
            "content-encoding",
            "x-a",
        ] {
            assert!(!is_framing_header(&HeaderName::from_static(name)), "{name}");
        }
    }

    #[test]
    fn number_matches_js() {
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number(" 12 "), 12.0);
        assert_eq!(js_number("1.250"), 1.25);
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("1e3"), 1000.0);
        assert!(js_number("abc").is_nan());
        assert!(js_number("inf").is_nan());
        assert!(js_number("1_0").is_nan());
        assert_eq!(js_number("-3"), -3.0);
        assert!(js_number("Infinity").is_infinite());
    }

    #[test]
    fn to_fixed_rounds_half_up() {
        assert_eq!(to_fixed3(1.5), "1.500");
        assert_eq!(to_fixed3(0.0625), "0.063");
        assert_eq!(to_fixed3(0.0), "0.000");
        assert_eq!(to_fixed3(999.9996), "1000.000");
        assert_eq!(to_fixed3(-1.25), "-1.250");
        assert_eq!(to_fixed3(12.3456), "12.346");
    }

    #[test]
    fn number_strings() {
        assert_eq!(js_number_string(1.5), "1.5");
        assert_eq!(js_number_string(100.0), "100");
        assert_eq!(js_number_string(999_999_999_999.0), "999999999999");
    }

    #[test]
    fn decode_component() {
        assert_eq!(decode_uri_component("/a%20b").as_deref(), Some("/a b"));
        assert_eq!(
            decode_uri_component("/%E2%82%AC").as_deref(),
            Some("/\u{20ac}")
        );
        assert_eq!(decode_uri_component("/%2F").as_deref(), Some("//"));
        assert!(decode_uri_component("/%E0%A4%A").is_none());
        assert!(decode_uri_component("/%zz").is_none());
        assert!(decode_uri_component("/%C0%80").is_none());
        assert!(decode_uri_component("/%ED%A0%80").is_none());
        assert!(decode_uri_component("/%").is_none());
    }

    #[test]
    fn target_normalisation() {
        assert_eq!(
            parse_target("/a/../b?x=1"),
            Some(("/b".into(), "?x=1".into()))
        );
        assert_eq!(
            parse_target("/%2e%2e/app.css"),
            Some(("/app.css".into(), String::new()))
        );
        assert_eq!(parse_target("/x?"), Some(("/x".into(), String::new())));
        assert_eq!(parse_target("*"), None);
    }

    #[test]
    fn iso() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601(1_793_723_331_450), "2026-11-03T16:28:51.450Z");
        assert_eq!(iso8601(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
