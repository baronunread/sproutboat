import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pool } from "../../supervisor/src/run";

type JsonValue = string | number | boolean | null | EdgeJsonObject | JsonValue[];

interface EdgeJsonObject {
  readonly [key: string]: JsonValue;
}

type EdgeInput = JsonValue | undefined;

interface LogEvent {
  readonly hostname?: string | null;
  readonly status: number;
  readonly durationMs: number;
  readonly error?: string;
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
const marketingHostname = (process.env.SPROUTBOAT_DEPLOYMENT_DOMAIN || "sproutboat.com").toLowerCase();
const marketingPage = Bun.file(resolve(import.meta.dir, "../../../apps/marketing/index.html"));
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

async function refreshRoutes(): Promise<void> {
  const currentMtimeMs = await snapshotMtime(routesPath);
  if (currentMtimeMs > routesMtimeMs) {
    const nextRoutes = await loadRoutes(routesPath);
    for (const [hostname, workerPath] of routes) {
      if (nextRoutes.get(hostname) !== workerPath) pool.dispose(workerPath);
    }
    routes = nextRoutes;
    routesMtimeMs = currentMtimeMs;
  }
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const started = performance.now();
    try { await refreshRoutes(); }
    catch (error) { console.error(`route snapshot reload failed: ${error instanceof Error ? error.message : String(error)}`); }
    const host = request.headers.get("host")?.split(":")[0]?.toLowerCase();
    if (host === marketingHostname) return new Response(marketingPage, { headers: { "content-type": "text/html; charset=utf-8" } });
    const workerPath = host ? routes.get(host) : undefined;
    if (!workerPath) {
      await log({ hostname: host || null, status: 404, durationMs: Math.round(performance.now() - started) });
      return new Response("unknown deployment", { status: 404 });
    }
    try {
      // Reverse-proxy the request to the deployment's native-fetch server.
      const base = await pool.endpoint(workerPath);
      const target = new URL(request.url);
      const upstream = await fetch(`${base}${target.pathname}${target.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });
      await log({ hostname: host, status: upstream.status, durationMs: Math.round(performance.now() - started) });
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    } catch (error) {
      console.error(`worker failure for ${host}: ${error instanceof Error ? error.message : String(error)}`);
      await log({ hostname: host, status: 502, durationMs: Math.round(performance.now() - started), error: "worker failure" });
      return new Response("worker failed", { status: 502 });
    }
  },
});

console.log(`Sproutboat edge router listening on http://localhost:${server.port}`);

const evictionTimer = setInterval(() => pool.evictIdle(), 60_000);

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
  for (const [hostname, workerPath] of routes) {
    if (nextRoutes.get(hostname) !== workerPath) pool.dispose(workerPath);
  }
  routesMtimeMs = nextRoutesMtimeMs;
  routes = nextRoutes;
  console.log("route snapshot reloaded");
});
