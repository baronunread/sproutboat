import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  boundResourceIds,
  brokerBwrapArgs,
  brokerEnv,
  brokerLaunchCommand,
  nodeModulesOf,
  planBrokerSandbox,
  prepareBrokerHostFiles,
  withoutToken,
  writeBwrapArgsFile,
  type BrokerPlanInput,
} from "./broker-sandbox";
import { ownerDirName, ownerStorageDir, r2BlobName } from "./resource-layout";
import { SproutPool, spawnSprout, verifyBindingCall } from "./run";

const id = (kind: string, n: number) => `${kind}_${n.toString(16).padStart(24, "0")}`;
const roots: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "sb-broker-sandbox-"));
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** Whether bubblewrap works here (Linux with unprivileged user namespaces). */
const bwrapWorks = (() => {
  if (process.platform !== "linux") return false;
  const probe = Bun.spawnSync(["bwrap", "--unshare-user", "--ro-bind", "/", "/", "true"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return probe.exitCode === 0;
})();

type BindingsOverride = {
  crons?: string[];
  services?: Array<{ binding: string; service: string }>;
  resources?: Record<string, { kind: string; id: string }>;
};
type Seen = {
  env: string[];
  resources: string[];
  own: string;
  otherResource: string;
  otherBroker: string;
  brokers: string[];
  platform: string;
  blobs: string[];
  owners: string;
  home: string | string[];
  /** The listing of the directory the Bun binary is in, when that is under /home (CI: /home/runner/.bun/bin). */
  bunDir: string | string[] | null;
};
type TestFrame = { op: string; params?: string[]; headers?: string[][] } & Partial<
  Record<"ns" | "key" | "value" | "db" | "sql" | "bucket" | "queue" | "body" | "binding" | "url" | "method", string>
>;
type Reply = {
  ok: boolean;
  found?: boolean;
  value?: string;
  results?: Array<{ name: string }>;
  status?: number;
  body?: string;
};

function bindings(over: BindingsOverride = {}): string {
  return JSON.stringify({
    kv: ["KV"],
    secrets: [],
    d1: ["DB"],
    r2: ["BUCKET"],
    queues: ["JOBS"],
    queueConfig: [{ binding: "JOBS", queue: "jobs" }],
    analytics: [],
    do: [],
    services: [],
    crons: [],
    ratelimiters: [],
    assets: "",
    resources: {
      KV: { kind: "kv", id: id("kv", 1) },
      DB: { kind: "d1", id: id("d1", 2) },
      BUCKET: { kind: "r2", id: id("r2", 3) },
      JOBS: { kind: "queue", id: id("queue", 4) },
    },
    ...over,
  });
}

/** A deployment laid out like the edge unit's: artifact dir, brokers/<dep>, resources/. */
function layout(bindingsJson = bindings()) {
  const root = scratch();
  const artifact = join(root, "artifacts", "dep-a");
  const stateDir = join(root, "brokers", "dep-a");
  const resourceDir = join(root, "resources");
  for (const dir of [artifact, stateDir, resourceDir]) mkdirSync(dir, { recursive: true });
  const bindingsPath = join(artifact, "bindings.json");
  writeFileSync(bindingsPath, bindingsJson);
  const input: BrokerPlanInput = {
    bun: process.execPath,
    entry: join(import.meta.dir, "broker-main.ts"),
    nodeModules: nodeModulesOf(import.meta.resolve("@sproutboat/wire/broker").replace("file://", "")),
    stateDir,
    resourceDir,
    bindingsPath,
    r2: { ownerId: "owner-a", resourceIds: [id("r2", 3)] },
  };
  return { root, artifact, stateDir, resourceDir, input };
}

describe("what a broker is given", () => {
  test("only the resource files its app is bound to, never the resource directory", () => {
    const { input, resourceDir } = layout();
    const mounts = planBrokerSandbox(input);
    const dests = mounts.map((m) => m.dest);
    for (const n of [id("kv", 1), id("d1", 2), id("r2", 3), id("queue", 4)])
      expect(dests).toContain(join(resourceDir, `${n}.sqlite`));
    // The directory itself, and any other account's file, is not a mount.
    expect(dests).not.toContain(resourceDir);
    expect(
      dests.filter((d) => d.startsWith(resourceDir)).every((d) => /\.sqlite(-wal|-shm)?$|r2-(blobs|parts)$/.test(d)),
    ).toBe(true);
    expect(dests).not.toContain(join(resourceDir, `${id("kv", 99)}.sqlite`));
  });

  test("R2 bodies, parts and the quota ledger come from the owner's own directory", () => {
    const { input, resourceDir } = layout();
    const owner = ownerStorageDir(resourceDir, "owner-a");
    const mounts = planBrokerSandbox(input);
    const mount = (dest: string) => mounts.find((m) => m.dest === join(resourceDir, dest));
    expect(mount("r2-blobs")?.source).toBe(join(owner, "r2-blobs"));
    expect(mount("r2-parts")?.source).toBe(join(owner, "r2-parts"));
    expect(mount("r2-quota.sqlite")?.source).toBe(join(owner, "r2-quota.sqlite"));
    // Two owners never share a directory, and an id is never put in a path as is.
    expect(ownerDirName("owner-a")).not.toBe(ownerDirName("owner-b"));
    expect(ownerDirName("bootstrap:../../etc")).toMatch(/^[0-9a-f]{32}$/);
  });

  test("the node_modules to bind is the outermost one, so an isolated (workspace) install keeps its symlinks", () => {
    // Hoisted layout.
    expect(nodeModulesOf("/srv/app/node_modules/@sproutboat/wire/dist/broker.js")).toBe("/srv/app/node_modules");
    // Isolated layout: the real path is inside the package's private store under node_modules/.bun.
    expect(
      nodeModulesOf("/srv/app/node_modules/.bun/@sproutboat+wire@0.21.4/node_modules/@sproutboat/wire/dist/broker.js"),
    ).toBe("/srv/app/node_modules");
    expect(nodeModulesOf("/srv/app/src/broker.js")).toBeNull();
  });

  test("a malformed or traversing resource id in bindings.json is dropped, not mounted", () => {
    const hostile = bindings({
      resources: {
        KV: { kind: "kv", id: "../../brokers/dep-b/state" },
        DB: { kind: "d1", id: id("d1", 2) },
        X: { kind: "kv", id: `${id("kv", 7)}/../${id("kv", 8)}` },
      },
    });
    const { input, bindingsPath } = (() => {
      const l = layout(hostile);
      return { input: l.input, bindingsPath: l.input.bindingsPath };
    })();
    expect(boundResourceIds(bindingsPath)).toEqual([id("d1", 2)]);
    const sources = planBrokerSandbox(input).map((m) => m.source);
    expect(sources.some((s) => s.includes(".."))).toBe(false);
  });

  test("state is the deployment's own directory, and a Durable Object store only when declared", () => {
    const { input, stateDir, resourceDir } = layout();
    expect(planBrokerSandbox(input).some((m) => m.mode === "rw" && m.source === stateDir)).toBe(true);
    expect(planBrokerSandbox(input).some((m) => m.dest.endsWith(".do-sql"))).toBe(false);
    const doDb = join(resourceDir, "do_0123456789abcdef01234567.sqlite");
    const withDo = planBrokerSandbox({ ...input, doDb }).map((m) => m.dest);
    expect(withDo).toContain(doDb);
    expect(withDo).toContain(join(resourceDir, "do_0123456789abcdef01234567.do-sql"));
  });

  test("code and the artifact's inputs are read only", () => {
    const { input } = layout();
    const mounts = planBrokerSandbox(input);
    for (const m of mounts.filter((m) =>
      [input.bun, input.entry, input.bindingsPath, input.nodeModules].includes(m.source),
    ))
      expect(m.mode).toBe("ro");
  });

  test("the sandbox is a fresh namespace set with no network unshare and no edge environment", () => {
    const { input } = layout();
    const args = brokerBwrapArgs(planBrokerSandbox(input), { PATH: "/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp" });
    for (const flag of [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--clearenv",
      "--die-with-parent",
      "--new-session",
    ])
      expect(args).toContain(flag);
    // The broker listens on loopback for its sprout and calls the edge there.
    expect(args).not.toContain("--unshare-net");
    expect(args.at(-1)).toBe("--");
  });
});

describe("what a broker's environment holds", () => {
  const edgeEnv = {
    PATH: "/opt/x",
    SB_EDGE_SECRET: "edge-wide",
    SB_EGRESS_URL: "http://127.0.0.1:8070",
    SB_EGRESS_TOKEN: "egress-token",
    DATABASE_URL: "postgres://secret",
    BETTER_AUTH_SECRET: "auth-secret",
    SPROUTBOAT_BACKUP_KEY: "backup-key",
    AWS_SECRET_ACCESS_KEY: "aws",
  };

  test("an allowlist: nothing else from the edge's environment, and no shared edge secret", () => {
    const env = brokerEnv(edgeEnv, null, { PATH: "/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "SB_EGRESS_TOKEN", "SB_EGRESS_URL", "TMPDIR"]);
    expect(env.SB_EDGE_SECRET).toBeUndefined();
  });

  test("with a credential, SB_EDGE_SECRET is that credential", () => {
    const env = brokerEnv(edgeEnv, "per-app", { PATH: "/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp" });
    expect(env.SB_EDGE_SECRET).toBe("per-app");
    expect(JSON.stringify(env)).not.toContain("edge-wide");
  });
});

describe("the legacy R2 layout is adopted per owner", () => {
  test("an owner's bodies move into its directory; another owner's stay where they are", () => {
    const { input, resourceDir } = layout();
    const mine = id("r2", 3);
    const theirs = id("r2", 30);
    const blobs = join(resourceDir, "r2-blobs");
    mkdirSync(blobs, { recursive: true });
    for (const [bucket, key] of [
      [mine, "a.txt"],
      [theirs, "b.txt"],
    ] as const) {
      const db = new Database(join(resourceDir, `${bucket}.sqlite`));
      db.exec(
        "CREATE TABLE r2 (bucket TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL, uploaded TEXT NOT NULL, blob_id TEXT, PRIMARY KEY (bucket, key))",
      );
      db.query("INSERT INTO r2 VALUES (?, ?, 1, 'e', 'now', NULL)").run(bucket, key);
      db.close();
      writeFileSync(join(blobs, `${r2BlobName(bucket, key)}.blob`), bucket);
    }
    const mounts = planBrokerSandbox(input);
    prepareBrokerHostFiles(input, mounts);
    prepareBrokerHostFiles(input, mounts); // safe to repeat
    const owner = ownerStorageDir(resourceDir, "owner-a");
    expect(existsSync(join(owner, "r2-blobs", `${r2BlobName(mine, "a.txt")}.blob`))).toBe(true);
    expect(existsSync(join(blobs, `${r2BlobName(mine, "a.txt")}.blob`))).toBe(false);
    expect(readdirSync(blobs)).toEqual([`${r2BlobName(theirs, "b.txt")}.blob`]);
  });
});

describe.skipIf(!bwrapWorks)("inside the sandbox (Linux, bubblewrap)", () => {
  /** Runs a script in the exact sandbox a broker gets, beside other tenants' files on the host. */
  async function probe(env: Record<string, string>) {
    const l = layout();
    // Another account's resource, another deployment's broker state, a platform database.
    writeFileSync(join(l.resourceDir, `${id("kv", 99)}.sqlite`), "other tenant");
    mkdirSync(join(l.root, "brokers", "dep-b"), { recursive: true });
    writeFileSync(join(l.root, "brokers", "dep-b", "state.sqlite"), "other broker");
    writeFileSync(join(l.root, "sproutboat.sqlite"), "platform");
    const otherOwner = ownerStorageDir(l.resourceDir, "owner-b");
    mkdirSync(join(otherOwner, "r2-blobs"), { recursive: true });
    writeFileSync(join(otherOwner, "r2-blobs", "x.blob"), "other owner body");
    const mounts = planBrokerSandbox(l.input);
    prepareBrokerHostFiles(l.input, mounts);
    const at = (...p: string[]) => JSON.stringify(join(l.root, ...p));
    const bunDir = dirname(process.execPath).startsWith("/home/") ? dirname(process.execPath) : null;
    const code = [
      'const fs = require("fs");',
      'const tryRead = (p) => { try { return fs.readFileSync(p, "utf8").slice(0, 40); } catch (e) { return "ERR " + e.code; } };',
      'const ls = (p) => { try { return fs.readdirSync(p).sort(); } catch (e) { return "ERR " + e.code; } };',
      "console.log(JSON.stringify({",
      '  env: Object.keys(process.env).filter((k) => k !== "PWD").sort(),',
      `  resources: ls(${at("resources")}),`,
      `  own: tryRead(${at("resources", `${id("kv", 1)}.sqlite`)}),`,
      `  otherResource: tryRead(${at("resources", `${id("kv", 99)}.sqlite`)}),`,
      `  otherBroker: tryRead(${at("brokers", "dep-b", "state.sqlite")}),`,
      `  brokers: ls(${at("brokers")}),`,
      `  platform: tryRead(${at("sproutboat.sqlite")}),`,
      `  blobs: ls(${at("resources", "r2-blobs")}),`,
      `  owners: ls(${at("resources", "owners")}),`,
      '  home: ls("/home"),',
      `  bunDir: ${JSON.stringify(bunDir)} ? ls(${JSON.stringify(bunDir)}) : null,`,
      `  write: (() => { try { fs.writeFileSync(${at("resources", "planted")}, "x"); return "wrote"; } catch (e) { return "ERR " + e.code; } })(),`,
      "}));",
    ].join("\n");
    const run = Bun.spawn([...brokerBwrapArgs(mounts, env), process.execPath, "-e", code], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin" },
    });
    const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
    expect(await run.exited, err).toBe(0);
    const seen: Seen = JSON.parse(out);
    return { seen, mounts, ...l };
  }

  const runtime = { PATH: "/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp" };

  test("it cannot read another account's resources, another broker's state, or the edge's secrets", async () => {
    const env = brokerEnv(
      { SB_EDGE_SECRET: "edge-wide", BETTER_AUTH_SECRET: "auth", SB_EGRESS_URL: "http://127.0.0.1:8070" },
      "per-app-credential",
      runtime,
    );
    const { seen, mounts, resourceDir } = await probe(env);
    expect(seen.env).toEqual(["HOME", "PATH", "SB_EDGE_SECRET", "SB_EGRESS_URL", "TMPDIR"]);
    expect(String(seen.own)).not.toStartWith("ERR");
    expect(seen.otherResource).toBe("ERR ENOENT");
    expect(seen.otherBroker).toBe("ERR ENOENT");
    expect(seen.brokers).toEqual(["dep-a"]);
    expect(seen.platform).toBe("ERR ENOENT");
    expect(seen.owners).toBe("ERR ENOENT");
    expect(seen.blobs).toEqual([]);
    // Nothing of the host's /home is there beyond the parents of the paths that are bound in (on a CI runner the
    // Bun binary lives in /home/runner/.bun/bin, so /home/runner exists, holding only that path's own directories).
    const under = (dir: string) => [
      ...new Set(
        mounts
          .map((m) => m.dest)
          .filter((dest) => dest.startsWith(`${dir}/`))
          .map((dest) => dest.slice(dir.length + 1).split("/")[0]!),
      ),
    ];
    expect(seen.home).toEqual(under("/home").length > 0 ? under("/home").sort() : "ERR ENOENT");
    if (seen.bunDir !== null) expect(seen.bunDir).toEqual([basename(process.execPath)]);
    // Only its bound files (and their -wal / -shm), plus the owner-mapped R2 paths.
    const listed = seen.resources;
    expect(listed).toContain(`${id("kv", 1)}.sqlite`);
    expect(listed).not.toContain(`${id("kv", 99)}.sqlite`);
    const allowed = /^(kv|d1|r2|queue)_[0-9a-f]{24}\.sqlite(-wal|-shm)?$|^r2-(blobs|parts|quota\.sqlite.*)$/;
    expect(listed.every((name) => allowed.test(name))).toBe(true);
    // Writing beside its files lands in a scratch tree, not on the host.
    expect(existsSync(join(resourceDir, "planted"))).toBe(false);
  });

  test("without a credential there is no SB_EDGE_SECRET at all", async () => {
    const { seen } = await probe(brokerEnv({ SB_EDGE_SECRET: "edge-wide" }, null, runtime));
    expect(seen.env).toEqual(["HOME", "PATH", "TMPDIR"]);
  });
});

describe("a running broker keeps working in the sandbox it is given", () => {
  const modes = bwrapWorks ? (["none", "bwrap"] as const) : (["none"] as const);
  const saved: Record<string, string | undefined> = {};
  const setEnv = (name: string, value: string | undefined) => {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const pools: SproutPool[] = [];
  const servers: Array<{ stop(force?: boolean): void }> = [];
  afterEach(() => {
    for (const pool of pools) pool.disposeAll();
    pools.length = 0;
    for (const server of servers) server.stop(true);
    servers.length = 0;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const standIn = `
import { connect } from "node:net";
const token = process.env.SB_BROKER_TOKEN;
const brokerPort = Number(process.env.SB_BROKER_PORT);
const triggers = [];
const call = (msg) => new Promise((resolve, reject) => {
  const socket = connect({ host: "127.0.0.1", port: brokerPort });
  const payload = Buffer.from(token + "\\n" + JSON.stringify(msg));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.length);
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      socket.end();
      resolve(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString());
    }
  });
  socket.on("error", reject);
  socket.write(Buffer.concat([head, payload]));
});
Bun.serve({
  port: Number(process.env.PORT),
  async fetch(request) {
    const url = new URL(request.url);
    const kind = request.headers.get("x-sb-trigger");
    if (kind) {
      triggers.push({ kind, body: await request.text() });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/triggers") return Response.json(triggers);
    if (url.pathname === "/frame") return new Response(await call(await request.json()));
    return new Response("ok");
  },
});
`;

  async function deploy(
    mode: "none" | "bwrap",
    opts: { services?: Record<string, string>; bindingsJson?: string; dispatchDisabled?: boolean } = {},
  ) {
    const root = scratch();
    const artifact = join(root, "artifacts", "dep-a");
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(artifact, "bindings.json"), opts.bindingsJson ?? bindings());
    writeFileSync(join(artifact, "app.js"), standIn);
    const sprout = join(artifact, "sprout");
    writeFileSync(sprout, `#!/bin/sh\nexec "${process.execPath}" "${join(artifact, "app.js")}"\n`, { mode: 0o755 });
    const resourceDir = join(root, "resources");
    setEnv("SPROUTBOAT_BROKER_STATE_DIR", join(root, "brokers"));
    setEnv("SPROUTBOAT_RESOURCE_DIR", resourceDir);
    setEnv("SPROUTBOAT_SPROUT_SANDBOX", "none");
    setEnv("SPROUTBOAT_UNSAFE_NO_SANDBOX", "1");
    setEnv("SPROUTBOAT_BROKER_SANDBOX", mode);
    const pool = new SproutPool({ spawn: spawnSprout, portRange: [21_000, 21_999], readyTimeoutMs: 20_000 });
    pools.push(pool);
    const endpoint = await pool.endpoint(
      sprout,
      null,
      opts.services ?? null,
      { ownerId: "owner-a", resourceIds: [id("r2", 3)] },
      opts.dispatchDisabled ?? false,
    );
    const frame = async (msg: TestFrame) => {
      const res = await fetch(`${endpoint.url}/frame`, { method: "POST", body: JSON.stringify(msg) });
      const reply: Reply = JSON.parse(await res.text());
      return reply;
    };
    const triggers = async () => {
      const list: Array<{ kind: string; body: string }> = await (await fetch(`${endpoint.url}/triggers`)).json();
      return list;
    };
    const until = async <T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 15_000): Promise<T> => {
      const end = Date.now() + ms;
      for (;;) {
        const value = await read();
        if (done(value) || Date.now() > end) return value;
        await Bun.sleep(100);
      }
    };
    const timed = {
      sproutPath: sprout,
      secretsPath: null,
      services: opts.services ?? null,
      r2: { ownerId: "owner-a", resourceIds: [id("r2", 3)] },
    };
    return { root, resourceDir, pool, endpoint, frame, triggers, until, timed };
  }

  for (const mode of modes) {
    describe(`sandbox mode ${mode}`, () => {
      test("KV, D1, R2 and queues work, and the data lands in the resource files", async () => {
        const d = await deploy(mode);
        expect(await d.frame({ op: "kv.put", ns: "KV", key: "k", value: "v" })).toMatchObject({ ok: true });
        expect(await d.frame({ op: "kv.get", ns: "KV", key: "k" })).toMatchObject({
          ok: true,
          found: true,
          value: "v",
        });
        await d.frame({ op: "d1.exec", db: "DB", sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)" });
        await d.frame({ op: "d1.query", db: "DB", sql: "INSERT INTO t (name) VALUES (?)", params: ["ada"] });
        expect(await d.frame({ op: "d1.query", db: "DB", sql: "SELECT name FROM t", params: [] })).toMatchObject({
          ok: true,
          results: [{ name: "ada" }],
        });
        expect(await d.frame({ op: "r2.put", bucket: "BUCKET", key: "a.txt", body: "hello" })).toMatchObject({
          ok: true,
        });
        expect(await d.frame({ op: "r2.get", bucket: "BUCKET", key: "a.txt" })).toMatchObject({
          ok: true,
          found: true,
          body: "hello",
        });
        expect(await d.frame({ op: "queue.send", queue: "JOBS", body: "job" })).toMatchObject({ ok: true });
        const delivered = await d.until(d.triggers, (t) => t.some((x) => x.kind === "queue"));
        expect(delivered.some((x) => x.kind === "queue" && x.body.includes("job"))).toBe(true);
        // Reopened from disk by a second reader: the files really hold it, in the host's view.
        const kvDb = new Database(join(d.resourceDir, `${id("kv", 1)}.sqlite`), { readonly: true });
        expect(kvDb.query("SELECT value FROM kv WHERE key = 'k'").get()).toEqual({ value: "v" });
        kvDb.close();
        if (mode === "bwrap") {
          const owner = ownerStorageDir(d.resourceDir, "owner-a");
          expect(readdirSync(join(owner, "r2-blobs")).length).toBe(1);
          expect(existsSync(join(d.resourceDir, "r2-blobs"))).toBe(false);
        }
      }, 60_000);

      test("cron fires, and a staged candidate stays quiet until it is enabled", async () => {
        const d = await deploy(mode, {
          bindingsJson: bindings({ crons: ["* * * * *"] }),
          dispatchDisabled: true,
        });
        await d.frame({ op: "queue.send", queue: "JOBS", body: "held" });
        await Bun.sleep(2_500);
        expect(await d.triggers()).toEqual([]);
        await d.pool.reconcileTimed([d.timed]);
        const fired = await d.until(
          d.triggers,
          (t) => t.some((x) => x.kind === "scheduled") && t.some((x) => x.kind === "queue"),
          30_000,
        );
        expect(fired.some((x) => x.kind === "scheduled")).toBe(true);
        expect(fired.some((x) => x.kind === "queue")).toBe(true);
      }, 60_000);

      test("a service-binding call carries this broker's own credential, good only for the hosts it may call", async () => {
        const seen: Array<{ host: string; secret: string | null; url: string | null }> = [];
        const edge = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch(request) {
            const host = request.headers.get("host") ?? "";
            seen.push({ host, secret: request.headers.get("x-sb-edge-secret"), url: request.headers.get("x-sb-url") });
            return new Response("callee says hi");
          },
        });
        servers.push(edge);
        setEnv("SPROUTBOAT_EDGE_URL", `http://127.0.0.1:${edge.port}`);
        const d = await deploy(mode, {
          services: { PEER: "peer.test" },
          bindingsJson: bindings({ services: [{ binding: "PEER", service: "peer" }] }),
        });
        const reply = await d.frame({
          op: "service.fetch",
          binding: "PEER",
          url: "https://peer.test/hello",
          method: "GET",
          headers: [],
        });
        expect(reply).toMatchObject({ ok: true, status: 200 });
        expect(seen).toHaveLength(1);
        const credential = seen[0]!.secret ?? "";
        expect(seen[0]!.host).toBe("peer.test");
        expect(credential).toMatch(/^[0-9a-f]{48}$/);
        // Verified by the edge for that host, and for no other.
        expect(verifyBindingCall(credential, "peer.test")).toBe(true);
        expect(verifyBindingCall(credential, "PEER.test:8080")).toBe(true);
        expect(verifyBindingCall(credential, "victim.test")).toBe(false);
        // It dies with the broker.
        d.pool.disposeAll();
        expect(verifyBindingCall(credential, "peer.test")).toBe(false);
      }, 60_000);
    });
  }
});

describe("broker secrets stay out of the process command line", () => {
  const TOKEN = "tok-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const EDGE = "edge-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const EGRESS = "egress-cccccccccccccccccccccccccccccccccccccccccccccc";
  const runtime = { PATH: "/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp" };
  const payload = [process.execPath, "--smol", "/x/broker-main.ts", "--token", TOKEN, "--port", "9"];

  test("withoutToken drops the flag and its value only", () => {
    expect(withoutToken(payload).slice(-3)).toEqual(["/x/broker-main.ts", "--port", "9"]);
    expect(withoutToken(["a", "b"])).toEqual(["a", "b"]);
  });

  test("the launch command holds none of the secrets; the options file holds them", () => {
    const dir = scratch();
    const file = join(dir, "bwrap.args");
    const env = { ...brokerEnv({ SB_EGRESS_TOKEN: EGRESS }, EDGE, runtime), SB_BROKER_TOKEN: TOKEN };
    const bwrapArgv = brokerBwrapArgs([], env);
    writeBwrapArgsFile(file, bwrapArgv);
    const command = brokerLaunchCommand(file, withoutToken(payload), "/usr/bin/bwrap");
    for (const secret of [TOKEN, EDGE, EGRESS]) {
      expect(command.join(" ")).not.toContain(secret);
      expect(readFileSync(file, "utf8")).toContain(secret);
    }
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").endsWith("\0")).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain("--\0");
  });

  test.skipIf(process.platform !== "linux")(
    "bash hands the options to bwrap on a descriptor and deletes the file",
    async () => {
      const dir = scratch();
      const fake = join(dir, "bwrap");
      writeFileSync(fake, '#!/bin/bash\nprintf "ARGV:%s\\n" "$*"\ntr "\\0" "\\n" < "/dev/fd/$2"\n', { mode: 0o755 });
      const file = join(dir, "bwrap.args");
      const env = { ...brokerEnv({ SB_EGRESS_TOKEN: EGRESS }, EDGE, runtime), SB_BROKER_TOKEN: TOKEN };
      writeBwrapArgsFile(file, brokerBwrapArgs([], env));
      const run = Bun.spawn(brokerLaunchCommand(file, ["/bin/true", "--port", "9"], fake), {
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: "/usr/bin:/bin" },
      });
      const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
      expect(await run.exited, err).toBe(0);
      const [argvLine, ...fromFd] = out.split("\n");
      expect(argvLine).toMatch(/^ARGV:--args \d+ -- \/bin\/true --port 9$/);
      for (const secret of [TOKEN, EDGE, EGRESS]) {
        expect(argvLine).not.toContain(secret);
      }
      expect(fromFd).toContain("--unshare-user");
      expect(fromFd).toContain("SB_BROKER_TOKEN");
      expect(fromFd).toContain(TOKEN);
      expect(existsSync(file)).toBe(false);
    },
  );
});
