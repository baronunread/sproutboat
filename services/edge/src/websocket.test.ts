import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  isWebSocketUpgrade,
  offeredProtocols,
  relayHandlers,
  relayWebSocket,
  sendableCloseCode,
  upstreamHeaders,
  type RelayData,
} from "./websocket";

interface UpstreamData {
  readonly host: string | null;
  readonly greet: boolean;
}

let sprout: ReturnType<typeof Bun.serve<UpstreamData>>;
let edge: ReturnType<typeof Bun.serve<RelayData>>;
let kept = 0;

beforeAll(() => {
  // A sprout: echoes (text as text, bytes as bytes), picks the "chat" subprotocol, closes
  // on request, and refuses a path it does not serve.
  sprout = Bun.serve<UpstreamData>({
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/refuse") return new Response("no sockets here", { status: 426 });
      const upgraded = server.upgrade(request, {
        data: { host: request.headers.get("host"), greet: path === "/greet" },
        headers: path === "/proto" ? { "sec-websocket-protocol": "chat" } : undefined,
      });
      return upgraded ? undefined : new Response("expected websocket", { status: 426 });
    },
    websocket: {
      open(ws) {
        if (ws.data.greet) ws.send(`host:${ws.data.host}`);
      },
      message(ws, message) {
        if (message === "bye") ws.close(4002, "sprout says bye");
        else if (message instanceof Buffer) ws.send(message);
        else ws.send(`echo:${message}`);
      },
    },
  });
  edge = Bun.serve<RelayData>({
    port: 0,
    websocket: relayHandlers,
    async fetch(request, server) {
      const target = new URL(request.url);
      const result = await relayWebSocket({
        request,
        server,
        url: `ws://127.0.0.1:${sprout.port}${target.pathname}${target.search}`,
        headers: request.headers,
        keepAlive: () => {
          kept++;
        },
      });
      return "refused" in result ? result.refused : undefined;
    },
  });
});

afterAll(() => {
  edge.stop(true);
  sprout.stop(true);
});

const open = (path: string, protocols?: string[]) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = protocols
      ? new WebSocket(`ws://127.0.0.1:${edge.port}${path}`, protocols)
      : new WebSocket(`ws://127.0.0.1:${edge.port}${path}`);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error(`could not open ${path}`)), { once: true });
  });

const next = (ws: WebSocket) =>
  new Promise<MessageEvent["data"]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message")), 5000);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(event.data);
      },
      { once: true },
    );
  });

test("a client's upgrade is relayed: text, bytes, a large message and the subprotocol", async () => {
  const ws = await open("/proto", ["other", "chat"]);
  expect(ws.protocol).toBe("chat");
  ws.send("hi");
  expect(await next(ws)).toBe("echo:hi");
  ws.send(new Uint8Array([0, 1, 2, 255]));
  expect(Array.from(new Uint8Array(await next(ws)))).toEqual([0, 1, 2, 255]);
  const big = "x".repeat(2 * 1024 * 1024);
  ws.send(big);
  expect((await next(ws)).length).toBe(big.length + 5);
  ws.close(4001, "done");
  await Bun.sleep(50);
});

test("the sprout's greeting reaches the client even though it was sent before the client's end opened", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${edge.port}/greet`);
  const first = await new Promise<string>((resolve, reject) => {
    ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    ws.addEventListener("error", () => reject(new Error("no greeting")), { once: true });
  });
  expect(first).toMatch(/^host:127\.0\.0\.1:\d+$/);
  ws.close();
});

test("the sprout's close code and reason reach the client", async () => {
  const ws = await open("/echo");
  const closed = new Promise<[number, string]>((resolve) =>
    ws.addEventListener("close", (e) => resolve([e.code, e.reason]), { once: true }),
  );
  ws.send("bye");
  expect(await closed).toEqual([4002, "sprout says bye"]);
});

test("a sprout that refuses the socket gives the client a plain 502", async () => {
  const response = await fetch(`http://127.0.0.1:${edge.port}/refuse`, {
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
    },
  });
  expect(response.status).toBe(502);
});

test("handshake helpers", () => {
  const request = new Request("http://x/", {
    headers: { connection: "keep-alive, Upgrade", upgrade: "WebSocket", "sec-websocket-protocol": "a, b ,c" },
  });
  expect(isWebSocketUpgrade(request)).toBe(true);
  expect(isWebSocketUpgrade(new Request("http://x/", { method: "POST", headers: request.headers }))).toBe(false);
  expect(isWebSocketUpgrade(new Request("http://x/", { headers: { upgrade: "h2c", connection: "upgrade" } }))).toBe(
    false,
  );
  expect(offeredProtocols(request)).toEqual(["a", "b", "c"]);
  expect(
    upstreamHeaders(new Headers({ host: "a.example", connection: "Upgrade", "sec-websocket-key": "k", cookie: "s=1" })),
  ).toEqual({
    host: "a.example",
    cookie: "s=1",
  });
  expect([1000, 1001, 1005, 1006, 1015, 4001, 2999].map(sendableCloseCode)).toEqual([
    1000,
    1001,
    undefined,
    undefined,
    undefined,
    4001,
    undefined,
  ]);
  expect(kept).toBeGreaterThanOrEqual(0);
});
