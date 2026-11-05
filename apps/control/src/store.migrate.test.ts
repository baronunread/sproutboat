import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A database created by 0.13.0 / 0.13.1 (main before Community went supervisor-only): the schema a fresh install had,
// plus the four sproutd columns. Opening it with this release must keep every row and drop the columns.

let dir: string;
let store: typeof import("./store") | undefined;

function seed(path: string, sproutd: boolean): void {
  const database = new Database(path);
  database.exec(`
    CREATE TABLE artifacts (digest TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE projects (
      owner_id TEXT NOT NULL, name TEXT NOT NULL, username TEXT NOT NULL, created_at TEXT NOT NULL,
      runtime TEXT NOT NULL DEFAULT 'supervisor', runtime_limits TEXT,
      PRIMARY KEY (owner_id, name)
    );
    CREATE TABLE deployments (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project TEXT NOT NULL, username TEXT NOT NULL,
      hostname TEXT NOT NULL, artifact_digest TEXT NOT NULL REFERENCES artifacts(digest),
      sprout_path TEXT NOT NULL, deployed_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0,
      binary_size INTEGER, compile_ms INTEGER, sproutd_vid TEXT, fallback_reason TEXT,
      FOREIGN KEY (owner_id, project) REFERENCES projects(owner_id, name) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX one_active_deployment_per_project ON deployments(owner_id, project) WHERE active = 1;
    CREATE INDEX deployments_by_owner ON deployments(owner_id);
    CREATE INDEX deployments_by_artifact ON deployments(artifact_digest);
  `);
  const digest = "a".repeat(64);
  database.run("INSERT INTO artifacts VALUES (?, ?)", [digest, "2026-11-01T00:00:00.000Z"]);
  database.run("INSERT INTO projects (owner_id, name, username, created_at) VALUES ('u1', 'app', 'alice', 'x')");
  database.run(
    "INSERT INTO deployments (id, owner_id, project, username, hostname, artifact_digest, sprout_path, deployed_at, active, fallback_reason) VALUES ('d1', 'u1', 'app', 'alice', 'app.alice.test', ?, '/s', 'x', 1, 'abi_rejected: old')",
    [digest],
  );
  if (sproutd) {
    database.run(
      "INSERT INTO projects (owner_id, name, username, created_at, runtime) VALUES ('u1', 'edge', 'alice', 'x', 'sproutd')",
    );
  }
  database.close();
}

async function open(sproutd: boolean): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "sb-migrate-"));
  const path = join(dir, "control.sqlite");
  seed(path, sproutd);
  process.env.SPROUTBOAT_DATABASE_PATH = path;
  process.env.SPROUTBOAT_ROUTE_SNAPSHOT = join(dir, "routes.json");
  process.env.SPROUTBOAT_ARTIFACTS_DIR = join(dir, "artifacts");
  process.env.SPROUTBOAT_DEPLOYMENTS_PATH = join(dir, "deployments.json");
  store = await import("./store");
  return path;
}

const columns = (path: string, table: string): string[] => {
  const database = new Database(path, { readonly: true });
  // SAFETY: PRAGMA table_info rows always expose a string `name` column.
  const names = (database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  database.close();
  return names;
};

afterEach(async () => {
  store?.closeStore();
  store = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("a 0.13.x database upgrades: sproutd columns dropped, deployments kept", async () => {
  const path = await open(false);
  expect(store?.projectDeployments("u1", "app").map((d) => [d.id, d.active])).toEqual([["d1", true]]);
  store?.closeStore();
  expect(columns(path, "projects")).not.toContain("runtime");
  expect(columns(path, "projects")).not.toContain("runtime_limits");
  expect(columns(path, "deployments")).not.toContain("sproutd_vid");
  expect(columns(path, "deployments")).not.toContain("fallback_reason");
  expect(columns(path, "deployments")).toContain("compile_ms");
  // A second start is a no-op.
  store = await import("./store");
  expect(store.projectDeployments("u1", "app")).toHaveLength(1);
});

test("a database that holds a sproutd project keeps its columns and warns", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const path = await open(true);
  expect(store?.projectDeployments("u1", "app")).toHaveLength(1);
  store?.closeStore();
  expect(columns(path, "projects")).toContain("runtime");
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});

// An install from before artifacts were namespaced by owner: one digest directory, one broker-state
// directory and one log, shared by two accounts that uploaded identical bytes.
test("shared legacy artifact dirs are split per owner, once", async () => {
  const { chmod, mkdir, readdir, readFile, stat, writeFile } = await import("node:fs/promises");
  const log = spyOn(console, "log").mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), "sb-layout-"));
  const path = join(dir, "control.sqlite");
  seed(path, false);
  const digest = "a".repeat(64);
  const legacy = join(dir, "artifacts", digest);
  await mkdir(join(legacy, "assets"), { recursive: true });
  await writeFile(join(legacy, "sprout"), "binary");
  await chmod(join(legacy, "sprout"), 0o555);
  await writeFile(join(legacy, "assets", "a.txt"), "asset");
  await mkdir(join(dir, "brokers", digest, "d1"), { recursive: true });
  await writeFile(join(dir, "brokers", digest, "d1", "x.sqlite"), "state");
  await mkdir(join(dir, "logs", "sprouts"), { recursive: true });
  await writeFile(join(dir, "logs", "sprouts", `${digest}.log`), "shared log\n");
  const database = new Database(path);
  database.run("INSERT INTO projects (owner_id, name, username, created_at) VALUES ('u2', 'app', 'bob', 'x')");
  database.run(
    "INSERT INTO deployments (id, owner_id, project, username, hostname, artifact_digest, sprout_path, deployed_at, active) VALUES ('d2', 'u2', 'app', 'bob', 'app.bob.test', ?, ?, 'x', 1)",
    [digest, join(legacy, "sprout")],
  );
  database.run("UPDATE deployments SET sprout_path = ? WHERE id = 'd1'", [join(legacy, "sprout")]);
  database.close();
  process.env.SPROUTBOAT_DATABASE_PATH = path;
  process.env.SPROUTBOAT_ROUTE_SNAPSHOT = join(dir, "routes.json");
  process.env.SPROUTBOAT_ARTIFACTS_DIR = join(dir, "artifacts");
  process.env.SPROUTBOAT_DEPLOYMENTS_PATH = join(dir, "deployments.json");
  process.env.SPROUTBOAT_BROKER_STATE_DIR = join(dir, "brokers");
  process.env.SPROUTBOAT_LOG_PATH = join(dir, "logs", "requests.ndjson");
  store = await import("./store");
  store.projectDeployments("u1", "app"); // opens the store, which migrates
  await store.syncRoutes(); // queued behind the sync the migration scheduled

  const dirs = { u1: store.artifactOwnerDir("u1"), u2: store.artifactOwnerDir("u2") };
  expect(dirs.u1).not.toBe(dirs.u2);
  for (const owner of ["u1", "u2"] as const) {
    const root = join(dir, "artifacts", dirs[owner], digest);
    expect(await readFile(join(root, "sprout"), "utf8")).toBe("binary");
    expect(await readFile(join(root, "assets", "a.txt"), "utf8")).toBe("asset");
    expect((await stat(join(root, "sprout"))).mode & 0o777).toBe(0o555);
    expect(await readFile(join(dir, "brokers", `${dirs[owner]}-${digest}`, "d1", "x.sqlite"), "utf8")).toBe("state");
    expect(await readFile(join(dir, "logs", "sprouts", `${dirs[owner]}-${digest}.log`), "utf8")).toBe("shared log\n");
    expect(store.projectDeployments(owner, "app")[0]?.sproutPath).toBe(join(root, "sprout"));
  }
  // The legacy ones are gone.
  expect((await readdir(join(dir, "artifacts"))).sort()).toEqual([dirs.u1, dirs.u2].sort());
  expect((await readdir(join(dir, "brokers"))).sort()).toEqual([`${dirs.u1}-${digest}`, `${dirs.u2}-${digest}`].sort());
  expect((await readdir(join(dir, "logs", "sprouts"))).sort()).toEqual(
    [`${dirs.u1}-${digest}.log`, `${dirs.u2}-${digest}.log`].sort(),
  );
  // routes.json carries the new paths.
  // SAFETY: routes.json is the Route[] snapshot written by syncRoutes.
  const routes = JSON.parse(await readFile(join(dir, "routes.json"), "utf8")) as Array<{ sproutPath: string }>;
  expect(routes.map((route) => route.sproutPath).sort()).toEqual(
    [join(dir, "artifacts", dirs.u1, digest, "sprout"), join(dir, "artifacts", dirs.u2, digest, "sprout")].sort(),
  );
  // The artifacts table is keyed by owner now, and re-running changes nothing.
  expect(store.migrateArtifactLayout()).toBe(false);
  const messages = log.mock.calls.length;
  store.closeStore();
  store = await import("./store");
  store.projectDeployments("u1", "app");
  expect(log.mock.calls.length).toBe(messages);
  expect(columns(path, "artifacts")).toEqual(["owner_id", "digest", "created_at"]);
  log.mockRestore();
  delete process.env.SPROUTBOAT_BROKER_STATE_DIR;
  delete process.env.SPROUTBOAT_LOG_PATH;
});
