//! The NDJSON request log. A line is `{"at":<ISO>, ...event fields in call-site
//! order..., "path":<pathname>}` exactly like the Bun edge's
//! `JSON.stringify({ at, ...event, path })`: undefined fields are simply not
//! pushed, `null` is kept. Writes go through a channel to one dedicated task
//! that batches them, so request handling never waits on the disk.

use crate::util::{iso8601, js_number_string, now_ms};
use std::path::Path;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot};

enum V {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
}

/// One log event under construction. Field order is insertion order.
pub struct Event {
    fields: Vec<(&'static str, V)>,
}

impl Event {
    pub fn new() -> Event {
        Event {
            fields: Vec::with_capacity(14),
        }
    }
    pub fn str(mut self, key: &'static str, value: &str) -> Event {
        self.fields.push((key, V::Str(value.to_string())));
        self
    }
    pub fn num(mut self, key: &'static str, value: f64) -> Event {
        self.fields.push((key, V::Num(value)));
        self
    }
    pub fn int(self, key: &'static str, value: u64) -> Event {
        self.num(key, value as f64)
    }
    pub fn bool(mut self, key: &'static str, value: bool) -> Event {
        self.fields.push((key, V::Bool(value)));
        self
    }
    pub fn null(mut self, key: &'static str) -> Event {
        self.fields.push((key, V::Null));
        self
    }
    /// `null` when absent.
    pub fn opt_str(self, key: &'static str, value: Option<&str>) -> Event {
        match value {
            Some(v) => self.str(key, v),
            None => self.null(key),
        }
    }
    pub fn opt_num(self, key: &'static str, value: Option<f64>) -> Event {
        match value {
            Some(v) => self.num(key, v),
            None => self.null(key),
        }
    }
    /// Skipped entirely when absent (a JS `undefined`).
    pub fn undef_str(self, key: &'static str, value: Option<&str>) -> Event {
        match value {
            Some(v) => self.str(key, v),
            None => self,
        }
    }
}

fn push_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The serialised line, without a trailing newline.
pub fn render(at_ms: u64, event: &Event, path: Option<&str>) -> String {
    let mut out = String::with_capacity(256);
    out.push_str("{\"at\":\"");
    out.push_str(&iso8601(at_ms));
    out.push('"');
    for (key, value) in &event.fields {
        out.push_str(",\"");
        out.push_str(key);
        out.push_str("\":");
        match value {
            V::Str(s) => push_json_string(&mut out, s),
            V::Num(n) => out.push_str(&js_number_string(*n)),
            V::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            V::Null => out.push_str("null"),
        }
    }
    if let Some(path) = path {
        out.push_str(",\"path\":");
        push_json_string(&mut out, path);
    }
    out.push('}');
    out
}

enum Msg {
    Line(String),
    Flush(oneshot::Sender<()>),
}

#[derive(Clone)]
pub struct LogSink {
    tx: Option<mpsc::UnboundedSender<Msg>>,
}

impl LogSink {
    pub fn disabled() -> LogSink {
        LogSink { tx: None }
    }

    /// Open the append-only log (creating parent directories) and start the writer task.
    pub fn open(path: &str) -> LogSink {
        let init = || -> std::io::Result<std::fs::File> {
            if let Some(parent) = Path::new(path).parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)?;
                }
            }
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
        };
        let file = match init() {
            Ok(f) => tokio::fs::File::from_std(f),
            Err(error) => {
                eprintln!("request log init failed: {error}");
                return LogSink::disabled();
            }
        };
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(writer(file, rx));
        LogSink { tx: Some(tx) }
    }

    /// Fire and forget; the `path` is the request pathname, already capped.
    pub fn write(&self, event: &Event, path: Option<&str>) {
        if let Some(tx) = &self.tx {
            let mut line = render(now_ms(), event, path);
            line.push('\n');
            let _ = tx.send(Msg::Line(line));
        }
    }

    /// Resolves once everything queued so far has been written.
    pub async fn flush(&self) {
        if let Some(tx) = &self.tx {
            let (done, wait) = oneshot::channel();
            if tx.send(Msg::Flush(done)).is_ok() {
                let _ = wait.await;
            }
        }
    }
}

async fn writer(mut file: tokio::fs::File, mut rx: mpsc::UnboundedReceiver<Msg>) {
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    while let Some(first) = rx.recv().await {
        let mut flushes = Vec::new();
        let mut handle = |msg: Msg, buf: &mut Vec<u8>| match msg {
            Msg::Line(line) => buf.extend_from_slice(line.as_bytes()),
            Msg::Flush(done) => flushes.push(done),
        };
        handle(first, &mut buf);
        while buf.len() < 256 * 1024 {
            match rx.try_recv() {
                Ok(msg) => handle(msg, &mut buf),
                Err(_) => break,
            }
        }
        if let Err(error) = file.write_all(&buf).await {
            eprintln!("request log stream error: {error}");
        }
        // tokio's File completes writes on a blocking thread: wait for them before acknowledging a flush.
        if !flushes.is_empty() {
            let _ = file.flush().await;
        }
        buf.clear();
        for done in flushes {
            let _ = done.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_shape_matches_the_bun_edge() {
        let e = Event::new()
            .str("hostname", "b.test")
            .str("method", "GET")
            .int("status", 200)
            .int("durationMs", 9)
            .int("ttfbMs", 6)
            .int("reqBytes", 0)
            .int("resBytes", 10)
            .null("cpuMs");
        assert_eq!(
            render(1_793_723_331_450, &e, Some("/hello")),
            r#"{"at":"2026-11-03T16:28:51.450Z","hostname":"b.test","method":"GET","status":200,"durationMs":9,"ttfbMs":6,"reqBytes":0,"resBytes":10,"cpuMs":null,"path":"/hello"}"#
        );
    }

    #[test]
    fn path_is_omitted_when_the_url_did_not_parse_and_strings_escape_like_json() {
        let e = Event::new()
            .str("error", "a\"b\\c\nd\u{1}")
            .bool("uncaught", true)
            .num("cpuMs", 1.25);
        assert_eq!(
            render(0, &e, None),
            "{\"at\":\"1970-01-01T00:00:00.000Z\",\"error\":\"a\\\"b\\\\c\\nd\\u0001\",\"uncaught\":true,\"cpuMs\":1.25}"
        );
    }

    #[tokio::test]
    async fn writer_appends_and_flushes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/requests.ndjson");
        let sink = LogSink::open(path.to_str().unwrap());
        sink.write(&Event::new().int("status", 200), Some("/a"));
        sink.write(&Event::new().int("status", 404), None);
        sink.flush().await;
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text
            .lines()
            .next()
            .unwrap()
            .ends_with(r#""status":200,"path":"/a"}"#));
    }
}
