/**
 * Design 05, option A: for a route with a `backend`, the edge stays in front and forwards to
 * sproutd's frontend instead of starting a sprout. sproutd routes by the Host header, so the
 * original request goes through unchanged; the edge keeps its request log (what the dashboard's
 * metrics read) and its response caps. No asset serving (the module carries its assets), no GET
 * cache and no cold-start fields: sproutd wakes apps itself and does not report that per request.
 */
import type { Server } from "bun";
import { isWebSocketUpgrade, relayWebSocket, type RelayData } from "./websocket";

export type Backend = { kind: "sproutd"; url: string };

/** Headers only the edge may set toward an app (service-binding vouching, #48). Never forwarded from a client. */
const INTERNAL_REQUEST_HEADERS = ["x-sb-edge-secret", "x-sb-edge-token", "x-sb-binding-call", "x-sb-url"];

const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/;

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };
const isObject = (value: Json | undefined): value is { readonly [key: string]: Json } =>
  value !== null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function);
const isString = (value: Json | undefined): value is string => Object(value) !== value && value === String(value);

/** A backend entry from routes.json, or null when it is not a loopback sproutd URL (the route is then refused by the loader). */
export function parseBackend(value: Json | undefined): Backend | null {
  if (!isObject(value)) return null;
  const { kind, url } = value;
  if (kind !== "sproutd" || !isString(url) || !LOOPBACK.test(url)) return null;
  return { kind: "sproutd", url };
}

type LogEvent = {
  hostname?: string | null;
  method?: string;
  status: number;
  durationMs: number;
  ttfbMs?: number | null;
  reqBytes?: number;
  resBytes?: number | null;
  cpuMs?: number | null;
  error?: string;
  errorKind?: string;
};

export type BackendContext = {
  request: Request;
  server: Server<RelayData>;
  backend: Backend;
  host: string;
  requestTimeoutMs: number;
  responseMaxBytes: number;
  reqBytes: number;
  elapsed: () => number;
  log: (event: LogEvent) => void;
  cappedBody: (
    body: ReadableStream<Uint8Array> | null,
    host: string,
    onEnd: (bytes: number, ok: boolean) => void,
    maxBytes?: number | null,
  ) => ReadableStream<Uint8Array> | null;
};

export async function proxyToBackend(ctx: BackendContext): Promise<Response | undefined> {
  const { request, backend, host, log, elapsed, reqBytes } = ctx;
  const target = new URL(request.url);
  const forwarded = new Headers(request.headers);
  for (const name of INTERNAL_REQUEST_HEADERS) forwarded.delete(name);

  if (isWebSocketUpgrade(request)) {
    const result = await relayWebSocket({
      request,
      server: ctx.server,
      url: `${backend.url.replace(/^http/, "ws")}${target.pathname}${target.search}`,
      headers: forwarded,
      keepAlive: () => {},
    });
    if ("upgraded" in result) {
      log({ hostname: host, method: request.method, status: 101, durationMs: elapsed(), reqBytes });
      return undefined;
    }
    log({
      hostname: host,
      method: request.method,
      status: result.refused.status,
      durationMs: elapsed(),
      reqBytes,
      error: "websocket refused",
      errorKind: "websocket-refused",
    });
    return result.refused;
  }

  try {
    // A proxy: every upstream status is forwarded verbatim.
    // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check
    const upstream = await fetch(`${backend.url}${target.pathname}${target.search}`, {
      method: request.method,
      headers: forwarded,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(ctx.requestTimeoutMs)]),
    });
    const ttfbMs = elapsed();
    const declared = upstream.headers.has("content-length") ? Number(upstream.headers.get("content-length")) : NaN;
    if (Number.isFinite(declared) && declared > ctx.responseMaxBytes) {
      log({
        hostname: host,
        method: request.method,
        status: 502,
        durationMs: ttfbMs,
        ttfbMs,
        reqBytes,
        resBytes: declared,
        error: "response too large",
        errorKind: "response-too-large",
      });
      return new Response("response too large", { status: 502 });
    }
    const cpuHeader = upstream.headers.get("x-sb-cpu-ms");
    const cpuMs = cpuHeader != null && Number.isFinite(Number(cpuHeader)) ? Number(cpuHeader) : null;
    const headers = new Headers(upstream.headers);
    headers.delete("x-sb-uncaught");
    headers.delete("x-sb-cpu-ms");
    if (cpuMs !== null) headers.set("x-sb-cpu-ms", cpuMs.toFixed(3));
    const body = ctx.cappedBody(upstream.body, host, (bytes) =>
      log({
        hostname: host,
        method: request.method,
        status: upstream.status,
        durationMs: elapsed(),
        ttfbMs,
        reqBytes,
        resBytes: Number.isFinite(declared) ? declared : bytes,
        cpuMs,
        errorKind: upstream.status >= 500 ? "upstream-5xx" : undefined,
      }),
    );
    return new Response(body, { status: upstream.status, headers });
  } catch (error) {
    if (request.signal.aborted) {
      log({
        hostname: host,
        method: request.method,
        status: 499,
        durationMs: elapsed(),
        reqBytes,
        ttfbMs: null,
        error: "client closed the request",
        errorKind: "client-closed",
      });
      return new Response(null, { status: 499 });
    }
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    const status = timedOut ? 504 : 502;
    console.error(
      `sproutd ${timedOut ? "timed out" : "failure"} for ${host}: ${error instanceof Error ? error.message : String(error)}`,
    );
    log({
      hostname: host,
      method: request.method,
      status,
      durationMs: elapsed(),
      reqBytes,
      ttfbMs: null,
      error: timedOut ? "request timed out" : "sproutd failure",
      errorKind: timedOut ? "timed-out" : "proxy",
    });
    return new Response(timedOut ? "request timed out" : "sproutd failed", { status });
  }
}
