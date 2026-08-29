import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pool } from "../../supervisor/src/run";
import { EdgeCache, cacheableForSeconds } from "./cache";

type JsonValue = string | number | boolean | null | EdgeJsonObject | JsonValue[];

interface EdgeJsonObject {
  readonly [key: string]: JsonValue;
}

type EdgeInput = JsonValue | undefined;

interface LogEvent {
  readonly hostname?: string | null;
  readonly method?: string;
  readonly status: number;
  readonly durationMs: number;
  /** Time to the upstream response headers; null when the worker never answered. */
  readonly ttfbMs?: number | null;
  readonly reqBytes?: number;
  readonly resBytes?: number | null;
  /** True when this request had to spawn the worker process. */
  readonly coldStart?: boolean;
  /** Spawn→listening wait for that cold start, in ms. */
  readonly startupMs?: number | null;
  readonly error?: string;
  /** Coarse failure taxonomy: no-route | worker-unavailable | proxy | timed-out
   *  | response-too-large | upstream-5xx. Absent on a clean response. */
  readonly errorKind?: string;
  /** Edge cache outcome for a GET: hit | miss | dynamic | bypass. */
  readonly cacheStatus?: string;
}

function isObject(value: EdgeInput): value is EdgeJsonObject {
  return value !== null && Object(value) === value && !Array.isArray(value)
    && !(value instanceof Function);
}

function isString(value: EdgeInput): value is string {
  return Object(value) !== value && value === String(value);
}

async function loadRoutes(path: string): Promise<Map<string, string>> {
  const routes: EdgeInput = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(routes)) throw new TypeError("invalid route snapshot");
  const result = new Map<string, string>();
  for (const route of routes) {
    if (!isObject(route) || !isString(route.hostname) || !/^[a-z0-9.-]+$/.test(route.hostname) || !isString(route.workerPath) || !route.workerPath.startsWith("/")) throw new TypeError("invalid route snapshot");
    result.set(route.hostname, route.workerPath);
  }
  return result;
}

const routesPath = resolve(process.env.SPROUTBOAT_ROUTE_SNAPSHOT || "routes.json");
// #27/#33: platform-wide request wall-clock and response-size caps. Per-project
// overrides are still tracked on #27.
const requestTimeoutMs = Number(process.env.SPROUTBOAT_REQUEST_TIMEOUT_MS) || 30_000;
const responseMaxBytes = Number(process.env.SPROUTBOAT_RESPONSE_MAX_BYTES) || 10 * 1024 * 1024;
// #38: per-node edge cache. Set SPROUTBOAT_EDGE_CACHE=off to disable.
const cache = process.env.SPROUTBOAT_EDGE_CACHE === "off" ? null : new EdgeCache();
const MAX_CACHE_ENTRY_BYTES = 512 * 1024;

/** Fail the stream (and log) if the worker's response body runs past the cap. */
function cappedBody(body: ReadableStream<Uint8Array> | null, host: string): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  let sent = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sent += chunk.byteLength;
      if (sent > responseMaxBytes) {
        console.error(`response body cap (${responseMaxBytes}B) exceeded for ${host}`);
        controller.error(new Error("response exceeded byte cap"));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}
// The bare deployment domain hosts no content on this box — send it to the dashboard.
const deploymentDomain = (process.env.SPROUTBOAT_DEPLOYMENT_DOMAIN || "sproutboat.local").toLowerCase();
const dashboardUrl = (process.env.SPROUTBOAT_DASHBOARD_URL || `https://dashboard.${deploymentDomain}`).replace(/\/$/, "");
async function snapshotMtime(path: string): Promise<number> {
  try { return (await stat(path)).mtimeMs; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

let routes = new Map<string, string>();
let routesMtimeMs = await snapshotMtime(routesPath);
if (routesMtimeMs > 0) routes = await loadRoutes(routesPath);
const port = Number(process.env.PORT || 8080);
// Loopback only: Caddy terminates TLS and reverse-proxies deployment hosts here.
const bindHost = process.env.SPROUTBOAT_BIND_HOST || "127.0.0.1";
const logPath = process.env.SPROUTBOAT_LOG_PATH;

async function log(event: LogEvent): Promise<void> {
  if (!logPath) return;
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  } catch (error) {
    console.error(`request log write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Swap in a new route snapshot: dispose workers whose route changed or was
 * removed, then eagerly spawn any newly-routed worker so the first real request
 * to a fresh deploy is not a cold start (pre-warm on activate). Warm-up is
 * fire-and-forget — a broken artifact must not stall the reload.
 */
function swapRoutes(nextRoutes: Map<string, string>, nextMtimeMs: number): void {
  const oldPaths = new Set(routes.values());
  for (const [hostname, workerPath] of routes) {
    if (nextRoutes.get(hostname) !== workerPath) {
      pool.dispose(workerPath);
      cache?.purgeHost(hostname); // a new version must not serve the old one's cached responses
    }
  }
  routes = nextRoutes;
  routesMtimeMs = nextMtimeMs;
  for (const workerPath of new Set(nextRoutes.values())) {
    if (!oldPaths.has(workerPath)) void pool.endpoint(workerPath).catch(() => { /* first request will report it */ });
  }
}

async function refreshRoutes(): Promise<void> {
  const currentMtimeMs = await snapshotMtime(routesPath);
  if (currentMtimeMs > routesMtimeMs) swapRoutes(await loadRoutes(routesPath), currentMtimeMs);
}

const server = Bun.serve({
  port,
  hostname: bindHost,
  async fetch(request) {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const reqBytes = Number(request.headers.get("content-length")) || 0;
    try { await refreshRoutes(); }
    catch (error) { console.error(`route snapshot reload failed: ${error instanceof Error ? error.message : String(error)}`); }
    const host = request.headers.get("host")?.split(":")[0]?.toLowerCase();
    if (host === deploymentDomain) return Response.redirect(dashboardUrl, 302);
    const workerPath = host ? routes.get(host) : undefined;
    if (!workerPath || !host) {
      await log({ hostname: host || null, method: request.method, status: 404, durationMs: elapsed(), reqBytes, errorKind: "no-route" });
      return new Response("unknown deployment", { status: 404 });
    }

    const target = new URL(request.url);
    const cacheKey = cache && request.method === "GET" ? EdgeCache.key(host, "GET", target.pathname + target.search) : null;
    if (cacheKey) {
      const hit = cache!.get(cacheKey);
      if (hit) {
        await log({ hostname: host, method: "GET", status: hit.status, durationMs: elapsed(), reqBytes, resBytes: hit.body.byteLength, cacheStatus: "hit" });
        return new Response(hit.body, { status: hit.status, headers: [...hit.headers, ["sb-cache", "HIT"]] });
      }
    }

    let base: string;
    let coldStart = false;
    let startupMs: number | null = null;
    try {
      const endpoint = await pool.endpoint(workerPath);
      base = endpoint.url;
      coldStart = endpoint.coldStart;
      startupMs = endpoint.coldStart ? endpoint.startupMs : null;
    } catch (error) {
      console.error(`worker unavailable for ${host}: ${error instanceof Error ? error.message : String(error)}`);
      await log({ hostname: host, method: request.method, status: 502, durationMs: elapsed(), reqBytes, ttfbMs: null, error: "worker unavailable", errorKind: "worker-unavailable" });
      return new Response("worker failed", { status: 502 });
    }

    try {
      // Reverse-proxy the request to the deployment's native-fetch server.
      // This is a proxy: every upstream status (incl. 4xx/5xx) is forwarded
      // verbatim and branched on explicitly below — an `.ok` gate would be wrong.
      // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check
      const upstream = await fetch(`${base}${target.pathname}${target.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      // The body is streamed after this point, so durationMs == time to response
      // headers (TTFB). Full body-end timing needs a stream close hook — see #35.
      const ttfbMs = elapsed();
      const declared = Number(upstream.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > responseMaxBytes) {
        await log({ hostname: host, method: request.method, status: 502, durationMs: ttfbMs, ttfbMs, reqBytes, resBytes: declared, coldStart, startupMs, error: "response too large", errorKind: "response-too-large" });
        return new Response("response too large", { status: 502 });
      }

      const ttl = cacheKey ? cacheableForSeconds(upstream.headers.get("cache-control")) : null;
      if (cacheKey && ttl !== null && Number.isFinite(declared) && declared <= MAX_CACHE_ENTRY_BYTES) {
        const buffered = await upstream.arrayBuffer();
        const headers: [string, string][] = [...upstream.headers.entries()];
        cache!.set(cacheKey, upstream.status, headers, buffered, ttl);
        await log({ hostname: host, method: "GET", status: upstream.status, durationMs: elapsed(), ttfbMs, reqBytes, resBytes: buffered.byteLength, coldStart, startupMs, cacheStatus: "miss" });
        return new Response(buffered, { status: upstream.status, headers: [...headers, ["sb-cache", "MISS"]] });
      }

      const cacheStatus = request.method === "GET" ? (ttl === null ? "dynamic" : "miss") : undefined;
      await log({
        hostname: host, method: request.method, status: upstream.status, durationMs: ttfbMs,
        ttfbMs, reqBytes, resBytes: Number.isFinite(declared) ? declared : null,
        coldStart, startupMs, errorKind: upstream.status >= 500 ? "upstream-5xx" : undefined, cacheStatus,
      });
      const headers = new Headers(upstream.headers);
      if (cacheStatus) headers.set("sb-cache", cacheStatus === "dynamic" ? "DYNAMIC" : "MISS");
      return new Response(cappedBody(upstream.body, host), { status: upstream.status, headers });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      const status = timedOut ? 504 : 502;
      console.error(`worker ${timedOut ? "timed out" : "failure"} for ${host}: ${error instanceof Error ? error.message : String(error)}`);
      await log({ hostname: host, method: request.method, status, durationMs: elapsed(), reqBytes, ttfbMs: null, coldStart, startupMs, error: timedOut ? "request timed out" : "worker failure", errorKind: timedOut ? "timed-out" : "proxy" });
      return new Response(timedOut ? "request timed out" : "worker failed", { status });
    }
  },
});

console.log(`Sproutboat edge router listening on http://${bindHost}:${server.port}`);

// Never evict a deployment that still has a live route — its next request should
// not pay a cold start. Idle eviction then only reaps workers whose route is gone.
const evictionTimer = setInterval(() => pool.evictIdle(new Set(routes.values())), 60_000);

function shutdown(): void {
  clearInterval(evictionTimer);
  pool.disposeAll();
  server.stop();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

process.on("SIGHUP", async () => {
  const nextRoutesMtimeMs = await snapshotMtime(routesPath);
  const nextRoutes = nextRoutesMtimeMs > 0 ? await loadRoutes(routesPath) : new Map<string, string>();
  swapRoutes(nextRoutes, nextRoutesMtimeMs);
  console.log("route snapshot reloaded");
});
