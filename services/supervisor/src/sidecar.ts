/**
 * The supervisor pool behind a unix socket, for the Rust edge (services/edge-rs).
 *
 * The Rust edge does not embed the supervisor; it spawns this program lazily the
 * first time anything needs sandboxed sprouts, and talks JSON over the socket named
 * by SPROUTBOAT_SIDECAR_SOCKET. One pool, the same one the Bun edge embeds.
 *
 *   POST /endpoint        {sproutPath, secretsPath, services, r2, dispatchDisabled} -> Endpoint | 500 {error}
 *   POST /touch           {sproutPath, secretsPath, services, r2}
 *   POST /dispose         {sproutPath}
 *   POST /dispose-all
 *   POST /reconcile       [{sproutPath, secretsPath, services, r2}, ...]  (answers at once; runs in the background)
 *   GET  /stats           -> PoolStats
 *   POST /verify-binding-call  {credential, host} -> {ok}  (a scoped per-broker credential for that host, or the edge-wide secret)
 *
 * Brokers read SPROUTBOAT_EDGE_URL (the edge sets it in this process's environment).
 * Prints `sidecar ready` once listening. SIGTERM/SIGINT, or end of stdin when
 * SPROUTBOAT_SIDECAR_EXIT_ON_STDIN_EOF=1 (the edge died), dispose every sprout and exit.
 */
import { chmodSync, rmSync } from "node:fs";
import { acceptBindingCall } from "./binding-credentials";
import { pool, type R2Runtime, type TimedSprout } from "./run";

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };

type JsonObject = { readonly [key: string]: Json };

const tagOf = (value: Json | undefined): string => Object.prototype.toString.call(value).slice(8, -1);

const isString = (value: Json | undefined): value is string => tagOf(value) === "String";

const isRecord = (value: Json | undefined): value is JsonObject => tagOf(value) === "Object";

const optionalString = (value: Json | undefined): string | null => (isString(value) ? value : null);

function services(value: Json | undefined): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const pairs: Record<string, string> = {};
  for (const [binding, host] of Object.entries(value)) if (isString(host)) pairs[binding] = host;
  return pairs;
}

function r2(value: Json | undefined): R2Runtime | null {
  if (!isRecord(value) || !isString(value.ownerId)) return null;
  const resourceIds = Array.isArray(value.resourceIds) ? value.resourceIds.filter(isString) : [];
  return isString(value.doStoreId)
    ? { ownerId: value.ownerId, resourceIds, doStoreId: value.doStoreId }
    : { ownerId: value.ownerId, resourceIds };
}

function runtime(body: Json): TimedSprout & { sproutPath: string } {
  if (!isRecord(body) || !isString(body.sproutPath) || body.sproutPath === "")
    throw new TypeError("sproutPath is required");
  return {
    sproutPath: body.sproutPath,
    secretsPath: optionalString(body.secretsPath),
    services: services(body.services),
    r2: r2(body.r2),
  };
}

const message = (error: Error): string => error.message;

const socketPath = process.env.SPROUTBOAT_SIDECAR_SOCKET;
if (!socketPath) {
  console.error("SPROUTBOAT_SIDECAR_SOCKET is required");
  process.exit(2);
}
const socketFile: string = socketPath;
rmSync(socketFile, { force: true }); // a stale socket from a crashed predecessor

async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/stats") return Response.json(pool.stats());
  if (request.method !== "POST") return Response.json({ error: "not found" }, { status: 404 });
  const text = await request.text();
  // JSON.parse yields a Json value; every field is re-checked by the parsers above.
  const parsed: Json = text ? JSON.parse(text) : null;
  switch (pathname) {
    case "/endpoint": {
      const target = runtime(parsed);
      const dispatchDisabled = isRecord(parsed) && parsed.dispatchDisabled === true;
      const endpoint = await pool.endpoint(
        target.sproutPath,
        target.secretsPath,
        target.services,
        target.r2,
        dispatchDisabled,
      );
      return Response.json(endpoint);
    }
    case "/touch": {
      const target = runtime(parsed);
      pool.touch(target.sproutPath, target.secretsPath, target.services, target.r2);
      return Response.json({ ok: true });
    }
    case "/dispose": {
      if (!isRecord(parsed) || !isString(parsed.sproutPath)) throw new TypeError("sproutPath is required");
      pool.dispose(parsed.sproutPath);
      return Response.json({ ok: true });
    }
    case "/dispose-all":
      pool.disposeAll();
      return Response.json({ ok: true });
    case "/reconcile": {
      if (!Array.isArray(parsed)) throw new TypeError("a list of sprouts is required");
      const sprouts = parsed.map(runtime);
      // The pool serialises reconciliations; answer now so the edge never waits on a cold start.
      void pool.reconcileTimed(sprouts).catch((error: Error) => {
        console.error(`timed route reconcile failed: ${message(error)}`);
      });
      return Response.json({ ok: true });
    }
    case "/verify-binding-call": {
      const credential = isRecord(parsed) && isString(parsed.credential) ? parsed.credential : null;
      const host = isRecord(parsed) && isString(parsed.host) ? parsed.host : "";
      return Response.json({ ok: acceptBindingCall(credential, host) });
    }
    default:
      return Response.json({ error: "not found" }, { status: 404 });
  }
}

const server = Bun.serve({
  unix: socketFile,
  async fetch(request) {
    try {
      return await handle(request);
    } catch (error) {
      return Response.json(
        { error: message(error instanceof Error ? error : new Error(String(error))) },
        { status: 500 },
      );
    }
  },
});
// The socket carries the pool's controls; keep it to the edge's user.
chmodSync(socketFile, 0o600);

const evictionTimer = setInterval(() => pool.evictIdle(), 60_000);

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  clearInterval(evictionTimer);
  pool.disposeAll();
  void server.stop(true);
  rmSync(socketFile, { force: true });
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
if (process.env.SPROUTBOAT_SIDECAR_EXIT_ON_STDIN_EOF === "1") {
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.stdin.resume();
}

console.log("sidecar ready");
