import { afterEach, expect, test } from "bun:test";
import { WorkerPool } from "./run";
import { workerCommand } from "./sandbox";
import type { WorkerChild, WorkerFactory } from "./run";

// A stand-in worker: a tiny HTTP server on the assigned port, so the pool's real
// TCP readiness check and the edge's proxy both work without compiling Porffor.
function fakeSpawn() {
  const exits = new Map<number, (code: number) => void>();
  const servers = new Map<number, ReturnType<typeof Bun.serve>>();
  const stop = (port: number, code: number) => {
    servers.get(port)?.stop(true);
    servers.delete(port);
    exits.get(port)?.(code);
    exits.delete(port);
  };
  const spawn: WorkerFactory = (workerPath, port): WorkerChild => {
    servers.set(port, Bun.serve({ port, fetch: () => new Response(`ok ${workerPath} ${port}`) }));
    return { exited: new Promise<number>((resolve) => exits.set(port, resolve)), kill: () => stop(port, 137) };
  };
  return { spawn, servers, crash: (port: number) => stop(port, 139) };
}

const pools: WorkerPool[] = [];
afterEach(() => { for (const p of pools) p.disposeAll(); pools.length = 0; });
function makePool(spawn: WorkerFactory, opts = {}) {
  const pool = new WorkerPool({ spawn, portRange: [45_000, 45_999], ...opts });
  pools.push(pool);
  return pool;
}

test("endpoint starts one server per deployment and reuses it", async () => {
  const { spawn, servers } = fakeSpawn();
  const pool = makePool(spawn);
  const a = await pool.endpoint("/tmp/app/worker");
  const b = await pool.endpoint("/tmp/app/worker");
  expect(a.url).toBe(b.url);
  expect(servers.size).toBe(1);
  expect((await (await fetch(a.url)).text())).toContain("/tmp/app/worker");
});

test("endpoint reports the cold start and its startup time, then warm hits", async () => {
  const { spawn } = fakeSpawn();
  const pool = makePool(spawn);
  const cold = await pool.endpoint("/tmp/app/worker");
  expect(cold.coldStart).toBe(true);
  expect(cold.startupMs).toBeGreaterThanOrEqual(0);
  const warm = await pool.endpoint("/tmp/app/worker");
  expect(warm.coldStart).toBe(false);
  expect(warm.startupMs).toBe(0);
});

test("separate deployments get separate ports", async () => {
  const { spawn, servers } = fakeSpawn();
  const pool = makePool(spawn);
  const a = await pool.endpoint("/tmp/one/worker");
  const b = await pool.endpoint("/tmp/two/worker");
  expect(a.url).not.toBe(b.url);
  expect(servers.size).toBe(2);
});

test("a crashed worker is replaced on the next request", async () => {
  const { spawn, crash } = fakeSpawn();
  const pool = makePool(spawn);
  const first = await pool.endpoint("/tmp/app/worker");
  const port = Number(new URL(first.url).port);
  crash(port);
  await Bun.sleep(10);
  const second = await pool.endpoint("/tmp/app/worker");
  expect(Number(new URL(second.url).port)).not.toBe(port);
  expect(second.coldStart).toBe(true);
  expect((await fetch(second.url)).ok).toBe(true);
});

test("readiness failure surfaces and does not leak the port", async () => {
  const spawn: WorkerFactory = (): WorkerChild => ({ exited: new Promise(() => {}), kill() {} }); // never listens
  const pool = makePool(spawn, { readyTimeoutMs: 150 });
  await expect(pool.endpoint("/tmp/app/worker")).rejects.toThrow("did not listen");
});

test("evictIdle stops servers past the idle window", async () => {
  const { spawn } = fakeSpawn();
  let now = 0;
  const pool = makePool(spawn, { idleMs: 100, now: () => now });
  const { url } = await pool.endpoint("/tmp/app/worker");
  now = 100;
  expect(pool.evictIdle()).toBe(1);
  await Bun.sleep(10);
  await expect(fetch(url)).rejects.toThrow();
});

test("evictIdle keeps idle workers whose deployment is still routed", async () => {
  const { spawn } = fakeSpawn();
  let now = 0;
  const pool = makePool(spawn, { idleMs: 100, now: () => now });
  const routed = await pool.endpoint("/tmp/routed/worker");
  await pool.endpoint("/tmp/orphan/worker");
  now = 200;
  expect(pool.evictIdle(new Set(["/tmp/routed/worker"]))).toBe(1); // only the orphan
  expect((await fetch(routed.url)).ok).toBe(true);                  // routed one still warm
});

test("workerCommand wraps the worker in the bwrap launcher on Linux, runs it directly off Linux", () => {
  const saved = process.platform;
  const set = (v: string) => Object.defineProperty(process, "platform", { value: v, configurable: true });
  try {
    set("darwin");
    expect(workerCommand("/x/worker")).toEqual(["/x/worker"]);
    set("linux");
    process.env.SPROUTBOAT_WORKER_SANDBOX_CMD = "/opt/sproutboat/infra/sandbox/worker-sandbox.sh";
    expect(workerCommand("/var/lib/sproutboat/artifacts/a/worker")).toEqual(["/opt/sproutboat/infra/sandbox/worker-sandbox.sh", "/var/lib/sproutboat/artifacts/a/worker"]);
    delete process.env.SPROUTBOAT_WORKER_SANDBOX_CMD;
    process.env.SPROUTBOAT_WORKER_SANDBOX = "none";
    expect(() => workerCommand("/x/worker")).toThrow("refusing to run an untrusted native worker unsandboxed");
    delete process.env.SPROUTBOAT_WORKER_SANDBOX;
  } finally {
    Object.defineProperty(process, "platform", { value: saved, configurable: true });
  }
});
