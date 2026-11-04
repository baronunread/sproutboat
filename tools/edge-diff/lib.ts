/**
 * Process management, fixtures and the raw HTTP/WebSocket clients used by the edge differential
 * harness. Everything that is started is tracked and killed; temp dirs live under the OS tmpdir.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  renameSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { readAssetRules, walkAssets, type AssetManifest } from "@sproutboat/assets";

export const ROOT = resolve(import.meta.dir, "../..");
export const FAKE_APP = join(import.meta.dir, "fake-app.ts");
export const BUN_EDGE_MAIN = join(ROOT, "services/edge/src/main.ts");
/** Wrappers that register the case's scoped binding credentials first (see credentials-sync.ts). */
export const BUN_EDGE_WITH_CREDENTIALS = join(import.meta.dir, "bun-edge-main.ts");
export const SIDECAR_WITH_CREDENTIALS = join(import.meta.dir, "sidecar-main.ts");
export const DEFAULT_RUST_BIN = join(ROOT, "services/edge-rs/target/release/sproutboat-edge");

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// ---------------------------------------------------------------------------------------------
// tracked children and temp dirs

const children = new Set<Bun.Subprocess>();
const tempDirs = new Set<string>();
const pidDirs = new Set<string>();

export function track<T extends Bun.Subprocess>(proc: T): T {
  children.add(proc);
  void proc.exited.then(() => children.delete(proc));
  return proc;
}

function killPidFiles(only?: string): void {
  for (const dir of only ? [only] : pidDirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 1) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

/** Synchronous last-resort cleanup (also runs on exit and on fatal signals). */
export function cleanupNow(): void {
  for (const proc of children) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  killPidFiles();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    cleanupNow();
    process.exit(130);
  });
process.on("exit", cleanupNow);

export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `edge-diff-${prefix}-`));
  tempDirs.add(dir);
  return dir;
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  tempDirs.delete(dir);
}

/** Stop one tracked child: SIGTERM (so the edge can dispose its sprouts), SIGKILL after a grace period. */
export async function stopProc(proc: Bun.Subprocess, graceMs = 1500): Promise<void> {
  if (proc.exitCode !== null || proc.killed) {
    await Promise.race([proc.exited, sleep(200)]);
    return;
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    return;
  }
  const done = await Promise.race([proc.exited.then(() => true), sleep(graceMs).then(() => false)]);
  if (!done) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
    await Promise.race([proc.exited, sleep(500)]);
  }
}

// ---------------------------------------------------------------------------------------------
// reading a child's output

function pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void, tail?: { text: string }): void {
  void (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        if (tail) tail.text = (tail.text + text).slice(-8192);
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) onLine(line);
      }
    } catch {
      // killed
    }
    if (pending) onLine(pending);
  })();
}

// ---------------------------------------------------------------------------------------------
// fake backends and sprouts

export interface App {
  name: string;
  port: number;
  url: string;
  proc: Bun.Subprocess;
}

export interface AssetsSpec {
  /** Served path (no leading slash needed) -> contents. */
  files: Record<string, string | Uint8Array>;
  headers?: string;
  redirects?: string;
  runSproutFirst?: boolean | string[];
  notFound?: AssetManifest["notFound"];
  /** Write this text as assets.json instead of the generated manifest. */
  rawManifest?: string;
}

export interface SproutOpts {
  assets?: AssetsSpec;
  /** Replace the sprout executable entirely (shell script text). */
  script?: string;
  /** Do not create an executable at all (the file is missing). */
  missing?: boolean;
}

export class Fixture {
  readonly apps = new Map<string, App>();
  readonly sprouts = new Map<string, string>();
  readonly pidDir: string;

  constructor(readonly dir: string) {
    this.pidDir = join(dir, "pids");
    mkdirSync(this.pidDir, { recursive: true });
    pidDirs.add(this.pidDir);
  }

  /** Kill any process that registered a pid file here (sprouts the edge may have left behind). */
  sweep(): void {
    killPidFiles(this.pidDir);
    pidDirs.delete(this.pidDir);
  }

  path(...parts: string[]): string {
    const full = join(this.dir, ...parts);
    mkdirSync(dirname(full), { recursive: true });
    return full;
  }

  /** Port name -> number, for scrubbing ports out of bodies, headers and logs. */
  ports() {
    return Object.fromEntries([...this.apps].map(([name, app]) => [`app:${name}`, app.port]));
  }

  /** A fake sproutd-style backend on a fresh loopback port. */
  async startApp(name: string, env: Record<string, string> = {}): Promise<App> {
    const proc = track(
      Bun.spawn(["bun", FAKE_APP], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          APP_NAME: name,
          PORT: "0",
          EDGE_DIFF_PIDDIR: this.pidDir,
          ...env,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      }),
    );
    const port = await new Promise<number>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`fake app ${name} did not announce a port`)), 10_000);
      pump(proc.stdout, (line) => {
        const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
        if (match) {
          clearTimeout(timer);
          done(Number(match[1]));
        }
      });
      void proc.exited.then(() => {
        clearTimeout(timer);
        fail(new Error(`fake app ${name} exited early`));
      });
    });
    const app = { name, port, url: `http://127.0.0.1:${port}`, proc };
    this.apps.set(name, app);
    return app;
  }

  /** A loopback port nothing listens on. */
  async closedPort(): Promise<number> {
    return await new Promise<number>((done, fail) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = address instanceof Object ? address.port : 0;
        server.close(() => (port ? done(port) : fail(new Error("no port"))));
      });
    });
  }

  /** An artifact directory with a stand-in sprout (the fake app, honouring $PORT). Returns the sprout path. */
  async makeSprout(name: string, opts: SproutOpts = {}): Promise<string> {
    const dirPath = join(this.dir, "artifacts", name);
    mkdirSync(dirPath, { recursive: true });
    const sproutPath = join(dirPath, "sprout");
    if (!opts.missing) {
      const script =
        opts.script ??
        `#!/bin/sh\nexport APP_NAME=${name}\nexport EDGE_DIFF_PIDDIR=${this.pidDir}\nexec bun ${FAKE_APP}\n`;
      writeFileSync(sproutPath, script);
      chmodSync(sproutPath, 0o755);
    }
    if (opts.assets) writeAssets(dirPath, opts.assets);
    this.sprouts.set(name, sproutPath);
    return sproutPath;
  }
}

function writeAssets(artifactDir: string, spec: AssetsSpec): void {
  const assetsDir = join(artifactDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  for (const [key, content] of Object.entries(spec.files)) {
    const file = join(assetsDir, key.replace(/^\//, ""));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  if (spec.headers !== undefined) writeFileSync(join(assetsDir, "_headers"), spec.headers);
  if (spec.redirects !== undefined) writeFileSync(join(assetsDir, "_redirects"), spec.redirects);
  if (spec.rawManifest !== undefined) {
    writeFileSync(join(artifactDir, "assets.json"), spec.rawManifest);
    return;
  }
  const rules = readAssetRules(assetsDir);
  const manifest: AssetManifest = {
    notFound: spec.notFound ?? "none",
    runSproutFirst: spec.runSproutFirst ?? false,
    files: walkAssets(assetsDir),
  };
  if (spec.headers !== undefined) manifest.headers = rules.headers;
  if (spec.redirects !== undefined) manifest.redirects = rules.redirects;
  writeFileSync(join(artifactDir, "assets.json"), JSON.stringify(manifest));
}

// ---------------------------------------------------------------------------------------------
// edge processes

export type EdgeKind = "bun" | "rust";

export interface EdgeHandle {
  kind: EdgeKind;
  proc: Bun.Subprocess;
  pid: number;
  port: number;
  /** stdout lines after the listening line. */
  stdout: string[];
  stderr: { text: string };
  exited: Promise<number>;
}

export interface StartFailure {
  failed: true;
  code: number | null;
  stdout: string[];
  stderr: string;
}

export async function startEdge(opts: {
  kind: EdgeKind;
  bin: string;
  env: Record<string, string>;
  cwd: string;
  /** Wait for the process to die instead of for the listening line. */
  expectFailure?: boolean;
}): Promise<EdgeHandle | StartFailure> {
  const entry = opts.env.EDGE_DIFF_CREDENTIALS_FILE ? BUN_EDGE_WITH_CREDENTIALS : BUN_EDGE_MAIN;
  const cmd = opts.kind === "bun" ? ["bun", entry] : [opts.bin];
  const proc = track(Bun.spawn(cmd, { env: opts.env, cwd: opts.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
  const stdout: string[] = [];
  const stderr = { text: "" };
  pump(proc.stderr, () => {}, stderr);
  let port = 0;
  let announce: (value: number) => void = () => {};
  const announced = new Promise<number>((done) => (announce = done));
  pump(proc.stdout, (line) => {
    const match = /Sproutboat edge router listening on http:\/\/[^:\s]+:(\d+)/.exec(line);
    if (match && !port) {
      port = Number(match[1]);
      announce(port);
    } else stdout.push(line);
  });
  const exited = proc.exited.then((code) => code ?? -1);
  const winner = await Promise.race([
    announced.then(() => "up" as const),
    exited.then(() => "down" as const),
    sleep(20_000).then(() => "timeout" as const),
  ]);
  if (winner !== "up") {
    if (winner === "timeout") await stopProc(proc);
    await sleep(50);
    return { failed: true, code: proc.exitCode, stdout, stderr: stderr.text };
  }
  return { kind: opts.kind, proc, pid: proc.pid, port, stdout, stderr, exited };
}

export async function stopEdge(edge: EdgeHandle): Promise<void> {
  await stopProc(edge.proc);
}

// ---------------------------------------------------------------------------------------------
// raw HTTP client

export type Hdrs = [string, string][];

export interface HttpObs {
  kind: "http";
  label: string;
  status: number;
  headers: Hdrs;
  body: Uint8Array;
  /** The body ended the way its framing said it would. */
  complete: boolean;
  /** Connection-level failure or timeout, when there was one. */
  error?: string;
  hungUp?: boolean;
  loose?: Loose;
}

export interface NoteObs {
  kind: "note";
  label: string;
  value: Json;
}

export type Obs = HttpObs | NoteObs;

/** Per-request comparison relaxations. */
export interface Loose {
  /** Do not compare the body bytes (only completeness). */
  body?: boolean;
  /** Header names to ignore. */
  headers?: string[];
  /** Header name -> allowed absolute numeric difference. */
  tolerance?: Record<string, number>;
  /** Compare `connection` and `keep-alive` too (ignored by default). */
  strictHop?: boolean;
  /** Do not compare the status. */
  status?: boolean;
}

export interface ReqSpec {
  method?: string;
  path?: string;
  /** Host header; null omits it. Defaults to the case host. */
  host?: string | null;
  headers?: Record<string, string> | Hdrs;
  body?: string | Uint8Array;
  /** Send the body chunked, one piece at a time. */
  chunks?: (string | Uint8Array)[];
  chunkDelayMs?: number;
  /** Omit the content-length header even though there is a body (with `body`: close-delimited). */
  httpVersion?: "1.1" | "1.0";
  timeoutMs?: number;
  /** Close the socket this long after sending, without reading a response. */
  hangUpAfterMs?: number;
  /** Stop after the response head (a 101). */
  upgrade?: boolean;
  loose?: Loose;
}

const asBuf = (value: string | Uint8Array) =>
  value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(value, "latin1");

export function rawRequest(port: number, label: string, defaultHost: string, spec: ReqSpec = {}): Promise<HttpObs> {
  const method = spec.method ?? "GET";
  const host = spec.host === undefined ? defaultHost : spec.host;
  const version = spec.httpVersion ?? "1.1";
  const headers: Hdrs = Array.isArray(spec.headers) ? [...spec.headers] : Object.entries(spec.headers ?? {});
  const has = (name: string) => headers.some(([key]) => key.toLowerCase() === name);
  const lines = [`${method} ${spec.path ?? "/"} HTTP/${version}`];
  if (host !== null) lines.push(`host: ${host}`);
  for (const [key, value] of headers) lines.push(`${key}: ${value}`);
  const body = spec.body === undefined ? null : asBuf(spec.body);
  if (spec.chunks) {
    if (!has("transfer-encoding")) lines.push("transfer-encoding: chunked");
  } else if (body && !has("content-length")) lines.push(`content-length: ${body.length}`);
  const head = Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");

  return new Promise<HttpObs>((done) => {
    const obs: HttpObs = {
      kind: "http",
      label,
      status: 0,
      headers: [],
      body: new Uint8Array(),
      complete: false,
      loose: spec.loose,
    };
    const socket: Socket = createConnection({ host: "127.0.0.1", port });
    let buf: Buffer = Buffer.alloc(0);
    let state: "head" | "length" | "chunked" | "close" | "done" = "head";
    let remaining = 0;
    const parts: Buffer[] = [];
    let finished = false;
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error && !obs.error) obs.error = error;
      obs.body = new Uint8Array(Buffer.concat(parts));
      socket.destroy();
      done(obs);
    };
    const timer = setTimeout(() => finish("timeout"), spec.timeoutMs ?? 10_000);

    const header = (name: string) => obs.headers.find(([key]) => key === name)?.[1];

    const pumpBody = () => {
      for (;;) {
        if (state === "length") {
          const take = Math.min(remaining, buf.length);
          if (take > 0) {
            parts.push(buf.subarray(0, take));
            buf = buf.subarray(take);
            remaining -= take;
          }
          if (remaining === 0) {
            obs.complete = true;
            return finish();
          }
          return;
        }
        if (state === "close") {
          if (buf.length) parts.push(buf);
          buf = Buffer.alloc(0);
          return;
        }
        if (state === "chunked") {
          const eol = buf.indexOf("\r\n");
          if (eol < 0) return;
          const size = Number.parseInt(buf.subarray(0, eol).toString("latin1").split(";")[0].trim(), 16);
          if (!Number.isFinite(size)) return finish("bad chunk size");
          if (size === 0) {
            // no trailers expected: the size line is followed by the final empty line
            if (buf.length < eol + 4) return;
            obs.complete = true;
            return finish();
          }
          if (buf.length < eol + 2 + size + 2) return;
          parts.push(buf.subarray(eol + 2, eol + 2 + size));
          buf = buf.subarray(eol + 2 + size + 2);
          continue;
        }
        return;
      }
    };

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (state === "head") {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const text = buf.subarray(0, end).toString("latin1").split("\r\n");
        buf = buf.subarray(end + 4);
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(text[0] ?? "");
        obs.status = status ? Number(status[1]) : 0;
        for (const line of text.slice(1)) {
          const colon = line.indexOf(":");
          if (colon > 0) obs.headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
        }
        const noBody = method === "HEAD" || obs.status === 204 || obs.status === 304 || obs.status < 200;
        if (spec.upgrade && obs.status === 101) {
          obs.complete = true;
          return finish();
        }
        if (noBody) {
          obs.complete = true;
          return finish();
        }
        const te = header("transfer-encoding");
        const cl = header("content-length");
        if (te?.toLowerCase().includes("chunked")) state = "chunked";
        else if (cl !== undefined && /^\d+$/.test(cl)) {
          state = "length";
          remaining = Number(cl);
        } else state = "close";
      }
      pumpBody();
    };
    socket.on("data", onData);
    // SAFETY: socket errors raised by node:net are Error instances that may carry an errno `code`; `?? error.message` covers the rest.
    socket.on("error", (error) => finish(`socket error: ${(error as NodeJS.ErrnoException).code ?? error.message}`));
    socket.on("close", () => {
      if (finished) return;
      if (state === "head") finish(obs.status === 0 ? "closed before a response" : "closed in headers");
      else if (state === "close") {
        obs.complete = true;
        finish();
      } else finish("closed mid-body");
    });
    socket.on("connect", () => {
      socket.write(head);
      if (spec.chunks) {
        void (async () => {
          for (const piece of spec.chunks ?? []) {
            const data = asBuf(piece);
            if (socket.destroyed) return;
            socket.write(Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`), data, Buffer.from("\r\n")]));
            if (spec.chunkDelayMs) await sleep(spec.chunkDelayMs);
          }
          if (!socket.destroyed) socket.write("0\r\n\r\n");
        })();
      } else if (body) socket.write(body);
      if (spec.hangUpAfterMs !== undefined) {
        setTimeout(() => {
          obs.hungUp = true;
          finish();
        }, spec.hangUpAfterMs);
      }
    });
  });
}

export const bodyText = (obs: HttpObs) => Buffer.from(obs.body).toString("utf8");
export const sha1 = (data: Uint8Array | string) => createHash("sha1").update(data).digest("hex");

// ---------------------------------------------------------------------------------------------
// WebSocket client

export interface WsConn {
  opened: boolean;
  protocol: string;
  next(timeoutMs?: number): Promise<Json>;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  closed: Promise<{ code: number; reason: string }>;
}

/** What a received frame looks like in an observation: text as-is, bytes as a length + digest (+ prefix). */
function describeMessage(data: string | ArrayBuffer): Json {
  if (!(data instanceof ArrayBuffer))
    return data.length > 200 ? { text: data.length, sha1: sha1(data), head: data.slice(0, 40) } : data;
  const bytes = new Uint8Array(data);
  return { binary: bytes.length, sha1: sha1(bytes), head: Array.from(bytes.slice(0, 8)) };
}

export function openWebSocket(
  port: number,
  path: string,
  opts: { host: string; protocols?: string[]; headers?: Record<string, string>; timeoutMs?: number },
): Promise<WsConn> {
  return new Promise((done) => {
    const headers = { host: opts.host, ...opts.headers };
    // Bun's WebSocket takes handshake options as its second argument; the DOM typings do not know them.
    const ws: WebSocket = Reflect.construct(WebSocket, [
      `ws://127.0.0.1:${port}${path}`,
      { protocols: opts.protocols ?? [], headers },
    ]);
    ws.binaryType = "arraybuffer";
    const queue: Json[] = [];
    const waiting: ((value: Json) => void)[] = [];
    let settled = false;
    let closeResult: (value: { code: number; reason: string }) => void = () => {};
    const closed = new Promise<{ code: number; reason: string }>((resolveClosed) => (closeResult = resolveClosed));
    const conn: WsConn = {
      opened: false,
      protocol: "",
      next: (timeoutMs = 5000) =>
        new Promise<Json>((resolveNext) => {
          const ready = queue.shift();
          if (ready !== undefined) return resolveNext(ready);
          const timer = setTimeout(() => {
            waiting.splice(waiting.indexOf(handler), 1);
            resolveNext("<no message>");
          }, timeoutMs);
          const handler = (value: Json) => {
            clearTimeout(timer);
            resolveNext(value);
          };
          waiting.push(handler);
        }),
      // SAFETY: Bun's WebSocket.send accepts Uint8Array; only the DOM typings' BufferSource (ArrayBuffer-backed views) is narrower.
      send: (data) => ws.send(data as string),
      close: (code, reason) => (code === undefined ? ws.close() : ws.close(code, reason)),
      closed,
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(conn);
    };
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // not open
      }
      settle();
    }, opts.timeoutMs ?? 8000);
    ws.addEventListener("open", () => {
      conn.opened = true;
      conn.protocol = ws.protocol;
      settle();
    });
    ws.addEventListener("message", (event) => {
      const value = describeMessage(event.data);
      const waiter = waiting.shift();
      if (waiter) waiter(value);
      else queue.push(value);
    });
    ws.addEventListener("error", settle);
    ws.addEventListener("close", (event) => {
      closeResult({ code: event.code, reason: event.reason });
      settle();
    });
  });
}

// ---------------------------------------------------------------------------------------------
// routes.json helpers

export function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
