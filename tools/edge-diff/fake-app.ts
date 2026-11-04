/**
 * The fake backend behind every edge-diff case. The same file is run as a sproutd stand-in
 * (`PORT=0`, announces its port) and, wrapped in a tiny `sprout` shell script, as a supervisor
 * sprout (`PORT` set by the pool). node:http rather than Bun.serve on purpose: Bun adds a
 * content-type to every response and the runtime's bare 500 has none.
 *
 * Env: PORT, APP_NAME, EDGE_DIFF_PIDDIR (write a pid file so the harness can sweep leftovers),
 * EDGE_DIFF_LIFETIME_MS (self-destruct guard, default 3 minutes).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Duplex } from "node:stream";

const name = process.env.APP_NAME ?? "app";
const counters = new Map<string, number>();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const NOISE = new Set(["user-agent", "connection", "keep-alive", "accept", "accept-encoding", "accept-language"]);

process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});
setTimeout(() => process.exit(0), Number(process.env.EDGE_DIFF_LIFETIME_MS) || 180_000);
// The supervisor asks a sprout to report when its JS started (boot time); the stand-in does so unless told not to.
if (process.env.SB_STARTUP_FILE && !process.env.NO_STARTUP_FILE)
  writeFileSync(process.env.SB_STARTUP_FILE, String(Date.now()));
if (process.env.EDGE_DIFF_PIDDIR) {
  mkdirSync(process.env.EDGE_DIFF_PIDDIR, { recursive: true });
  writeFileSync(`${process.env.EDGE_DIFF_PIDDIR}/${process.pid}`, name);
}

function seenHeaders(req: IncomingMessage, only?: string[]) {
  const out: Record<string, string | string[] | undefined> = {};
  for (const key of Object.keys(req.headers).sort()) {
    if (only ? !only.includes(key) : NOISE.has(key)) continue;
    out[key] = req.headers[key];
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(chunk);
  return Buffer.concat(parts);
}

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string | string[]> = {},
) {
  res.writeHead(status, { "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

async function http(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(`http://x${req.url ?? "/"}`); // not a base-relative parse: `//a//b` is a path, not an authority
  const path = url.pathname;
  const q = url.searchParams;
  const text = { "content-type": "text/plain" };

  if (path === "/seen") {
    const body = await readBody(req);
    return send(
      res,
      200,
      JSON.stringify({
        app: name,
        method: req.method,
        url: req.url,
        headers: seenHeaders(req),
        body: body.toString("latin1"),
      }),
      { "content-type": "application/json" },
    );
  }
  if (path.startsWith("/status/")) {
    const status = Number(path.slice("/status/".length));
    return send(res, status, `status ${status}`, text);
  }
  if (path === "/slow") {
    await sleep(Number(q.get("ms")) || 400);
    return send(res, 200, "late", text);
  }
  if (path === "/hang") return; // never answers
  if (path === "/busy") return send(res, 503, "app queue full", text);
  if (path === "/crash") {
    res.socket?.destroy();
    return;
  }
  if (path === "/big") {
    const n = Number(q.get("n")) || 0;
    res.writeHead(200, { "content-length": n, "content-type": "application/octet-stream" });
    let left = n;
    while (left > 0 && !res.destroyed) {
      const size = Math.min(left, 64 * 1024);
      if (!res.write(Buffer.alloc(size, 0x78))) await new Promise((resolve) => res.once("drain", resolve));
      left -= size;
    }
    res.end();
    return;
  }
  if (path === "/stream") {
    // Chunked, no content-length: the size is only known by counting.
    const n = Number(q.get("n")) || 0;
    const chunk = Number(q.get("chunk")) || 4096;
    res.writeHead(200, { "content-type": "application/octet-stream" });
    let left = n;
    while (left > 0 && !res.destroyed) {
      const size = Math.min(left, chunk);
      if (!res.write(Buffer.alloc(size, 0x79))) await new Promise((resolve) => res.once("drain", resolve));
      left -= size;
    }
    res.end();
    return;
  }
  if (path === "/stall") {
    // Headers and a first chunk now, the rest after a pause (a request deadline mid-body).
    res.writeHead(200, text);
    res.write("first;");
    await sleep(Number(q.get("ms")) || 800);
    res.end("second");
    return;
  }
  if (path === "/gzip") {
    // A compressed body the edge must forward untouched, content-encoding included.
    return send(res, 200, gzipSync(Buffer.from("hello gzip ".repeat(200))), {
      "content-type": "text/plain",
      "content-encoding": "gzip",
    });
  }
  if (path === "/sse") {
    // Headers at once, then events for a while: only the headers are subject to the request deadline.
    const total = Number(q.get("ms")) || 2500;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("data: start\n\n");
    const started = Date.now();
    while (Date.now() - started < total && !res.destroyed) {
      await sleep(250);
      res.write("data: tick\n\n");
    }
    res.end("data: done\n\n");
    return;
  }
  if (path === "/dropmid") {
    // Headers and a partial body, then the connection dies.
    res.writeHead(200, { "content-length": 1000, "content-type": "text/plain" });
    res.write("partial");
    await sleep(50);
    res.socket?.destroy();
    return;
  }
  if (path === "/upload") {
    const body = await readBody(req);
    return send(res, 200, JSON.stringify({ app: name, bytes: body.byteLength, method: req.method }), {
      "content-type": "application/json",
    });
  }
  if (path === "/echo") {
    const body = await readBody(req);
    return send(res, 200, body, {
      "x-sb-cpu-ms": "1.2345",
      "x-sb-uncaught": "boom",
      "x-seen-host": req.headers.host ?? "",
      "x-seen-secret": String(req.headers["x-sb-edge-secret"] ?? ""),
    });
  }
  if (path === "/uncaught") {
    // The runtime's answer to a throwing handler: bare 500, no content-type, 21 bytes.
    res.writeHead(500, { "content-length": 21 });
    res.end("Internal Server Error");
    return;
  }
  if (path === "/deliberate") return send(res, 500, "Internal Server Error", text);
  if (path === "/marker") {
    const marker = encodeURIComponent(JSON.stringify({ name: "Error", message: "callee" }));
    return send(res, 500, "Internal Server Error", { ...text, "x-sb-uncaught": marker });
  }
  if (path === "/uncaught-200") {
    return send(res, 200, "fine", { ...text, "x-sb-uncaught": "weird" });
  }
  if (path === "/uncaught-nolen") {
    res.writeHead(500);
    res.end("Internal Server Error");
    return;
  }
  if (path === "/cpu") {
    const headers = new Map(Object.entries(text));
    if (q.has("v")) headers.set("x-sb-cpu-ms", q.get("v") ?? "");
    return send(res, 200, "cpu", Object.fromEntries(headers));
  }
  if (path === "/redirect") return send(res, 302, "", { location: q.get("to") ?? "/target", "set-cookie": "r=1" });
  if (path === "/cookies") {
    return send(res, 200, "cookies", {
      ...text,
      "set-cookie": ["a=1; Path=/", "b=2; HttpOnly"],
      "x-dup": ["one", "two"],
    });
  }
  if (path === "/gen") {
    // A configurable response for the cache and header cases.
    const key = req.url ?? "";
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    const genHeaders = new Map([["content-type", q.get("ct") ?? "text/plain"]]);
    if (q.has("cc")) genHeaders.set("cache-control", q.get("cc") ?? "");
    if (q.has("vary")) genHeaders.set("vary", q.get("vary") ?? "");
    if (q.has("cookie")) genHeaders.set("set-cookie", "s=1");
    if (q.has("age")) genHeaders.set("age", q.get("age") ?? "");
    if (q.has("date")) genHeaders.set("date", new Date(Date.now() + Number(q.get("date")) * 1000).toUTCString());
    if (q.has("cpu")) genHeaders.set("x-sb-cpu-ms", q.get("cpu") ?? "");
    if (q.has("etag")) genHeaders.set("etag", '"v1"');
    if (q.has("x")) genHeaders.set("x-custom", q.get("x") ?? "");
    const headers = Object.fromEntries(genHeaders);
    const size = Number(q.get("size")) || 0;
    const prefix = `${name}:gen:${n}:`;
    const body = size > 0 ? prefix.padEnd(size, "x") : prefix;
    const status = Number(q.get("status")) || 200;
    if (q.has("nolen")) {
      res.writeHead(status, headers);
      res.write(body.slice(0, Math.floor(body.length / 2)));
      await sleep(5);
      res.end(body.slice(Math.floor(body.length / 2)));
      return;
    }
    return send(res, status, body, headers);
  }
  return send(
    res,
    200,
    JSON.stringify({ app: name, host: req.headers.host ?? null, path: path + url.search, rawUrl: req.url ?? null }),
    {
      "content-type": "application/json",
    },
  );
}

// ---- a small WebSocket server (RFC 6455: unfragmented frames, masked client frames) ----

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(opcode: number, payload: Buffer): Buffer {
  let head: Buffer;
  if (payload.length < 126) head = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([head, payload]);
}

const closeFrame = (code?: number, reason = "") => {
  if (code === undefined) return frame(8, Buffer.alloc(0));
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2);
  return frame(8, body);
};

function upgrade(req: IncomingMessage, socket: Duplex): void {
  const path = new URL(`http://x${req.url ?? "/"}`).pathname;
  socket.on("error", () => {});
  if (path === "/refuse") {
    socket.end(
      "HTTP/1.1 426 Upgrade Required\r\ncontent-length: 15\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nno sockets here",
    );
    return;
  }
  const key = String(req.headers["sec-websocket-key"] ?? "");
  const accept = createHash("sha1")
    .update(key + GUID)
    .digest("base64");
  const offered = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  const chosen = path === "/proto" ? (offered.includes("chat") ? "chat" : undefined) : undefined;
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n${chosen ? `sec-websocket-protocol: ${chosen}\r\n` : ""}\r\n`,
  );
  const send = (opcode: number, payload: Buffer) => {
    if (!socket.destroyed) socket.write(frame(opcode, payload));
  };
  if (path === "/greet") send(1, Buffer.from(`host:${req.headers.host}`));
  if (path === "/headers")
    send(
      1,
      Buffer.from(
        JSON.stringify(
          seenHeaders(req, [
            "host",
            "cookie",
            "authorization",
            "origin",
            "x-custom",
            "x-sb-edge-secret",
            "x-sb-edge-token",
            "x-sb-binding-call",
            "x-sb-url",
            "content-length",
            "transfer-encoding",
          ]),
        ),
      ),
    );
  if (path === "/pinger") {
    // Echo server that also pings every second (an idle but live socket).
    const timer = setInterval(() => send(9, Buffer.alloc(0)), 1000);
    socket.on("close", () => clearInterval(timer));
  }
  if (path === "/silent-close") {
    socket.write(closeFrame(1001, "going away"));
    socket.end();
    return;
  }
  let buffered = Buffer.alloc(0);
  let assembling: { opcode: number; parts: Buffer[] } | null = null;
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.length < 2) return;
      const fin = (buffered[0] & 0x80) !== 0;
      const opcode = buffered[0] & 0x0f;
      const masked = (buffered[1] & 0x80) !== 0;
      let length = buffered[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        length = Number(buffered.readBigUInt64BE(2));
        offset = 10;
      }
      const mask = masked ? buffered.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (buffered.length < offset + length) return;
      const payload = Buffer.from(buffered.subarray(offset, offset + length));
      buffered = buffered.subarray(offset + length);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (opcode === 9) {
        send(10, payload);
        continue;
      }
      if (opcode === 8) {
        if (!socket.destroyed) {
          socket.write(frame(8, payload.subarray(0, 2)));
          socket.end();
        }
        return;
      }
      if (opcode === 1 || opcode === 2) assembling = { opcode, parts: [] };
      if (!assembling) continue;
      assembling.parts.push(payload);
      if (!fin) continue;
      const whole = Buffer.concat(assembling.parts);
      const kind = assembling.opcode;
      assembling = null;
      if (kind === 2) send(2, whole);
      else if (whole.toString() === "bye") {
        socket.write(closeFrame(4002, "sprout says bye"));
        socket.end();
      } else if (whole.toString() === "nocode") {
        socket.write(closeFrame());
        socket.end();
      } else send(1, Buffer.concat([Buffer.from("echo:"), whole]));
    }
  });
}

const server = createServer((req, res) => {
  res.on("error", () => {});
  http(req, res).catch(() => res.destroy());
});
server.on("upgrade", upgrade);
server.listen(Number(process.env.PORT) || 0, "127.0.0.1", () => {
  const address = server.address();
  if (address instanceof Object) console.log(`fake-app ${name} listening on http://127.0.0.1:${address.port}`);
});
