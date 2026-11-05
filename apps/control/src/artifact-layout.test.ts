import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LayoutPaths,
  legacySproutPath,
  migrate,
  ownedSproutPath,
  ownerDir,
  pathsFromEnv,
  pending,
  revert,
  verifyCopy,
} from "./artifact-layout";

const A = "a".repeat(64); // one owner (u1)
const B = "b".repeat(64); // shared by u1 and u2
const C = "c".repeat(64); // an older, inactive deployment of u1
const TOOL = join(import.meta.dir, "artifact-layout.ts");

let dir: string;
let paths: LayoutPaths;
let lines: string[];
const log = (line: string) => lines.push(line);

const envFor = (root: string) => ({
  SPROUTBOAT_DATABASE_PATH: join(root, "sproutboat.sqlite"),
  SPROUTBOAT_ARTIFACTS_DIR: join(root, "artifacts"),
  SPROUTBOAT_BROKER_STATE_DIR: join(root, "brokers"),
  SPROUTBOAT_LOG_PATH: join(root, "logs", "requests.ndjson"),
  SPROUTBOAT_ROUTE_SNAPSHOT: join(root, "routes.json"),
});

type Seed = { id: string; owner: string; digest: string; host: string; active: number };
const FIRST: Seed = { id: "d1", owner: "u1", digest: A, host: "a.alice.test", active: 1 };
const ROWS: Seed[] = [
  FIRST,
  { id: "d2", owner: "u1", digest: B, host: "b.alice.test", active: 1 },
  { id: "d3", owner: "u2", digest: B, host: "b.bob.test", active: 1 },
  { id: "d4", owner: "u1", digest: C, host: "a.alice.test", active: 0 },
];

function seed(rows: Seed[], column = "sprout_path"): void {
  const db = new Database(paths.database);
  db.exec(`CREATE TABLE deployments (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project TEXT NOT NULL, username TEXT NOT NULL,
    hostname TEXT NOT NULL, artifact_digest TEXT NOT NULL, ${column} TEXT NOT NULL,
    deployed_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0)`);
  for (const row of rows) {
    db.run(`INSERT INTO deployments VALUES (?, ?, 'app', 'x', ?, ?, ?, 'x', ?)`, [
      row.id,
      row.owner,
      row.host,
      row.digest,
      legacySproutPath(paths, row.digest),
      row.active,
    ]);
  }
  db.close();
}

/** The legacy artifact dir, broker state and log of one digest. */
function legacyEntries(digest: string): void {
  const artifact = join(paths.artifacts, digest);
  mkdirSync(join(artifact, "assets"), { recursive: true });
  writeFileSync(join(artifact, "sprout"), `binary ${digest.slice(0, 1)}`);
  chmodSync(join(artifact, "sprout"), 0o555);
  writeFileSync(join(artifact, "assets", "a.txt"), "asset");
  mkdirSync(join(paths.brokers, digest, "d1"), { recursive: true });
  writeFileSync(join(paths.brokers, digest, "d1", "x.sqlite"), "state");
  mkdirSync(paths.sproutLogs, { recursive: true });
  writeFileSync(join(paths.sproutLogs, `${digest}.log`), `log ${digest.slice(0, 1)}\n`);
}

const ROUTES = [
  { hostname: "a.alice.test", sproutPath: "", port: 1, extra: { keep: true } },
  { hostname: "b.alice.test", ownerId: "u1", sproutPath: "", port: 2 },
  { hostname: "b.bob.test", sproutPath: "", port: 3 },
];
const routeDigests = [A, B, B];

function writeRoutes(count = ROUTES.length): string {
  const routes = ROUTES.slice(0, count).map((route, i) => ({
    ...route,
    sproutPath: legacySproutPath(paths, routeDigests[i] ?? A),
  }));
  writeFileSync(paths.routes, `${JSON.stringify(routes, null, 2)}\n`);
  chmodSync(paths.routes, 0o640);
  return readFileSync(paths.routes, "utf8");
}

function world(rows: Seed[] = ROWS, digests: string[] = [A, B, C], routeCount = ROUTES.length): void {
  seed(rows);
  for (const digest of digests) legacyEntries(digest);
  writeRoutes(routeCount);
}

function dbPaths(): Record<string, string> {
  const db = new Database(paths.database, { readonly: true });
  // SAFETY: the query selects exactly these two string columns.
  const rows = db.query("SELECT id, sprout_path FROM deployments ORDER BY id").all() as Array<{
    id: string;
    sprout_path: string;
  }>;
  db.close();
  return Object.fromEntries(rows.map((row) => [row.id, row.sprout_path]));
}

type Route = { hostname: string; ownerId?: string; sproutPath: string; port: number; extra?: { keep: boolean } };
// SAFETY: routes.json is the array this test wrote.
const routes = (): Route[] => JSON.parse(readFileSync(paths.routes, "utf8")) as Route[];

/** Every entry under `root`: relative path -> kind, mode and bytes. */
function tree(root: string) {
  const out: Record<string, string> = {};
  const walk = (path: string, rel: string) => {
    const info = lstatSync(path);
    const mode = (info.mode & 0o7777).toString(8);
    if (info.isDirectory()) {
      out[rel] = `dir:${mode}`;
      for (const name of readdirSync(path)) walk(join(path, name), `${rel}/${name}`);
    } else out[rel] = `file:${mode}:${readFileSync(path, "utf8")}`;
  };
  walk(root, "");
  return out;
}

const ino = (path: string): number => statSync(path).ino;
const owned = (owner: string, digest: string) => join(paths.artifacts, ownerDir(owner), digest);
const brokerOf = (owner: string, digest: string) => join(paths.brokers, `${ownerDir(owner)}-${digest}`);
const logOf = (owner: string, digest: string) => join(paths.sproutLogs, `${ownerDir(owner)}-${digest}.log`);
const exists = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

async function cli(command: string): Promise<{ code: number; out: string }> {
  const child = Bun.spawn([process.execPath, TOOL, command], {
    env: { ...process.env, ...envFor(dir) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { code, out };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sb-layout-"));
  paths = pathsFromEnv(envFor(dir));
  lines = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("migrate", () => {
  test("a single-owner digest is renamed, with its row and route rewritten", async () => {
    world([FIRST], [A], 1);
    const before = {
      artifact: ino(join(paths.artifacts, A)),
      broker: ino(join(paths.brokers, A)),
      log: ino(join(paths.sproutLogs, `${A}.log`)),
    };
    const routeMode = statSync(paths.routes).mode & 0o777;
    expect((await cli("check")).code).toBe(3);

    expect(migrate(paths, log)).toEqual({ moved: 3, copied: 0, rows: 1 });
    expect(ino(owned("u1", A))).toBe(before.artifact);
    expect(ino(brokerOf("u1", A))).toBe(before.broker);
    expect(ino(logOf("u1", A))).toBe(before.log);
    expect(exists(join(paths.artifacts, A))).toBe(false);
    expect(exists(join(paths.brokers, A))).toBe(false);
    expect(exists(join(paths.sproutLogs, `${A}.log`))).toBe(false);
    expect(statSync(join(owned("u1", A), "sprout")).mode & 0o777).toBe(0o555);
    expect(readFileSync(join(brokerOf("u1", A), "d1", "x.sqlite"), "utf8")).toBe("state");
    expect(dbPaths()).toEqual({ d1: ownedSproutPath(paths, "u1", A) });

    const [route] = routes();
    expect(route?.sproutPath).toBe(ownedSproutPath(paths, "u1", A));
    expect(route?.port).toBe(1);
    expect(route?.extra).toEqual({ keep: true });
    expect(statSync(paths.routes).mode & 0o777).toBe(routeMode);
    expect(statSync(owned("u1", A).replace(`/${A}`, "")).mode & 0o777).toBe(0o750);

    const checked = await cli("check");
    expect(checked.code).toBe(0);
    expect(checked.out).toContain("per-account");

    lines = [];
    expect(migrate(paths, log)).toEqual({ moved: 0, copied: 0, rows: 0 });
    expect(lines).toEqual([]);
  });

  test("a digest shared by two owners is copied once and renamed once", () => {
    world();
    const sharedBefore = tree(join(paths.artifacts, B));
    const summary = migrate(paths, log);
    expect(summary.copied).toBe(3); // artifact, broker state and log of B, one extra account each
    expect(summary.moved).toBe(9); // artifact, broker state and log of A, B and C: one rename each
    expect(tree(owned("u1", B))).toEqual(sharedBefore);
    expect(tree(owned("u2", B))).toEqual(sharedBefore);
    expect(statSync(join(owned("u2", B), "sprout")).mode & 0o777).toBe(0o555);
    expect(tree(brokerOf("u1", B))).toEqual(tree(brokerOf("u2", B)));
    expect(readFileSync(logOf("u1", B), "utf8")).toBe(readFileSync(logOf("u2", B), "utf8"));
    expect(exists(join(paths.artifacts, B))).toBe(false);
    expect(exists(join(paths.brokers, B))).toBe(false);
    expect(exists(join(paths.sproutLogs, `${B}.log`))).toBe(false);
    for (const root of [
      paths.artifacts,
      paths.brokers,
      paths.sproutLogs,
      join(paths.artifacts, ownerDir("u1")),
      join(paths.artifacts, ownerDir("u2")),
    ]) {
      expect(readdirSync(root).filter((name) => name.endsWith(".migrating"))).toEqual([]);
    }
    expect(dbPaths()).toEqual({
      d1: ownedSproutPath(paths, "u1", A),
      d2: ownedSproutPath(paths, "u1", B),
      d3: ownedSproutPath(paths, "u2", B),
      d4: ownedSproutPath(paths, "u1", C),
    });
    // ownerId is used when the route has one; otherwise the active row for its hostname decides.
    expect(routes().map((route) => route.sproutPath)).toEqual([
      ownedSproutPath(paths, "u1", A),
      ownedSproutPath(paths, "u1", B),
      ownedSproutPath(paths, "u2", B),
    ]);
  });

  test("an inactive older deployment is moved too", () => {
    world();
    migrate(paths, log);
    expect(readFileSync(join(owned("u1", C), "sprout"), "utf8")).toBe("binary c");
    expect(readFileSync(logOf("u1", C), "utf8")).toBe("log c\n");
    expect(exists(brokerOf("u1", C))).toBe(true);
    expect(exists(join(paths.artifacts, C))).toBe(false);
  });

  test("a run interrupted after the first copy is finished without touching it", () => {
    world();
    mkdirSync(join(paths.artifacts, ownerDir("u1")), { recursive: true, mode: 0o750 });
    cpSync(join(paths.artifacts, B), owned("u1", B), { recursive: true });
    const existing = ino(owned("u1", B));
    // A copy that died half way leaves a `.migrating` sibling behind.
    mkdirSync(`${brokerOf("u1", B)}.migrating/junk`, { recursive: true });
    writeFileSync(`${brokerOf("u1", B)}.migrating/junk/stale`, "stale");

    migrate(paths, log);
    expect(ino(owned("u1", B))).toBe(existing);
    expect(tree(owned("u1", B))).toEqual(tree(owned("u2", B)));
    expect(tree(brokerOf("u1", B))).toEqual(tree(brokerOf("u2", B)));
    expect(exists(`${brokerOf("u1", B)}.migrating`)).toBe(false);
    expect(exists(join(paths.artifacts, B))).toBe(false);
    expect(Object.values(dbPaths()).some((path) => path.includes(`${paths.artifacts}/${B}/`))).toBe(false);
  });

  test("a target that exists without holding a copy is discarded, not taken for one", () => {
    world();
    // Something else put empty names where the per-account entries go: an empty artifact directory (an
    // artifact is immutable, so anything but an exact copy is wrong), an empty broker directory and an
    // empty log. None of them holds what the legacy entry holds.
    mkdirSync(owned("u1", A), { recursive: true, mode: 0o750 });
    mkdirSync(brokerOf("u1", A), { recursive: true });
    writeFileSync(logOf("u1", A), "");
    // A partial artifact copy of the shared digest, missing a file, is wrong too.
    cpSync(join(paths.artifacts, B), owned("u1", B), { recursive: true });
    rmSync(join(owned("u1", B), "assets"), { recursive: true });

    expect(
      pending(paths)
        .entries.map((entry) => entry.from)
        .sort(),
    ).toEqual(
      [
        join(paths.artifacts, A),
        join(paths.brokers, A),
        join(paths.sproutLogs, `${A}.log`),
        join(paths.artifacts, B),
        join(paths.brokers, B),
        join(paths.sproutLogs, `${B}.log`),
        join(paths.artifacts, C),
        join(paths.brokers, C),
        join(paths.sproutLogs, `${C}.log`),
      ].sort(),
    );
    const before = { artifact: tree(join(paths.artifacts, A)), broker: tree(join(paths.brokers, A)) };
    migrate(paths, log);
    expect(lines.some((line) => line.includes("kept legacy"))).toBe(false);
    expect(tree(owned("u1", A))).toEqual(before.artifact);
    expect(tree(brokerOf("u1", A))).toEqual(before.broker);
    expect(readFileSync(logOf("u1", A), "utf8")).not.toBe("");
    expect(tree(owned("u1", B))).toEqual(tree(owned("u2", B)));
    expect(exists(join(paths.artifacts, A))).toBe(false);
    expect(exists(join(paths.artifacts, B))).toBe(false);
    expect(pending(paths)).toEqual({ rows: [], entries: [] });
  });

  test("a failed copy leaves the previous layout intact, and a re-run finishes", () => {
    world();
    const rowsBefore = dbPaths();
    const routesBefore = readFileSync(paths.routes, "utf8");
    // A plain file where the first owner's account directory must be: the copy of B cannot be made.
    const obstacle = join(paths.artifacts, ownerDir("u1"));
    writeFileSync(obstacle, "in the way");

    expect(() => migrate(paths, log)).toThrow();
    for (const digest of [A, B, C]) {
      expect(readFileSync(join(paths.artifacts, digest, "sprout"), "utf8")).toBe(`binary ${digest.slice(0, 1)}`);
      expect(readFileSync(join(paths.brokers, digest, "d1", "x.sqlite"), "utf8")).toBe("state");
      expect(readFileSync(join(paths.sproutLogs, `${digest}.log`), "utf8")).toBe(`log ${digest.slice(0, 1)}\n`);
    }
    expect(dbPaths()).toEqual(rowsBefore);
    expect(readFileSync(paths.routes, "utf8")).toBe(routesBefore);

    rmSync(obstacle);
    expect(migrate(paths, log).rows).toBe(4);
    expect(exists(join(paths.artifacts, B))).toBe(false);
    expect(tree(owned("u1", B))).toEqual(tree(owned("u2", B)));
  });

  test.skipIf(process.getuid?.() === 0)("an unreadable file in the shared artifact fails before anything moves", () => {
    world();
    const rowsBefore = dbPaths();
    const secret = join(paths.artifacts, B, "assets", "a.txt");
    chmodSync(secret, 0o000);

    expect(() => migrate(paths, log)).toThrow();
    expect(readFileSync(join(paths.artifacts, A, "sprout"), "utf8")).toBe("binary a");
    expect(exists(join(paths.artifacts, B))).toBe(true);
    expect(readFileSync(join(paths.sproutLogs, `${B}.log`), "utf8")).toBe("log b\n");
    expect(dbPaths()).toEqual(rowsBefore);

    chmodSync(secret, 0o644);
    expect(migrate(paths, log).rows).toBe(4);
    expect(readFileSync(join(owned("u2", B), "assets", "a.txt"), "utf8")).toBe("asset");
    expect(exists(`${owned("u1", B)}.migrating`)).toBe(false);
  });

  test("a database that still names the column worker_path is handled", () => {
    seed([FIRST], "worker_path");
    legacyEntries(A);
    expect(pending(paths).rows).toHaveLength(1);
    expect(migrate(paths, log).rows).toBe(1);
    const db = new Database(paths.database, { readonly: true });
    // SAFETY: the query selects one string column.
    const row = db.query("SELECT worker_path FROM deployments").get() as { worker_path: string };
    db.close();
    expect(row.worker_path).toBe(ownedSproutPath(paths, "u1", A));
    expect(revert(paths, log).rows).toBe(1);
  });

  test("without a database there is nothing to do", async () => {
    expect(migrate(paths, log)).toEqual({ moved: 0, copied: 0, rows: 0 });
    expect(revert(paths, log)).toEqual({ moved: 0, copied: 0, rows: 0 });
    expect((await cli("check")).code).toBe(0);
  });
});

describe("verifyCopy", () => {
  function pair() {
    const from = join(dir, "src");
    mkdirSync(join(from, "sub"), { recursive: true });
    writeFileSync(join(from, "sub", "f"), "abcdef");
    writeFileSync(join(from, "x"), "x");
    chmodSync(join(from, "x"), 0o555);
    const to = join(dir, "copy");
    cpSync(from, to, { recursive: true });
    return { from, to };
  }

  test("accepts an identical copy", () => {
    const { from, to } = pair();
    expect(() => verifyCopy(from, to)).not.toThrow();
  });

  test("detects a differing byte", () => {
    const { from, to } = pair();
    writeFileSync(join(to, "sub", "f"), "abcdeX");
    expect(() => verifyCopy(from, to)).toThrow("different bytes");
  });

  test("detects a missing entry", () => {
    const { from, to } = pair();
    rmSync(join(to, "sub", "f"));
    expect(() => verifyCopy(from, to)).toThrow();
  });

  test("detects a different mode", () => {
    const { from, to } = pair();
    chmodSync(join(to, "x"), 0o755);
    expect(() => verifyCopy(from, to)).toThrow("different mode");
  });
});

describe("revert", () => {
  test("single-owner entries go back by rename, rows and routes with them", async () => {
    world([FIRST], [A], 1);
    const legacyRoutes = readFileSync(paths.routes, "utf8");
    migrate(paths, log);
    const inodes = { artifact: ino(owned("u1", A)), broker: ino(brokerOf("u1", A)), log: ino(logOf("u1", A)) };

    expect(revert(paths, log)).toEqual({ moved: 3, copied: 0, rows: 1 });
    expect(ino(join(paths.artifacts, A))).toBe(inodes.artifact);
    expect(ino(join(paths.brokers, A))).toBe(inodes.broker);
    expect(ino(join(paths.sproutLogs, `${A}.log`))).toBe(inodes.log);
    expect(exists(join(paths.artifacts, ownerDir("u1")))).toBe(false);
    expect(dbPaths()).toEqual({ d1: legacySproutPath(paths, A) });
    expect(readFileSync(paths.routes, "utf8")).toBe(legacyRoutes);
    expect((await cli("check")).code).toBe(3);
  });

  test("a shared digest sends one copy back and keeps the other; migrating again reuses it", async () => {
    world();
    migrate(paths, log);
    lines = [];
    revert(paths, log);
    expect(lines.some((line) => line.includes("kept artifact") && line.includes(owned("u2", B)))).toBe(true);
    expect(exists(join(paths.artifacts, B))).toBe(true);
    expect(exists(owned("u1", B))).toBe(false);
    expect(exists(owned("u2", B))).toBe(true);
    expect(exists(join(paths.artifacts, ownerDir("u1")))).toBe(false);
    expect(dbPaths().d3).toBe(legacySproutPath(paths, B));
    expect(routes().every((route) => route.sproutPath.startsWith(join(paths.artifacts, "")))).toBe(true);
    expect(routes()[2]?.sproutPath).toBe(legacySproutPath(paths, B));
    expect((await cli("check")).code).toBe(3);

    const kept = ino(owned("u2", B));
    expect(migrate(paths, log).copied).toBe(0);
    expect(ino(owned("u2", B))).toBe(kept);
    expect(exists(join(paths.artifacts, B))).toBe(false);
    expect(tree(owned("u1", B))).toEqual(tree(owned("u2", B)));
    expect((await cli("check")).code).toBe(0);
  });
});
