//! The HTTP side of the service: one request in, one upstream request out.
//! Mirrors `createEgressHandler` in `egress.ts`.

use crate::addr::Allow;
use crate::resolve::Resolve;
use crate::upstream::{
    fetch_vetted, fold_headers, header_name, vet, Client, OutBody, Outbound, ReqBody, Vetting,
};
use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::{Body, Frame, Incoming, SizeHint};
use hyper::header::{HeaderValue, CONTENT_LENGTH, CONTENT_TYPE, HOST, TRANSFER_ENCODING};
use hyper::{Method, Request, Response, StatusCode};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use url::{Position, Url};

pub const EGRESS_URL_HEADER: &str = "x-sb-egress-url";
pub const EGRESS_TOKEN_HEADER: &str = "x-sb-egress-token";
pub const EGRESS_ERROR_HEADER: &str = "x-sb-egress-error";

/// Bun.serve's default `maxRequestBodySize`.
pub const DEFAULT_MAX_REQUEST_BYTES: usize = 128 * 1024 * 1024;

/// A request body with a declared length up to this is held in memory (and can be replayed
/// on a pooled connection); a larger or undeclared one is streamed.
pub const BODY_BUFFER_MAX: usize = 256 * 1024;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type RespBody = BoxBody<Bytes, BoxError>;

pub struct Egress {
    pub token: Vec<u8>,
    pub allow: Allow,
    /// The whole address table (default); `false` is `SB_EGRESS_STRICT=0`.
    pub strict: bool,
    pub max_request_bytes: usize,
    pub resolver: Box<dyn Resolve>,
    pub client: Client,
}

impl Egress {
    pub fn new(token: &str, allow: Allow, resolver: Box<dyn Resolve>) -> Result<Egress, String> {
        if token.is_empty() {
            return Err("the egress service needs a token".into());
        }
        Ok(Egress {
            token: token.as_bytes().to_vec(),
            allow,
            strict: true,
            max_request_bytes: DEFAULT_MAX_REQUEST_BYTES,
            resolver,
            client: Client::new(),
        })
    }
}

fn full(text: impl Into<Bytes>) -> RespBody {
    Full::new(text.into())
        .map_err(|never| match never {})
        .boxed()
}

/// `Response.json({ error }, { status, headers: { x-sb-egress-error: 1 } })`.
fn refuse(status: StatusCode, error: &str) -> Response<RespBody> {
    let body = serde_json::json!({ "error": error }).to_string();
    let mut res = Response::new(full(body));
    *res.status_mut() = status;
    res.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/json;charset=utf-8"),
    );
    res.headers_mut().insert(
        header_name(EGRESS_ERROR_HEADER),
        HeaderValue::from_static("1"),
    );
    res
}

fn plain(status: StatusCode, text: &'static str) -> Response<RespBody> {
    let mut res = Response::new(full(text));
    *res.status_mut() = status;
    res.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain;charset=utf-8"),
    );
    res
}

fn same_token(given: &[u8], expected: &[u8]) -> bool {
    if given.len() != expected.len() {
        return false;
    }
    given
        .iter()
        .zip(expected)
        .fold(0u8, |d, (a, b)| d | (a ^ b))
        == 0
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (
                (b[i + 1] as char).to_digit(16),
                (b[i + 2] as char).to_digit(16),
            ) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

enum ReadError {
    TooLarge,
    Broken,
}

/// Read a request body into memory, refusing more than `limit` bytes.
async fn read_body(mut body: Incoming, limit: usize) -> Result<Bytes, ReadError> {
    let mut buf: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else {
            return Err(ReadError::Broken);
        };
        if let Ok(data) = frame.into_data() {
            if buf.len() + data.len() > limit {
                return Err(ReadError::TooLarge);
            }
            buf.extend_from_slice(&data);
        }
    }
    Ok(Bytes::from(buf))
}

/// The caller's body passed on to the upstream as it arrives, failing (and noting why)
/// when it runs past the limit.
struct Limited {
    inner: Incoming,
    left: usize,
    exceeded: Arc<AtomicBool>,
}

impl Body for Limited {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    if data.len() > this.left {
                        this.exceeded.store(true, Ordering::SeqCst);
                        return Poll::Ready(Some(Err("request body too large".into())));
                    }
                    this.left -= data.len();
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(Box::new(e)))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

fn header_text(headers: &hyper::HeaderMap, name: &str) -> Option<Vec<u8>> {
    let mut it = headers.get_all(name).iter().peekable();
    it.peek()?;
    let parts: Vec<&[u8]> = it.map(|v| v.as_bytes()).collect();
    Some(parts.join(&b", "[..]))
}

/// The service's request handler.
pub async fn handle(egress: Arc<Egress>, req: Request<Incoming>) -> Response<RespBody> {
    let (parts, body) = req.into_parts();
    let given = header_text(&parts.headers, EGRESS_TOKEN_HEADER).unwrap_or_default();
    if !same_token(&given, &egress.token) {
        return plain(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let raw = String::from_utf8_lossy(
        &header_text(&parts.headers, EGRESS_URL_HEADER).unwrap_or_default(),
    )
    .to_string();
    let Ok(url) = Url::parse(&raw) else {
        return refuse(StatusCode::BAD_REQUEST, &format!("invalid url: {raw}"));
    };
    if url.scheme() != "https" && url.scheme() != "http" {
        return refuse(
            StatusCode::BAD_REQUEST,
            &format!("unsupported protocol: {}:", url.scheme()),
        );
    }
    if url.host_str().is_none_or(str::is_empty) {
        return refuse(StatusCode::BAD_REQUEST, &format!("invalid url: {raw}"));
    }

    let mut headers = fold_headers(&parts.headers);
    for name in [EGRESS_URL_HEADER, EGRESS_TOKEN_HEADER, "expect"] {
        headers.remove(name);
    }
    headers.remove(HOST);
    headers.remove(CONTENT_LENGTH);
    headers.remove(TRANSFER_ENCODING);
    let authority = &url[Position::BeforeHost..Position::AfterPort];
    if let Ok(v) = HeaderValue::from_str(authority) {
        headers.insert(HOST, v);
    }
    // Like Bun's fetch: credentials in the URL become Basic auth, and a missing
    // Accept / User-Agent gets Bun's default.
    if (!url.username().is_empty() || url.password().is_some())
        && !headers.contains_key(hyper::header::AUTHORIZATION)
    {
        let mut cred = percent_decode(url.username());
        cred.push(b':');
        cred.extend(percent_decode(url.password().unwrap_or("")));
        if let Ok(v) = HeaderValue::from_str(&format!("Basic {}", base64(&cred))) {
            headers.insert(hyper::header::AUTHORIZATION, v);
        }
    }
    if !headers.contains_key(hyper::header::ACCEPT) {
        headers.insert(hyper::header::ACCEPT, HeaderValue::from_static("*/*"));
    }

    // Destination first: the port, then the resolved addresses. Nothing of the request
    // body is read until both pass.
    if url.port_or_known_default() == Some(25) {
        return refuse(StatusCode::BAD_GATEWAY, PORT_25_REFUSAL);
    }
    let vetting = Vetting {
        resolver: egress.resolver.as_ref(),
        allow: &egress.allow,
        strict: egress.strict,
    };
    let vetted = match vet(&url, &vetting).await {
        Ok(v) => v,
        Err(message) => return refuse(StatusCode::BAD_GATEWAY, &message),
    };

    let method = parts.method.clone();
    let exceeded = Arc::new(AtomicBool::new(false));
    let too_large = || plain(StatusCode::PAYLOAD_TOO_LARGE, "Request Entity Too Large");
    let out_body = if method == Method::GET || method == Method::HEAD {
        OutBody::Buffered(Bytes::new())
    } else {
        let declared = header_text(&parts.headers, "content-length")
            .and_then(|v| String::from_utf8_lossy(&v).trim().parse::<usize>().ok());
        match declared {
            Some(n) if n > egress.max_request_bytes => return too_large(),
            Some(n) if n <= BODY_BUFFER_MAX => {
                match read_body(body, egress.max_request_bytes).await {
                    Ok(b) => {
                        // Bun's fetch always states the length of a body-carrying request, even 0.
                        headers.insert(CONTENT_LENGTH, HeaderValue::from(b.len()));
                        OutBody::Buffered(b)
                    }
                    Err(ReadError::TooLarge) => return too_large(),
                    Err(ReadError::Broken) => return plain(StatusCode::BAD_REQUEST, "Bad Request"),
                }
            }
            _ => {
                if let Some(n) = declared {
                    headers.insert(CONTENT_LENGTH, HeaderValue::from(n));
                }
                let stream: ReqBody = Limited {
                    inner: body,
                    left: egress.max_request_bytes,
                    exceeded: exceeded.clone(),
                }
                .boxed();
                OutBody::Stream(Some(stream))
            }
        }
    };
    let out = Outbound {
        method: method.clone(),
        headers,
        body: out_body,
    };
    match fetch_vetted(&egress.client, &url, out, &vetted).await {
        Ok(upstream) => relay(upstream, &method),
        Err(_) if exceeded.load(Ordering::SeqCst) => too_large(),
        Err(message) => refuse(StatusCode::BAD_GATEWAY, &message),
    }
}

/// `fetch()` to port 25 is refused, as the tunnel refuses it (and as Workers does).
pub const PORT_25_REFUSAL: &str = "fetch() refused: port 25 is blocked, as on Workers";

/// `new Response(upstream.body, { status, headers })`.
fn relay(upstream: Response<crate::upstream::Guarded>, method: &Method) -> Response<RespBody> {
    let (parts, body) = upstream.into_parts();
    let mut headers = fold_headers(&parts.headers);
    headers.remove(TRANSFER_ENCODING);
    // A Response built from a stream gets `application/octet-stream` when the
    // upstream named no type; bodiless answers do not.
    let bodiless = *method == Method::HEAD
        || parts.status.is_informational()
        || parts.status == StatusCode::NO_CONTENT
        || parts.status == StatusCode::RESET_CONTENT
        || parts.status == StatusCode::NOT_MODIFIED
        || headers
            .get(CONTENT_LENGTH)
            .map(|v| v.as_bytes() == b"0")
            .unwrap_or(false);
    if !bodiless && !headers.contains_key(CONTENT_TYPE) {
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
    }
    let mut res = Response::new(body.map_err(|e| -> BoxError { Box::new(e) }).boxed());
    *res.status_mut() = parts.status;
    *res.headers_mut() = headers;
    res
}

/// Connection-level limits for the HTTP side.
#[derive(Clone, Copy, Debug)]
pub struct ServeLimits {
    /// Time allowed to receive a request head (also bounds an idle keep-alive wait).
    pub header_read_timeout: Duration,
    /// Largest buffered request head.
    pub max_buf_size: usize,
    /// Concurrent connections served; accepting waits when exhausted.
    pub max_connections: usize,
}

impl Default for ServeLimits {
    fn default() -> Self {
        ServeLimits {
            header_read_timeout: Duration::from_secs(30),
            max_buf_size: 64 * 1024,
            max_connections: 1024,
        }
    }
}

/// Serve the HTTP side on `listener` until the task is dropped.
pub async fn serve(egress: Arc<Egress>, listener: tokio::net::TcpListener) {
    serve_with(egress, listener, ServeLimits::default()).await
}

pub async fn serve_with(
    egress: Arc<Egress>,
    listener: tokio::net::TcpListener,
    limits: ServeLimits,
) {
    let slots = Arc::new(tokio::sync::Semaphore::new(limits.max_connections));
    loop {
        let Ok(permit) = slots.clone().acquire_owned().await else {
            return;
        };
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let _ = stream.set_nodelay(true);
        let egress = egress.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let svc = hyper::service::service_fn(move |req| {
                let egress = egress.clone();
                async move { Ok::<_, std::convert::Infallible>(handle(egress, req).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .timer(hyper_util::rt::TokioTimer::new())
                .header_read_timeout(limits.header_read_timeout)
                .max_buf_size(limits.max_buf_size)
                .serve_connection(hyper_util::rt::TokioIo::new(stream), svc)
                .await;
        });
    }
}

#[cfg(test)]
mod serve_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn silent_connection_is_closed_after_header_timeout() {
        let egress = Arc::new(
            Egress::new(
                "t",
                Allow::default(),
                Box::new(crate::resolve::StaticResolver(vec![])),
            )
            .unwrap(),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let limits = ServeLimits {
            header_read_timeout: Duration::from_millis(200),
            ..ServeLimits::default()
        };
        tokio::spawn(serve_with(egress, listener, limits));
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        s.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
        let mut buf = Vec::new();
        let r = tokio::time::timeout(Duration::from_secs(5), s.read_to_end(&mut buf)).await;
        assert!(r.is_ok(), "connection was not closed");
    }
}
