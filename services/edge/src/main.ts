import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runWorker } from "../../supervisor/src/run";

type Route = { hostname: string; workerPath: string };

async function loadRoutes(path: string): Promise<Map<string, string>> {
  const routes = JSON.parse(await readFile(path, "utf8")) as Route[];
  const result = new Map<string, string>();
  for (const route of routes) {
    if (!/^[a-z0-9.-]+$/.test(route.hostname) || !route.workerPath.startsWith("/")) throw new TypeError("invalid route snapshot");
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

async function log(event: Record<string, unknown>): Promise<void> {
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
    routes = await loadRoutes(routesPath);
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
      const headers = Object.fromEntries([...request.headers].filter(([name]) => !name.startsWith("sec-ch-ua")));
      const response = await runWorker(workerPath, { method: request.method, url: request.url, headers, body: await request.text() });
      await log({ hostname: host, status: response.status, durationMs: Math.round(performance.now() - started) });
      return new Response(response.body, { status: response.status, headers: response.headers });
    } catch (error) {
      console.error(`worker failure for ${host}: ${error instanceof Error ? error.message : String(error)}`);
      await log({ hostname: host, status: 502, durationMs: Math.round(performance.now() - started), error: "worker failure" });
      return new Response("worker failed", { status: 502 });
    }
  },
});

console.log(`Sproutboat edge router listening on http://localhost:${server.port}`);

process.on("SIGHUP", async () => {
  routesMtimeMs = await snapshotMtime(routesPath);
  routes = routesMtimeMs > 0 ? await loadRoutes(routesPath) : new Map();
  console.log("route snapshot reloaded");
});
