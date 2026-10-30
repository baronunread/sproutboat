import { afterAll, beforeAll, expect, test } from "bun:test";
import { parseBackend, proxyToBackend } from "./backend";
import { relayHandlers, type RelayData } from "./websocket";

type Logged = {
  status: number;
  errorKind?: string;
  hostname?: string | null;
  cpuMs?: number | null;
  resBytes?: number | null;
};
let upstream: ReturnType<typeof Bun.serve>;
let edge: ReturnType<typeof Bun.serve<RelayData>>;
let logs: Logged[] = [];
let timeoutMs = 5_000;
let backendUrl = "";

// An app that reports the Host and internal headers it received, like sproutd's frontend routes by Host.
beforeAll(() => {
  upstream = Bun.serve<undefined>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws")
        return server.upgrade(request, { data: undefined }) ? undefined : new Response("no", { status: 426 });
      if (url.pathname === "/slow") {
        await Bun.sleep(400);
        return new Response("late");
      }
      if (url.pathname === "/busy") return new Response("app queue full", { status: 503 });
      if (url.pathname === "/echo")
        return new Response(await request.text(), {
          headers: {
            "x-sb-cpu-ms": "1.2345",
            "x-sb-uncaught": "boom",
            "x-seen-host": request.headers.get("host") ?? "",
            "x-seen-secret": request.headers.get("x-sb-edge-secret") ?? "",
          },
        });
      return Response.json({ host: request.headers.get("host"), path: url.pathname + url.search });
    },
    websocket: {
      message(ws, message) {
        ws.send(`echo:${message}`);
      },
    },
  });
  backendUrl = `http://127.0.0.1:${upstream.port}`;
  edge = Bun.serve<RelayData>({
    port: 0,
    hostname: "127.0.0.1",
    websocket: relayHandlers,
    fetch(request, server) {
      const started = performance.now();
      return proxyToBackend({
        request,
        server,
        backend: { kind: "sproutd", url: backendUrl },
        host: request.headers.get("host")?.split(":")[0] ?? "",
        requestTimeoutMs: timeoutMs,
        responseMaxBytes: 1024,
        reqBytes: Number(request.headers.get("content-length")) || 0,
        elapsed: () => Math.round(performance.now() - started),
        log: (event) => void logs.push(event),
        cappedBody: (body, _host, onEnd) => {
          if (!body) {
            onEnd(0, true);
            return null;
          }
          let sent = 0;
          return body.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                sent += chunk.byteLength;
                controller.enqueue(chunk);
              },
              flush: () => onEnd(sent, true),
            }),
          );
        },
      });
    },
  });
});
afterAll(() => {
  edge.stop(true);
  upstream.stop(true);
});

const get = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${edge.port}${path}`, init);

test("forwards the original Host, path and query, and logs the request under the host", async () => {
  logs = [];
  const res = await get("/hello?x=1", { headers: { host: "blog.alice.sb.test" } });
  expect(await res.json()).toEqual({ host: "blog.alice.sb.test", path: "/hello?x=1" });
  await Bun.sleep(20);
  expect(logs.at(-1)).toMatchObject({ status: 200, hostname: "blog.alice.sb.test" });
});

test("a client cannot send the edge's internal headers to the app; the app's uncaught marker never reaches the client", async () => {
  const res = await get("/echo", {
    method: "POST",
    body: "payload",
    headers: { host: "a.test", "x-sb-edge-secret": "forged" },
  });
  expect(await res.text()).toBe("payload");
  expect(res.headers.get("x-seen-secret")).toBe("");
  expect(res.headers.get("x-sb-uncaught")).toBeNull();
  expect(res.headers.get("x-sb-cpu-ms")).toBe("1.234");
});

test("an upstream 503 passes through and is logged as an upstream 5xx", async () => {
  logs = [];
  const res = await get("/busy", { headers: { host: "a.test" } });
  expect(res.status).toBe(503);
  expect(await res.text()).toBe("app queue full");
  await Bun.sleep(20);
  expect(logs.at(-1)).toMatchObject({ status: 503, errorKind: "upstream-5xx" });
});

test("a slow app past the request deadline is a 504", async () => {
  timeoutMs = 100;
  logs = [];
  const res = await get("/slow", { headers: { host: "a.test" } });
  timeoutMs = 5_000;
  expect(res.status).toBe(504);
  expect(logs.at(-1)).toMatchObject({ status: 504, errorKind: "timed-out" });
});

test("an unreachable sproutd is a 502", async () => {
  const saved = backendUrl;
  backendUrl = "http://127.0.0.1:1";
  logs = [];
  const down = await get("/x", { headers: { host: "a.test" } });
  backendUrl = saved;
  expect(down.status).toBe(502);
  expect(logs.at(-1)).toMatchObject({ status: 502, errorKind: "proxy" });
});

test("a WebSocket upgrade is relayed to the backend", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${edge.port}/ws`);
  const message = await new Promise<string>((resolve, reject) => {
    ws.onopen = () => ws.send("hi");
    ws.onmessage = (event) => resolve(String(event.data));
    ws.onerror = () => reject(new Error("websocket failed"));
  });
  expect(message).toBe("echo:hi");
  ws.close();
});

test("only loopback sproutd URLs are accepted as a backend", () => {
  expect(parseBackend({ kind: "sproutd", url: "http://127.0.0.1:8600" })).toEqual({
    kind: "sproutd",
    url: "http://127.0.0.1:8600",
  });
  expect(parseBackend({ kind: "sproutd", url: "http://localhost:8600" })).not.toBeNull();
  for (const bad of [
    { kind: "sproutd", url: "http://10.0.0.5:8600" },
    { kind: "sproutd", url: "http://127.0.0.1:8600/path" },
    { kind: "sproutd", url: "https://127.0.0.1:8600" },
    { kind: "sproutd", url: "http://127.0.0.1.evil.test:80" },
    { kind: "other", url: "http://127.0.0.1:1" },
    null,
    "http://127.0.0.1:1",
  ])
    expect(parseBackend(bad)).toBeNull();
});
