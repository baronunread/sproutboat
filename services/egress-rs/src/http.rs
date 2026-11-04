//! The HTTP side of the service: one request in, one upstream request out.
//! Mirrors `createEgressHandler` in `egress.ts`.

use crate::resolve::Resolve;
use crate::upstream::{
    fold_headers, header_name, vetted_fetch, Client, Outbound, Vetting, DEFAULT_USER_AGENT,
};
use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{HeaderValue, CONTENT_LENGTH, CONTENT_TYPE, HOST, TRANSFER_ENCODING};
use hyper::{Method, Request, Response, StatusCode};
use std::sync::Arc;
use url::{Position, Url};

pub const EGRESS_URL_HEADER: &str = "x-sb-egress-url";
pub const EGRESS_TOKEN_HEADER: &str = "x-sb-egress-token";
pub const EGRESS_ERROR_HEADER: &str = "x-sb-egress-error";

/// Bun.serve's default `maxRequestBodySize`.
pub const DEFAULT_MAX_REQUEST_BYTES: usize = 128 * 1024 * 1024;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type RespBody = BoxBody<Bytes, BoxError>;

pub struct Egress {
    pub token: Vec<u8>,
    pub allow: Vec<String>,
    pub strict: bool,
    pub max_request_bytes: usize,
    pub resolver: Box<dyn Resolve>,
    pub client: Client,
}

impl Egress {
    pub fn new(
        token: &str,
        allow: Vec<String>,
        resolver: Box<dyn Resolve>,
    ) -> Result<Egress, String> {
        if token.is_empty() {
            return Err("the egress service needs a token".into());
        }
        Ok(Egress {
            token: token.as_bytes().to_vec(),
            allow,
            strict: false,
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

/// Read a request body, refusing more than `limit` bytes.
async fn read_body(body: Incoming, limit: usize) -> Result<Bytes, ()> {
    use hyper::body::Body;
    if body.size_hint().lower() as usize > limit {
        return Err(());
    }
    let mut body = body;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else { return Err(()) };
        if let Ok(data) = frame.into_data() {
            if buf.len() + data.len() > limit {
                return Err(());
            }
            buf.extend_from_slice(&data);
        }
    }
    Ok(Bytes::from(buf))
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
    if !headers.contains_key(hyper::header::USER_AGENT) {
        headers.insert(
            hyper::header::USER_AGENT,
            HeaderValue::from_static(DEFAULT_USER_AGENT),
        );
    }

    let method = parts.method.clone();
    let body = if method == Method::GET || method == Method::HEAD {
        Bytes::new()
    } else {
        match read_body(body, egress.max_request_bytes).await {
            Ok(b) => b,
            Err(()) => return plain(StatusCode::PAYLOAD_TOO_LARGE, "Request Entity Too Large"),
        }
    };
    if method != Method::GET && method != Method::HEAD {
        // Bun's fetch always states the length of a body-carrying request, even 0.
        headers.insert(CONTENT_LENGTH, HeaderValue::from(body.len()));
    }
    let out = Outbound {
        method: method.clone(),
        headers,
        body,
    };
    let vetting = Vetting {
        resolver: egress.resolver.as_ref(),
        allow: &egress.allow,
        strict: egress.strict,
    };
    match vetted_fetch(&egress.client, &url, &out, &vetting).await {
        Ok(upstream) => relay(upstream, &method),
        Err(message) => refuse(StatusCode::BAD_GATEWAY, &message),
    }
}

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

/// Serve the HTTP side on `listener` until the task is dropped.
pub async fn serve(egress: Arc<Egress>, listener: tokio::net::TcpListener) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let _ = stream.set_nodelay(true);
        let egress = egress.clone();
        tokio::spawn(async move {
            let svc = hyper::service::service_fn(move |req| {
                let egress = egress.clone();
                async move { Ok::<_, std::convert::Infallible>(handle(egress, req).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(hyper_util::rt::TokioIo::new(stream), svc)
                .await;
        });
    }
}
