//! In-process tests: the service against fake upstreams, with a counting resolver
//! standing in for DNS (the rebinding defence) and a raw client.

use sproutboat_egress::addr::allow_list;
use sproutboat_egress::resolve::{Answer, Resolve, ResolveFuture};
use sproutboat_egress::tunnel::{
    open_frame, typed_frame, Tunnels, TCP_CONNECTED, TCP_DATA, TCP_ERROR,
};
use sproutboat_egress::{serve, Egress};
use std::net::IpAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const TOKEN: &str = "test-token";

/// Answers from a script, one entry per lookup (the last repeats), and counts lookups.
struct Script {
    answers: Mutex<Vec<Vec<&'static str>>>,
    lookups: AtomicUsize,
}
impl Script {
    fn new(answers: Vec<Vec<&'static str>>) -> Arc<Script> {
        Arc::new(Script {
            answers: Mutex::new(answers),
            lookups: AtomicUsize::new(0),
        })
    }
}
struct ScriptResolver(Arc<Script>);
impl Resolve for ScriptResolver {
    fn resolve<'a>(&'a self, host: &'a str) -> ResolveFuture<'a> {
        Box::pin(async move {
            if let Some(a) = sproutboat_egress::resolve::literal_answer(host) {
                return Ok(vec![a]);
            }
            let n = self.0.lookups.fetch_add(1, Ordering::SeqCst);
            let all = self.0.answers.lock().unwrap();
            let list = &all[n.min(all.len() - 1)];
            Ok(list
                .iter()
                .map(|t| Answer {
                    ip: t.parse::<IpAddr>().ok(),
                    text: t.to_string(),
                })
                .collect())
        })
    }
}

/// An upstream that answers every request `ok` and records each request head.
async fn upstream() -> (u16, Arc<Mutex<Vec<String>>>, Arc<AtomicUsize>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let conns = Arc::new(AtomicUsize::new(0));
    let (s2, c2) = (seen.clone(), conns.clone());
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = l.accept().await.unwrap();
            c2.fetch_add(1, Ordering::SeqCst);
            let seen = s2.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                loop {
                    let Ok(n) = sock.read(&mut tmp).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    while let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_string();
                        buf.drain(..i + 4);
                        seen.lock().unwrap().push(head);
                        if sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\ncontent-type: text/plain\r\n\r\nok").await.is_err() {
                            return;
                        }
                    }
                }
            });
        }
    });
    (port, seen, conns)
}

async fn start(allow: &str, script: Arc<Script>) -> u16 {
    let egress = Egress::new(
        TOKEN,
        allow_list(Some(allow)),
        Box::new(ScriptResolver(script)),
    )
    .unwrap();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(serve(Arc::new(egress), l));
    port
}

async fn fetch(svc: u16, url: &str, token: &str) -> (u16, String, String) {
    let mut s = TcpStream::connect(("127.0.0.1", svc)).await.unwrap();
    let req = format!("GET / HTTP/1.1\r\nhost: egress\r\nconnection: close\r\nx-sb-egress-url: {url}\r\nx-sb-egress-token: {token}\r\n\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).await.unwrap();
    let text = String::from_utf8_lossy(&out).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, head.to_string(), body.to_string())
}

#[tokio::test]
async fn relays_and_sets_host_to_the_name() {
    let (up, seen, _) = upstream().await;
    let svc = start("127.0.0.1", Script::new(vec![vec!["127.0.0.1"]])).await;
    let (status, head, body) = fetch(svc, &format!("http://pinned.test:{up}/x?y=1"), TOKEN).await;
    assert_eq!((status, body.as_str()), (200, "ok"));
    assert!(head.to_lowercase().contains("content-type: text/plain"));
    let req = seen.lock().unwrap()[0].clone();
    assert!(req.starts_with("GET /x?y=1 HTTP/1.1"), "{req}");
    assert!(
        req.to_lowercase()
            .contains(&format!("host: pinned.test:{up}")),
        "{req}"
    );
}

#[tokio::test]
async fn rebinding_resolves_once_per_request_and_connects_to_the_vetted_address() {
    let (up, seen, _) = upstream().await;
    // Lookup 1 is allowed; every later lookup would be private. If the service ever
    // resolved again between the check and the connect, the request would not land.
    let script = Script::new(vec![
        vec!["127.0.0.1"],
        vec!["10.255.255.1"],
        vec!["169.254.169.254"],
    ]);
    let svc = start("127.0.0.1", script.clone()).await;
    let (s1, _, b1) = fetch(svc, &format!("http://rebind.test:{up}/"), TOKEN).await;
    assert_eq!((s1, b1.as_str()), (200, "ok"));
    assert_eq!(
        script.lookups.load(Ordering::SeqCst),
        1,
        "one lookup for one request"
    );
    assert_eq!(seen.lock().unwrap().len(), 1);
    // The next request resolves again and is vetted again: now private, refused.
    let (s2, _, b2) = fetch(svc, &format!("http://rebind.test:{up}/"), TOKEN).await;
    assert_eq!(s2, 502);
    assert!(
        b2.contains("fetch() refused: rebind.test resolves to 10.255.255.1"),
        "{b2}"
    );
    assert_eq!(script.lookups.load(Ordering::SeqCst), 2);
    assert_eq!(
        seen.lock().unwrap().len(),
        1,
        "nothing reached any upstream"
    );
}

#[tokio::test]
async fn private_answer_is_refused_whatever_follows() {
    let (up, seen, _) = upstream().await;
    let script = Script::new(vec![vec!["10.255.255.1"], vec!["127.0.0.1"]]);
    let svc = start("127.0.0.1", script.clone()).await;
    let (status, _, body) = fetch(svc, &format!("http://rebind-reverse.test:{up}/"), TOKEN).await;
    assert_eq!(status, 502);
    assert!(body.contains("10.255.255.1"));
    assert_eq!(script.lookups.load(Ordering::SeqCst), 1);
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn mixed_answers_use_only_the_vetted_ones() {
    let (up, seen, _) = upstream().await;
    let svc = start(
        "127.0.0.1",
        Script::new(vec![vec!["10.0.0.5", "127.0.0.1", "169.254.169.254"]]),
    )
    .await;
    let (status, _, _) = fetch(svc, &format!("http://mixed.test:{up}/"), TOKEN).await;
    assert_eq!(status, 200);
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn refused_forms_through_the_resolver() {
    let (up, seen, _) = upstream().await;
    for (name, answer) in [
        ("mapped", "::ffff:7f00:1"),
        ("mapped-dotted", "::ffff:127.0.0.1"),
        ("nat64", "64:ff9b::7f00:1"),
        ("sixtofour", "2002:7f00:1::"),
        ("ula", "fd00::1"),
        ("linklocal", "fe80::1"),
        ("cgnat", "100.64.0.1"),
        ("metadata", "169.254.169.254"),
        ("unspecified", "0.0.0.0"),
        ("scoped", "fe80::1%eth0"),
        ("garbage", "not-an-address"),
    ] {
        let svc = start("", Script::new(vec![vec![answer]])).await;
        let (status, _, body) = fetch(svc, &format!("http://{name}.test:{up}/"), TOKEN).await;
        assert_eq!(status, 502, "{name}");
        assert!(
            body.contains(&format!(
                "fetch() refused: {name}.test resolves to {answer}"
            )),
            "{name}: {body}"
        );
    }
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn falls_through_only_when_an_address_cannot_be_connected() {
    let (up, seen, _) = upstream().await;
    // ::1 is allowed but nothing listens there (the upstream is IPv4 only): refused connect, next address.
    let svc = start("127.0.0.1,::1", Script::new(vec![vec!["::1", "127.0.0.1"]])).await;
    let (status, _, _) = fetch(svc, &format!("http://dual.test:{up}/"), TOKEN).await;
    assert_eq!(status, 200);
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn token_and_url_errors() {
    let svc = start("", Script::new(vec![vec!["1.1.1.1"]])).await;
    let (s, _, b) = fetch(svc, "http://example.test/", "wrong-token").await;
    assert_eq!((s, b.as_str()), (401, "unauthorized"));
    let (s, head, b) = fetch(svc, "ftp://example.test/", TOKEN).await;
    assert_eq!(s, 400);
    assert!(head.to_lowercase().contains("x-sb-egress-error: 1"));
    assert_eq!(b, r#"{"error":"unsupported protocol: ftp:"}"#);
    let (s, _, b) = fetch(svc, "not a url", TOKEN).await;
    assert_eq!(
        (s, b.as_str()),
        (400, r#"{"error":"invalid url: not a url"}"#)
    );
}

#[tokio::test]
async fn reuses_connections_per_name_and_address() {
    let (up, seen, conns) = upstream().await;
    let svc = start("127.0.0.1", Script::new(vec![vec!["127.0.0.1"]])).await;
    // keep-alive between requests to the same name
    let mut c = TcpStream::connect(("127.0.0.1", svc)).await.unwrap();
    for _ in 0..4 {
        let req = format!("GET / HTTP/1.1\r\nhost: e\r\nx-sb-egress-url: http://reuse.test:{up}/\r\nx-sb-egress-token: {TOKEN}\r\n\r\n");
        c.write_all(req.as_bytes()).await.unwrap();
        let mut got = Vec::new();
        let mut tmp = [0u8; 1024];
        while !String::from_utf8_lossy(&got).ends_with("ok") {
            let n = c.read(&mut tmp).await.unwrap();
            assert!(n > 0);
            got.extend_from_slice(&tmp[..n]);
        }
    }
    assert_eq!(seen.lock().unwrap().len(), 4);
    assert_eq!(
        conns.load(Ordering::SeqCst),
        1,
        "one upstream connection served all four"
    );
    // a different name on the same address never rides that connection
    let (s, _, _) = fetch(svc, &format!("http://other.test:{up}/"), TOKEN).await;
    assert_eq!(s, 200);
    assert_eq!(conns.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn tunnel_relays_bytes_and_refuses_private_targets() {
    // echo server
    let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut s, _) = echo.accept().await.unwrap();
            tokio::spawn(async move {
                let mut b = [0u8; 1024];
                while let Ok(n) = s.read(&mut b).await {
                    if n == 0 || s.write_all(&b[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    let resolver: Arc<dyn Resolve> = Arc::new(ScriptResolver(Script::new(vec![vec!["127.0.0.1"]])));
    let tls = sproutboat_egress::upstream::Client::new().tls;
    let tunnels = Arc::new(Tunnels::new(
        TOKEN,
        allow_list(Some("127.0.0.1")),
        resolver,
        tls,
    ));
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(sproutboat_egress::tunnel::serve(tunnels, l));

    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(&open_frame(&serde_json::json!({"token": TOKEN, "op": "tcp.open", "host": "echo.test", "port": echo_port, "mode": "off"}))).await.unwrap();
    assert_eq!(read_frame(&mut s).await.0, TCP_CONNECTED);
    s.write_all(&typed_frame(TCP_DATA, b"ping")).await.unwrap();
    assert_eq!(read_frame(&mut s).await, (TCP_DATA, b"ping".to_vec()));

    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(&open_frame(&serde_json::json!({"token": TOKEN, "op": "tcp.open", "host": "10.0.0.1", "port": 80, "mode": "off"}))).await.unwrap();
    let (kind, msg) = read_frame(&mut s).await;
    assert_eq!(kind, TCP_ERROR);
    assert!(String::from_utf8_lossy(&msg)
        .starts_with("connect() refused: 10.0.0.1 resolves to 10.0.0.1"));

    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(&open_frame(&serde_json::json!({"token": "bad", "op": "tcp.open", "host": "127.0.0.1", "port": echo_port, "mode": "off"}))).await.unwrap();
    assert_eq!(
        read_frame(&mut s).await,
        (TCP_ERROR, b"unauthorized".to_vec())
    );
}

async fn read_frame(s: &mut TcpStream) -> (u8, Vec<u8>) {
    let mut h = [0u8; 5];
    s.read_exact(&mut h).await.unwrap();
    let len = u32::from_le_bytes(h[1..5].try_into().unwrap()) as usize;
    let mut p = vec![0u8; len];
    s.read_exact(&mut p).await.unwrap();
    (h[0], p)
}
