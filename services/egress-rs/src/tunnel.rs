//! The TCP tunnel endpoint behind `connect()` (cloudflare:sockets): the egress side
//! of `@sproutboat/wire`'s `tcp.ts` (`listenTunnelService`). A broker opens a raw TCP
//! connection and sends one `tcp.open` frame; from then on both ends speak typed
//! frames, `[u8 type][u32 LE length][payload]`:
//!
//!   broker -> service  1 data, 2 startTls (payload: server name), 3 shutdown the write
//!                      side, 7 close
//!   service -> broker  1 data, 4 error (payload: reason), 5 connected, 6 TLS done,
//!                      7 closed (the origin connection is gone), 8 end of input
//!
//! The origin is resolved here, every address vetted as `fetch()` vets it, and the
//! connection goes to the vetted address, never the name. There is no ack on this
//! endpoint: a refusal is an error frame.

use crate::addr::egress_refusal;
use crate::resolve::{is_ip_literal, literal_answer, Answer, Resolve};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::Instant;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::TlsConnector;

pub const TCP_DATA: u8 = 1;
pub const TCP_START_TLS: u8 = 2;
pub const TCP_SHUTDOWN: u8 = 3;
pub const TCP_ERROR: u8 = 4;
pub const TCP_CONNECTED: u8 = 5;
pub const TCP_TLS_DONE: u8 = 6;
pub const TCP_CLOSE: u8 = 7;
pub const TCP_EOF: u8 = 8;

/// Open tunnels the service holds at once (the Bun service passes 256).
pub const SERVICE_MAX_OPEN: usize = 256;
pub const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_TYPED_FRAME: usize = 1024 * 1024;
const MAX_HEAD: usize = 64 * 1024;
/// Bytes buffered each way before the reading side is paused.
const BUFFER_LIMIT: usize = 256 * 1024;

pub struct Tunnels {
    pub token: Vec<u8>,
    pub allow: Vec<String>,
    pub strict: bool,
    pub max_open: usize,
    pub connect_timeout: Duration,
    pub resolver: Arc<dyn Resolve>,
    pub tls: TlsConnector,
    live: AtomicUsize,
}

impl Tunnels {
    pub fn new(
        token: &str,
        allow: Vec<String>,
        resolver: Arc<dyn Resolve>,
        tls: TlsConnector,
    ) -> Tunnels {
        Tunnels {
            token: token.as_bytes().to_vec(),
            allow,
            strict: false,
            max_open: SERVICE_MAX_OPEN,
            connect_timeout: TCP_CONNECT_TIMEOUT,
            resolver,
            tls,
            live: AtomicUsize::new(0),
        }
    }

    pub fn open(&self) -> usize {
        self.live.load(Ordering::SeqCst)
    }
}

struct Live<'a>(&'a AtomicUsize);
impl Drop for Live<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

pub fn typed_frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(kind);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// The opening frame as a broker writes it, length header included.
pub fn open_frame(head: &serde_json::Value) -> Vec<u8> {
    let mut obj = serde_json::Map::new();
    obj.insert("v".into(), 1.into());
    if let Some(m) = head.as_object() {
        for (k, v) in m {
            obj.insert(k.clone(), v.clone());
        }
    }
    let json = serde_json::Value::Object(obj).to_string();
    let mut out = Vec::new();
    out.extend_from_slice(&((5 + json.len()) as u32).to_le_bytes());
    out.push(1);
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(json.as_bytes());
    out
}

/// The head of a `tcp.open` payload (marker, json length, json), or `None`.
fn parse_tcp_open(payload: &[u8]) -> Option<serde_json::Map<String, serde_json::Value>> {
    if payload.len() < 5 || payload[0] != 1 {
        return None;
    }
    let json_len = u32::from_le_bytes(payload[1..5].try_into().ok()?) as usize;
    if 5 + json_len > payload.len() {
        return None;
    }
    let text = String::from_utf8_lossy(&payload[5..5 + json_len]);
    if !text.contains("\"op\":\"tcp.open\"") {
        return None;
    }
    match serde_json::from_str::<serde_json::Value>(&text).ok()? {
        serde_json::Value::Object(m)
            if m.get("op").and_then(|v| v.as_str()) == Some("tcp.open") =>
        {
            Some(m)
        }
        _ => None,
    }
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
type Origin = Box<dyn Io>;

fn same_token(given: &str, expected: &[u8]) -> bool {
    let g = given.as_bytes();
    g.len() == expected.len() && g.iter().zip(expected).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
}

fn net_error(ip: IpAddr, port: u16, e: &std::io::Error) -> String {
    let code = match e.kind() {
        std::io::ErrorKind::ConnectionRefused => "ECONNREFUSED",
        std::io::ErrorKind::NetworkUnreachable => "ENETUNREACH",
        std::io::ErrorKind::HostUnreachable => "EHOSTUNREACH",
        std::io::ErrorKind::TimedOut => "ETIMEDOUT",
        std::io::ErrorKind::ConnectionReset => "ECONNRESET",
        _ => return e.to_string(),
    };
    let host = if ip.is_ipv6() {
        format!("{ip}")
    } else {
        ip.to_string()
    };
    format!("connect {code} {host}:{port}")
}

fn server_name(servername: &str, ip: IpAddr) -> Option<ServerName<'static>> {
    let bare = servername.trim_start_matches('[').trim_end_matches(']');
    if is_ip_literal(bare) {
        Some(ServerName::IpAddress(
            bare.parse::<IpAddr>().unwrap_or(ip).into(),
        ))
    } else {
        ServerName::try_from(servername.to_string()).ok()
    }
}

impl Tunnels {
    /// Resolve `host` and keep the addresses that may be reached, or the refusal.
    async fn vetted(&self, host: &str) -> Result<Vec<Answer>, String> {
        let name = host.strip_prefix('[').unwrap_or(host);
        let name = name.strip_suffix(']').unwrap_or(name);
        let answers: Vec<Answer> = if is_ip_literal(name) {
            vec![literal_answer(name).expect("literal")]
        } else {
            self.resolver
                .resolve(name)
                .await
                .map_err(|_| format!("could not resolve {host}"))?
        };
        let mut refusal: Option<String> = None;
        let mut ok = Vec::new();
        for a in answers {
            match egress_refusal(host, &a.text, &self.allow, self.strict) {
                None => ok.push(a),
                Some(why) => {
                    refusal.get_or_insert(why);
                }
            }
        }
        if ok.is_empty() {
            let why = refusal.unwrap_or_else(|| format!("could not resolve {host}"));
            return Err(match why.strip_prefix("fetch()") {
                Some(rest) => format!("connect(){rest}"),
                None => why,
            });
        }
        Ok(ok)
    }

    async fn attempt(
        &self,
        ip: IpAddr,
        port: u16,
        servername: &str,
        secure: bool,
        left: Duration,
    ) -> Result<Origin, String> {
        let work = async {
            let tcp = TcpStream::connect(SocketAddr::new(ip, port))
                .await
                .map_err(|e| net_error(ip, port, &e))?;
            let _ = tcp.set_nodelay(true);
            if secure {
                let name =
                    server_name(servername, ip).ok_or_else(|| "invalid server name".to_string())?;
                let tls = self
                    .tls
                    .connect(name, tcp)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok::<Origin, String>(Box::new(tls))
            } else {
                Ok(Box::new(tcp) as Origin)
            }
        };
        match tokio::time::timeout(left, work).await {
            Ok(r) => r,
            Err(_) => Err("connect timed out".into()),
        }
    }

    /// Serve one broker connection to its end.
    pub async fn handle(self: Arc<Self>, sock: TcpStream) {
        let _ = sock.set_nodelay(true);
        let (mut prd, mut pwr) = sock.into_split();
        // --- the opening frame
        let mut inbox: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; 16 * 1024];
        let (head, rest) = loop {
            if inbox.len() >= 4 {
                let len = u32::from_le_bytes(inbox[0..4].try_into().unwrap()) as usize;
                if len > MAX_HEAD {
                    return;
                }
                if inbox.len() >= 4 + len {
                    let rest = inbox[4 + len..].to_vec();
                    match parse_tcp_open(&inbox[4..4 + len]) {
                        Some(h) => break (h, rest),
                        None => {
                            let _ = pwr
                                .write_all(&typed_frame(TCP_ERROR, b"expected tcp.open"))
                                .await;
                            let _ = pwr.shutdown().await;
                            return;
                        }
                    }
                }
            }
            match prd.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => inbox.extend_from_slice(&buf[..n]),
            }
        };

        // --- admission (token, then target, then limits, in the Bun order)
        let token = head.get("token").and_then(|v| v.as_str()).unwrap_or("");
        if !same_token(token, &self.token) {
            let _ = pwr
                .write_all(&typed_frame(TCP_ERROR, b"unauthorized"))
                .await;
            let _ = pwr.shutdown().await;
            return;
        }
        let host = head
            .get("host")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let port: Option<u16> = head.get("port").and_then(|v| v.as_f64()).and_then(|n| {
            (n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 && (1.0..=65535.0).contains(&n))
                .then_some(n as u16)
        });
        let mode = match head.get("mode").and_then(|v| v.as_str()) {
            Some(m @ ("on" | "starttls" | "off")) => Some(m.to_string()),
            _ => None,
        };
        let servername = match head.get("servername").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => host.clone(),
        };
        let invalid: Option<&str> = if self.open() >= self.max_open {
            Some("Too many open connections")
        } else if host.is_empty() || host.chars().count() > 255 || mode.is_none() {
            Some("invalid tunnel target")
        } else if port.is_none() {
            Some("invalid tunnel port")
        } else if port == Some(25) {
            Some("connect() refused: port 25 is blocked, as on Workers")
        } else {
            None
        };
        if let Some(why) = invalid {
            let _ = pwr.write_all(&typed_frame(TCP_ERROR, why.as_bytes())).await;
            let _ = pwr.shutdown().await;
            return;
        }
        let (port, mode) = (port.unwrap(), mode.unwrap());
        self.live.fetch_add(1, Ordering::SeqCst);
        let _live = Live(&self.live);

        // --- connecting
        let origin = match self.connect(&host, port, &servername, mode == "on").await {
            Ok(o) => o,
            Err(why) => {
                let _ = pwr.write_all(&typed_frame(TCP_ERROR, why.as_bytes())).await;
                let _ = pwr.shutdown().await;
                return;
            }
        };
        let mut to_peer: Vec<u8> = typed_frame(TCP_CONNECTED, b"");
        self.pump(origin, &mode, prd, &mut pwr, rest, &mut to_peer)
            .await;
        // flush what is left, then end our side
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            let _ = pwr.write_all(&to_peer).await;
            let _ = pwr.shutdown().await;
        })
        .await;
    }

    async fn connect(
        &self,
        host: &str,
        port: u16,
        servername: &str,
        secure: bool,
    ) -> Result<Origin, String> {
        let addresses = self.vetted(host).await?;
        let deadline = Instant::now() + self.connect_timeout;
        let mut last = "connect timed out".to_string();
        for a in addresses {
            let Some(ip) = a.ip else { continue };
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            match self.attempt(ip, port, servername, secure, left).await {
                Ok(o) => return Ok(o),
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    /// Move bytes both ways until either side is done.
    async fn pump(
        &self,
        origin: Origin,
        mode: &str,
        mut prd: tokio::net::tcp::OwnedReadHalf,
        pwr: &mut tokio::net::tcp::OwnedWriteHalf,
        mut inbox: Vec<u8>,
        to_peer: &mut Vec<u8>,
    ) {
        let (mut ord, mut owr) = tokio::io::split(origin);
        let mut to_origin: Vec<u8> = Vec::new();
        let (mut pbuf, mut obuf) = (vec![0u8; 32 * 1024], vec![0u8; 32 * 1024]);
        let (mut origin_eof, mut shutdown_requested, mut origin_shut, mut upgraded) =
            (false, false, false, false);
        let mut start_tls: Option<String> = None;
        let mut ended = false;
        // Frames that arrived with the opening frame.
        let mut parse = true;
        loop {
            if parse {
                parse = false;
                loop {
                    if inbox.len() < 5 {
                        break;
                    }
                    let kind = inbox[0];
                    let len = u32::from_le_bytes(inbox[1..5].try_into().unwrap()) as usize;
                    if len > MAX_TYPED_FRAME {
                        to_peer.extend(typed_frame(TCP_ERROR, b"frame too large"));
                        ended = true;
                        break;
                    }
                    if inbox.len() < 5 + len {
                        break;
                    }
                    let payload: Vec<u8> = inbox[5..5 + len].to_vec();
                    inbox.drain(..5 + len);
                    match kind {
                        TCP_DATA => to_origin.extend_from_slice(&payload),
                        TCP_START_TLS => {
                            if mode != "starttls" || upgraded || start_tls.is_some() {
                                to_peer.extend(typed_frame(
                                    TCP_ERROR,
                                    b"startTls is not available on this socket",
                                ));
                            } else {
                                start_tls = Some(String::from_utf8_lossy(&payload).to_string());
                                break;
                            }
                        }
                        TCP_SHUTDOWN => shutdown_requested = true,
                        TCP_CLOSE => {
                            ended = true;
                            break;
                        }
                        _ => {}
                    }
                }
                if ended {
                    break;
                }
            }

            if let Some(name) = start_tls.take() {
                // Everything written so far goes out in the clear first, as it was sent.
                if owr.write_all(&to_origin).await.is_err() {
                    to_peer.extend(typed_frame(TCP_ERROR, b"write failed"));
                    to_peer.extend(typed_frame(TCP_CLOSE, b""));
                    break;
                }
                to_origin.clear();
                let raw = ord.unsplit(owr);
                let ip: IpAddr = [0, 0, 0, 0].into();
                let Some(sn) = server_name(&name, ip) else {
                    to_peer.extend(typed_frame(TCP_ERROR, b"invalid server name"));
                    to_peer.extend(typed_frame(TCP_CLOSE, b""));
                    break;
                };
                match self.tls.connect(sn, raw).await {
                    Ok(tls) => {
                        upgraded = true;
                        let (r, w) = tokio::io::split(Box::new(tls) as Origin);
                        ord = r;
                        owr = w;
                        to_peer.extend(typed_frame(TCP_TLS_DONE, b""));
                    }
                    Err(e) => {
                        to_peer.extend(typed_frame(TCP_ERROR, e.to_string().as_bytes()));
                        to_peer.extend(typed_frame(TCP_CLOSE, b""));
                        break;
                    }
                }
                parse = true;
                continue;
            }

            if shutdown_requested && to_origin.is_empty() && !origin_shut {
                let _ = owr.shutdown().await;
                origin_shut = true;
            }
            if origin_eof && origin_shut {
                to_peer.extend(typed_frame(TCP_CLOSE, b""));
                break;
            }

            tokio::select! {
                r = prd.read(&mut pbuf), if to_origin.len() < BUFFER_LIMIT => {
                    match r {
                        Ok(0) | Err(_) => break,
                        Ok(n) => { inbox.extend_from_slice(&pbuf[..n]); parse = true; }
                    }
                }
                r = ord.read(&mut obuf), if !origin_eof && to_peer.len() < BUFFER_LIMIT => {
                    match r {
                        Ok(0) => { origin_eof = true; to_peer.extend(typed_frame(TCP_EOF, b"")); }
                        Ok(n) => to_peer.extend(typed_frame(TCP_DATA, &obuf[..n])),
                        Err(e) => {
                            to_peer.extend(typed_frame(TCP_ERROR, e.to_string().as_bytes()));
                            to_peer.extend(typed_frame(TCP_CLOSE, b""));
                            break;
                        }
                    }
                }
                w = pwr.write(to_peer.as_slice()), if !to_peer.is_empty() => {
                    match w { Ok(n) => { to_peer.drain(..n); } Err(_) => break }
                }
                w = owr.write(to_origin.as_slice()), if !to_origin.is_empty() => {
                    match w {
                        Ok(n) => { to_origin.drain(..n); }
                        Err(e) => {
                            to_peer.extend(typed_frame(TCP_ERROR, e.to_string().as_bytes()));
                            to_peer.extend(typed_frame(TCP_CLOSE, b""));
                            break;
                        }
                    }
                }
            }
        }
    }
}

/// Accept broker connections on `listener` until the task is dropped.
pub async fn serve(tunnels: Arc<Tunnels>, listener: TcpListener) {
    loop {
        let Ok((sock, _)) = listener.accept().await else {
            continue;
        };
        tokio::spawn(tunnels.clone().handle(sock));
    }
}
