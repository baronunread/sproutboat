import { resolve } from "node:path";
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

function spawnNativeWorker(workerPath: string, port: number): WorkerChild {
  return Bun.spawn(workerCommand(workerPath), {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, PORT: String(port) },
  });
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
    this.#child = spawn(workerPath, port);
    this.#ready = this.#awaitListening(readyTimeoutMs);
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
    while (Date.now() < deadline) {
      if (this.#closed) throw new Error("worker exited before it began listening");
      if (await listens(this.port)) return;
      await Bun.sleep(20);
    }
    this.dispose();
    throw new Error(`worker did not listen on :${this.port} within ${timeoutMs}ms`);
  }
}

/** Deployment-keyed pool of native-fetch server processes. */
export class WorkerPool {
  readonly #servers = new Map<string, WorkerServer>();
  readonly #usedPorts = new Set<number>();
  readonly #spawn: WorkerFactory;
  readonly #readyTimeoutMs: number;
  readonly #idleMs: number;
  readonly #now: () => number;
  readonly #portRange: readonly [number, number];

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
  async endpoint(workerPath: string): Promise<string> {
    const key = resolve(workerPath);
    let server = this.#servers.get(key);
    if (!server || server.closed) {
      const port = this.#freePort();
      this.#usedPorts.add(port);
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
      server.dispose();
      this.#servers.delete(key);
      this.#usedPorts.delete(server.port);
      throw error;
    }
    return server.url;
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
    return evicted;
  }
}

/** Process-wide worker pool the edge proxies through. */
export const pool = new WorkerPool();
