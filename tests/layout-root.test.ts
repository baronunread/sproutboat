import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, chownSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerDir } from "../apps/control/src/artifact-layout";

// The installer runs the layout tool as root over an install owned by two service users and a shared group.
// This builds the ownership and modes of a real 0.14.0 host (numeric ids that need not exist) and checks that
// the tool keeps every owner. Needs root on Linux (chown); CI runs it under sudo, see .github/workflows/ci.yml.
const CONTROL = 61001;
const EDGE = 61002;
const GROUP = 61000;
const TOOL = join(import.meta.dir, "..", "apps/control/src/artifact-layout.ts");

const A = "a".repeat(64); // active, u1, with broker state and a log
const C = "c".repeat(64); // inactive older deployment of u1
const B = "b".repeat(64); // shared by u1 and u2

let state: string;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "sb-layout-root-"));
  chmodSync(state, 0o755);
});
afterEach(() => {
  rmSync(state, { recursive: true, force: true });
});

const at = (...parts: string[]) => join(state, ...parts);

function dir(path: string, uid: number, mode: number): void {
  mkdirSync(path, { recursive: true });
  chownSync(path, uid, GROUP);
  chmodSync(path, mode);
}
function file(path: string, uid: number, mode: number, content: string): void {
  writeFileSync(path, content);
  chownSync(path, uid, GROUP);
  chmodSync(path, mode);
}

function build(): void {
  dir(at("logs"), EDGE, 0o770);
  dir(at("logs", "sprouts"), EDGE, 0o755);
  dir(at("brokers"), EDGE, 0o2770);
  dir(at("artifacts"), CONTROL, 0o750);
  dir(at("resources"), EDGE, 0o2770);
  for (const digest of [A, C, B]) {
    const artifact = at("artifacts", digest);
    dir(artifact, CONTROL, 0o750);
    file(join(artifact, "sprout"), CONTROL, 0o555, `binary ${digest.slice(0, 1)}`);
    dir(join(artifact, "assets"), CONTROL, 0o750);
    file(join(artifact, "assets", "a.txt"), CONTROL, 0o640, "asset");
    if (digest === C) continue;
    dir(at("brokers", digest), EDGE, 0o2770);
    dir(at("brokers", digest, "d1"), EDGE, 0o2770);
    file(at("brokers", digest, "d1", "x.sqlite"), EDGE, 0o660, "state");
    file(at("logs", "sprouts", `${digest}.log`), EDGE, 0o660, `log ${digest.slice(0, 1)}\n`);
  }
  const db = new Database(at("sproutboat.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE deployments (id TEXT PRIMARY KEY, owner_id TEXT, project TEXT, username TEXT,
    hostname TEXT, artifact_digest TEXT, sprout_path TEXT, deployed_at TEXT, active INTEGER)`);
  const rows: Array<[string, string, string, string, number]> = [
    ["d1", "u1", "a.alice.test", A, 1],
    ["d2", "u1", "a.alice.test", C, 0],
    ["d3", "u1", "b.alice.test", B, 1],
    ["d4", "u2", "b.bob.test", B, 1],
  ];
  for (const [id, owner, host, digest, active] of rows) {
    db.run("INSERT INTO deployments VALUES (?, ?, 'app', 'x', ?, ?, ?, 'x', ?)", [
      id,
      owner,
      host,
      digest,
      at("artifacts", digest, "sprout"),
      active,
    ]);
  }
  db.close();
  chownSync(at("sproutboat.sqlite"), CONTROL, GROUP);
  chmodSync(at("sproutboat.sqlite"), 0o600);
  const routes = [
    { hostname: "a.alice.test", ownerId: "u1", sproutPath: at("artifacts", A, "sprout") },
    { hostname: "b.bob.test", ownerId: "u2", sproutPath: at("artifacts", B, "sprout") },
  ];
  file(at("routes.json"), CONTROL, 0o640, `${JSON.stringify(routes)}\n`);
}

/** Every entry under the state dir: relative path -> uid:gid:mode. */
function owners() {
  const out: Record<string, string> = {};
  const walk = (path: string, rel: string) => {
    const info = lstatSync(path);
    out[rel] = `${info.uid}:${info.gid}:${(info.mode & 0o7777).toString(8)}`;
    if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name), `${rel}/${name}`);
  };
  walk(state, "");
  return out;
}
const of = (...parts: string[]) => owners()[`/${parts.join("/")}`];

async function tool(command: string): Promise<string> {
  const child = Bun.spawn([process.execPath, TOOL, command], {
    env: {
      ...process.env,
      SPROUTBOAT_DATABASE_PATH: at("sproutboat.sqlite"),
      SPROUTBOAT_ARTIFACTS_DIR: at("artifacts"),
      SPROUTBOAT_BROKER_STATE_DIR: at("brokers"),
      SPROUTBOAT_LOG_PATH: at("logs", "requests.ndjson"),
      SPROUTBOAT_ROUTE_SNAPSHOT: at("routes.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ command, code, err }).toEqual({ command, code: 0, err: "" });
  return out;
}

const control = (mode: string) => `${CONTROL}:${GROUP}:${mode}`;
const edge = (mode: string) => `${EDGE}:${GROUP}:${mode}`;

test.skipIf(process.getuid?.() !== 0 || process.platform !== "linux")(
  "migrate and revert keep every owner and mode",
  async () => {
    build();
    const before = owners();

    await tool("migrate");
    const after = owners();
    const u1 = ownerDir("u1");
    const u2 = ownerDir("u2");

    // Everything moved.
    for (const digest of [A, C, B]) expect(after[`/artifacts/${digest}`]).toBeUndefined();
    for (const digest of [A, B]) {
      expect(after[`/brokers/${digest}`]).toBeUndefined();
      expect(after[`/logs/sprouts/${digest}.log`]).toBeUndefined();
    }
    // Account directories: owned like the artifacts root, 0750.
    expect(of("artifacts", u1)).toBe(control("750"));
    expect(of("artifacts", u2)).toBe(control("750"));
    // Moved entries keep owner and mode; so do the copies, entry by entry.
    for (const [owner, digest] of [
      ["u1", A],
      ["u1", C],
      ["u1", B],
      ["u2", B],
    ] as const) {
      const root = ["artifacts", ownerDir(owner), digest];
      expect(of(...root)).toBe(control("750"));
      expect(of(...root, "sprout")).toBe(control("555"));
      expect(of(...root, "assets")).toBe(control("750"));
      expect(of(...root, "assets", "a.txt")).toBe(control("640"));
    }
    for (const [owner, digest] of [
      ["u1", A],
      ["u1", B],
      ["u2", B],
    ] as const) {
      const root = ["brokers", `${ownerDir(owner)}-${digest}`];
      expect(of(...root)).toBe(edge("2770"));
      expect(of(...root, "d1")).toBe(edge("2770"));
      expect(of(...root, "d1", "x.sqlite")).toBe(edge("660"));
      expect(of("logs", "sprouts", `${ownerDir(owner)}-${digest}.log`)).toBe(edge("660"));
    }
    // The database and the route snapshot keep their owner and mode; no sidecar is left owned by root.
    expect(of("sproutboat.sqlite")).toBe(control("600"));
    expect(of("routes.json")).toBe(control("640"));
    for (const [name, owner] of Object.entries(after)) {
      if (name.startsWith("/sproutboat.sqlite-")) expect({ name, owner }).toEqual({ name, owner: control("600") });
    }
    expect(Object.keys(after).filter((name) => name.endsWith(".migrating"))).toEqual([]);

    expect((await tool("check")).trim()).toBe("layout: per-account");

    await tool("revert");
    const reverted = owners();
    // Every entry that existed before has its owner and mode again; the kept per-account copy of the
    // shared digest is the only addition.
    for (const [name, owner] of Object.entries(before))
      expect({ name, owner: reverted[name] }).toEqual({ name, owner });
    for (const name of Object.keys(reverted)) {
      if (!(name in before)) expect(name).toContain(u2);
    }
    expect(of("sproutboat.sqlite")).toBe(control("600"));
    expect(of("routes.json")).toBe(control("640"));
  },
);
