import type { Server, ServerWebSocket, WebSocketHandler } from "bun";

/**
 * WebSockets through the edge. A client's upgrade request is answered once the sprout accepts
 * a WebSocket of its own: the edge opens it first (`connectUpstream`, so a refusal is a plain
 * HTTP error, and the sprout's cold start has already happened), then upgrades the client and
 * relays messages and closes both ways. Text stays text and binary stays binary; the
 * subprotocol the sprout picked is the one the client gets.
 *
 * The edge keeps a socket's sprout warm (`keepAlive`) so an idle-looking connection does not
 * get its sprout reaped, and closes the client when the sprout goes away.
 */

/** Cloudflare's limit for a message, which sprouts accept too. */
export const WS_MAX_PAYLOAD = 32 * 1024 * 1024;
/** How long the sprout has to accept the socket. */
export const WS_CONNECT_TIMEOUT_MS = 10_000;

const DROPPED_REQUEST_HEADERS = new Set([
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "content-length",
  "transfer-encoding",
]);

export function isWebSocketUpgrade(request: Request): boolean {
  if (request.method !== "GET") return false;
  const upgrade = request.headers.get("upgrade")?.toLowerCase() ?? "";
  const connection = request.headers.get("connection")?.toLowerCase() ?? "";
  return upgrade === "websocket" && connection.split(",").some((token) => token.trim() === "upgrade");
}

/** The subprotocols a client offered, in order. */
export function offeredProtocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

/** Headers for the edge's own upgrade request to the sprout: the client's, without its handshake. */
export function upstreamHeaders(forwarded: Headers) {
  return Object.fromEntries([...forwarded].filter(([name]) => !DROPPED_REQUEST_HEADERS.has(name)));
}

/** A close code a server may send: 1000, 1001-1003 and 1007-1014 or 3000-4999; else none. */
export function sendableCloseCode(code: number): number | undefined {
  if (
    code === 1000 ||
    (code >= 1001 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  )
    return code;
  return undefined;
}

/** What the edge keeps per client socket. */
export interface RelayData {
  readonly upstream: WebSocket;
  /** Messages from the sprout that arrived before the client's socket was open. */
  readonly early: (string | ArrayBuffer)[];
  /** Set once the client's socket is open. */
  client: ServerWebSocket<RelayData> | null;
  closed: boolean;
  stopKeepAlive: () => void;
}

/** Opens the sprout's end. Rejects when the sprout refuses, closes at once, or takes too long. */
export function connectUpstream(
  url: string,
  protocols: string[],
  headers: Record<string, string>,
  timeoutMs = WS_CONNECT_TIMEOUT_MS,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // Bun's WebSocket takes handshake options as its second argument; the DOM typings do not know them.
    const upstream: WebSocket = Reflect.construct(WebSocket, [url, { protocols, headers }]);
    upstream.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      upstream.close();
      reject(new Error("timed out waiting for the sprout to accept the WebSocket"));
    }, timeoutMs);
    upstream.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve(upstream);
      },
      { once: true },
    );
    const refused = () => {
      clearTimeout(timer);
      reject(new Error("the sprout did not accept the WebSocket"));
    };
    upstream.addEventListener("error", refused, { once: true });
    upstream.addEventListener("close", refused, { once: true });
  });
}

/**
 * Upgrades the client once the sprout's end is open. Resolves with the sprout's refusal as a
 * Response, or undefined when the connection was upgraded (Bun's convention).
 */
export async function relayWebSocket(args: {
  readonly request: Request;
  readonly server: Server<RelayData>;
  readonly url: string;
  readonly headers: Headers;
  readonly keepAlive: () => void;
}): Promise<{ readonly refused: Response } | { readonly upgraded: true }> {
  const { request, server, url, headers, keepAlive } = args;
  let upstream: WebSocket;
  try {
    upstream = await connectUpstream(url, offeredProtocols(request), upstreamHeaders(headers));
  } catch {
    return { refused: new Response("the sprout did not accept the WebSocket", { status: 502 }) };
  }
  const interval = setInterval(keepAlive, 30_000);
  const data: RelayData = {
    upstream,
    early: [],
    client: null,
    closed: false,
    stopKeepAlive: () => clearInterval(interval),
  };
  upstream.addEventListener("message", (event) => {
    // With binaryType "arraybuffer" a message is text or an ArrayBuffer.
    const message: string | ArrayBuffer = event.data;
    if (data.client) data.client.send(message);
    else data.early.push(message);
  });
  upstream.addEventListener("close", (event) => {
    data.stopKeepAlive();
    if (data.closed) return;
    data.closed = true;
    data.client?.close(sendableCloseCode(event.code), event.reason);
    // A client that never opened is gone before the upgrade finished: nothing to close.
  });
  upstream.addEventListener("error", () => {
    data.stopKeepAlive();
    if (data.closed) return;
    data.closed = true;
    data.client?.close(1011, "the sprout's WebSocket failed");
  });
  const protocol = upstream.protocol;
  const done = server.upgrade(request, {
    data,
    headers: protocol ? { "sec-websocket-protocol": protocol } : undefined,
  });
  if (!done) {
    data.closed = true;
    data.stopKeepAlive();
    upstream.close();
    return { refused: new Response("WebSocket upgrade failed", { status: 400 }) };
  }
  return { upgraded: true };
}

/** Bun.serve's `websocket` option: relays what the client sends to the sprout's end. */
export const relayHandlers: WebSocketHandler<RelayData> = {
  maxPayloadLength: WS_MAX_PAYLOAD,
  idleTimeout: 120,
  open(ws) {
    const data = ws.data;
    data.client = ws;
    if (data.closed) {
      ws.close(1011, "the sprout's WebSocket closed");
      return;
    }
    for (const message of data.early.splice(0)) ws.send(message);
  },
  message(ws, message) {
    const { upstream } = ws.data;
    if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
  },
  close(ws, code, reason) {
    const data = ws.data;
    data.stopKeepAlive();
    if (data.closed) return;
    data.closed = true;
    const sendable = sendableCloseCode(code);
    if (data.upstream.readyState === WebSocket.OPEN) {
      if (sendable === undefined) data.upstream.close();
      else data.upstream.close(sendable, reason);
    }
  },
};
