import { readFile, stat } from "node:fs/promises";
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pool } from "../../supervisor/src/run";
import { isSproutFirst, resolveAssetKey, type AssetManifest } from "sproutboat/runtime/assets";
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
  /** Time to the upstream response headers; null when the sprout never answered. */
  readonly ttfbMs?: number | null;
  readonly reqBytes?: number;
  readonly resBytes?: number | null;
  /** True when this request had to spawn the sprout process. */
  readonly coldStart?: boolean;
  /** Spawn→listening wait for that cold start, in ms. */
  readonly startupMs?: number | null;
  /** Of startupMs, the spawn→JS-start slice (process + runtime bootstrap). #41 */
  readonly bootMs?: number | null;
  /** Sprout CPU time for this invocation, ms — self-reported via `x-sb-cpu-ms`.
   *  Absent for async handlers and pre-#28 sprouts. #28 */
  readonly cpuMs?: number | null;
  readonly error?: string;
  /** Coarse failure taxonomy: no-route | sprout-unavailable | proxy | timed-out
   *  | response-too-large | upstream-5xx. Absent on a clean response. */
  readonly errorKind?: string;
  /** Edge cache outcome for a GET: hit | miss | dynamic | bypass. */
  readonly cacheStatus?: string;
}

function isObject(value: EdgeInput): value is EdgeJsonObject {
  return value !== null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function);
}

function isString(value: EdgeInput): value is string {
  return Object(value) !== value && value === String(value);
}

/** `secretsPath` / `secretsHash` are present when the project has ≥1 secret (#2). */
type Route = { sproutPath: string; secretsPath: string | null; secretsHash: string | null };

async function loadRoutes(path: string): Promise<Map<string, Route>> {
  const routes: EdgeInput = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(routes)) throw new TypeError("invalid route snapshot");
  const result = new Map<string, Route>();
  for (const route of routes) {
    if (
      !isObject(route) ||
      !isString(route.hostname) ||
      !/^[a-z0-9.-]+$/.test(route.hostname) ||
      !isString(route.sproutPath) ||
      !route.sproutPath.startsWith("/")
    )
      throw new TypeError("invalid route snapshot");
    const secretsPath = isString(route.secretsPath) && route.secretsPath.startsWith("/") ? route.secretsPath : null;
    result.set(route.hostname, {
      sproutPath: route.sproutPath,
      secretsPath,
      secretsHash: isString(route.secretsHash) ? route.secretsHash : null,
    });
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

/** Fail the stream (and log) if the sprout's response body runs past the cap. */
/**
 * Wrap the upstream body to (a) enforce the byte cap and (b) call `onEnd` with
 * the total bytes streamed once the response body actually finishes — so the
 * request log can carry a real full duration (#31), not just TTFB.
 */
function cappedBody(
  body: ReadableStream<Uint8Array> | null,
  host: string,
  onEnd: (bytes: number, ok: boolean) => void,
): ReadableStream<Uint8Array> | null {
  if (!body) {
    onEnd(0, true);
    return null;
  }
  let sent = 0;
  let ended = false;
  // `flush` covers normal completion and the byte-cap abort; a client that
  // hangs up mid-stream won't reach here and that request goes unlogged.
  const finish = (ok: boolean) => {
    if (!ended) {
      ended = true;
      onEnd(sent, ok);
    }
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        sent += chunk.byteLength;
        if (sent > responseMaxBytes) {
          console.error(`response body cap (${responseMaxBytes}B) exceeded for ${host}`);
          finish(false);
          controller.error(new Error("response exceeded byte cap"));
          return;
        }
        controller.enqueue(chunk);
      },
      flush() {
        finish(true);
      },
    }),
  );
}
// The bare deployment domain has no content of its own; unrouted, it goes to the dashboard.
const deploymentDomain = (process.env.SPROUTBOAT_DEPLOYMENT_DOMAIN || "sproutboat.local").toLowerCase();
const dashboardUrl = (process.env.SPROUTBOAT_DASHBOARD_URL || `https://dashboard.${deploymentDomain}`).replace(
  /\/$/,
  "",
);
async function snapshotMtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

let routes = new Map<string, Route>();
let routesMtimeMs = await snapshotMtime(routesPath);
if (routesMtimeMs > 0) routes = await loadRoutes(routesPath);
const port = Number(process.env.PORT || 8080);
// Loopback only: Caddy terminates TLS and reverse-proxies deployment hosts here.
const bindHost = process.env.SPROUTBOAT_BIND_HOST || "127.0.0.1";
const logPath = process.env.SPROUTBOAT_LOG_PATH;

// One long-lived append stream, opened once. `appendFile` was open+write+close
// (~28µs) per call and it was `await`ed on the fastest paths (404s, asset 304s,
// cache hits) — more than the work the request did. `write()` here is buffered,
// non-blocking, fire-and-forget; a line lost to a crash is acceptable for a
// request log.
let logStream: WriteStream | null = null;
if (logPath) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    logStream = createWriteStream(logPath, { flags: "a" });
    logStream.on("error", (error) => console.error(`request log stream error: ${error.message}`));
  } catch (error) {
    console.error(`request log init failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function log(event: LogEvent): void {
  logStream?.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

/**
 * Static-asset manifests, keyed by sproutPath. Loaded lazily on first request
 * to a deployment and dropped when its route changes (like the sprout process).
 * `null` = no `assets.json` next to the artifact.
 */
const assetManifests = new Map<string, AssetManifest | null>();
function assetManifestFor(sproutPath: string): AssetManifest | null {
  const cached = assetManifests.get(sproutPath);
  if (cached !== undefined) return cached;
  const path = join(dirname(sproutPath), "assets.json");
  let manifest: AssetManifest | null = null;
  try {
    if (existsSync(path)) {
      // SAFETY: this file is written only by `sproutboat build` from the AssetManifest
      // type; a malformed one just yields lookups that miss and fall through to the sprout.
      manifest = JSON.parse(readFileSync(path, "utf8")) as AssetManifest;
    }
  } catch (error) {
    console.error(
      `asset manifest load failed for ${sproutPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assetManifests.set(sproutPath, manifest);
  return manifest;
}

/**
 * Swap in a new route snapshot: dispose sprouts whose route changed or was
 * removed. Newly-routed sprouts are NOT pre-spawned — that stampeded the node
 * on startup (every route at once) and pinned idle deployments resident. A
 * fresh deploy's first request cold-starts (~1ms + broker wait), and
 * `sproutboat deploy` already warms it with its post-upload health check.
 */
function swapRoutes(nextRoutes: Map<string, Route>, nextMtimeMs: number): void {
  for (const [hostname, route] of routes) {
    const next = nextRoutes.get(hostname);
    // A changed sprout path OR a changed secrets hash (#2) means the running
    // worker is stale — dispose it so the next request respawns it fresh.
    if (!next || next.sproutPath !== route.sproutPath || next.secretsHash !== route.secretsHash) {
      pool.dispose(route.sproutPath);
      assetManifests.delete(route.sproutPath);
      cache?.purgeHost(hostname); // a new version must not serve the old one's cached responses
    }
  }
  routes = nextRoutes;
  routesMtimeMs = nextMtimeMs;
}

// Belt-and-braces reload: SIGHUP (below) is the authoritative path. Throttle the
// stat() so a hot node isn't calling it thousands of times a second for a file
// that changes on deploy; 250ms is well inside the staleness people already tolerate.
let lastRouteCheck = 0;
async function refreshRoutes(): Promise<void> {
  const now = Date.now();
  if (now - lastRouteCheck < 250) return;
  lastRouteCheck = now;
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
    try {
      await refreshRoutes();
    } catch (error) {
      console.error(`route snapshot reload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // #30 — runtime-lifecycle gauges, loopback only (edge binds 127.0.0.1).
    if (new URL(request.url).pathname === "/__sb/pool") return Response.json(pool.stats());
    const host = request.headers.get("host")?.split(":")[0]?.toLowerCase();
    const route = host ? routes.get(host) : undefined;
    if (!route || !host) {
      // The bare deployment domain has no content of its own unless an owner has
      // attached it to a project (allowed for the apex + www). Otherwise, send it
      // to the dashboard rather than a bare 404.
      if (host === deploymentDomain) return Response.redirect(dashboardUrl, 302);
      log({
        hostname: host || null,
        method: request.method,
        status: 404,
        durationMs: elapsed(),
        reqBytes,
        errorKind: "no-route",
      });
      return new Response("unknown deployment", { status: 404 });
    }
    const sproutPath = route.sproutPath;

    const target = new URL(request.url);

    // Static assets, served edge-first (Cloudflare's default). Static-host path
    // resolution (`/docs` -> `/docs.html`, `/docs/` -> `/docs/index.html`); the
    // SPA / 404 fallback still belongs to the sprout via `env.<ASSETS>.fetch()`.
    if (request.method === "GET" || request.method === "HEAD") {
      const manifest = assetManifestFor(sproutPath);
      const assetKey = manifest
        ? resolveAssetKey(decodeURIComponent(target.pathname), (k) => Boolean(manifest.files[k]))
        : null;
      const entry =
        manifest && assetKey && !isSproutFirst(manifest.runSproutFirst, assetKey)
          ? manifest.files[assetKey]
          : undefined;
      if (entry && assetKey) {
        const inm = request.headers.get("if-none-match");
        const etag = `"${entry.hash}"`;
        if (inm === etag) {
          log({
            hostname: host,
            method: request.method,
            status: 304,
            durationMs: elapsed(),
            reqBytes,
            resBytes: 0,
            cacheStatus: "asset",
          });
          return new Response(null, { status: 304, headers: { etag } });
        }
        const body = request.method === "HEAD" ? null : await readFile(join(dirname(sproutPath), "assets", assetKey));
        log({
          hostname: host,
          method: request.method,
          status: 200,
          durationMs: elapsed(),
          reqBytes,
          resBytes: entry.size,
          cacheStatus: "asset",
        });
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": entry.type,
            etag,
            "content-length": String(entry.size),
            "cache-control": "public, max-age=0, must-revalidate",
          },
        });
      }
    }

    const cacheKey =
      cache && request.method === "GET" ? EdgeCache.key(host, "GET", target.pathname + target.search) : null;
    if (cacheKey) {
      const hit = cache!.get(cacheKey);
      if (hit) {
        log({
          hostname: host,
          method: "GET",
          status: hit.status,
          durationMs: elapsed(),
          reqBytes,
          resBytes: hit.body.byteLength,
          cacheStatus: "hit",
        });
        return new Response(hit.body, { status: hit.status, headers: [...hit.headers, ["sb-cache", "HIT"]] });
      }
    }

    let base: string;
    let coldStart = false;
    let startupMs: number | null = null;
    let bootMs: number | null = null;
    try {
      const endpoint = await pool.endpoint(sproutPath, route.secretsPath);
      base = endpoint.url;
      coldStart = endpoint.coldStart;
      startupMs = endpoint.coldStart ? endpoint.startupMs : null;
      bootMs = endpoint.coldStart ? endpoint.bootMs : null;
    } catch (error) {
      console.error(`sprout unavailable for ${host}: ${error instanceof Error ? error.message : String(error)}`);
      log({
        hostname: host,
        method: request.method,
        status: 502,
        durationMs: elapsed(),
        reqBytes,
        ttfbMs: null,
        error: "sprout unavailable",
        errorKind: "sprout-unavailable",
      });
      return new Response("sprout failed", { status: 502 });
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
      const ttfbMs = elapsed();
      // #28 — per-invocation CPU time the sprout self-reports; read it here and
      // strip it from every copy of the headers that leaves the edge below.
      const cpuHeader = upstream.headers.get("x-sb-cpu-ms");
      const cpuMs = cpuHeader != null && Number.isFinite(Number(cpuHeader)) ? Number(cpuHeader) : null;
      // `Number(null)` is 0, not NaN — so a missing content-length would read as
      // a finite 0 and slip past both the response-size cap and the cache-entry
      // cap. Treat "absent" as unknown.
      const declared = upstream.headers.has("content-length") ? Number(upstream.headers.get("content-length")) : NaN;
      if (Number.isFinite(declared) && declared > responseMaxBytes) {
        log({
          hostname: host,
          method: request.method,
          status: 502,
          durationMs: ttfbMs,
          ttfbMs,
          reqBytes,
          resBytes: declared,
          coldStart,
          startupMs,
          bootMs,
          error: "response too large",
          errorKind: "response-too-large",
        });
        return new Response("response too large", { status: 502 });
      }

      const ttl = cacheKey ? cacheableForSeconds(upstream.headers.get("cache-control")) : null;
      if (cacheKey && ttl !== null && Number.isFinite(declared) && declared <= MAX_CACHE_ENTRY_BYTES) {
        const buffered = await upstream.arrayBuffer();
        const headers: [string, string][] = [...upstream.headers.entries()].filter(([name]) => name !== "x-sb-cpu-ms");
        cache!.set(cacheKey, upstream.status, headers, buffered, ttl);
        log({
          hostname: host,
          method: "GET",
          status: upstream.status,
          durationMs: elapsed(),
          ttfbMs,
          reqBytes,
          resBytes: buffered.byteLength,
          coldStart,
          startupMs,
          bootMs,
          cpuMs,
          cacheStatus: "miss",
        });
        return new Response(buffered, { status: upstream.status, headers: [...headers, ["sb-cache", "MISS"]] });
      }

      const cacheStatus = request.method === "GET" ? (ttl === null ? "dynamic" : "miss") : undefined;
      // #31 — log once the response body has actually finished streaming, so
      // durationMs is the full request duration and resBytes is the real count.
      const body = cappedBody(upstream.body, host, (bytes) => {
        log({
          hostname: host,
          method: request.method,
          status: upstream.status,
          durationMs: elapsed(),
          ttfbMs,
          reqBytes,
          resBytes: Number.isFinite(declared) ? declared : bytes,
          coldStart,
          startupMs,
          bootMs,
          cpuMs,
          errorKind: upstream.status >= 500 ? "upstream-5xx" : undefined,
          cacheStatus,
        });
      });
      const headers = new Headers(upstream.headers);
      headers.delete("x-sb-cpu-ms");
      if (cacheStatus) headers.set("sb-cache", cacheStatus === "dynamic" ? "DYNAMIC" : "MISS");
      return new Response(body, { status: upstream.status, headers });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      const status = timedOut ? 504 : 502;
      console.error(
        `sprout ${timedOut ? "timed out" : "failure"} for ${host}: ${error instanceof Error ? error.message : String(error)}`,
      );
      log({
        hostname: host,
        method: request.method,
        status,
        durationMs: elapsed(),
        reqBytes,
        ttfbMs: null,
        coldStart,
        startupMs,
        bootMs,
        error: timedOut ? "request timed out" : "sprout failure",
        errorKind: timedOut ? "timed-out" : "proxy",
      });
      return new Response(timedOut ? "request timed out" : "sprout failed", { status });
    }
  },
});

console.log(`Sproutboat edge router listening on http://${bindHost}:${server.port}`);

// Reap any sprout with no traffic for the idle window (default 10 min), routed
// or not. Hot deployments keep themselves warm; cold ones free their sprout +
// broker and pay a ~1ms cold start on the next request.
const evictionTimer = setInterval(() => pool.evictIdle(), 60_000);

function shutdown(): void {
  clearInterval(evictionTimer);
  logStream?.end();
  pool.disposeAll();
  server.stop();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

process.on("SIGHUP", async () => {
  const nextRoutesMtimeMs = await snapshotMtime(routesPath);
  const nextRoutes = nextRoutesMtimeMs > 0 ? await loadRoutes(routesPath) : new Map<string, Route>();
  swapRoutes(nextRoutes, nextRoutesMtimeMs);
  console.log("route snapshot reloaded");
});
