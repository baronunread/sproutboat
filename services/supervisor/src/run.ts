import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { sproutCommand } from "./sandbox";

/**
 * Where the sprout writes the wall-clock ms at which its bundled JS began
 * running (#41). Diffed against the spawn time, it splits cold-start into
 * "process + runtime bootstrap" (spawn -> JS starts) and "module eval + bind"
 * (JS starts -> listening). Both the spawn env (`SB_STARTUP_FILE`) and the
 * reader derive the same path.
 */
export const startupFilePath = (sproutPath: string, port: number): string =>
  resolve(dirname(sproutPath), `.startup-${port}`);

function readBootMs(file: string, spawnedAt: number, startupMs: number): number {
  try {
    const jsStartedAt = Number(readFileSync(file, "utf8").trim());
    if (!Number.isFinite(jsStartedAt)) return 0;
    const boot = Math.round(jsStartedAt - spawnedAt);
    // same host, same CLOCK_REALTIME — clamp only to absorb rounding slop
    return boot < 0 ? 0 : boot > startupMs ? startupMs : boot;
  } catch {
    return 0;
  }
}

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

export type SproutChild = { readonly exited: Promise<number>; kill(signal?: number): void };
/** `secretsPath` (#2) points at the project's decrypted `secrets.json`, written
 *  outside the content-addressed artifact dir; null when the project has none. */
export type SproutFactory = (sproutPath: string, port: number, secretsPath?: string | null) => SproutChild;

/**
 * What `endpoint()` resolved to. `coldStart` is true when this call had to spawn
 * the sprout process; `startupMs` is the spawn→listening wait for that cold
 * start (0 on a warm hit). The edge records both per request so the dashboard
 * can chart cold-start rate and startup-time percentiles.
 */
export type Endpoint = { url: string; coldStart: boolean; startupMs: number; bootMs: number };

export type SproutPoolOptions = {
  readonly spawn?: SproutFactory;
  readonly readyTimeoutMs?: number;
  readonly idleMs?: number;
  readonly now?: () => number;
  readonly portRange?: readonly [number, number];
};

const defaultReadyTimeoutMs = 10_000;
const defaultIdleMs = 600_000;
const defaultPortRange: readonly [number, number] = [40_000, 49_999];

// The broker runs as a subprocess (not an import): resolve the CLI package's
// `runtime/broker` export to a path Bun can spawn.
const brokerEntry = fileURLToPath(import.meta.resolve("sproutboat/runtime/broker"));

/**
 * Bindings broker sidecar. Spawned only when the artifact ships a `bindings.json`
 * (KV / D1 / R2 / queues / secrets / cron / Durable Objects). The worker reaches
 * it on `SB_BROKER_PORT`; the broker delivers cron + queue triggers back to the
 * worker on `SB_SPROUT_URL`.
 *
 * ponytail: broker port is `workerPort + 10000` — deterministic, within the
 * ephemeral range, no second allocator. Give the broker its own port pool if two
 * live sprouts ever land exactly 10000 apart.
 */
function spawnWithBroker(sproutPath: string, port: number, secretsPath?: string | null): SproutChild {
  const workerDir = dirname(sproutPath);
  const bindingsPath = resolve(workerDir, "bindings.json");
  let broker: Bun.Subprocess | null = null;
  const brokerEnv: Record<string, string> = {};

  if (existsSync(bindingsPath)) {
    const brokerPort = port + 10_000;
    const token = randomBytes(24).toString("hex");
    // The artifact dir is read-only to the edge (0750 sproutboat-control), so
    // broker state can't live in `workerDir/.broker`. Put it beside the request
    // log, whose dir the edge owns; fall back to the artifact dir for dev/tests
    // where it is writable. Nothing creates the tree, so mkdir it here.
    const stateBase = process.env.SPROUTBOAT_BROKER_STATE_DIR
      || (process.env.SPROUTBOAT_LOG_PATH ? resolve(dirname(process.env.SPROUTBOAT_LOG_PATH), "brokers") : workerDir);
    const stateDir = resolve(stateBase, basename(workerDir));
    mkdirSync(resolve(stateDir, "d1"), { recursive: true });
    const args = [
      // `process.execPath`, not "bun": sproutboat-edge.service runs with a
      // hardened PATH that doesn't include the pinned /opt/sproutboat/bun, so a
      // bare "bun" is ENOENT and every sprout with bindings fails to launch.
      process.execPath, brokerEntry,
      "--port", String(brokerPort),
      "--token", token,
      "--db", resolve(stateDir, "state.sqlite"),
      "--data-dir", resolve(stateDir, "d1"),
      "--bindings", bindingsPath,
      // The broker's flag is `--sprout-url` (worker->sprout rename); passing the
      // old `--worker-url` makes its parseArgs throw and the broker never starts.
      "--sprout-url", `http://127.0.0.1:${port}/`,
    ];
    // #2 — secrets come from a per-project file the control plane writes outside
    // the shared artifact dir; the path rides in on the route snapshot.
    if (secretsPath && existsSync(secretsPath)) args.push("--secrets", secretsPath);
    // Static assets published beside the artifact back `env.<ASSETS>.fetch()`.
    if (existsSync(resolve(workerDir, "assets.json"))) args.push("--assets-dir", resolve(workerDir, "assets"));
    broker = Bun.spawn(args, { stdout: "ignore", stderr: "ignore", env: process.env });
    brokerEnv.SB_BROKER_PORT = String(brokerPort);
    brokerEnv.SB_BROKER_TOKEN = token;
  }

  const startupFile = startupFilePath(sproutPath, port);
  try { rmSync(startupFile, { force: true }); } catch { /* fresh spawn */ }
  const sprout = Bun.spawn(sproutCommand(sproutPath), {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, PORT: String(port), SB_STARTUP_FILE: startupFile, ...brokerEnv },
  });

  // #4 — bind the two lifecycles. A worker with a `bindings.json` is useless
  // without its broker, so if either process exits the other is torn down and
  // the pool respawns the pair on the next request:
  //  - worker exits (crash / evict / dispose) -> stop the orphaned broker
  //  - broker exits (crash) -> kill the sprout so `exited` fires and the route
  //    doesn't keep serving binding calls into a closed socket
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; sprout.kill(9); broker?.kill(9); };
  void sprout.exited.then(stop);
  if (broker) void broker.exited.then(stop);

  return { exited: sprout.exited, kill: stop };
}

function spawnSprout(sproutPath: string, port: number, secretsPath?: string | null): SproutChild {
  return spawnWithBroker(sproutPath, port, secretsPath);
}

async function listens(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port }, () => { socket.destroy(); done(true); });
    socket.on("error", () => done(false));
  });
}

class SproutServer {
  readonly port: number;
  readonly url: string;
  #child: SproutChild;
  #closed = false;
  #ready: Promise<void>;
  lastUsedAt: number;
  /** Spawn→listening wait in ms, set once the process accepts a connection. */
  startupMs = 0;
  /** Spawn->JS-start slice of startupMs: process create + ld.so + runtime init (#41). */
  bootMs = 0;

  constructor(
    readonly sproutPath: string,
    port: number,
    spawn: SproutFactory,
    readyTimeoutMs: number,
    now: () => number,
    private readonly onExit: (server: SproutServer) => void,
    secretsPath?: string | null,
  ) {
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.lastUsedAt = now();
    const spawnedAt = Date.now();
    this.#child = spawn(sproutPath, port, secretsPath);
    this.#ready = this.#awaitListening(readyTimeoutMs).then(() => {
      this.startupMs = Date.now() - spawnedAt;
      this.bootMs = readBootMs(startupFilePath(sproutPath, port), spawnedAt, this.startupMs);
    });
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
    // Fast poll early (most sprouts listen within a few ms), then back off so a
    // slow start doesn't spin. #39: replace polling entirely with an inherited
    // listening fd once Porffor supports it.
    let wait = 1;
    while (Date.now() < deadline) {
      if (this.#closed) throw new Error("sprout exited before it began listening");
      if (await listens(this.port)) return;
      await Bun.sleep(wait);
      if (wait < 20) wait = Math.min(20, wait * 2);
    }
    this.dispose();
    throw new Error(`sprout did not listen on :${this.port} within ${timeoutMs}ms`);
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

export class SproutPool {
  readonly #servers = new Map<string, SproutServer>();
  readonly #usedPorts = new Set<number>();
  readonly #spawn: SproutFactory;
  readonly #readyTimeoutMs: number;
  readonly #idleMs: number;
  readonly #now: () => number;
  readonly #portRange: readonly [number, number];
  readonly #seenKeys = new Set<string>();
  #spawns = 0;
  #restarts = 0;
  #readyFailures = 0;
  #idleEvictions = 0;

  constructor({ spawn = spawnSprout, readyTimeoutMs = defaultReadyTimeoutMs, idleMs = defaultIdleMs, now = Date.now, portRange = defaultPortRange }: SproutPoolOptions = {}) {
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
    throw new Error("no free sprout port available");
  }

  /** Base URL of the deployment's server, starting and awaiting it if needed. */
  async endpoint(sproutPath: string, secretsPath?: string | null): Promise<Endpoint> {
    const key = resolve(sproutPath);
    let server = this.#servers.get(key);
    let coldStart = false;
    if (!server || server.closed) {
      coldStart = true;
      if (this.#seenKeys.has(key)) this.#restarts += 1; // this route ran before: crash/evict replacement
      this.#seenKeys.add(key);
      const port = this.#freePort();
      this.#usedPorts.add(port);
      this.#spawns += 1;
      server = new SproutServer(key, port, this.#spawn, this.#readyTimeoutMs, this.#now, (dead) => {
        if (this.#servers.get(key) === dead) this.#servers.delete(key);
        this.#usedPorts.delete(dead.port);
      }, secretsPath);
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
    return { url: server.url, coldStart, startupMs: coldStart ? server.startupMs : 0, bootMs: coldStart ? server.bootMs : 0 };
  }

  dispose(sproutPath: string): void {
    const key = resolve(sproutPath);
    this.#servers.get(key)?.dispose();
    this.#servers.delete(key);
  }

  disposeAll(): void {
    for (const server of Array.from(this.#servers.values())) server.dispose();
    this.#servers.clear();
    this.#usedPorts.clear();
  }

  /**
   * Stop sprouts idle past the window. `keepWarm` — the sprout paths of
   * currently-routed deployments — are never evicted, so an active deployment
   * stays hot and its next request is not a cold start; idle eviction then only
   * reaps sprouts whose route is gone.
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
export const pool = new SproutPool();
