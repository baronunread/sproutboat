/**
 * Fixtures for the egress differential harness: tracked child processes, a raw
 * HTTP/1.1 fake upstream (plain and TLS), a DNS stub, a self-signed certificate,
 * and the typed-frame client for the tunnel endpoint. Everything started here is
 * tracked and killed by PID; nothing uses pkill/pgrep.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

export const ROOT = resolve(import.meta.dir, "../..");
export const TS_WRAPPER = join(import.meta.dir, "ts-egress.ts");
export const RUST_DIFF_TARGET = join(ROOT, "services/egress-rs/target/diff");
export const DEFAULT_RUST_BIN = join(RUST_DIFF_TARGET, "release/sproutboat-egress");
export const TOKEN = "egress-diff-token";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type TunnelCtx = {
  echo: { port: number };
  tlsEcho: { port: number } | null;
};

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex").slice(0, 16);

// --- tracked children and temp dirs ---------------------------------------------------------

const children = new Set<Bun.Subprocess>();
const tempDirs = new Set<string>();
const stops = new Set<() => void>();

export function cleanupNow(): void {
  for (const stop of stops) {
    try {
      stop();
    } catch {
      // already stopped
    }
  }
  stops.clear();
  for (const proc of children) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    cleanupNow();
    process.exit(130);
  });
process.on("exit", cleanupNow);

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

// --- the two services ---------------------------------------------------------------------

export type Service = { name: "ts" | "rust"; http: number; tcp: number; stop: () => Promise<void> };

export async function startService(
  name: "ts" | "rust",
  env: Record<string, string>,
  rustBin: string,
): Promise<Service> {
  const cmd = name === "ts" ? ["bun", TS_WRAPPER] : [rustBin, "--host", "127.0.0.1", "--port", "0", "--tcp-port", "0"];
  const proc = Bun.spawn(cmd, {
    env: { ...process.env, SB_EGRESS_TOKEN: TOKEN, ...env },
    stdout: "pipe",
    stderr: "inherit",
  });
  children.add(proc);
  void proc.exited.then(() => children.delete(proc));
  let out = "";
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const ports = { http: 0, tcp: 0 };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
    if (name === "ts") {
      const m = /READY http=(\d+) tcp=(\d+)/.exec(out);
      if (m) {
        ports.http = Number(m[1]);
        ports.tcp = Number(m[2]);
        break;
      }
    } else {
      const h = /listening on http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      const t = /tunnels listening on port (\d+)/.exec(out);
      if (h && t) {
        ports.http = Number(h[1]);
        ports.tcp = Number(t[1]);
        break;
      }
    }
  }
  // keep draining so the child never blocks on a full pipe
  void (async () => {
    try {
      while (!(await reader.read()).done);
    } catch {
      // closed
    }
  })();
  if (!ports.http) {
    proc.kill("SIGKILL");
    throw new Error(`${name} egress did not start: ${out}`);
  }
  return {
    name,
    ...ports,
    stop: async () => {
      proc.kill("SIGTERM");
      const t = setTimeout(() => proc.kill("SIGKILL"), 3000);
      await proc.exited;
      clearTimeout(t);
    },
  };
}

// --- fake upstream (raw HTTP/1.1, keep-alive, recording) ---------------------------------

export type Seen = {
  method: string;
  target: string;
  headers: Record<string, string>;
  bodySha: string;
  bodyLen: number;
};

const BIG = Buffer.alloc(5 * 1024 * 1024);
for (let i = 0; i < BIG.length; i++) BIG[i] = (i * 31 + (i >> 8)) & 255;
const GZ = gzipSync("compressed hello, compressed hello, compressed hello");

function response(method: string, path: string): Uint8Array | string {
  const crlf = "\r\n";
  if (method === "HEAD") return `HTTP/1.1 200 OK${crlf}Content-Length: 10${crlf}X-H: 1${crlf}${crlf}`;
  switch (path) {
    case "/gzip":
      return Buffer.concat([
        Buffer.from(
          `HTTP/1.1 200 OK${crlf}Content-Encoding: gzip${crlf}Content-Type: text/plain${crlf}Content-Length: ${GZ.length}${crlf}${crlf}`,
        ),
        GZ,
      ]);
    case "/chunk":
      return `HTTP/1.1 200 OK${crlf}Transfer-Encoding: chunked${crlf}X-A: 1${crlf}Content-Type: text/plain${crlf}${crlf}5${crlf}hello${crlf}6${crlf} world${crlf}0${crlf}${crlf}`;
    case "/untyped":
      return `HTTP/1.1 200 OK${crlf}Content-Length: 4${crlf}${crlf}abcd`;
    case "/close":
      return `HTTP/1.1 200 OK${crlf}Connection: close${crlf}Content-Type: text/x${crlf}${crlf}hello until close`;
    case "/204":
      return `HTTP/1.1 204 No Content${crlf}X-A: 1${crlf}${crlf}`;
    case "/304":
      return `HTTP/1.1 304 Not Modified${crlf}ETag: "x"${crlf}${crlf}`;
    case "/empty":
      return `HTTP/1.1 200 OK${crlf}Content-Length: 0${crlf}${crlf}`;
    case "/redir":
      return `HTTP/1.1 302 Found${crlf}Location: http://127.0.0.2/next${crlf}Content-Length: 0${crlf}${crlf}`;
    case "/404":
      return `HTTP/1.1 404 Not Found${crlf}Content-Type: text/plain${crlf}Content-Length: 2${crlf}${crlf}no`;
    case "/500":
      return `HTTP/1.1 500 Oops${crlf}Content-Length: 3${crlf}${crlf}bad`;
    case "/cookies":
      return `HTTP/1.1 200 OK${crlf}Set-Cookie: a=1; Path=/${crlf}Set-Cookie: b=2${crlf}Content-Type: text/plain${crlf}Content-Length: 2${crlf}${crlf}ok`;
    case "/dup":
      return `HTTP/1.1 200 OK${crlf}X-Multi: a${crlf}x-multi: b${crlf}Content-Type: text/plain${crlf}Content-Length: 2${crlf}${crlf}ok`;
    case "/trunc":
      return `HTTP/1.1 200 OK${crlf}Content-Type: text/plain${crlf}Content-Length: 50${crlf}${crlf}hello`;
    case "/drop":
      return "";
    case "/big":
      return Buffer.concat([
        Buffer.from(
          `HTTP/1.1 200 OK${crlf}Content-Type: application/octet-stream${crlf}Content-Length: ${BIG.length}${crlf}${crlf}`,
        ),
        BIG,
      ]);
    default: {
      const text = "ok";
      return `HTTP/1.1 200 OK${crlf}Content-Type: text/plain${crlf}Content-Length: ${text.length}${crlf}${crlf}${text}`;
    }
  }
}

export type Upstream = { port: number; seen: Seen[]; stop: () => void };

export function fakeUpstream(opts: { tls?: { cert: string; key: string }; hostname?: string } = {}): Upstream {
  const seen: Seen[] = [];
  type State = { buf: Buffer };
  const listener = Bun.listen<State>({
    hostname: opts.hostname ?? "127.0.0.1",
    port: 0,
    tls: opts.tls,
    socket: {
      open(socket) {
        socket.data = { buf: Buffer.alloc(0) };
      },
      data(socket, chunk) {
        const st = socket.data;
        st.buf = Buffer.concat([st.buf, chunk]);
        for (;;) {
          const end = st.buf.indexOf("\r\n\r\n");
          if (end < 0) return;
          const head = st.buf.subarray(0, end).toString("latin1").split("\r\n");
          const [method, target] = head[0].split(" ");
          const headers: Record<string, string> = {};
          for (const line of head.slice(1)) {
            const i = line.indexOf(":");
            const k = line.slice(0, i).toLowerCase();
            const v = line.slice(i + 1).trim();
            headers[k] = k in headers ? `${headers[k]}, ${v}` : v;
          }
          const len = Number(headers["content-length"] ?? 0);
          if (st.buf.length < end + 4 + len) return;
          const body = st.buf.subarray(end + 4, end + 4 + len);
          st.buf = st.buf.subarray(end + 4 + len);
          seen.push({ method, target, headers, bodySha: sha(body), bodyLen: body.length });
          const path = target.split("?")[0];
          const res = response(method, path);
          if (path === "/drop") {
            socket.end();
            return;
          }
          socket.write(res);
          if (path === "/close" || path === "/trunc") {
            socket.end();
            return;
          }
        }
      },
      drain() {},
    },
  });
  stops.add(() => listener.stop(true));
  return { port: listener.port, seen, stop: () => listener.stop(true) };
}

/** A TCP echo server for the tunnel cases. `banner` is sent on connect. */
export function echoServer(opts: { tls?: { cert: string; key: string }; banner?: string; hostname?: string } = {}) {
  const listener = Bun.listen<undefined>({
    hostname: opts.hostname ?? "127.0.0.1",
    port: 0,
    tls: opts.tls,
    socket: {
      open(socket) {
        if (opts.banner) socket.write(opts.banner);
      },
      data(socket, chunk) {
        if (chunk.toString() === "HALFCLOSE\n") {
          socket.write("bye\n");
          socket.end();
          return;
        }
        socket.write(chunk);
      },
      drain() {},
    },
  });
  stops.add(() => listener.stop(true));
  return { port: listener.port, stop: () => listener.stop(true) };
}

// --- DNS stub ------------------------------------------------------------------------------

/**
 * `GET /resolve?host=NAME` -> JSON array of address texts, or 404. `script[name]` is a
 * list of answers, one per lookup; the last repeats. `lookups[name]` counts them.
 */
export function dnsStub(script: Record<string, string[][]>) {
  const lookups: Record<string, number> = {};
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const host = new URL(req.url).searchParams.get("host") ?? "";
      lookups[host] = (lookups[host] ?? 0) + 1;
      const answers = script[host];
      if (!answers) return new Response("nxdomain", { status: 404 });
      return Response.json(answers[Math.min(lookups[host] - 1, answers.length - 1)]);
    },
  });
  stops.add(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, lookups, stop: () => server.stop(true) };
}

// --- certificates --------------------------------------------------------------------------

export async function selfSigned(
  dir: string,
  name: string,
  san: string,
): Promise<{ cert: string; key: string; certPath: string }> {
  const keyPath = join(dir, `${name}.key`);
  const certPath = join(dir, `${name}.pem`);
  const p = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      `subjectAltName=${san}`,
      "-addext",
      "basicConstraints=critical,CA:FALSE",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  if ((await p.exited) !== 0) throw new Error("openssl failed");
  return { cert: await Bun.file(certPath).text(), key: await Bun.file(keyPath).text(), certPath };
}

// --- one request through an egress service -------------------------------------------------

export type Call = {
  method?: string;
  url?: string | null; // x-sb-egress-url; null = header absent
  token?: string | null; // null = header absent
  headers?: Record<string, string>;
  body?: string | Uint8Array<ArrayBuffer>;
  /** Request path on the egress service itself (it must be ignored). */
  path?: string;
};

export type Outcome = {
  status: number;
  headers: Record<string, string>;
  cookies: string[];
  bodyLen: number;
  bodySha: string;
  bodyText: string | null; // small bodies only
  error: string | null;
};

export async function call(service: Service, c: Call): Promise<Outcome> {
  const headers = { ...c.headers };
  if (c.url !== null) headers["x-sb-egress-url"] = c.url ?? "";
  if (c.token !== null) headers["x-sb-egress-token"] = c.token ?? TOKEN;
  try {
    const res = await fetch(`http://127.0.0.1:${service.http}${c.path ?? "/"}`, {
      method: c.method ?? "GET",
      headers,
      body: c.body,
      redirect: "manual",
      // Bun option: keep the bytes and Content-Encoding as relayed
      decompress: false,
    });
    const body = new Uint8Array(await res.arrayBuffer());
    const hs: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k !== "set-cookie") hs[k] = v;
    });
    return {
      status: res.status,
      headers: hs,
      cookies: res.headers.getSetCookie(),
      bodyLen: body.length,
      bodySha: sha(body),
      bodyText: body.length <= 2048 ? new TextDecoder().decode(body) : null,
      error: null,
    };
  } catch (error) {
    return { status: 0, headers: {}, cookies: [], bodyLen: 0, bodySha: "", bodyText: null, error: String(error) };
  }
}

// --- tunnel client -------------------------------------------------------------------------

export type Frame = { type: number; text: string };

export const T = { DATA: 1, START_TLS: 2, SHUTDOWN: 3, ERROR: 4, CONNECTED: 5, TLS_DONE: 6, CLOSE: 7, EOF: 8 };

export function openFrame(head: JsonObject): Buffer {
  const json = Buffer.from(JSON.stringify({ v: 1, ...head }), "utf8");
  const out = Buffer.allocUnsafe(9 + json.length);
  out.writeUInt32LE(5 + json.length, 0);
  out.writeUInt8(1, 4);
  out.writeUInt32LE(json.length, 5);
  json.copy(out, 9);
  return out;
}
function isText(value: string | Uint8Array): value is string {
  return String(value) === value;
}
export function typed(type: number, payload: Uint8Array | string = ""): Buffer {
  const p = isText(payload) ? Buffer.from(payload) : Buffer.from(payload);
  const out = Buffer.allocUnsafe(5 + p.length);
  out.writeUInt8(type, 0);
  out.writeUInt32LE(p.length, 1);
  p.copy(out, 5);
  return out;
}

/** Open a tunnel, send `steps` (raw buffers, or a pause in ms), and collect frames until quiet. */
export async function tunnel(
  port: number,
  first: Buffer,
  steps: Array<Buffer | number> = [],
  quietMs = 400,
): Promise<{ frames: Frame[]; closed: boolean }> {
  const frames: Frame[] = [];
  let buf = Buffer.alloc(0);
  let closed = false;
  let last = Date.now();
  const sock = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, chunk) {
        last = Date.now();
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 5) break;
          const len = buf.readUInt32LE(1);
          if (buf.length < 5 + len) break;
          frames.push({ type: buf[0], text: buf.subarray(5, 5 + len).toString("latin1") });
          buf = buf.subarray(5 + len);
        }
      },
      close() {
        closed = true;
      },
      drain() {},
      error() {
        closed = true;
      },
    },
  });
  sock.write(first);
  for (const step of steps) {
    if (Buffer.isBuffer(step)) sock.write(step);
    else await sleep(step);
    await sleep(60);
  }
  const deadline = Date.now() + 6000;
  last = Math.max(last, Date.now());
  while (Date.now() < deadline) {
    await sleep(25);
    if (Date.now() - last > quietMs) break;
    if (closed && Date.now() - last > 150) break;
  }
  try {
    sock.end();
  } catch {
    // closed already
  }
  return { frames, closed };
}

/** One request written by hand, so that the client adds no headers of its own (no User-Agent). */
export async function rawStatus(service: Service, headerLines: string[]): Promise<number> {
  let text = "";
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const sock = await Bun.connect({
    hostname: "127.0.0.1",
    port: service.http,
    socket: {
      data(_s, chunk) {
        text += chunk.toString("latin1");
      },
      close: done,
      error: done,
      drain() {},
    },
  });
  sock.write(`GET / HTTP/1.1\r\nHost: egress\r\nConnection: close\r\n${headerLines.join("\r\n")}\r\n\r\n`);
  await Promise.race([finished, sleep(10_000)]);
  return Number(text.split(" ")[1] ?? 0);
}
