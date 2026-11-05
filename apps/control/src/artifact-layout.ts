#!/usr/bin/env bun
/**
 * artifact-layout: move an install between the two on-disk layouts of its artifacts, broker state and sprout
 * logs. Run as root by install.sh before the services start, by sb-rollback when the release it restores
 * predates the per-account layout, and by `sbctl restore` after a backup is unpacked. Control only checks the
 * layout at boot (see store.ts) and refuses to serve a legacy one.
 *
 *   bun artifact-layout.ts check     exit 0: per-account layout; 3: legacy entries remain (listed); 1: error
 *   bun artifact-layout.ts migrate   legacy -> per-account. Idempotent and resumable.
 *   bun artifact-layout.ts revert    per-account -> legacy, for a release that only reads the old layout.
 *
 * Legacy layout (up to 0.14.0): `artifacts/<digest>/`, `brokers/<digest>/`, `logs/sprouts/<digest>.log`, and
 * `deployments.sprout_path = artifacts/<digest>/sprout`. Per-account layout: `artifacts/<ownerDir>/<digest>/`,
 * `brokers/<ownerDir>-<digest>/`, `logs/sprouts/<ownerDir>-<digest>.log` (`ownerDir` as in store.ts and the
 * supervisor's resource-layout.ts). A digest several accounts deploy is copied once per extra account.
 *
 * Order of a migration: plan from the database and the filesystem, make and verify every extra copy (through a
 * `.migrating` sibling, so a crash never leaves a half-made target), then switch each legacy entry to its last
 * target with one rename, then rewrite the rows and routes.json. Up to the switch nothing the previous release
 * reads has moved; after it, `revert` puts every entry back by the same renames. A run interrupted anywhere is
 * finished by the next one. Moved entries keep their owner and modes; copies take the owner of what they copy.
 *
 * Reads the services' environment (SPROUTBOAT_DATABASE_PATH, SPROUTBOAT_ARTIFACTS_DIR, SPROUTBOAT_BROKER_STATE_DIR,
 * SPROUTBOAT_LOG_PATH, SPROUTBOAT_ROUTE_SNAPSHOT) with the installer's defaults. Imports nothing from the tree,
 * so the copy installed as /usr/local/lib/sproutboat/layout.ts still runs after the tree has been rolled back.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type LayoutPaths = {
  database: string;
  artifacts: string;
  brokers: string;
  /** `logs/sprouts`, beside the request log. */
  sproutLogs: string;
  routes: string;
};

export function pathsFromEnv(env: NodeJS.ProcessEnv = process.env): LayoutPaths {
  const database = env.SPROUTBOAT_DATABASE_PATH || "/var/lib/sproutboat/sproutboat.sqlite";
  const logPath = env.SPROUTBOAT_LOG_PATH || "/var/lib/sproutboat/logs/requests.ndjson";
  return {
    database,
    artifacts: resolve(env.SPROUTBOAT_ARTIFACTS_DIR || "/var/lib/sproutboat/artifacts"),
    brokers: resolve(env.SPROUTBOAT_BROKER_STATE_DIR || resolve(dirname(database), "brokers")),
    sproutLogs: resolve(dirname(logPath), "sprouts"),
    routes: resolve(env.SPROUTBOAT_ROUTE_SNAPSHOT || "/var/lib/sproutboat/routes.json"),
  };
}

/** Same hash as `artifactOwnerDir` in store.ts and `ownerDirName` in the supervisor: keep the three in step. */
export const ownerDir = (ownerId: string): string => createHash("sha256").update(ownerId).digest("hex").slice(0, 32);

const DIGEST = /^[a-f0-9]{64}$/;
export const legacySproutPath = (paths: LayoutPaths, digest: string): string =>
  resolve(paths.artifacts, digest, "sprout");
export const ownedSproutPath = (paths: LayoutPaths, ownerId: string, digest: string): string =>
  resolve(paths.artifacts, ownerDir(ownerId), digest, "sprout");

type Row = {
  id: string;
  owner_id: string;
  artifact_digest: string;
  hostname: string;
  active: number;
  sprout_path: string;
};

/** A legacy entry and the per-account names it maps to (one per account that deploys the digest). */
export type Entry = { what: "artifact" | "broker state" | "sprout log"; from: string; targets: string[] };

export type Log = (line: string) => void;

function openDatabase(path: string): Database | null {
  if (!existsSync(path)) return null;
  const db = new Database(path);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** The column that holds the sprout path: `worker_path` in a database from before the rename. */
function sproutPathColumn(db: Database): string | null {
  // SAFETY: PRAGMA table_info rows always expose a string `name` column.
  const cols = (db.query("PRAGMA table_info(deployments)").all() as Array<{ name: string }>).map((c) => c.name);
  if (cols.includes("sprout_path")) return "sprout_path";
  if (cols.includes("worker_path")) return "worker_path";
  return null;
}

function readRows(db: Database, column: string): Row[] {
  // SAFETY: SQLite returns exactly the columns selected here.
  const rows = db
    .query(`SELECT id, owner_id, artifact_digest, hostname, active, ${column} AS sprout_path FROM deployments`)
    .all() as Row[];
  return rows.filter((row) => DIGEST.test(row.artifact_digest));
}

/** Digest -> the accounts that deploy it, in a fixed order. */
function ownersByDigest(rows: Row[]): Map<string, string[]> {
  const owners = new Map<string, Set<string>>();
  for (const row of rows)
    owners.set(row.artifact_digest, (owners.get(row.artifact_digest) ?? new Set()).add(row.owner_id));
  return new Map([...owners].map(([digest, set]) => [digest, [...set].toSorted()]));
}

/** Every legacy entry the deployments table implies, whether or not it exists on disk. */
export function planEntries(paths: LayoutPaths, rows: Row[]): Entry[] {
  const entries: Entry[] = [];
  for (const [digest, owners] of ownersByDigest(rows)) {
    const named = owners.map((owner) => `${ownerDir(owner)}-${digest}`);
    entries.push(
      {
        what: "artifact",
        from: resolve(paths.artifacts, digest),
        targets: owners.map((o) => resolve(paths.artifacts, ownerDir(o), digest)),
      },
      {
        what: "broker state",
        from: resolve(paths.brokers, digest),
        targets: named.map((n) => resolve(paths.brokers, n)),
      },
      {
        what: "sprout log",
        from: resolve(paths.sproutLogs, `${digest}.log`),
        targets: named.map((n) => resolve(paths.sproutLogs, `${n}.log`)),
      },
    );
  }
  return entries;
}

const isRoot = (): boolean => process.getuid?.() === 0;

/** Give `copy` the owner of `source`, entry by entry (cpSync keeps modes but not owners). Root only. */
function mirrorOwners(source: string, copy: string): void {
  if (!isRoot()) return;
  const walk = (from: string, to: string) => {
    const info = lstatSync(from);
    lchownSync(to, info.uid, info.gid);
    if (info.isDirectory()) for (const entry of readdirSync(from)) walk(join(from, entry), join(to, entry));
  };
  walk(source, copy);
}

/** Make a directory the way the service owning its parent would, keeping the parent's owner. */
function makeDirLike(parent: string, path: string, mode: number): void {
  if (existsSync(path)) return;
  mkdirSync(path, { mode });
  chmodSync(path, mode); // mkdir applies the umask; the mode is meant literally
  if (isRoot()) {
    const info = lstatSync(parent);
    lchownSync(path, info.uid, info.gid);
  }
}

const fileHash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Throws when `copy` is not entry-for-entry what `source` is: names, kinds, modes, sizes and bytes. */
export function verifyCopy(source: string, copy: string): void {
  const differ = (what: string, path: string): never => {
    throw new Error(`copy of ${source} differs at ${path}: ${what}`);
  };
  const walk = (from: string, to: string) => {
    const a = lstatSync(from);
    const b = lstatSync(to, { throwIfNoEntry: false }) ?? differ("missing", to);
    if ((a.mode & 0o170000) !== (b.mode & 0o170000)) differ("different kind", to);
    if (a.isSymbolicLink()) {
      if (readlinkSync(from) !== readlinkSync(to)) differ("different link target", to);
      return;
    }
    if ((a.mode & 0o7777) !== (b.mode & 0o7777)) differ("different mode", to);
    if (a.isDirectory()) {
      const left = readdirSync(from).sort();
      const right = readdirSync(to).sort();
      if (left.join("\0") !== right.join("\0")) differ("different entries", to);
      for (const entry of left) walk(join(from, entry), join(to, entry));
      return;
    }
    if (a.size !== b.size) differ("different size", to);
    if (fileHash(from) !== fileHash(to)) differ("different bytes", to);
  };
  walk(source, copy);
}

/** Copy `from` to `to` through a `.migrating` sibling: `to` appears only once the copy is complete and verified. */
function copyVerified(from: string, to: string): void {
  const partial = `${to}.migrating`;
  rmSync(partial, { recursive: true, force: true });
  cpSync(from, partial, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  mirrorOwners(from, partial);
  verifyCopy(from, partial);
  renameSync(partial, to);
}

/**
 * Whether an existing target already holds what the legacy entry holds. A target is made through a
 * `.migrating` sibling, so one that exists is normally complete; this guards against anything else that
 * put a name there (an empty directory, a stray file). An artifact is immutable, so its copy must match
 * the legacy entry exactly; broker state and a sprout log may have been written to since, so only an
 * empty one is known to hold nothing.
 */
function holdsCopy(entry: Entry, target: string): boolean {
  const info = lstatSync(target, { throwIfNoEntry: false });
  if (!info) return false;
  if (entry.what === "artifact") {
    try {
      verifyCopy(entry.from, target);
      return true;
    } catch {
      return false;
    }
  }
  return info.isDirectory() ? readdirSync(target).length > 0 : info.size > 0;
}

/** Targets still to make: missing ones, and ones that exist without holding a copy (those are discarded). */
function missingTargets(entry: Entry, discard: boolean): string[] {
  return entry.targets.filter((target) => {
    if (!existsSync(target)) return true;
    if (holdsCopy(entry, target)) return false;
    if (discard) rmSync(target, { recursive: true, force: true });
    return true;
  });
}

/** Parent of a per-account artifact directory: `artifacts/<ownerDir>/`, owned like the artifacts root, 0750. */
function ensureArtifactParent(paths: LayoutPaths, target: string): void {
  const parent = dirname(target);
  if (dirname(parent) === paths.artifacts) makeDirLike(paths.artifacts, parent, 0o750);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** One routes.json entry as control writes it; only `sproutPath` (and `ownerId`, `hostname`) matter here. */
type RouteObject = { [key: string]: Json };
const isString = (value: Json | undefined): value is string => value !== undefined && value === String(value);
const isObject = (value: Json): value is RouteObject =>
  value !== null && Object(value) === value && !Array.isArray(value);

function readRoutes(path: string): Json[] | null {
  let parsed: Json;
  try {
    // SAFETY: JSON.parse yields only JSON values; the file is control's own Route[] snapshot.
    parsed = JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

/** Rewrite the sprout paths in routes.json in place (same owner and mode), so the edge never routes to a moved path. */
function rewriteRoutes(path: string, rewrite: (route: RouteObject) => string | null, log: Log): void {
  const routes = readRoutes(path);
  if (!routes) return;
  let changed = 0;
  for (const route of routes) {
    if (!isObject(route)) continue;
    const next = rewrite(route);
    if (next !== null && next !== route.sproutPath) {
      route.sproutPath = next;
      changed++;
    }
  }
  if (changed === 0) return;
  const temporary = `${path}.migrating`;
  writeFileSync(temporary, `${JSON.stringify(routes, null, 2)}\n`);
  const info = lstatSync(path);
  chmodSync(temporary, info.mode & 0o7777);
  if (isRoot()) lchownSync(temporary, info.uid, info.gid);
  renameSync(temporary, path);
  log(`layout: rewrote ${changed} route(s) in ${basename(path)}`);
}

/** The account a route belongs to: its own ownerId, else the one account that deploys the digest, else by hostname. */
function routeOwner(route: RouteObject, digest: string, rows: Row[]): string | null {
  if (isString(route.ownerId)) return route.ownerId;
  const owners = ownersByDigest(rows.filter((row) => row.artifact_digest === digest)).get(digest) ?? [];
  if (owners.length === 1) return owners[0] ?? null;
  return (
    rows.find((row) => row.hostname === route.hostname && row.artifact_digest === digest && row.active === 1)
      ?.owner_id ?? null
  );
}

/** The digest of a legacy `artifacts/<digest>/sprout` path, null for any other path. */
const digestOfLegacy = (paths: LayoutPaths, sproutPath: string): string | null => {
  const digest = basename(dirname(sproutPath));
  return DIGEST.test(digest) && legacySproutPath(paths, digest) === sproutPath ? digest : null;
};

export type Pending = { rows: Row[]; entries: Entry[] };

/** What `migrate` would still do: rows on a legacy sprout path, and legacy entries on disk with a target missing. */
export function pending(paths: LayoutPaths): Pending {
  const db = openDatabase(paths.database);
  if (!db) return { rows: [], entries: [] };
  try {
    const column = sproutPathColumn(db);
    if (!column) return { rows: [], entries: [] };
    const rows = readRows(db, column);
    return {
      rows: rows.filter((row) => row.sprout_path === legacySproutPath(paths, row.artifact_digest)),
      entries: planEntries(paths, rows).filter(
        (entry) => existsSync(entry.from) && missingTargets(entry, false).length > 0,
      ),
    };
  } finally {
    db.close();
  }
}

export type Summary = { moved: number; copied: number; rows: number };

/** Legacy -> per-account. See the file comment for the order and what each step guarantees. */
export function migrate(paths: LayoutPaths, log: Log = console.log): Summary {
  const db = openDatabase(paths.database);
  if (!db) return { moved: 0, copied: 0, rows: 0 };
  try {
    const column = sproutPathColumn(db);
    if (!column) return { moved: 0, copied: 0, rows: 0 };
    const rows = readRows(db, column);
    const entries = planEntries(paths, rows).filter((entry) => existsSync(entry.from));
    const switches: Array<{ entry: Entry; to: string }> = [];
    let copied = 0;

    // 1. Copies, each verified before it appears under its final name. The legacy entry is untouched.
    for (const entry of entries) {
      const missing = missingTargets(entry, true);
      if (missing.length === 0) {
        log(`layout: kept legacy ${entry.what} ${entry.from}: every per-account copy already holds it`);
        continue;
      }
      for (const target of missing.slice(0, -1)) {
        if (entry.what === "artifact") ensureArtifactParent(paths, target);
        copyVerified(entry.from, target);
        copied++;
        log(`layout: copied ${entry.what} ${entry.from} -> ${target}`);
      }
      const last = missing.at(-1);
      if (last !== undefined) switches.push({ entry, to: last });
    }

    // 2. The switch: one rename per legacy entry. `revert` undoes exactly these.
    for (const { entry, to } of switches) {
      if (entry.what === "artifact") ensureArtifactParent(paths, to);
      renameSync(entry.from, to);
      log(`layout: moved ${entry.what} ${entry.from} -> ${to}`);
    }

    // 3. Rows, then the route snapshot the edge reads.
    const legacy = rows.filter((row) => row.sprout_path === legacySproutPath(paths, row.artifact_digest));
    const update = db.query(`UPDATE deployments SET ${column} = ? WHERE id = ?`);
    db.transaction(() => {
      for (const row of legacy) update.run(ownedSproutPath(paths, row.owner_id, row.artifact_digest), row.id);
    })();
    if (legacy.length > 0) log(`layout: ${legacy.length} deployment(s) now on per-account sprout paths`);
    rewriteRoutes(
      paths.routes,
      (route) => {
        const digest = isString(route.sproutPath) ? digestOfLegacy(paths, route.sproutPath) : null;
        if (!digest) return null;
        const owner = routeOwner(route, digest, rows);
        return owner ? ownedSproutPath(paths, owner, digest) : null;
      },
      log,
    );
    return { moved: switches.length, copied, rows: legacy.length };
  } finally {
    db.close();
  }
}

/**
 * Per-account -> legacy, for a release that only reads the legacy layout. Each per-account entry goes back under
 * its digest name by one rename; where that name is already taken (two accounts deployed the digest, or a legacy
 * copy was kept) the entry stays, and the release being restored serves the shared legacy one, as it did before.
 */
export function revert(paths: LayoutPaths, log: Log = console.log): Summary {
  const db = openDatabase(paths.database);
  if (!db) return { moved: 0, copied: 0, rows: 0 };
  try {
    const column = sproutPathColumn(db);
    if (!column) return { moved: 0, copied: 0, rows: 0 };
    const rows = readRows(db, column);
    let moved = 0;
    const parents = new Set<string>();
    for (const entry of planEntries(paths, rows)) {
      for (const target of entry.targets) {
        if (!existsSync(target)) continue;
        if (entry.what === "artifact") parents.add(dirname(target));
        if (existsSync(entry.from)) {
          log(`layout: kept ${entry.what} ${target}: ${entry.from} exists`);
          continue;
        }
        renameSync(target, entry.from);
        moved++;
        log(`layout: moved ${entry.what} ${target} -> ${entry.from}`);
      }
    }
    for (const parent of parents) {
      try {
        rmdirSync(parent); // only when empty
      } catch {
        /* still holds another digest, or a kept copy */
      }
    }
    const owned = rows.filter((row) => row.sprout_path === ownedSproutPath(paths, row.owner_id, row.artifact_digest));
    const update = db.query(`UPDATE deployments SET ${column} = ? WHERE id = ?`);
    db.transaction(() => {
      for (const row of owned) update.run(legacySproutPath(paths, row.artifact_digest), row.id);
    })();
    if (owned.length > 0) log(`layout: ${owned.length} deployment(s) back on legacy sprout paths`);
    rewriteRoutes(
      paths.routes,
      (route) => {
        const sproutPath = route.sproutPath;
        if (!isString(sproutPath)) return null;
        const digest = basename(dirname(sproutPath));
        const owned = rows.some(
          (row) => row.artifact_digest === digest && sproutPath === ownedSproutPath(paths, row.owner_id, digest),
        );
        return DIGEST.test(digest) && owned ? legacySproutPath(paths, digest) : null;
      },
      log,
    );
    return { moved, copied: 0, rows: owned.length };
  } finally {
    db.close();
  }
}

function main(argv: string[]): number {
  const command = argv[0];
  const paths = pathsFromEnv();
  switch (command) {
    case "check": {
      const { rows, entries } = pending(paths);
      if (rows.length === 0 && entries.length === 0) {
        console.log("layout: per-account");
        return 0;
      }
      console.log(
        `layout: legacy: ${rows.length} deployment(s) on artifacts/<digest> paths, ${entries.length} legacy entr${entries.length === 1 ? "y" : "ies"} on disk`,
      );
      for (const entry of entries) console.log(`  ${entry.what} ${entry.from}`);
      return 3;
    }
    case "migrate": {
      const summary = migrate(paths);
      console.log(
        `layout: migrated: ${summary.moved} moved, ${summary.copied} copied, ${summary.rows} row(s) rewritten`,
      );
      return 0;
    }
    case "revert": {
      const summary = revert(paths);
      console.log(`layout: reverted: ${summary.moved} moved, ${summary.rows} row(s) rewritten`);
      return 0;
    }
    default:
      console.error("usage: artifact-layout.ts check | migrate | revert");
      return 2;
  }
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`layout: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
