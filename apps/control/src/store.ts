import { Database } from "bun:sqlite";
import { readFileSync, renameSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

/**
 * Transactional metadata store for projects, deployments, and artifacts (#17).
 *
 * The edge never reads this DB — it consumes the atomic `routes.json` snapshot
 * that `syncRoutes()` regenerates from the active deployments after every
 * mutation. Artifact bytes stay on the filesystem; only the digest lives here,
 * so `collectArtifacts()` can GC the ones no deployment still references.
 */

// Read lazily so tests (and any embedder) can set these before first use.
const dbPath = () => process.env.SPROUTBOAT_DATABASE_PATH || "/var/lib/sproutboat/sproutboat.sqlite";
const routesPath = () => resolve(process.env.SPROUTBOAT_ROUTE_SNAPSHOT || "/var/lib/sproutboat/routes.json");
const artifactRoot = () => resolve(process.env.SPROUTBOAT_ARTIFACTS_DIR || "/var/lib/sproutboat/artifacts");
const legacyDeploymentsPath = () => resolve(process.env.SPROUTBOAT_DEPLOYMENTS_PATH || "/var/lib/sproutboat/deployments.json");

export type Deployment = {
  id: string; project: string; ownerId: string; username: string;
  hostname: string; artifact: string; workerPath: string; deployedAt: string; active: boolean;
};
export type ProjectSummary = { name: string; hostname: string; activeDeploymentId: string; deployedAt: string };

type DeploymentRow = {
  id: string; project: string; owner_id: string; username: string;
  hostname: string; artifact_digest: string; worker_path: string; deployed_at: string; active: number;
};

const toDeployment = (row: DeploymentRow): Deployment => ({
  id: row.id, project: row.project, ownerId: row.owner_id, username: row.username,
  hostname: row.hostname, artifact: row.artifact_digest, workerPath: row.worker_path,
  deployedAt: row.deployed_at, active: row.active === 1,
});

let db: Database | undefined;
let dbConnectedPath: string | undefined;

function q<T>(sql: string, ...args: Array<string | number | null>): T[] {
  // SAFETY: callers pass a SELECT whose columns match T, against the schema
  // created in connection(); SQLite rows have no further shape to validate.
  return connection().query(sql).all(...args) as T[];
}
function q1<T>(sql: string, ...args: Array<string | number | null>): T | undefined {
  // SAFETY: as q(), for a single-row .get().
  return (connection().query(sql).get(...args) as T | null) ?? undefined;
}

function run(sql: string, ...args: Array<string | number | null>): number {
  return connection().query(sql).run(...args).changes;
}

function present(deployment: Deployment): boolean {
  for (const field of [deployment.id, deployment.ownerId, deployment.project, deployment.username, deployment.hostname, deployment.artifact, deployment.workerPath]) {
    if (Object(field) === field || field !== String(field) || field === "") return false;
  }
  return true;
}

function connection(): Database {
  if (db && dbConnectedPath === dbPath()) return db;
  db?.close();
  const database = new Database(dbPath());
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      digest TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (owner_id, name)
    );
    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      project TEXT NOT NULL,
      username TEXT NOT NULL,
      hostname TEXT NOT NULL,
      artifact_digest TEXT NOT NULL REFERENCES artifacts(digest),
      worker_path TEXT NOT NULL,
      deployed_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (owner_id, project) REFERENCES projects(owner_id, name) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_deployment_per_project
      ON deployments(owner_id, project) WHERE active = 1;
    CREATE INDEX IF NOT EXISTS deployments_by_owner ON deployments(owner_id);
    CREATE INDEX IF NOT EXISTS deployments_by_artifact ON deployments(artifact_digest);
    CREATE TABLE IF NOT EXISTS banned_owners (
      owner_id TEXT PRIMARY KEY,
      banned_at TEXT NOT NULL
    );
  `);
  db = database;
  dbConnectedPath = dbPath();
  importLegacyDeployments();
  return database;
}

/** One-time import of the pre-#17 deployments.json; the file is renamed aside afterwards. */
function importLegacyDeployments(): void {
  if ((q1<{ n: number }>("SELECT COUNT(*) AS n FROM deployments")?.n ?? 0) > 0) return;
  let raw: string;
  try { raw = readFileSync(legacyDeploymentsPath(), "utf8"); }
  catch { return; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return; } // a corrupt legacy file must not brick every store call
  if (!Array.isArray(parsed)) return;
  // SAFETY: deployments.json was written by this service's own pre-#17 code with
  // the Deployment[] contract; present() drops any entry missing a string field.
  const legacy = (parsed as Deployment[]).filter(present);

  const now = new Date().toISOString();
  connection().transaction(() => {
    for (const d of legacy) {
      const at = Object(d.deployedAt) !== d.deployedAt && d.deployedAt === String(d.deployedAt) && d.deployedAt !== "" ? d.deployedAt : now;
      run("INSERT OR IGNORE INTO projects (owner_id, name, username, created_at) VALUES (?, ?, ?, ?)", d.ownerId, d.project, d.username, at);
      run("INSERT OR IGNORE INTO artifacts (digest, created_at) VALUES (?, ?)", d.artifact, at);
      run(`INSERT OR IGNORE INTO deployments (id, owner_id, project, username, hostname, artifact_digest, worker_path, deployed_at, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, d.id, d.ownerId, d.project, d.username, d.hostname, d.artifact, d.workerPath, at, d.active === true ? 1 : 0);
    }
  })();
  try { renameSync(legacyDeploymentsPath(), `${legacyDeploymentsPath()}.imported`); } catch { /* best effort */ }
}

/** Of the given digests, the ones we still hold a row for that no deployment references. */
function orphanedAmong(digests: string[]): string[] {
  return [...new Set(digests)].filter((digest) =>
    q1("SELECT 1 FROM artifacts WHERE digest = ?", digest)
    && !q1("SELECT 1 FROM deployments WHERE artifact_digest = ? LIMIT 1", digest));
}

// --- reads -----------------------------------------------------------------

export function ownerDeployments(ownerId: string): Deployment[] {
  return q<DeploymentRow>("SELECT * FROM deployments WHERE owner_id = ? ORDER BY deployed_at DESC", ownerId).map(toDeployment);
}

export function projectDeployments(ownerId: string, project: string): Deployment[] {
  return q<DeploymentRow>("SELECT * FROM deployments WHERE owner_id = ? AND project = ? ORDER BY deployed_at DESC", ownerId, project).map(toDeployment);
}

export function projectDeployment(ownerId: string, project: string, id: string): Deployment | undefined {
  const row = q1<DeploymentRow>("SELECT * FROM deployments WHERE id = ? AND owner_id = ? AND project = ?", id, ownerId, project);
  return row ? toDeployment(row) : undefined;
}

export function activeProjects(ownerId: string): ProjectSummary[] {
  return q<DeploymentRow>("SELECT * FROM deployments WHERE owner_id = ? AND active = 1", ownerId)
    .map((row) => ({ name: row.project, hostname: row.hostname, activeDeploymentId: row.id, deployedAt: row.deployed_at }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

// --- operator aggregates (cross-owner) ----------------------------------

export type GlobalStats = {
  owners: number; projects: number; activeProjects: number;
  deployments: number; artifacts: number; bannedOwners: number;
};

export function globalStats(): GlobalStats {
  const n = (sql: string): number => q1<{ n: number }>(sql)?.n ?? 0;
  return {
    owners: n("SELECT COUNT(DISTINCT owner_id) AS n FROM projects"),
    projects: n("SELECT COUNT(*) AS n FROM projects"),
    activeProjects: n("SELECT COUNT(*) AS n FROM deployments WHERE active = 1"),
    deployments: n("SELECT COUNT(*) AS n FROM deployments"),
    artifacts: n("SELECT COUNT(*) AS n FROM artifacts"),
    bannedOwners: n("SELECT COUNT(*) AS n FROM banned_owners"),
  };
}

export type OwnerRollup = {
  ownerId: string; username: string;
  projects: number; deployments: number; activeProjects: number; banned: boolean;
};

/** One row per owner that has ever deployed. Owners with no deployments are absent. */
export function ownerRollups(): OwnerRollup[] {
  const banned = new Set(bannedOwners());
  return q<{ owner_id: string; username: string; projects: number; deployments: number; active_projects: number }>(
    `SELECT owner_id,
            MAX(username) AS username,
            COUNT(DISTINCT project) AS projects,
            COUNT(*) AS deployments,
            SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_projects
     FROM deployments GROUP BY owner_id`,
  ).map((row) => ({
    ownerId: row.owner_id, username: row.username,
    projects: row.projects, deployments: row.deployments, activeProjects: row.active_projects,
    banned: banned.has(row.owner_id),
  }));
}

// --- mutations (each its own transaction) ---------------------------------

export function recordDeployment(input: Omit<Deployment, "active">): Deployment {
  return connection().transaction(() => {
    run("INSERT OR IGNORE INTO projects (owner_id, name, username, created_at) VALUES (?, ?, ?, ?)", input.ownerId, input.project, input.username, input.deployedAt);
    run("INSERT OR IGNORE INTO artifacts (digest, created_at) VALUES (?, ?)", input.artifact, input.deployedAt);
    run("UPDATE deployments SET active = 0 WHERE owner_id = ? AND project = ?", input.ownerId, input.project);
    run(`INSERT INTO deployments (id, owner_id, project, username, hostname, artifact_digest, worker_path, deployed_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      input.id, input.ownerId, input.project, input.username, input.hostname, input.artifact, input.workerPath, input.deployedAt);
    return { ...input, active: true };
  })();
}

/** Returns the now-active deployment, or undefined if `id` is not a version of this project. */
export function activateDeployment(ownerId: string, project: string, id: string): Deployment | undefined {
  return connection().transaction(() => {
    const target = q1<DeploymentRow>("SELECT * FROM deployments WHERE id = ? AND owner_id = ? AND project = ?", id, ownerId, project);
    if (!target) return undefined;
    run("UPDATE deployments SET active = 0 WHERE owner_id = ? AND project = ?", ownerId, project);
    run("UPDATE deployments SET active = 1 WHERE id = ?", id);
    return toDeployment({ ...target, active: 1 });
  })();
}

export type ProjectDeletion = { removed: number; hostnames: string[]; orphanedArtifacts: string[] };

/** Deletes one project and all its versions. Returns hostnames to unroute and digests now unreferenced. */
export function deleteProject(ownerId: string, project: string): ProjectDeletion {
  return connection().transaction(() => {
    const rows = q<DeploymentRow>("SELECT * FROM deployments WHERE owner_id = ? AND project = ?", ownerId, project);
    const digests = rows.map((row) => row.artifact_digest);
    run("DELETE FROM projects WHERE owner_id = ? AND name = ?", ownerId, project); // cascades to deployments
    return { removed: rows.length, hostnames: [...new Set(rows.map((row) => row.hostname))], orphanedArtifacts: orphanedAmong(digests) };
  })();
}

export type DeploymentDeletion = { deleted: boolean; active: boolean; orphanedArtifacts: string[] };

/**
 * #4: delete one inactive version. Refuses the active version (`deleted: false,
 * active: true`) — it must be rolled back or replaced, or the project deleted.
 * Returns undefined if `id` is not a version of this project.
 */
export function deleteDeployment(ownerId: string, project: string, id: string): DeploymentDeletion | undefined {
  return connection().transaction(() => {
    const row = q1<DeploymentRow>("SELECT * FROM deployments WHERE id = ? AND owner_id = ? AND project = ?", id, ownerId, project);
    if (!row) return undefined;
    if (row.active === 1) return { deleted: false, active: true, orphanedArtifacts: [] };
    run("DELETE FROM deployments WHERE id = ?", id);
    return { deleted: true, active: false, orphanedArtifacts: orphanedAmong([row.artifact_digest]) };
  })();
}

// --- owner bans (operator action; stops the owner's routes) --------------

/** Marks an owner banned. `syncRoutes()` then drops every one of their hostnames. */
export function banOwner(ownerId: string): void {
  run("INSERT OR IGNORE INTO banned_owners (owner_id, banned_at) VALUES (?, ?)", ownerId, new Date().toISOString());
}

/** Lifts an owner's ban. Their active deployments route again on the next `syncRoutes()`. */
export function unbanOwner(ownerId: string): void {
  run("DELETE FROM banned_owners WHERE owner_id = ?", ownerId);
}

export function bannedOwners(): string[] {
  return q<{ owner_id: string }>("SELECT owner_id FROM banned_owners").map((row) => row.owner_id);
}

/** Deletes every project owned by `ownerId`. Same shape as deleteProject, aggregated. */
export function deleteOwner(ownerId: string): ProjectDeletion {
  return connection().transaction(() => {
    const rows = q<DeploymentRow>("SELECT * FROM deployments WHERE owner_id = ?", ownerId);
    const digests = rows.map((row) => row.artifact_digest);
    run("DELETE FROM projects WHERE owner_id = ?", ownerId);
    return { removed: rows.length, hostnames: [...new Set(rows.map((row) => row.hostname))], orphanedArtifacts: orphanedAmong(digests) };
  })();
}

// --- routes snapshot + artifact GC --------------------------------------

/**
 * Rewrites routes.json from the current active deployments (atomic temp + rename).
 * Calls are serialized through one promise chain so that when two mutations race,
 * the last-scheduled write re-queries and wins — a concurrent pair can't leave a
 * deleted project's hostname in the snapshot.
 */
let routeSync: Promise<void> = Promise.resolve();
export function syncRoutes(): Promise<void> {
  routeSync = routeSync.catch(() => {}).then(writeRouteSnapshot);
  return routeSync;
}
async function writeRouteSnapshot(): Promise<void> {
  const routes = q<{ hostname: string; worker_path: string }>(
    `SELECT hostname, worker_path FROM deployments
     WHERE active = 1 AND owner_id NOT IN (SELECT owner_id FROM banned_owners)
     ORDER BY hostname`,
  ).map((row) => ({ hostname: row.hostname, workerPath: row.worker_path }));
  await mkdir(dirname(routesPath()), { recursive: true });
  const temporary = `${routesPath()}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(routes, null, 2)}\n`, { mode: 0o640 });
  await rename(temporary, routesPath());
}

/**
 * Removes the on-disk artifact directory for each digest that is no longer
 * referenced, then drops its row. Never throws — returns the digests it could
 * not remove so the caller can report partial failure instead of claiming success.
 */
export async function collectArtifacts(digests: string[]): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const digest of new Set(digests)) {
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      // junk input is not our problem; a real digest we still hold is
      if (q1("SELECT 1 FROM artifacts WHERE digest = ?", digest)) failed.push(digest);
      continue;
    }
    // Drop the row first, and only while nothing references it — then the bytes.
    // ponytail: a redeploy of this exact digest landing between this commit and
    // the rm below could still lose bytes on a single box — acceptable until GC
    // and deploy share a lock. A failed rm leaves the row gone and the dir
    // orphaned for a future sweep, not a broken deployment.
    const dropped = run(
      "DELETE FROM artifacts WHERE digest = ? AND NOT EXISTS (SELECT 1 FROM deployments WHERE artifact_digest = ?)",
      digest, digest,
    );
    if (!dropped) continue;
    try {
      await rm(resolve(artifactRoot(), digest), { recursive: true, force: true });
      removed.push(digest);
    } catch {
      failed.push(digest);
    }
  }
  return { removed, failed };
}

/** Test/ops helper: close and forget the connection. */
export function closeStore(): void {
  db?.close();
  db = undefined;
}
