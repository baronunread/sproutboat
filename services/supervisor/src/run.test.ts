import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SproutPool, brokerArgs, spawnSprout, startupFilePath } from "./run";
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
afterEach(() => {
  for (const p of pools) p.disposeAll();
  pools.length = 0;
});
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
  expect(await (await fetch(a.url)).text()).toContain("/tmp/app/sprout");
});

test("staged candidate is listener-ready without broker dispatch until promotion (#141)", async () => {
  const { spawn } = fakeSpawn();
  let dispatchEnabled = 0;
  const stagedSpawn: SproutFactory = (path, port, secrets, services, dispatchDisabled) => {
    expect(dispatchDisabled).toBe(true);
    return { ...spawn(path, port, secrets, services), enableDispatch: () => dispatchEnabled++ };
  };
  const pool = makePool(stagedSpawn);
  const id = "11111111-1111-4111-8111-111111111111";
  const endpoint = await pool.stageCandidate({ id, sproutPath: "/tmp/candidate/sprout" });
  expect((await fetch(endpoint.url)).ok).toBe(true); // TCP/listener proof only
  expect(dispatchEnabled).toBe(0);
  pool.promoteCandidate(id);
  expect(dispatchEnabled).toBe(1);
});

test("staged candidates with a rotated secrets generation never reuse a stale runtime (#141)", async () => {
  const { spawn, servers } = fakeSpawn();
  const pool = makePool(spawn);
  const common = { sproutPath: "/tmp/candidate/sprout", secretsPath: "/tmp/secrets/app.json" };
  await pool.stageCandidate({ id: "55555555-5555-4555-8555-555555555555", ...common, secretsHash: "old" });
  await pool.stageCandidate({ id: "66666666-6666-4666-8666-666666666666", ...common, secretsHash: "new" });
  expect(servers.size).toBe(2);
  pool.discardCandidate("55555555-5555-4555-8555-555555555555");
  pool.discardCandidate("66666666-6666-4666-8666-666666666666");
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
  await pool.endpoint("/tmp/a/sprout"); // restart
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
  now = 150; // cold idle 150, hot idle 60
  expect(pool.evictIdle()).toBe(1); // only the cold one
  expect((await fetch(hot.url)).ok).toBe(true);
});

test("active timed routes start without HTTP traffic and survive HTTP idle eviction (#142)", async () => {
  const { spawn, servers } = fakeSpawn();
  let now = 0;
  const pool = makePool(spawn, { idleMs: 100, now: () => now });

  // This models edge boot: only the active route snapshot selects timer-driven
  // deployments, so there has been no request to this sprout.
  await pool.reconcileTimed([{ sproutPath: "/tmp/timer/sprout" }]);
  expect(servers.size).toBe(1);
  now = 10_000;
  expect(pool.evictIdle()).toBe(0);
  expect(pool.stats().live).toBe(1);
});

test("a timed route generation switch stops the old dispatcher and starts only the active one (#142)", async () => {
  const { spawn, servers } = fakeSpawn();
  const pool = makePool(spawn);
  await pool.reconcileTimed([{ sproutPath: "/tmp/old/sprout" }]);
  expect(servers.size).toBe(1);

  // This models an atomic routes.json promotion while the node receives no HTTP.
  await pool.reconcileTimed([{ sproutPath: "/tmp/new/sprout" }]);
  expect(servers.size).toBe(1);
  expect(pool.stats().portsInUse).toBe(1);
  const active = await pool.endpoint("/tmp/new/sprout");
  expect((await fetch(active.url)).ok).toBe(true);
});

test("a timed sprout crash is restarted without needing an HTTP request (#142)", async () => {
  const { spawn, servers, crash } = fakeSpawn();
  const pool = makePool(spawn);
  await pool.reconcileTimed([{ sproutPath: "/tmp/timer/sprout" }]);
  const first = await pool.endpoint("/tmp/timer/sprout");
  crash(Number(new URL(first.url).port));

  // The timed lifecycle retries after a short capped backoff rather than
  // waiting for traffic that might never arrive.
  await Bun.sleep(350);
  expect(servers.size).toBe(1);
  expect(pool.stats().spawns).toBe(2);
});

test("runtime contexts do not share a sprout and removal releases every port (#142)", async () => {
  const { spawn, servers } = fakeSpawn();
  const pool = makePool(spawn);
  await pool.reconcileTimed([
    { sproutPath: "/tmp/shared/sprout", secretsPath: "/tmp/secrets/a.json", services: { API: "a.test" } },
    { sproutPath: "/tmp/shared/sprout", secretsPath: "/tmp/secrets/b.json", services: { API: "b.test" } },
  ]);
  expect(servers.size).toBe(2);
  expect(pool.stats().portsInUse).toBe(2);
  pool.dispose("/tmp/shared/sprout");
  expect(servers.size).toBe(0);
  expect(pool.stats().portsInUse).toBe(0);
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
    expect(sproutCommand("/var/lib/sproutboat/artifacts/a/sprout")).toEqual([
      "/opt/sproutboat/infra/sandbox/sprout-sandbox.sh",
      "/var/lib/sproutboat/artifacts/a/sprout",
    ]);
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
      "systemd-run",
      "--scope",
      "--quiet",
      "--collect",
      "-p",
      "MemoryMax=96M",
      "-p",
      "MemorySwapMax=0",
      "-p",
      "CPUQuota=50%",
      "-p",
      "TasksMax=24",
      "--",
      "/x/sprout",
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
  const spy: SproutFactory = (path, port, secretsPath) => {
    seen.push(secretsPath);
    return spawn(path, port);
  };
  const pool = makePool(spy);
  await pool.endpoint("/tmp/withsecrets/worker", "/var/lib/sproutboat/secrets/u__app.json");
  await pool.endpoint("/tmp/nosecrets/worker");
  expect(seen).toEqual(["/var/lib/sproutboat/secrets/u__app.json", undefined]);
});

/**
 * An artifact that cannot be executed — a truncated upload, a foreign
 * architecture, a seeded placeholder — used to make `Bun.spawn` throw
 * synchronously out of `spawnSprout`. Nothing caught it, so one request to one
 * bad deployment killed the edge process and took every other tenant with it.
 *
 * The failure mode itself is platform-dependent: macOS's posix_spawn throws
 * ENOEXEC synchronously out of Bun.spawn (what spawnSprout's try/catch
 * resolves to exit 1); Linux's posix_spawn instead forks unconditionally and
 * lets the failed exec inside the child report itself via a 127 exit, the
 * traditional shell "exec failed" convention — Bun.spawn never throws there
 * at all. Assert the invariant that holds on both: it does not throw out of
 * spawnSprout, and it resolves to *some* non-zero exit — not the specific
 * number either platform's own error-reporting convention happens to pick.
 */
test("an unexecutable artifact fails its own request, it does not throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-noexec-"));
  const sproutPath = join(dir, "sprout");
  // Executable bit set, but not a runnable image: posix_spawn gives ENOEXEC.
  writeFileSync(sproutPath, "\x7fELF this is not a real binary", { mode: 0o755 });
  try {
    const child = spawnSprout(sproutPath, 45_998);
    expect(await child.exited).not.toBe(0);
    child.kill();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#freePort skips a port another process already holds (#flaky-ci)", async () => {
  // Stand in for the "second supervisor / stray test server" case that made CI
  // fail with "Failed to start server. Is port N in use?": occupy one port and
  // pin the range to it, so the allocator has no other choice but to reject it.
  const squatter = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const taken = squatter.port;
  try {
    const { spawn } = fakeSpawn();
    const pool = new SproutPool({ spawn, portRange: [taken, taken] });
    await expect(pool.endpoint("/tmp/app/sprout")).rejects.toThrow(/no free sprout port available/);
  } finally {
    squatter.stop(true);
  }
});

test("the broker is told where its sprout is, so cron and queues actually run (#81, #82)", () => {
  const args = brokerArgs({
    entry: "/opt/sproutboat/broker.ts",
    brokerPort: 14_321,
    token: "deadbeef",
    stateDir: "/var/lib/sproutboat/brokers/abc",
    resourceDir: "/var/lib/sproutboat/resources",
    bindingsPath: "/var/lib/sproutboat/artifacts/abc/bindings.json",
    sproutPort: 4321,
  });
  // The broker starts its cron scheduler and queue consumer only when it knows
  // its sprout's URL. Lose this pair and requests keep serving while every
  // scheduled and queued job silently stops — the failure nothing alerts on.
  const flag = args.indexOf("--sprout-url");
  expect(flag).toBeGreaterThan(-1);
  expect(args[flag + 1]).toBe("http://127.0.0.1:4321/");
  expect(args).toContain("--bindings");
  expect(args).toContain("--resource-dir");
});

test("brokerArgs adds secrets and assets only when there are any", () => {
  const base = {
    entry: "/broker.ts",
    brokerPort: 1,
    token: "t",
    stateDir: "/state",
    resourceDir: "/resources",
    bindingsPath: "/bindings.json",
    sproutPort: 2,
  };
  expect(brokerArgs(base)).not.toContain("--secrets");
  expect(brokerArgs(base)).not.toContain("--assets-dir");

  const full = brokerArgs({ ...base, secretsPath: "/secrets/app.json", assetsDir: "/artifact/assets" });
  expect(full[full.indexOf("--secrets") + 1]).toBe("/secrets/app.json");
  expect(full[full.indexOf("--assets-dir") + 1]).toBe("/artifact/assets");
});

test("brokerArgs carries service bindings only when it also knows the edge (#48)", () => {
  const base = {
    entry: "/opt/sproutboat/broker.ts",
    brokerPort: 14_321,
    token: "deadbeef",
    stateDir: "/var/lib/sproutboat/brokers/abc",
    resourceDir: "/var/lib/sproutboat/resources",
    bindingsPath: "/var/lib/sproutboat/artifacts/abc/bindings.json",
    sproutPort: 4321,
  };
  const full = brokerArgs({ ...base, services: { API: "api.alice.test" }, edgeUrl: "http://127.0.0.1:8080/" });
  expect(full).toContain("--services");
  expect(full[full.indexOf("--services") + 1]).toBe('{"API":"api.alice.test"}');
  expect(full[full.indexOf("--edge-url") + 1]).toBe("http://127.0.0.1:8080/");

  // Half the pair is a misconfiguration, not a partial feature: a broker told
  // about bindings but not where to send them would fail every call at runtime.
  expect(brokerArgs({ ...base, services: { API: "api.alice.test" } })).not.toContain("--services");
  expect(brokerArgs({ ...base, edgeUrl: "http://127.0.0.1:8080/" })).not.toContain("--edge-url");
  expect(brokerArgs({ ...base, services: {}, edgeUrl: "http://127.0.0.1:8080/" })).not.toContain("--services");
});
