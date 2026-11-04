//! WebSockets through the edge (port of `websocket.ts`). A client's upgrade is
//! answered once the sprout accepts a WebSocket of its own: the edge opens the
//! upstream socket first (so a refusal is a plain HTTP error and any cold start
//! has already happened), then upgrades the client and relays messages and
//! closes both ways. Text stays text, binary stays binary, and the subprotocol
//! the sprout picked is the one the client gets.

use crate::util::header_joined;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use hyper::header::{HeaderMap, HeaderName};
use hyper::Method;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::WebSocketStream;

/// Cloudflare's limit for a message, which sprouts accept too.
pub const WS_MAX_PAYLOAD: usize = 32 * 1024 * 1024;
/// How long the sprout has to accept the socket.
pub const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A client socket with no frames at all for this long is closed.
pub const WS_IDLE: Duration = Duration::from_secs(120);

const DROPPED_REQUEST_HEADERS: [&str; 8] = [
    "connection",
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
    "content-length",
    "transfer-encoding",
];

pub fn is_websocket_upgrade(method: &Method, headers: &HeaderMap) -> bool {
    if method != Method::GET {
        return false;
    }
    let upgrade = header_joined(headers, "upgrade")
        .unwrap_or_default()
        .to_lowercase();
    let connection = header_joined(headers, "connection")
        .unwrap_or_default()
        .to_lowercase();
    upgrade == "websocket" && connection.split(',').any(|token| token.trim() == "upgrade")
}

/// The subprotocols a client offered, in order.
pub fn offered_protocols(headers: &HeaderMap) -> Vec<String> {
    header_joined(headers, "sec-websocket-protocol")
        .unwrap_or_default()
        .split(',')
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

/// Headers for the edge's own upgrade request to the sprout: the client's, without its handshake.
pub fn upstream_headers(forwarded: &HeaderMap) -> Vec<(HeaderName, Vec<u8>)> {
    forwarded
        .iter()
        .filter(|(name, _)| !DROPPED_REQUEST_HEADERS.contains(&name.as_str()))
        .map(|(name, value)| (name.clone(), value.as_bytes().to_vec()))
        .collect()
}

/// A close code a server may send: 1000, 1001-1003 and 1007-1014 or 3000-4999; else none.
pub fn sendable_close_code(code: u16) -> Option<u16> {
    (code == 1000
        || (1001..=1003).contains(&code)
        || (1007..=1014).contains(&code)
        || (3000..=4999).contains(&code))
    .then_some(code)
}

fn config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(WS_MAX_PAYLOAD))
        .max_frame_size(Some(WS_MAX_PAYLOAD))
}

/// `Sec-WebSocket-Accept` for a client's key, and the validity of its handshake.
pub fn accept_key_for(headers: &HeaderMap) -> Option<String> {
    let key = headers.get("sec-websocket-key")?;
    let version = headers.get("sec-websocket-version")?;
    if version.as_bytes() != b"13" {
        return None;
    }
    Some(derive_accept_key(key.as_bytes()))
}

pub struct Upstream {
    pub socket: WebSocketStream<TcpStream>,
    /// The subprotocol the sprout picked, if any.
    pub protocol: Option<String>,
}

/// Opens the sprout's end. `Err` when the sprout refuses, closes at once, or takes too long.
pub async fn connect_upstream(
    authority: &str,
    path_and_query: &str,
    headers: &HeaderMap,
    protocols: &[String],
    timeout: Duration,
) -> Result<Upstream, String> {
    tokio::time::timeout(
        timeout,
        handshake(authority, path_and_query, headers, protocols),
    )
    .await
    .map_err(|_| "timed out waiting for the sprout to accept the WebSocket".to_string())?
}

async fn handshake(
    authority: &str,
    path_and_query: &str,
    headers: &HeaderMap,
    protocols: &[String],
) -> Result<Upstream, String> {
    fn refused<T>(_: T) -> String {
        "the sprout did not accept the WebSocket".to_string()
    }
    let mut stream = TcpStream::connect(authority).await.map_err(refused)?;
    let _ = stream.set_nodelay(true);
    let key = generate_key();
    let mut request: Vec<u8> = Vec::with_capacity(512);
    request.extend_from_slice(format!("GET {path_and_query} HTTP/1.1\r\n").as_bytes());
    let forwarded = upstream_headers(headers);
    // The original Host goes through unchanged (the sprout sees the client's Host).
    if !forwarded.iter().any(|(n, _)| n == "host") {
        request.extend_from_slice(format!("host: {authority}\r\n").as_bytes());
    }
    for (name, value) in &forwarded {
        request.extend_from_slice(name.as_str().as_bytes());
        request.extend_from_slice(b": ");
        request.extend_from_slice(value);
        request.extend_from_slice(b"\r\n");
    }
    request.extend_from_slice(
        format!("connection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: {key}\r\n")
            .as_bytes(),
    );
    if !protocols.is_empty() {
        request.extend_from_slice(
            format!("sec-websocket-protocol: {}\r\n", protocols.join(", ")).as_bytes(),
        );
    }
    request.extend_from_slice(b"\r\n");
    stream.write_all(&request).await.map_err(refused)?;

    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    loop {
        let mut chunk = [0u8; 2048];
        let n = stream.read(&mut chunk).await.map_err(refused)?;
        if n == 0 || buf.len() > 64 * 1024 {
            return Err(refused(()));
        }
        buf.extend_from_slice(&chunk[..n]);
        let mut storage = [httparse::EMPTY_HEADER; 64];
        let mut response = httparse::Response::new(&mut storage);
        match response.parse(&buf) {
            Ok(httparse::Status::Complete(len)) => {
                if response.code != Some(101) {
                    return Err(refused(()));
                }
                let header = |name: &str| {
                    response
                        .headers
                        .iter()
                        .find(|h| h.name.eq_ignore_ascii_case(name))
                        .map(|h| String::from_utf8_lossy(h.value).trim().to_string())
                };
                if header("sec-websocket-accept").as_deref()
                    != Some(derive_accept_key(key.as_bytes()).as_str())
                {
                    return Err(refused(()));
                }
                let protocol = header("sec-websocket-protocol");
                // A spec-compliant client (Bun's WebSocket) fails when it offered protocols and the
                // server picked none, or one it did not offer.
                if protocol.as_ref().is_some_and(|p| !protocols.contains(p))
                    || (protocol.is_none() && !protocols.is_empty())
                {
                    return Err(refused(()));
                }
                let leftover = buf[len..].to_vec();
                let socket = WebSocketStream::from_partially_read(
                    stream,
                    leftover,
                    Role::Client,
                    Some(config()),
                )
                .await;
                return Ok(Upstream { socket, protocol });
            }
            Ok(httparse::Status::Partial) => continue,
            Err(_) => return Err(refused(())),
        }
    }
}

fn close_message(code: Option<u16>, reason: &str) -> Message {
    match code {
        Some(code) => Message::Close(Some(CloseFrame {
            code: CloseCode::from(code),
            reason: reason.into(),
        })),
        // Bun closes a socket whose peer sent no usable code with a normal 1000.
        None => Message::Close(Some(CloseFrame {
            code: CloseCode::Normal,
            reason: reason.into(),
        })),
    }
}

/// How a relayed socket ended, for the close log line.
pub struct Closed {
    /// Who or what ended it: `client`, `upstream`, `client-lost`, `client-error`,
    /// `upstream-error`, `idle` or `shutdown`.
    pub by: &'static str,
    /// The close code carried by the ending frame (or sent by the edge); none when the transport just dropped.
    pub code: Option<u16>,
    /// Text and binary payload bytes received from the client.
    pub from_client: u64,
    /// Text and binary payload bytes sent to the client.
    pub to_client: u64,
}

fn payload_len(message: &Message) -> u64 {
    match message {
        Message::Text(t) => t.len() as u64,
        Message::Binary(b) => b.len() as u64,
        _ => 0,
    }
}

/// Relays messages and closes between the client's socket and the sprout's until either ends.
pub async fn relay<C>(
    client: WebSocketStream<C>,
    upstream: WebSocketStream<TcpStream>,
    keep_alive: impl Fn(),
    mut shutdown: watch::Receiver<bool>,
) -> Closed
where
    C: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut client_tx, mut client_rx) = client.split();
    let (mut up_tx, mut up_rx) = upstream.split();
    let mut keep = tokio::time::interval(Duration::from_secs(30));
    keep.tick().await;
    let mut ping = tokio::time::interval(WS_IDLE / 2);
    ping.tick().await;
    let mut last_client_frame = Instant::now();
    let mut closed = Closed {
        by: "client",
        code: None,
        from_client: 0,
        to_client: 0,
    };
    loop {
        tokio::select! {
            incoming = client_rx.next() => {
                last_client_frame = Instant::now();
                match incoming {
                    Some(Ok(message @ (Message::Text(_) | Message::Binary(_)))) => {
                        closed.from_client += payload_len(&message);
                        if up_tx.send(message).await.is_err() {
                            let _ = client_tx.send(close_message(Some(1011), "the sprout's WebSocket failed")).await;
                            (closed.by, closed.code) = ("upstream-error", Some(1011));
                            break;
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let sendable = frame.as_ref().and_then(|f| sendable_close_code(u16::from(f.code)));
                        let reason = frame.as_ref().map_or("", |f| f.reason.as_str()).to_string();
                        let _ = up_tx.send(close_message(sendable, &reason)).await;
                        (closed.by, closed.code) = ("client", frame.as_ref().map(|f| u16::from(f.code)));
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(WsError::Capacity(_))) => {
                        let _ = client_tx.send(close_message(Some(1009), "Received too big message")).await;
                        let _ = up_tx.send(Message::Close(None)).await;
                        (closed.by, closed.code) = ("client-error", Some(1009));
                        break;
                    }
                    Some(Err(_)) | None => {
                        let _ = up_tx.send(Message::Close(None)).await;
                        closed.by = "client-lost";
                        break;
                    }
                }
            }
            incoming = up_rx.next() => {
                match incoming {
                    Some(Ok(message @ (Message::Text(_) | Message::Binary(_)))) => {
                        let len = payload_len(&message);
                        if client_tx.send(message).await.is_err() {
                            closed.by = "client-lost";
                            break;
                        }
                        closed.to_client += len;
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let sendable = frame.as_ref().and_then(|f| sendable_close_code(u16::from(f.code)));
                        let reason = frame.as_ref().map_or("", |f| f.reason.as_str()).to_string();
                        let _ = client_tx.send(close_message(sendable, &reason)).await;
                        (closed.by, closed.code) = ("upstream", frame.as_ref().map(|f| u16::from(f.code)));
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => {
                        let _ = client_tx.send(close_message(Some(1011), "the sprout's WebSocket failed")).await;
                        (closed.by, closed.code) = ("upstream-error", Some(1011));
                        break;
                    }
                    None => {
                        let _ = client_tx.send(close_message(None, "")).await;
                        closed.by = "upstream";
                        break;
                    }
                }
            }
            _ = keep.tick() => keep_alive(),
            _ = ping.tick() => {
                if client_tx.send(Message::Ping(Bytes::new())).await.is_err() {
                    closed.by = "client-lost";
                    break;
                }
            }
            _ = tokio::time::sleep_until(last_client_frame + WS_IDLE) => {
                let _ = client_tx.send(close_message(Some(1001), "idle timeout")).await;
                let _ = up_tx.send(Message::Close(None)).await;
                (closed.by, closed.code) = ("idle", Some(1001));
                break;
            }
            _ = shutdown.changed() => {
                let _ = client_tx.send(close_message(Some(1001), "going away")).await;
                let _ = up_tx.send(close_message(Some(1001), "going away")).await;
                (closed.by, closed.code) = ("shutdown", Some(1001));
                break;
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        let _ = client_tx.close().await;
        let _ = up_tx.close().await;
    })
    .await;
    closed
}

pub fn server_config() -> WebSocketConfig {
    config()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderValue;

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
    fn handshake_helpers() {
        let h = headers(&[
            ("connection", "keep-alive, Upgrade"),
            ("upgrade", "WebSocket"),
            ("sec-websocket-protocol", "a, b ,c"),
        ]);
        assert!(is_websocket_upgrade(&Method::GET, &h));
        assert!(!is_websocket_upgrade(&Method::POST, &h));
        assert!(!is_websocket_upgrade(
            &Method::GET,
            &headers(&[("upgrade", "h2c"), ("connection", "upgrade")])
        ));
        assert!(!is_websocket_upgrade(
            &Method::GET,
            &headers(&[("upgrade", "websocket")])
        ));
        assert_eq!(offered_protocols(&h), ["a", "b", "c"]);
        assert!(offered_protocols(&HeaderMap::new()).is_empty());
    }

    #[test]
    fn upstream_headers_drop_the_clients_handshake() {
        let kept: Vec<String> = upstream_headers(&headers(&[
            ("host", "a.example"),
            ("connection", "Upgrade"),
            ("sec-websocket-key", "k"),
            ("sec-websocket-extensions", "permessage-deflate"),
            ("content-length", "0"),
            ("cookie", "s=1"),
        ]))
        .into_iter()
        .map(|(n, _)| n.to_string())
        .collect();
        assert_eq!(kept, ["host", "cookie"]);
    }

    #[test]
    fn sendable_close_codes() {
        let got: Vec<_> = [
            1000, 1001, 1005, 1006, 1015, 4001, 2999, 1004, 1014, 3000, 4999, 5000,
        ]
        .map(sendable_close_code)
        .to_vec();
        assert_eq!(
            got,
            [
                Some(1000),
                Some(1001),
                None,
                None,
                None,
                Some(4001),
                None,
                None,
                Some(1014),
                Some(3000),
                Some(4999),
                None
            ]
        );
    }

    #[test]
    fn accept_key_needs_a_key_and_version_13() {
        let ok = headers(&[
            ("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="),
            ("sec-websocket-version", "13"),
        ]);
        assert_eq!(
            accept_key_for(&ok).as_deref(),
            Some("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
        );
        assert_eq!(
            accept_key_for(&headers(&[("sec-websocket-key", "k")])),
            None
        );
        assert_eq!(
            accept_key_for(&headers(&[
                ("sec-websocket-key", "k"),
                ("sec-websocket-version", "8")
            ])),
            None
        );
    }
}
