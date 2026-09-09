import { readFile, stat } from "node:fs/promises";
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pool } from "../../supervisor/src/run";
import { isSproutFirst, resolveAssetKey, type AssetManifest } from "sproutboat/runtime/assets";
import { EdgeCache, cacheRequestEligible, cacheResponseEligible } from "./cache";
import { ActivationSpool } from "./activation";

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

/** `secretsPath` / `secretsHash` are present when the project has ≥1 secret (#2).
 *  `services` (#48) maps a service binding to the hostname it calls, resolved by
 *  the control plane at activation. */
type Route = {
  sproutPath: string;
  secretsPath: string | null;
  secretsHash: string | null;
  services: Record<string, string> | null;
};

type TimedBindings = {
  queues?: unknown;
  crons?: unknown;
  do?: unknown;
};

/**
 * Timed work is broker-originated, so its sprout must be woken independently
 * of HTTP traffic. A malformed or missing bindings file is intentionally not a
 * reason to pin an app: the broker would have no timer to dispatch either.
 */
function hasTimedBindings(sproutPath: string): boolean {
  try {
    // SAFETY: this is only an optional capability hint from the artifact's
    // generated bindings.json. Every property is checked as an array below.
    const bindings = JSON.parse(readFileSync(join(dirname(sproutPath), "bindings.json"), "utf8")) as TimedBindings;
    return [bindings.queues, bindings.crons, bindings.do].some((value) => Array.isArray(value) && value.length > 0);
  } catch {
    return false;
  }
}

function timedSprouts(current: Map<string, Route>) {
  const result: Array<{ sproutPath: string; secretsPath: string | null; services: Record<string, string> | null }> = [];
  for (const route of current.values()) {
    if (!hasTimedBindings(route.sproutPath)) continue;
    // The pool de-duplicates identical runtime contexts. Keep different secret
    // and service snapshots separate even if a content-addressed artifact is
    // attached to more than one custom hostname.
    result.push({ sproutPath: route.sproutPath, secretsPath: route.secretsPath, services: route.services });
  }
  return result;
}

function reconcileTimed(current: Map<string, Route>): void {
  void pool.reconcileTimed(timedSprouts(current)).catch((error) => {
    console.error(`timed route reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

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
    // Only well-formed binding -> hostname pairs survive; a bad entry drops that
    // one binding rather than the whole route.
    let services: Record<string, string> | null = null;
    if (isObject(route.services)) {
      const pairs: Record<string, string> = {};
      for (const [binding, host] of Object.entries(route.services)) {
        if (/^[A-Z][A-Z0-9_]*$/.test(binding) && isString(host) && /^[a-z0-9.-]+$/.test(host)) pairs[binding] = host;
      }
      if (Object.keys(pairs).length > 0) services = pairs;
    }
    result.set(route.hostname, {
      sproutPath: route.sproutPath,
      secretsPath,
      secretsHash: isString(route.secretsHash) ? route.secretsHash : null,
      services,
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
const serviceSignature = (services: Record<string, string> | null | undefined): string =>
  JSON.stringify(Object.entries(services ?? {}).sort(([left], [right]) => left.localeCompare(right)));
const activationSpool = new ActivationSpool(pool, undefined, async (candidate) => {
  await refreshRoutes(true);
  const route = routes.get(candidate.hostname);
  if (
    !route ||
    route.sproutPath !== candidate.sproutPath ||
    route.secretsPath !== candidate.secretsPath ||
    route.secretsHash !== candidate.secretsHash ||
    serviceSignature(route.services) !== serviceSignature(candidate.services)
  )
    throw new Error("edge has not loaded the candidate route generation");
});
const MAX_CACHE_ENTRY_BYTES = 512 * 1024;

/**
 * Pass a response through while retaining at most one cache entry's actual
 * bytes. Content-Length is only an early rejection: a lying origin cannot
 * make us allocate an unbounded buffer.
 */
function cacheFillBody(
  body: ReadableStream<Uint8Array> | null,
  put: (body: ArrayBuffer) => void,
): ReadableStream<Uint8Array> | null {
  if (!body) {
    put(new ArrayBuffer(0));
    return null;
  }
  const parts: Uint8Array[] = [];
  let bytes = 0;
  let fits = true;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (fits && bytes + chunk.byteLength <= MAX_CACHE_ENTRY_BYTES) {
          parts.push(chunk.slice());
          bytes += chunk.byteLength;
        } else {
          fits = false;
          // Drop retained chunks as soon as this no longer fits. The response
          // still streams to the client, but no oversized fill remains in RAM.
          parts.length = 0;
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (!fits) return;
        const buffered = new Uint8Array(bytes);
        let offset = 0;
        for (const part of parts) {
          buffered.set(part, offset);
          offset += part.byteLength;
        }
        put(buffered.buffer);
      },
    }),
  );
}

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
 * removed. HTTP-only sprouts are not pre-spawned: they cold-start on their
 * first request and remain eligible for idle eviction. The bounded timed-route
 * reconciliation below is the exception for active cron, queue and alarm
 * dispatch, which otherwise has no request to wake it.
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
  reconcileTimed(routes);
}

// Belt-and-braces reload: SIGHUP (below) is the authoritative path. Throttle the
// stat() so a hot node isn't calling it thousands of times a second for a file
// that changes on deploy; 250ms is well inside the staleness people already tolerate.
let lastRouteCheck = 0;
async function refreshRoutes(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastRouteCheck < 250) return;
  lastRouteCheck = now;
  const currentMtimeMs = await snapshotMtime(routesPath);
  // Promotion is a generation barrier, not a cache invalidation hint. Force a
  // fresh parse even when filesystem timestamp precision makes the just-written
  // snapshot look unchanged, then validate the exact context before timers can
  // be enabled on the candidate.
  if (force) {
    swapRoutes(currentMtimeMs > 0 ? await loadRoutes(routesPath) : new Map<string, Route>(), currentMtimeMs);
    return;
  }
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

    // Decide before lookup as well as insertion. A credentialed request must
    // never consume an anonymous shared entry, even if the origin later sends
    // public Cache-Control by mistake.
    const cacheEligibleRequest = cache !== null && cacheRequestEligible(request);
    const cacheKey = cacheEligibleRequest ? EdgeCache.key(host, "GET", target.pathname + target.search) : null;
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
        const headers = new Headers(hit.headers);
        headers.set("age", String(hit.ageAtStore + Math.floor((Date.now() - hit.storedAt) / 1000)));
        headers.set("sb-cache", "HIT");
        return new Response(hit.body, { status: hit.status, headers });
      }
    }

    let base: string;
    let coldStart = false;
    let startupMs: number | null = null;
    let bootMs: number | null = null;
    try {
      const endpoint = await pool.endpoint(sproutPath, route.secretsPath, route.services);
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
      // #28 — per-invocation CPU time the sprout self-reports. Cache entries
      // omit it because it is specific to one invocation; uncached responses
      // retain it so a caller can show its own request's CPU time.
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

      const cachePolicy = cacheKey ? cacheResponseEligible(upstream.headers) : null;
      const cacheStatus =
        request.method === "GET" ? (cacheKey ? (cachePolicy === null ? "dynamic" : "miss") : "bypass") : undefined;
      // #31 — log once the response body has actually finished streaming, so
      // durationMs is the full request duration and resBytes is the real count.
      const headers = new Headers(upstream.headers);
      headers.delete("x-sb-cpu-ms");
      if (cpuMs !== null) headers.set("x-sb-cpu-ms", cpuMs.toFixed(3));
      if (cacheStatus) headers.set("sb-cache", cacheStatus === "dynamic" ? "DYNAMIC" : cacheStatus.toUpperCase());
      const cacheHeaders: [string, string][] = [...headers.entries()].filter(
        ([name]) => name !== "sb-cache" && name !== "x-sb-cpu-ms",
      );
      const cacheFill =
        cacheKey && cachePolicy !== null && (!Number.isFinite(declared) || declared <= MAX_CACHE_ENTRY_BYTES)
          ? cacheFillBody(upstream.body, (buffered) =>
              // A route reload purges before it swaps. Do not let an old,
              // in-flight response repopulate that new deployment's cache.
              routes.get(host) === route && Date.now() < cachePolicy.expiresAt
                ? cache!.set(
                    cacheKey,
                    upstream.status,
                    cacheHeaders,
                    buffered,
                    Math.ceil((cachePolicy.expiresAt - Date.now()) / 1000),
                    Math.floor((Date.now() - cachePolicy.responseDateMs) / 1000),
                    cachePolicy.expiresAt,
                  )
                : false,
            )
          : upstream.body;
      const body = cappedBody(cacheFill, host, (bytes) => {
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

// #48 — service bindings are forwarded back through this server, so every
// broker we spawn from here needs our own address. Set before any sprout starts.
process.env.SPROUTBOAT_EDGE_URL ||= `http://127.0.0.1:${server.port}/`;

// Start only active timer-driven routes after the edge can accept broker
// callbacks. `reconcileTimed` wakes two at once, so an edge restart does not
// stampede every deployment in a large snapshot.
reconcileTimed(routes);
void activationSpool.poll();

console.log(`Sproutboat edge router listening on http://${bindHost}:${server.port}`);

// Reap any sprout with no traffic for the idle window (default 10 min), routed
// or not. Hot deployments keep themselves warm; cold ones free their sprout +
// broker and pay a ~1ms cold start on the next request.
const evictionTimer = setInterval(() => pool.evictIdle(), 60_000);
// Deployments update routes.json atomically. HTTP requests and SIGHUP reload it
// promptly already, but timer-only deployments may have neither, so keep a
// cheap mtime poll independent of traffic. It only spawns work after a route
// generation actually changes.
const routeRefreshTimer = setInterval(() => {
  void refreshRoutes().catch((error) => {
    console.error(`route snapshot reload failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}, 1_000);
const activationTimer = setInterval(() => {
  void activationSpool.poll().catch((error) => {
    console.error(`activation command poll failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}, 100);

function shutdown(): void {
  clearInterval(evictionTimer);
  clearInterval(routeRefreshTimer);
  clearInterval(activationTimer);
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
