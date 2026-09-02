import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SproutPool, startupFilePath } from "./run";
import { sproutCommand } from "./sandbox";
import type { SproutChild, SproutFactory } from "./run";

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
  const spawn: SproutFactory = (sproutPath, port): SproutChild => {
    servers.set(port, Bun.serve({ port, fetch: () => new Response(`ok ${sproutPath} ${port}`) }));
    return { exited: new Promise<number>((resolve) => exits.set(port, resolve)), kill: () => stop(port, 137) };
  };
  return { spawn, servers, crash: (port: number) => stop(port, 139) };
}

const pools: SproutPool[] = [];
afterEach(() => { for (const p of pools) p.disposeAll(); pools.length = 0; });
function makePool(spawn: SproutFactory, opts = {}) {
  const pool = new SproutPool({ spawn, portRange: [45_000, 45_999], ...opts });
  pools.push(pool);
  return pool;
}

test("endpoint starts one server per deployment and reuses it", async () => {
  const { spawn, servers } = fakeSpawn();
  const pool = makePool(spawn);
  const a = await pool.endpoint("/tmp/app/sprout");
  const b = await pool.endpoint("/tmp/app/sprout");
  expect(a.url).toBe(b.url);
  expect(servers.size).toBe(1);
  expect((await (await fetch(a.url)).text())).toContain("/tmp/app/sprout");
});

test("endpoint reports the cold start and its startup time, then warm hits", async () => {
  const { spawn } = fakeSpawn();
  const pool = makePool(spawn);
  const cold = await pool.endpoint("/tmp/app/sprout");
  expect(cold.coldStart).toBe(true);
  expect(cold.startupMs).toBeGreaterThanOrEqual(0);
  expect(cold.bootMs).toBe(0); // fake spawn writes no SB_STARTUP_FILE
  const warm = await pool.endpoint("/tmp/app/sprout");
  expect(warm.coldStart).toBe(false);
  expect(warm.startupMs).toBe(0);
  expect(warm.bootMs).toBe(0);
});

test("cold start splits out a boot slice from the sprout's startup marker (#41)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-startup-"));
  const sproutPath = join(dir, "sprout");
  const { spawn } = fakeSpawn();
  // Stand in for the prelude's __sbStartupMark: record "JS started" at spawn time.
  const spawnWithMarker: SproutFactory = (path, port) => {
    writeFileSync(startupFilePath(path, port), String(Date.now()));
    return spawn(path, port);
  };
  try {
    const pool = makePool(spawnWithMarker);
    const cold = await pool.endpoint(sproutPath);
    expect(cold.coldStart).toBe(true);
    expect(cold.bootMs).toBeGreaterThanOrEqual(0);
    expect(cold.bootMs).toBeLessThanOrEqual(cold.startupMs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("separate deployments get separate ports", async () => {
  const { spawn, servers } = fakeSpawn();
  const pool = makePool(spawn);
  const a = await pool.endpoint("/tmp/one/sprout");
  const b = await pool.endpoint("/tmp/two/sprout");
  expect(a.url).not.toBe(b.url);
  expect(servers.size).toBe(2);
});

test("stats() tracks live count, spawns, restarts, evictions and the port pool", async () => {
  const { spawn, crash } = fakeSpawn();
  const pool = makePool(spawn, { idleMs: 0, portRange: [46_000, 46_099] });
  await pool.endpoint("/tmp/a/sprout");
  await pool.endpoint("/tmp/b/sprout");
  let s = pool.stats();
  expect(s.live).toBe(2);
  expect(s.spawns).toBe(2);
  expect(s.restarts).toBe(0);
  expect(s.portsInUse).toBe(2);
  expect(s.portPoolSize).toBe(100);

  const first = await pool.endpoint("/tmp/a/sprout"); // warm, no new spawn
  crash(Number(new URL(first.url).port));
  await Bun.sleep(10);
  await pool.endpoint("/tmp/a/sprout");               // restart
  s = pool.stats();
  expect(s.spawns).toBe(3);
  expect(s.restarts).toBe(1);

  expect(pool.evictIdle()).toBeGreaterThan(0);
  expect(pool.stats().idleEvictions).toBeGreaterThan(0);
  expect(pool.stats().live).toBe(0);
});

test("a crashed worker is replaced on the next request", async () => {
  const { spawn, crash } = fakeSpawn();
  const pool = makePool(spawn);
  const first = await pool.endpoint("/tmp/app/sprout");
  const port = Number(new URL(first.url).port);
  crash(port);
  await Bun.sleep(10);
  const second = await pool.endpoint("/tmp/app/sprout");
  expect(Number(new URL(second.url).port)).not.toBe(port);
  expect(second.coldStart).toBe(true);
  expect((await fetch(second.url)).ok).toBe(true);
});

test("readiness failure surfaces and does not leak the port", async () => {
  const spawn: SproutFactory = (): SproutChild => ({ exited: new Promise(() => {}), kill() {} }); // never listens
  const pool = makePool(spawn, { readyTimeoutMs: 150 });
  await expect(pool.endpoint("/tmp/app/sprout")).rejects.toThrow("did not listen");
});

test("evictIdle stops servers past the idle window", async () => {
  const { spawn } = fakeSpawn();
  let now = 0;
  const pool = makePool(spawn, { idleMs: 100, now: () => now });
  const { url } = await pool.endpoint("/tmp/app/sprout");
  now = 100;
  expect(pool.evictIdle()).toBe(1);
  await Bun.sleep(10);
  await expect(fetch(url)).rejects.toThrow();
});

test("evictIdle reaps any idle sprout; a still-hot one survives", async () => {
  const { spawn } = fakeSpawn();
  let now = 0;
  const pool = makePool(spawn, { idleMs: 100, now: () => now });
  await pool.endpoint("/tmp/cold/worker");
  now = 90;
  const hot = await pool.endpoint("/tmp/hot/worker"); // used at t=90
  now = 150;                                          // cold idle 150, hot idle 60
  expect(pool.evictIdle()).toBe(1);                   // only the cold one
  expect((await fetch(hot.url)).ok).toBe(true);
});

test("sproutCommand wraps the sprout in the bwrap launcher on Linux, runs it directly off Linux", () => {
  const saved = process.platform;
  const set = (v: string) => Object.defineProperty(process, "platform", { value: v, configurable: true });
  try {
    set("darwin");
    expect(sproutCommand("/x/sprout")).toEqual(["/x/sprout"]);
    set("linux");
    process.env.SPROUTBOAT_SPROUT_SANDBOX_CMD = "/opt/sproutboat/infra/sandbox/sprout-sandbox.sh";
    // The sandboxed path never adds a cgroup wrapper — sprout-sandbox.sh owns
    // the scope. Even with SPROUTBOAT_SPROUT_CGROUP=1 it's just [launcher, path].
    process.env.SPROUTBOAT_SPROUT_CGROUP = "1";
    expect(sproutCommand("/var/lib/sproutboat/artifacts/a/sprout")).toEqual(["/opt/sproutboat/infra/sandbox/sprout-sandbox.sh", "/var/lib/sproutboat/artifacts/a/sprout"]);
    delete process.env.SPROUTBOAT_SPROUT_SANDBOX_CMD;
    process.env.SPROUTBOAT_SPROUT_SANDBOX = "none";
    delete process.env.SPROUTBOAT_SPROUT_CGROUP;
    expect(() => sproutCommand("/x/sprout")).toThrow("refusing to run an untrusted native sprout unsandboxed");

    // The `none` path (trusted local Linux) does wrap in a cgroup scope so a dev
    // run can exercise the limits.
    process.env.SPROUTBOAT_UNSAFE_NO_SANDBOX = "1";
    process.env.SPROUTBOAT_SPROUT_CGROUP = "1";
    process.env.SPROUTBOAT_SPROUT_MEMORY_MAX = "96M";
    expect(sproutCommand("/x/sprout")).toEqual([
      "systemd-run", "--scope", "--quiet", "--collect",
      "-p", "MemoryMax=96M", "-p", "MemorySwapMax=0", "-p", "CPUQuota=50%", "-p", "TasksMax=24", "--", "/x/sprout",
    ]);
    delete process.env.SPROUTBOAT_SPROUT_CGROUP;
    delete process.env.SPROUTBOAT_SPROUT_MEMORY_MAX;
    delete process.env.SPROUTBOAT_UNSAFE_NO_SANDBOX;
    delete process.env.SPROUTBOAT_SPROUT_SANDBOX;
  } finally {
    Object.defineProperty(process, "platform", { value: saved, configurable: true });
  }
});

test("endpoint forwards the secrets path to the spawn factory (#2)", async () => {
  const seen: Array<string | null | undefined> = [];
  const { spawn } = fakeSpawn();
  const spy: SproutFactory = (path, port, secretsPath) => { seen.push(secretsPath); return spawn(path, port); };
  const pool = makePool(spy);
  await pool.endpoint("/tmp/withsecrets/worker", "/var/lib/sproutboat/secrets/u__app.json");
  await pool.endpoint("/tmp/nosecrets/worker");
  expect(seen).toEqual(["/var/lib/sproutboat/secrets/u__app.json", undefined]);
});
