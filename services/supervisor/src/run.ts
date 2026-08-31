import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { connect } from "node:net";
import { workerCommand } from "./sandbox";

/**
 * One long-lived native-fetch HTTP server per deployment.
 *
 * alpha-3 Porffor compiles `export default { fetch }` into a uWebSockets server
 * binary. The supervisor assigns it a loopback port ($PORT — see
 * patches/porffor-render.patch), starts it, waits for it to listen, and restarts
 * it if it exits. The edge reverse-proxies each request to `endpoint()`.
 *
 * No stdin/stdout framing, no per-request process, no recycle: alpha-3 has
 * working memory management (verified flat RSS over 500k requests).
 */

export type WorkerChild = { readonly exited: Promise<number>; kill(signal?: number): void };
export type WorkerFactory = (workerPath: string, port: number) => WorkerChild;

/**
 * What `endpoint()` resolved to. `coldStart` is true when this call had to spawn
 * the worker process; `startupMs` is the spawn→listening wait for that cold
 * start (0 on a warm hit). The edge records both per request so the dashboard
 * can chart cold-start rate and startup-time percentiles.
 */
export type Endpoint = { url: string; coldStart: boolean; startupMs: number };

export type WorkerPoolOptions = {
  readonly spawn?: WorkerFactory;
  readonly readyTimeoutMs?: number;
  readonly idleMs?: number;
  readonly now?: () => number;
  readonly portRange?: readonly [number, number];
};

const defaultReadyTimeoutMs = 10_000;
const defaultIdleMs = 600_000;
const defaultPortRange: readonly [number, number] = [40_000, 49_999];

const brokerEntry = resolve(import.meta.dir, "../../broker/src/broker.ts");

/**
 * Bindings broker sidecar. Spawned only when the artifact ships a `bindings.json`
 * (KV / D1 / R2 / queues / secrets / cron / Durable Objects). The worker reaches
 * it on `SB_BROKER_PORT`; the broker delivers cron + queue triggers back to the
 * worker on `SB_WORKER_URL`.
 *
 * ponytail: broker port is `workerPort + 10000` — deterministic, within the
 * ephemeral range, no second allocator. Give the broker its own port pool if two
 * live workers ever land exactly 10000 apart.
 */
function spawnWithBroker(workerPath: string, port: number): WorkerChild {
  const workerDir = dirname(workerPath);
  const bindingsPath = resolve(workerDir, "bindings.json");
  let broker: Bun.Subprocess | null = null;
  const brokerEnv: Record<string, string> = {};

  if (existsSync(bindingsPath)) {
    const brokerPort = port + 10_000;
    const token = randomBytes(24).toString("hex");
    const stateDir = process.env.SPROUTBOAT_BROKER_STATE_DIR || resolve(workerDir, ".broker");
    const args = [
      "bun", brokerEntry,
      "--port", String(brokerPort),
      "--token", token,
      "--db", resolve(stateDir, "state.sqlite"),
      "--data-dir", resolve(stateDir, "d1"),
      "--bindings", bindingsPath,
      "--worker-url", `http://127.0.0.1:${port}/`,
    ];
    const secretsPath = resolve(workerDir, "secrets.json");
    if (existsSync(secretsPath)) args.push("--secrets", secretsPath);
    // Static assets published beside the artifact back `env.<ASSETS>.fetch()`.
    if (existsSync(resolve(workerDir, "assets.json"))) args.push("--assets-dir", resolve(workerDir, "assets"));
    broker = Bun.spawn(args, { stdout: "ignore", stderr: "ignore", env: process.env });
    brokerEnv.SB_BROKER_PORT = String(brokerPort);
    brokerEnv.SB_BROKER_TOKEN = token;
  }

  const worker = Bun.spawn(workerCommand(workerPath), {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, PORT: String(port), ...brokerEnv },
  });
  return {
    exited: worker.exited,
    kill(signal?: number) {
      worker.kill(signal ?? 9);
      broker?.kill(9);
    },
  };
}

function spawnNativeWorker(workerPath: string, port: number): WorkerChild {
  return spawnWithBroker(workerPath, port);
}

async function listens(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port }, () => { socket.destroy(); done(true); });
    socket.on("error", () => done(false));
  });
}

class WorkerServer {
  readonly port: number;
  readonly url: string;
  #child: WorkerChild;
  #closed = false;
  #ready: Promise<void>;
  lastUsedAt: number;
  /** Spawn→listening wait in ms, set once the process accepts a connection. */
  startupMs = 0;

  constructor(
    readonly workerPath: string,
    port: number,
    spawn: WorkerFactory,
    readyTimeoutMs: number,
    now: () => number,
    private readonly onExit: (server: WorkerServer) => void,
  ) {
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.lastUsedAt = now();
    const spawnedAt = Date.now();
    this.#child = spawn(workerPath, port);
    this.#ready = this.#awaitListening(readyTimeoutMs).then(() => { this.startupMs = Date.now() - spawnedAt; });
    void this.#child.exited.then(() => { if (!this.#closed) { this.#closed = true; this.onExit(this); } });
  }

  get closed(): boolean { return this.#closed; }

  async ready(): Promise<void> { return this.#ready; }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    // SIGKILL: the bwrap launcher does not forward SIGTERM to the payload;
    // killing bwrap hard triggers --die-with-parent teardown of the namespace.
    this.#child.kill(9);
  }

  async #awaitListening(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // Fast poll early (most workers listen within a few ms), then back off so a
    // slow start doesn't spin. #43: replace polling entirely with an inherited
    // listening fd once Porffor supports it.
    let wait = 1;
    while (Date.now() < deadline) {
      if (this.#closed) throw new Error("worker exited before it began listening");
      if (await listens(this.port)) return;
      await Bun.sleep(wait);
      if (wait < 20) wait = Math.min(20, wait * 2);
    }
    this.dispose();
    throw new Error(`worker did not listen on :${this.port} within ${timeoutMs}ms`);
  }
}

/** Deployment-keyed pool of native-fetch server processes. */
/** #30 — process-wide runtime-lifecycle gauges for the admin dashboard. */
export type PoolStats = {
  live: number;
  spawns: number;
  restarts: number;
  readyFailures: number;
  idleEvictions: number;
  portsInUse: number;
  portPoolSize: number;
};

export class WorkerPool {
  readonly #servers = new Map<string, WorkerServer>();
  readonly #usedPorts = new Set<number>();
  readonly #spawn: WorkerFactory;
  readonly #readyTimeoutMs: number;
  readonly #idleMs: number;
  readonly #now: () => number;
  readonly #portRange: readonly [number, number];
  readonly #seenKeys = new Set<string>();
  #spawns = 0;
  #restarts = 0;
  #readyFailures = 0;
  #idleEvictions = 0;

  constructor({ spawn = spawnNativeWorker, readyTimeoutMs = defaultReadyTimeoutMs, idleMs = defaultIdleMs, now = Date.now, portRange = defaultPortRange }: WorkerPoolOptions = {}) {
    this.#spawn = spawn;
    this.#readyTimeoutMs = readyTimeoutMs;
    this.#idleMs = idleMs;
    this.#now = now;
    this.#portRange = portRange;
  }

  #freePort(): number {
    const [lo, hi] = this.#portRange;
    for (let attempt = 0; attempt < 10_000; attempt++) {
      const port = lo + Math.floor(Math.random() * (hi - lo + 1));
      if (!this.#usedPorts.has(port)) return port;
    }
    throw new Error("no free worker port available");
  }

  /** Base URL of the deployment's server, starting and awaiting it if needed. */
  async endpoint(workerPath: string): Promise<Endpoint> {
    const key = resolve(workerPath);
    let server = this.#servers.get(key);
    let coldStart = false;
    if (!server || server.closed) {
      coldStart = true;
      if (this.#seenKeys.has(key)) this.#restarts += 1; // this route ran before: crash/evict replacement
      this.#seenKeys.add(key);
      const port = this.#freePort();
      this.#usedPorts.add(port);
      this.#spawns += 1;
      server = new WorkerServer(key, port, this.#spawn, this.#readyTimeoutMs, this.#now, (dead) => {
        if (this.#servers.get(key) === dead) this.#servers.delete(key);
        this.#usedPorts.delete(dead.port);
      });
      this.#servers.set(key, server);
    }
    server.lastUsedAt = this.#now();
    try {
      await server.ready();
    } catch (error) {
      this.#readyFailures += 1;
      server.dispose();
      this.#servers.delete(key);
      this.#usedPorts.delete(server.port);
      throw error;
    }
    return { url: server.url, coldStart, startupMs: coldStart ? server.startupMs : 0 };
  }

  dispose(workerPath: string): void {
    const key = resolve(workerPath);
    this.#servers.get(key)?.dispose();
    this.#servers.delete(key);
  }

  disposeAll(): void {
    for (const server of Array.from(this.#servers.values())) server.dispose();
    this.#servers.clear();
    this.#usedPorts.clear();
  }

  /**
   * Stop workers idle past the window. `keepWarm` — the worker paths of
   * currently-routed deployments — are never evicted, so an active deployment
   * stays hot and its next request is not a cold start; idle eviction then only
   * reaps workers whose route is gone.
   *
   * ponytail: keeps every routed deployment resident. Add an LRU cap or
   * memory-pressure trigger once one node carries many hundreds of deployments.
   */
  evictIdle(keepWarm?: ReadonlySet<string>, now = this.#now()): number {
    let evicted = 0;
    for (const [key, server] of Array.from(this.#servers.entries())) {
      if (keepWarm?.has(key)) continue;
      if (now - server.lastUsedAt >= this.#idleMs) {
        server.dispose();
        this.#servers.delete(key);
        this.#usedPorts.delete(server.port);
        evicted++;
      }
    }
    this.#idleEvictions += evicted;
    return evicted;
  }

  stats(): PoolStats {
    const [lo, hi] = this.#portRange;
    return {
      live: this.#servers.size,
      spawns: this.#spawns,
      restarts: this.#restarts,
      readyFailures: this.#readyFailures,
      idleEvictions: this.#idleEvictions,
      portsInUse: this.#usedPorts.size,
      portPoolSize: hi - lo + 1,
    };
  }
}

/** Process-wide worker pool the edge proxies through. */
export const pool = new WorkerPool();
