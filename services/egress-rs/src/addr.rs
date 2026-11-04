//! The private-address block (baronunread/sproutboat#174): which addresses an app's
//! `fetch()` / `connect()` may never reach. A port of `@sproutboat/runtime`'s
//! `egress.ts`, including its parser, so that both sides agree on every string.

use std::net::{IpAddr, Ipv6Addr};
use std::sync::OnceLock;

/// Blocked ranges, in the order `egress.ts` lists them (the first match names the
/// range in the refusal). IPv4-mapped (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`) and
/// 6to4 (`2002::/16`) addresses are checked by the IPv4 address they embed.
pub const BLOCKED_RANGES: [&str; 22] = [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
    "::/96",
    "64:ff9b:1::/48",
    "100::/64",
    "2001:db8::/32",
    "fc00::/7",
    "fe80::/10",
    "fec0::/10",
    "ff00::/8",
];

/// Extra ranges, only with `SB_EGRESS_STRICT=1` (not in the Bun service; see
/// BEHAVIOUR.md, "Findings"). Checked against the address as written first, then
/// against whatever IPv4 it embeds.
pub const STRICT_EXTRA_RANGES: [&str; 9] = [
    "192.31.196.0/24",
    "192.52.193.0/24",
    "192.88.99.0/24",
    "192.175.48.0/24",
    "::ffff:0:0:0/96",
    "2001::/23",
    "2002::/16",
    "3fff::/20",
    "5f00::/16",
];

/// Parse an IPv4 or IPv6 literal to its bytes (4 or 16); `None` when it is neither.
/// Mirrors `parseAddress` in `egress.ts`: dotted-decimal IPv4 with 1-3 digit groups
/// (leading zeros allowed, read as decimal), IPv6 with `::`, and a dotted IPv4 tail.
pub fn parse_address(text: &str) -> Option<Vec<u8>> {
    if let Some(v4) = parse_dotted(text) {
        return Some(v4.to_vec());
    }
    if !text.contains(':') {
        return None;
    }
    let mut tail: Option<[u8; 4]> = None;
    let mut body = text.to_string();
    // /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/ : the greedy prefix ends at the last ':'.
    if let Some(i) = text.rfind(':') {
        let (head, last) = text.split_at(i + 1);
        if last.contains('.') {
            let embedded = parse_dotted(last)?;
            body = format!("{head}0:0");
            tail = Some(embedded);
        }
    }
    let halves: Vec<&str> = body.split("::").collect();
    if halves.len() > 2 {
        return None;
    }
    let groups = |part: &str| -> Vec<String> {
        if part.is_empty() {
            Vec::new()
        } else {
            part.split(':').map(str::to_string).collect()
        }
    };
    let head = groups(halves[0]);
    let rest = if halves.len() == 2 {
        groups(halves[1])
    } else {
        Vec::new()
    };
    let have = head.len() + rest.len();
    if have > 8 {
        return None;
    }
    let missing = 8 - have;
    if halves.len() == 2 {
        if missing < 1 {
            return None;
        }
    } else if missing != 0 {
        return None;
    }
    let mut all: Vec<String> = head;
    all.extend(std::iter::repeat_n("0".to_string(), missing));
    all.extend(rest);
    let mut out = vec![0u8; 16];
    for (i, g) in all.iter().enumerate() {
        if g.is_empty() || g.len() > 4 || !g.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let n = u16::from_str_radix(g, 16).ok()?;
        out[i * 2] = (n >> 8) as u8;
        out[i * 2 + 1] = (n & 255) as u8;
    }
    if let Some(t) = tail {
        out[12..16].copy_from_slice(&t);
    }
    Some(out)
}

fn parse_dotted(text: &str) -> Option<[u8; 4]> {
    let mut out = [0u8; 4];
    let mut n = 0;
    for part in text.split('.') {
        if n == 4 || part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        let v: u16 = part.parse().ok()?;
        if v > 255 {
            return None;
        }
        out[n] = v as u8;
        n += 1;
    }
    (n == 4).then_some(out)
}

struct Range {
    cidr: &'static str,
    bytes: Vec<u8>,
    bits: usize,
}

fn compile(table: &[&'static str]) -> Vec<Range> {
    table
        .iter()
        .map(|cidr| {
            let (addr, bits) = cidr.split_once('/').expect("cidr");
            Range {
                cidr,
                bytes: parse_address(addr).expect("table address"),
                bits: bits.parse().expect("table bits"),
            }
        })
        .collect()
}

fn ranges() -> &'static Vec<Range> {
    static R: OnceLock<Vec<Range>> = OnceLock::new();
    R.get_or_init(|| compile(&BLOCKED_RANGES))
}

fn extra_ranges() -> &'static Vec<Range> {
    static R: OnceLock<Vec<Range>> = OnceLock::new();
    R.get_or_init(|| compile(&STRICT_EXTRA_RANGES))
}

fn in_range(bytes: &[u8], range: &Range) -> bool {
    if bytes.len() != range.bytes.len() {
        return false;
    }
    let whole = range.bits >> 3;
    if bytes[..whole] != range.bytes[..whole] {
        return false;
    }
    let rem = range.bits & 7;
    if rem == 0 {
        return true;
    }
    let mask = (0xffu16 << (8 - rem)) as u8;
    (bytes[whole] & mask) == (range.bytes[whole] & mask)
}

/// The IPv4 address an IPv6 one carries, for the mapped, NAT64 and 6to4 forms.
fn embedded_v4(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.len() != 16 {
        return None;
    }
    let prefix = |p: &[u8]| bytes[..p.len()] == *p;
    if prefix(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]) {
        return Some(&bytes[12..]);
    }
    if prefix(&[0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0]) {
        return Some(&bytes[12..]);
    }
    if prefix(&[0x20, 0x02]) {
        return Some(&bytes[2..6]);
    }
    None
}

/// The blocked range `bytes` (4 or 16) falls in, or `None` when it may be reached.
pub fn blocked_range_bytes(bytes: &[u8], strict: bool) -> Option<&'static str> {
    if strict {
        if let Some(r) = extra_ranges().iter().find(|r| in_range(bytes, r)) {
            return Some(r.cidr);
        }
    }
    let probe = embedded_v4(bytes).unwrap_or(bytes);
    if strict && probe.len() == 4 {
        if let Some(r) = extra_ranges().iter().find(|r| in_range(probe, r)) {
            return Some(r.cidr);
        }
    }
    ranges().iter().find(|r| in_range(probe, r)).map(|r| r.cidr)
}

/// The blocked range the address text falls in; `"unparseable address"` when the
/// text is no address at all (fail closed, as in the Bun service).
pub fn blocked_range(address: &str, strict: bool) -> Option<&'static str> {
    match parse_address(address) {
        None => Some("unparseable address"),
        Some(b) => blocked_range_bytes(&b, strict),
    }
}

/// Why `fetch()` may not connect to `address`, or `None` when it may. The message is
/// byte-identical to `egressRefusal` in `egress.ts` (and to the C client's).
pub fn egress_refusal(host: &str, address: &str, allow: &[String], strict: bool) -> Option<String> {
    if allow.iter().any(|a| a == "*" || a == address) {
        return None;
    }
    let range = blocked_range(address, strict)?;
    Some(format!(
        "fetch() refused: {host} resolves to {address}, a private or reserved address ({range}). An operator can allow it with SB_EGRESS_ALLOW={address}"
    ))
}

/// `SB_EGRESS_ALLOW` split into entries.
pub fn allow_list(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// An address as `inet_ntop` prints it (what the system resolver hands Bun), which
/// differs from `std`'s `Display` for IPv4-compatible addresses.
pub fn ip_text(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v) => v.to_string(),
        IpAddr::V6(v) => ntop6(v),
    }
}

fn ntop6(addr: Ipv6Addr) -> String {
    let w = addr.segments();
    // Longest run of zero groups (first wins a tie), at least two long.
    let (mut best, mut best_len, mut cur, mut cur_len) = (usize::MAX, 0usize, usize::MAX, 0usize);
    for (i, g) in w.iter().enumerate() {
        if *g == 0 {
            if cur == usize::MAX {
                cur = i;
                cur_len = 1;
            } else {
                cur_len += 1;
            }
        } else if cur != usize::MAX {
            if cur_len > best_len {
                best = cur;
                best_len = cur_len;
            }
            cur = usize::MAX;
        }
    }
    if cur != usize::MAX && cur_len > best_len {
        best = cur;
        best_len = cur_len;
    }
    if best_len < 2 {
        best = usize::MAX;
    }
    let mut out = String::new();
    let mut i = 0;
    while i < 8 {
        if best != usize::MAX && i == best {
            out.push(':');
            i += best_len;
            if i == 8 {
                out.push(':');
            }
            continue;
        }
        if i != 0 {
            out.push(':');
        }
        if i == 6 && best == 0 && (best_len == 6 || (best_len == 5 && w[5] == 0xffff)) {
            out.push_str(&format!(
                "{}.{}.{}.{}",
                w[6] >> 8,
                w[6] & 255,
                w[7] >> 8,
                w[7] & 255
            ));
            break;
        }
        out.push_str(&format!("{:x}", w[i]));
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked(a: &str) -> Option<&'static str> {
        blocked_range(a, false)
    }

    #[test]
    fn ipv4_private_ranges() {
        assert_eq!(blocked("10.0.0.1"), Some("10.0.0.0/8"));
        assert_eq!(blocked("10.255.255.255"), Some("10.0.0.0/8"));
        assert_eq!(blocked("172.16.0.1"), Some("172.16.0.0/12"));
        assert_eq!(blocked("172.31.255.255"), Some("172.16.0.0/12"));
        assert_eq!(blocked("172.15.255.255"), None);
        assert_eq!(blocked("172.32.0.0"), None);
        assert_eq!(blocked("192.168.1.1"), Some("192.168.0.0/16"));
        assert_eq!(blocked("192.167.255.255"), None);
    }

    #[test]
    fn ipv4_cgnat() {
        assert_eq!(blocked("100.64.0.1"), Some("100.64.0.0/10"));
        assert_eq!(blocked("100.127.255.255"), Some("100.64.0.0/10"));
        assert_eq!(blocked("100.63.255.255"), None);
        assert_eq!(blocked("100.128.0.0"), None);
    }

    #[test]
    fn ipv4_loopback_linklocal_metadata() {
        assert_eq!(blocked("127.0.0.1"), Some("127.0.0.0/8"));
        assert_eq!(blocked("127.255.255.254"), Some("127.0.0.0/8"));
        assert_eq!(blocked("169.254.0.1"), Some("169.254.0.0/16"));
        assert_eq!(blocked("169.254.169.254"), Some("169.254.0.0/16"));
        assert_eq!(blocked("169.253.0.1"), None);
    }

    #[test]
    fn ipv4_this_network_broadcast_multicast_reserved() {
        assert_eq!(blocked("0.0.0.0"), Some("0.0.0.0/8"));
        assert_eq!(blocked("0.1.2.3"), Some("0.0.0.0/8"));
        assert_eq!(blocked("255.255.255.255"), Some("240.0.0.0/4"));
        assert_eq!(blocked("224.0.0.1"), Some("224.0.0.0/4"));
        assert_eq!(blocked("239.255.255.255"), Some("224.0.0.0/4"));
        assert_eq!(blocked("240.0.0.1"), Some("240.0.0.0/4"));
        assert_eq!(blocked("223.255.255.255"), None);
    }

    #[test]
    fn ipv4_special_use_blocks() {
        assert_eq!(blocked("192.0.0.1"), Some("192.0.0.0/24"));
        assert_eq!(blocked("192.0.2.1"), Some("192.0.2.0/24"));
        assert_eq!(blocked("198.18.0.1"), Some("198.18.0.0/15"));
        assert_eq!(blocked("198.19.255.255"), Some("198.18.0.0/15"));
        assert_eq!(blocked("198.20.0.0"), None);
        assert_eq!(blocked("198.51.100.7"), Some("198.51.100.0/24"));
        assert_eq!(blocked("203.0.113.7"), Some("203.0.113.0/24"));
    }

    #[test]
    fn public_addresses_pass() {
        for a in [
            "1.1.1.1",
            "8.8.8.8",
            "93.184.216.34",
            "2606:4700::1111",
            "2001:4860:4860::8888",
            "2a00:1450:4001::1",
        ] {
            assert_eq!(blocked(a), None, "{a}");
        }
    }

    #[test]
    fn ipv6_loopback_unspecified() {
        assert_eq!(blocked("::1"), Some("::/96"));
        assert_eq!(blocked("::"), Some("::/96"));
        assert_eq!(blocked("0:0:0:0:0:0:0:1"), Some("::/96"));
    }

    #[test]
    fn ipv6_ula_linklocal_sitelocal_multicast() {
        assert_eq!(blocked("fc00::1"), Some("fc00::/7"));
        assert_eq!(blocked("fd12:3456:789a::1"), Some("fc00::/7"));
        assert_eq!(blocked("fe80::1"), Some("fe80::/10"));
        assert_eq!(blocked("febf::1"), Some("fe80::/10"));
        assert_eq!(blocked("fec0::1"), Some("fec0::/10"));
        assert_eq!(blocked("ff02::1"), Some("ff00::/8"));
        assert_eq!(blocked("fbff::1"), None);
    }

    #[test]
    fn ipv6_documentation_discard_local_nat64() {
        assert_eq!(blocked("2001:db8::1"), Some("2001:db8::/32"));
        assert_eq!(blocked("100::1"), Some("100::/64"));
        assert_eq!(blocked("64:ff9b:1::1"), Some("64:ff9b:1::/48"));
        assert_eq!(blocked("64:ff9b:1:ffff::1"), Some("64:ff9b:1::/48"));
    }

    #[test]
    fn ipv4_mapped() {
        assert_eq!(blocked("::ffff:127.0.0.1"), Some("127.0.0.0/8"));
        assert_eq!(blocked("::ffff:7f00:1"), Some("127.0.0.0/8"));
        assert_eq!(blocked("::ffff:169.254.169.254"), Some("169.254.0.0/16"));
        assert_eq!(blocked("::ffff:a9fe:a9fe"), Some("169.254.0.0/16"));
        assert_eq!(blocked("::ffff:10.1.2.3"), Some("10.0.0.0/8"));
        assert_eq!(blocked("0:0:0:0:0:ffff:c0a8:101"), Some("192.168.0.0/16"));
        assert_eq!(blocked("::ffff:8.8.8.8"), None);
        assert_eq!(blocked("::ffff:0808:0808"), None);
    }

    #[test]
    fn ipv4_compatible() {
        // the whole of ::/96 is blocked, public embedded address or not
        assert_eq!(blocked("::127.0.0.1"), Some("::/96"));
        assert_eq!(blocked("::7f00:1"), Some("::/96"));
        assert_eq!(blocked("::8.8.8.8"), Some("::/96"));
    }

    #[test]
    fn nat64_embedding() {
        assert_eq!(blocked("64:ff9b::127.0.0.1"), Some("127.0.0.0/8"));
        assert_eq!(blocked("64:ff9b::7f00:1"), Some("127.0.0.0/8"));
        assert_eq!(blocked("64:ff9b::a9fe:a9fe"), Some("169.254.0.0/16"));
        assert_eq!(blocked("64:ff9b::10.0.0.1"), Some("10.0.0.0/8"));
        assert_eq!(blocked("64:ff9b::c0a8:1"), Some("192.168.0.0/16"));
        assert_eq!(blocked("64:ff9b::8.8.8.8"), None);
    }

    #[test]
    fn six_to_four_embedding() {
        assert_eq!(blocked("2002:7f00:1::"), Some("127.0.0.0/8"));
        assert_eq!(blocked("2002:7f00:0001::1"), Some("127.0.0.0/8"));
        assert_eq!(blocked("2002:a9fe:a9fe::1"), Some("169.254.0.0/16"));
        assert_eq!(blocked("2002:0a00:0001::"), Some("10.0.0.0/8"));
        assert_eq!(blocked("2002:c0a8:101::"), Some("192.168.0.0/16"));
        assert_eq!(blocked("2002:0808:0808::1"), None);
    }

    #[test]
    fn unparseable_text_is_refused() {
        for a in [
            "",
            "nonsense",
            "1.2.3",
            "1.2.3.4.5",
            "256.1.1.1",
            "::g",
            ":::",
            "1::2::3",
            "fe80::1%eth0",
            "12345::1",
            "1:2:3:4:5:6:7:8:9",
            "[::1]",
        ] {
            assert_eq!(blocked(a), Some("unparseable address"), "{a:?}");
        }
    }

    #[test]
    fn parser_matches_the_ts_forms() {
        assert_eq!(parse_address("1.2.3.4"), Some(vec![1, 2, 3, 4]));
        // leading zeros read as decimal, like the TS regex
        assert_eq!(parse_address("010.0.0.1"), Some(vec![10, 0, 0, 1]));
        assert_eq!(
            parse_address("::1.2.3.4").map(|b| b[12..].to_vec()),
            Some(vec![1, 2, 3, 4])
        );
        assert_eq!(
            parse_address("1::").map(|b| (b[0], b[1], b[15])),
            Some((0, 1, 0))
        );
    }

    #[test]
    fn host_literals_in_odd_forms_normalise_before_the_check() {
        // The service reads the target through the WHATWG URL parser, which turns
        // decimal, octal and hex IPv4 hosts into dotted decimal; these all land in
        // 127.0.0.0/8 or 10.0.0.0/8 and are refused by address.
        for (input, want) in [
            ("http://2130706433/", "127.0.0.1"),
            ("http://0x7f000001/", "127.0.0.1"),
            ("http://0x7f.1/", "127.0.0.1"),
            ("http://0177.0.0.1/", "127.0.0.1"),
            ("http://127.1/", "127.0.0.1"),
            ("http://012.0.0.1/", "10.0.0.1"),
            ("http://0xA.0.0.1/", "10.0.0.1"),
            ("http://167772161/", "10.0.0.1"),
            ("http://0xa9fea9fe/", "169.254.169.254"),
            ("http://2852039166/", "169.254.169.254"),
            ("http://%31%32%37.0.0.1/", "127.0.0.1"),
            ("http://127\u{3002}0\u{3002}0\u{3002}1/", "127.0.0.1"),
            ("http://\u{ff11}\u{ff12}\u{ff17}.0.0.1/", "127.0.0.1"),
            ("http://[::ffff:127.0.0.1]/", "::ffff:7f00:1"),
            ("http://[0:0:0:0:0:0:0:1]/", "::1"),
            ("http://[::FFFF:A9FE:A9FE]/", "::ffff:a9fe:a9fe"),
        ] {
            let url = url::Url::parse(input).expect(input);
            let host = url
                .host_str()
                .unwrap()
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_string();
            assert_eq!(host, want, "{input}");
            assert!(blocked(&host).is_some(), "{input} -> {host}");
        }
    }

    #[test]
    fn refusal_message_is_the_ts_message() {
        let msg = egress_refusal("169.254.169.254", "169.254.169.254", &[], false).unwrap();
        assert_eq!(
            msg,
            "fetch() refused: 169.254.169.254 resolves to 169.254.169.254, a private or reserved address (169.254.0.0/16). An operator can allow it with SB_EGRESS_ALLOW=169.254.169.254"
        );
        let msg = egress_refusal("[::1]", "::1", &[], false).unwrap();
        assert_eq!(
            msg,
            "fetch() refused: [::1] resolves to ::1, a private or reserved address (::/96). An operator can allow it with SB_EGRESS_ALLOW=::1"
        );
    }

    #[test]
    fn allow_list_is_exact_or_star() {
        let allow = allow_list(Some(" 127.0.0.1 , ,10.0.0.5"));
        assert_eq!(allow, vec!["127.0.0.1", "10.0.0.5"]);
        assert!(egress_refusal("h", "127.0.0.1", &allow, false).is_none());
        assert!(egress_refusal("h", "10.0.0.5", &allow, false).is_none());
        assert!(egress_refusal("h", "10.0.0.6", &allow, false).is_some());
        // exact text only: no CIDR, no other spelling of the same address
        assert!(egress_refusal("h", "::ffff:7f00:1", &allow, false).is_some());
        assert!(egress_refusal("h", "10.0.0.6", &["*".to_string()], false).is_none());
        assert_eq!(allow_list(None), Vec::<String>::new());
    }

    #[test]
    fn strict_mode_adds_ranges_without_loosening_any() {
        for a in [
            "192.88.99.1",
            "192.31.196.1",
            "2001::1",
            "2001:0:4136:e378:8000:63bf:3fff:fdd2",
            "::ffff:0:7f00:1",
            "3fff::1",
            "2002:0808:0808::1",
            "5f00::1",
        ] {
            assert_eq!(blocked_range(a, false), None, "default {a}");
            assert!(blocked_range(a, true).is_some(), "strict {a}");
        }
        for a in BLOCKED_RANGES.iter().map(|c| c.split('/').next().unwrap()) {
            assert!(blocked_range(a, true).is_some(), "{a}");
        }
        assert_eq!(blocked_range("1.1.1.1", true), None);
        assert_eq!(blocked_range("2606:4700::1111", true), None);
    }

    #[test]
    fn ntop_matches_inet_ntop() {
        let t = |s: &str| ip_text(s.parse::<IpAddr>().unwrap());
        assert_eq!(t("::1"), "::1");
        assert_eq!(t("::"), "::");
        assert_eq!(t("::ffff:1.2.3.4"), "::ffff:1.2.3.4");
        assert_eq!(t("::102:304"), "::1.2.3.4");
        assert_eq!(t("2001:db8:0:0:1:0:0:1"), "2001:db8::1:0:0:1");
        assert_eq!(t("2606:4700::1111"), "2606:4700::1111");
        assert_eq!(t("fe80:0:0:0:1:2:3:4"), "fe80::1:2:3:4");
        assert_eq!(t("1:0:0:0:0:0:0:0"), "1::");
        assert_eq!(t("64:ff9b::7f00:1"), "64:ff9b::7f00:1");
    }
}
