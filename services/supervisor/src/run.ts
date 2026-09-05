import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
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

  // Tee sprout + broker stdout/stderr to one plain-text file per deployment,
  // truncated on each fresh spawn so it always shows the current instance
  // (handler console.log, crashes, "broker rc -N"). Control reads it for
  // `sproutboat tail --sprout`. `"ignore"` when there's no log dir (dev/tests)
  // or the open fails.
  const sproutLogPath = process.env.SPROUTBOAT_LOG_PATH
    ? resolve(dirname(process.env.SPROUTBOAT_LOG_PATH), "sprouts", `${basename(workerDir)}.log`)
    : null;
  const openLog = (mode: "w" | "a"): number | "ignore" => {
    if (!sproutLogPath) return "ignore";
    try {
      mkdirSync(dirname(sproutLogPath), { recursive: true });
      return openSync(sproutLogPath, mode);
    } catch {
      return "ignore";
    }
  };
  const withLog = (fd: number | "ignore") => ({ stdout: fd, stderr: fd }) as const;
  const closeLog = (fd: number | "ignore") => {
    if (fd !== "ignore") closeSync(fd);
  };

  if (existsSync(bindingsPath)) {
    const brokerPort = port + 10_000;
    const token = randomBytes(24).toString("hex");
    // The artifact dir is read-only to the edge (0750 sproutboat-control), so
    // broker state can't live in `workerDir/.broker`. Put it beside the request
    // log, whose dir the edge owns; fall back to the artifact dir for dev/tests
    // where it is writable. Nothing creates the tree, so mkdir it here.
    const stateBase =
      process.env.SPROUTBOAT_BROKER_STATE_DIR ||
      (process.env.SPROUTBOAT_LOG_PATH ? resolve(dirname(process.env.SPROUTBOAT_LOG_PATH), "brokers") : workerDir);
    const stateDir = resolve(stateBase, basename(workerDir));
    mkdirSync(resolve(stateDir, "d1"), { recursive: true });
    // #74 — account-level KV/R2/queue/D1 resources live in one shared dir keyed
    // by their globally-unique `<kind>_<24hex>` id (not per-deployment, not
    // per-owner): the control plane already refuses a deploy that references an
    // id the caller doesn't own, and the id is unguessable. This is what lets a
    // resource's data outlive a redeploy and be shared between projects.
    const resourceDir =
      process.env.SPROUTBOAT_RESOURCE_DIR ||
      (process.env.SPROUTBOAT_LOG_PATH
        ? resolve(dirname(process.env.SPROUTBOAT_LOG_PATH), "resources")
        : resolve(stateBase, "..", "resources"));
    mkdirSync(resourceDir, { recursive: true });
    const args = [
      // `process.execPath`, not "bun": sproutboat-edge.service runs with a
      // hardened PATH that doesn't include the pinned /opt/sproutboat/bun, so a
      // bare "bun" is ENOENT and every sprout with bindings fails to launch.
      // `--smol`: the broker is near-idle and one per deployment — trade GC CPU
      // (idle here) for a smaller JSC heap.
      process.execPath,
      "--smol",
      brokerEntry,
      "--port",
      String(brokerPort),
      "--token",
      token,
      "--db",
      resolve(stateDir, "state.sqlite"),
      "--data-dir",
      resolve(stateDir, "d1"),
      "--resource-dir",
      resourceDir,
      "--bindings",
      bindingsPath,
      // The broker's flag is `--sprout-url` (worker->sprout rename); passing the
      // old `--worker-url` makes its parseArgs throw and the broker never starts.
      "--sprout-url",
      `http://127.0.0.1:${port}/`,
    ];
    // #2 — secrets come from a per-project file the control plane writes outside
    // the shared artifact dir; the path rides in on the route snapshot.
    if (secretsPath && existsSync(secretsPath)) args.push("--secrets", secretsPath);
    // Static assets published beside the artifact back `env.<ASSETS>.fetch()`.
    if (existsSync(resolve(workerDir, "assets.json"))) args.push("--assets-dir", resolve(workerDir, "assets"));
    const brokerFd = openLog("w");
    broker = Bun.spawn(args, { ...withLog(brokerFd), env: process.env });
    closeLog(brokerFd);
    brokerEnv.SB_BROKER_PORT = String(brokerPort);
    brokerEnv.SB_BROKER_TOKEN = token;
  }

  const startupFile = startupFilePath(sproutPath, port);
  try {
    rmSync(startupFile, { force: true });
  } catch {
    /* fresh spawn */
  }

  let sprout: Bun.Subprocess | null = null;
  let stopped = false;
  const capturedBroker = broker;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    sprout?.kill(9);
    capturedBroker?.kill(9);
  };

  // The broker is a Bun process; a freshly compiled native sprout is ready in
  // ~1ms and would fire its first env.KV / env.ASSETS call into a broker that
  // isn't listening yet ("broker rc -2" -> uncaught -> sprout dies -> lifecycle
  // bind kills the broker -> respawn -> same race forever). Gate the sprout on
  // the broker's port. No broker (no bindings) -> start immediately.
  const exited = (async () => {
    if (capturedBroker) {
      const up = await awaitPort(port + 10_000, 5_000);
      if (stopped) return 0;
      // Broker never listened — don't start a sprout that will only crash on its
      // first binding call. Resolve as a failed exit; the pool retries next hit.
      if (!up) {
        capturedBroker.kill(9);
        return 1;
      }
    }
    const sproutFd = openLog(capturedBroker ? "a" : "w");
    try {
      sprout = Bun.spawn(sproutCommand(sproutPath), {
        ...withLog(sproutFd),
        env: { ...process.env, PORT: String(port), SB_STARTUP_FILE: startupFile, ...brokerEnv },
      });
    } catch (cause) {
      // The artifact is not executable on this box — a truncated upload, a
      // foreign architecture, a seeded placeholder. `Bun.spawn` throws
      // synchronously (ENOEXEC), and an uncaught throw here would take the
      // whole edge down with it: one bad artifact, every tenant offline.
      // Fail this deployment only; the pool retries on the next request.
      console.error(`sprout ${sproutPath} could not be executed:`, cause instanceof Error ? cause.message : cause);
      capturedBroker?.kill(9);
      closeLog(sproutFd);
      return 1;
    }
    closeLog(sproutFd);
    // #4 — bind the two lifecycles: a sprout with bindings is useless without
    // its broker, so either exiting tears down the other and the pool respawns
    // the pair on the next request.
    void sprout.exited.then(stop);
    if (capturedBroker) void capturedBroker.exited.then(stop);
    return sprout.exited;
  })();

  return { exited, kill: stop };
}

/** The real spawn behind the default pool. Exported so the unexecutable-artifact
 *  path can be covered — it used to throw and take the whole edge down. */
export function spawnSprout(sproutPath: string, port: number, secretsPath?: string | null): SproutChild {
  return spawnWithBroker(sproutPath, port, secretsPath);
}

async function listens(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      done(true);
    });
    socket.on("error", () => done(false));
  });
}

/** Poll a loopback port until something accepts, or the deadline passes. */
async function awaitPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let wait = 2;
  while (Date.now() < deadline) {
    if (await listens(port)) return true;
    await Bun.sleep(wait);
    if (wait < 25) wait = Math.min(25, wait * 2);
  }
  return false;
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
    void this.#child.exited.then(() => {
      if (!this.#closed) {
        this.#closed = true;
        this.onExit(this);
      }
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  async ready(): Promise<void> {
    return this.#ready;
  }

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

  constructor({
    spawn = spawnSprout,
    readyTimeoutMs = defaultReadyTimeoutMs,
    idleMs = defaultIdleMs,
    now = Date.now,
    portRange = defaultPortRange,
  }: SproutPoolOptions = {}) {
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
      server = new SproutServer(
        key,
        port,
        this.#spawn,
        this.#readyTimeoutMs,
        this.#now,
        (dead) => {
          if (this.#servers.get(key) === dead) this.#servers.delete(key);
          this.#usedPorts.delete(dead.port);
        },
        secretsPath,
      );
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
    return {
      url: server.url,
      coldStart,
      startupMs: coldStart ? server.startupMs : 0,
      bootMs: coldStart ? server.bootMs : 0,
    };
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
   * Stop any sprout idle past the window — routed or not. A hot deployment
   * keeps `lastUsedAt` fresh and is never touched; a deployment with a route
   * but no traffic for `idleMs` is reaped and cold-starts (~1ms + broker wait)
   * on its next request. Deployments whose route was removed are disposed
   * eagerly by the edge on snapshot swap; this is the traffic-based reaper.
   *
   * Previously every routed deployment was pinned resident, so a node with N
   * deployments held N sprouts (+ N brokers) forever regardless of traffic.
   */
  evictIdle(now = this.#now()): number {
    let evicted = 0;
    for (const [key, server] of Array.from(this.#servers.entries())) {
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
