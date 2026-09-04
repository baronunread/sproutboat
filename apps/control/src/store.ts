import { Database } from "bun:sqlite";
import { readFileSync, renameSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { decryptSecret, encryptSecret } from "./secrets-crypto";

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
const legacyDeploymentsPath = () =>
  resolve(process.env.SPROUTBOAT_DEPLOYMENTS_PATH || "/var/lib/sproutboat/deployments.json");

export type Deployment = {
  id: string;
  project: string;
  ownerId: string;
  username: string;
  hostname: string;
  artifact: string;
  sproutPath: string;
  deployedAt: string;
  active: boolean;
};
export type ProjectSummary = { name: string; hostname: string; activeDeploymentId: string; deployedAt: string };

type DeploymentRow = {
  id: string;
  project: string;
  owner_id: string;
  username: string;
  hostname: string;
  artifact_digest: string;
  sprout_path: string;
  deployed_at: string;
  active: number;
};

const toDeployment = (row: DeploymentRow): Deployment => ({
  id: row.id,
  project: row.project,
  ownerId: row.owner_id,
  username: row.username,
  hostname: row.hostname,
  artifact: row.artifact_digest,
  sproutPath: row.sprout_path,
  deployedAt: row.deployed_at,
  active: row.active === 1,
});

let db: Database | undefined;
let dbConnectedPath: string | undefined;

function q<T>(sql: string, ...args: Array<string | number | null>): T[] {
  // SAFETY: callers pass a SELECT whose columns match T, against the schema
  // created in connection(); SQLite rows have no further shape to validate.
  return connection()
    .query(sql)
    .all(...args) as T[];
}
function q1<T>(sql: string, ...args: Array<string | number | null>): T | undefined {
  // SAFETY: as q(), for a single-row .get().
  return (
    (connection()
      .query(sql)
      .get(...args) as T | null) ?? undefined
  );
}

function run(sql: string, ...args: Array<string | number | null>): number {
  return connection()
    .query(sql)
    .run(...args).changes;
}

function present(deployment: Deployment): boolean {
  for (const field of [
    deployment.id,
    deployment.ownerId,
    deployment.project,
    deployment.username,
    deployment.hostname,
    deployment.artifact,
    deployment.sproutPath,
  ]) {
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
      sprout_path TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS custom_domains (
      hostname TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      project TEXT NOT NULL,
      token TEXT NOT NULL,
      verified_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (owner_id, project) REFERENCES projects(owner_id, name) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS custom_domains_by_project ON custom_domains(owner_id, project);
    CREATE TABLE IF NOT EXISTS secrets (
      owner_id TEXT NOT NULL,
      project TEXT NOT NULL,
      name TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner_id, project, name),
      FOREIGN KEY (owner_id, project) REFERENCES projects(owner_id, name) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS resources_by_owner ON resources(owner_id);
    CREATE UNIQUE INDEX IF NOT EXISTS resource_name_per_owner_kind ON resources(owner_id, kind, name);
    CREATE TABLE IF NOT EXISTS deployment_resources (
      deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL,
      PRIMARY KEY (deployment_id, resource_id)
    );
    CREATE INDEX IF NOT EXISTS deployment_resources_by_resource ON deployment_resources(resource_id);
  `);
  // worker -> sprout rename: bring a pre-rename DB's column name forward.
  // SAFETY: PRAGMA table_info rows always expose a string `name` column.
  const cols = database.query("PRAGMA table_info(deployments)").all() as Array<{ name: string }>;
  if (cols.some((column) => column.name === "worker_path") && !cols.some((column) => column.name === "sprout_path")) {
    database.run("ALTER TABLE deployments RENAME COLUMN worker_path TO sprout_path");
  }
  db = database;
  dbConnectedPath = dbPath();
  importLegacyDeployments();
  return database;
}

/** One-time import of the pre-#17 deployments.json; the file is renamed aside afterwards. */
function importLegacyDeployments(): void {
  if ((q1<{ n: number }>("SELECT COUNT(*) AS n FROM deployments")?.n ?? 0) > 0) return;
  let raw: string;
  try {
    raw = readFileSync(legacyDeploymentsPath(), "utf8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  } // a corrupt legacy file must not brick every store call
  if (!Array.isArray(parsed)) return;
  // SAFETY: deployments.json was written by this service's own pre-#17 code with
  // the Deployment[] contract; present() drops any entry missing a string field.
  const legacy = (parsed as Deployment[]).filter(present);

  const now = new Date().toISOString();
  connection().transaction(() => {
    for (const d of legacy) {
      const at =
        Object(d.deployedAt) !== d.deployedAt && d.deployedAt === String(d.deployedAt) && d.deployedAt !== ""
          ? d.deployedAt
          : now;
      run(
        "INSERT OR IGNORE INTO projects (owner_id, name, username, created_at) VALUES (?, ?, ?, ?)",
        d.ownerId,
        d.project,
        d.username,
        at,
      );
      run("INSERT OR IGNORE INTO artifacts (digest, created_at) VALUES (?, ?)", d.artifact, at);
      run(
        `INSERT OR IGNORE INTO deployments (id, owner_id, project, username, hostname, artifact_digest, sprout_path, deployed_at, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        d.id,
        d.ownerId,
        d.project,
        d.username,
        d.hostname,
        d.artifact,
        d.sproutPath,
        at,
        d.active === true ? 1 : 0,
      );
    }
  })();
  try {
    renameSync(legacyDeploymentsPath(), `${legacyDeploymentsPath()}.imported`);
  } catch {
    /* best effort */
  }
}

/** Of the given digests, the ones we still hold a row for that no deployment references. */
function orphanedAmong(digests: string[]): string[] {
  return [...new Set(digests)].filter(
    (digest) =>
      q1("SELECT 1 FROM artifacts WHERE digest = ?", digest) &&
      !q1("SELECT 1 FROM deployments WHERE artifact_digest = ? LIMIT 1", digest),
  );
}

// --- reads -----------------------------------------------------------------

export function ownerDeployments(ownerId: string): Deployment[] {
  return q<DeploymentRow>("SELECT * FROM deployments WHERE owner_id = ? ORDER BY deployed_at DESC", ownerId).map(
    toDeployment,
  );
}

export function projectDeployments(ownerId: string, project: string): Deployment[] {
  return q<DeploymentRow>(
    "SELECT * FROM deployments WHERE owner_id = ? AND project = ? ORDER BY deployed_at DESC",
    ownerId,
    project,
  ).map(toDeployment);
}

export function projectDeployment(ownerId: string, project: string, id: string): Deployment | undefined {
  const row = q1<DeploymentRow>(
    "SELECT * FROM deployments WHERE id = ? AND owner_id = ? AND project = ?",
    id,
    ownerId,
    project,
  );
  return row ? toDeployment(row) : undefined;
}

/** #25 — number of distinct projects an owner holds (for the per-account cap). */
export function ownerProjectCount(ownerId: string): number {
  return q1<{ n: number }>("SELECT COUNT(*) AS n FROM projects WHERE owner_id = ?", ownerId)?.n ?? 0;
}

/**
 * #25 — keep only the newest `keep` versions of a project plus its active one;
 * delete the rest. Returns digests that no deployment references any more so the
 * caller can GC them (`collectArtifacts`).
 */
export function pruneProjectDeployments(ownerId: string, project: string, keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 1) return [];
  return connection().transaction(() => {
    const rows = q<DeploymentRow>(
      "SELECT * FROM deployments WHERE owner_id = ? AND project = ? ORDER BY deployed_at DESC",
      ownerId,
      project,
    );
    const doomed = rows.filter((row) => row.active !== 1).slice(keep);
    if (doomed.length === 0) return [];
    const digests = doomed.map((row) => row.artifact_digest);
    for (const row of doomed) run("DELETE FROM deployments WHERE id = ?", row.id);
    return orphanedAmong(digests);
  })();
}

export function activeProjects(ownerId: string): ProjectSummary[] {
  return q<DeploymentRow>("SELECT * FROM deployments WHERE owner_id = ? AND active = 1", ownerId)
    .map((row) => ({
      name: row.project,
      hostname: row.hostname,
      activeDeploymentId: row.id,
      deployedAt: row.deployed_at,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

// --- admin aggregates (cross-owner) ----------------------------------

export type GlobalStats = {
  owners: number;
  projects: number;
  activeProjects: number;
  deployments: number;
  artifacts: number;
  bannedOwners: number;
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
  ownerId: string;
  username: string;
  projects: number;
  deployments: number;
  activeProjects: number;
  banned: boolean;
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
    ownerId: row.owner_id,
    username: row.username,
    projects: row.projects,
    deployments: row.deployments,
    activeProjects: row.active_projects,
    banned: banned.has(row.owner_id),
  }));
}

// --- mutations (each its own transaction) ---------------------------------

export function recordDeployment(input: Omit<Deployment, "active"> & { resourceIds?: string[] }): Deployment {
  const { resourceIds = [], ...deployment } = input;
  return connection().transaction(() => {
    run(
      "INSERT OR IGNORE INTO projects (owner_id, name, username, created_at) VALUES (?, ?, ?, ?)",
      deployment.ownerId,
      deployment.project,
      deployment.username,
      deployment.deployedAt,
    );
    run(
      "INSERT OR IGNORE INTO artifacts (digest, created_at) VALUES (?, ?)",
      deployment.artifact,
      deployment.deployedAt,
    );
    run("UPDATE deployments SET active = 0 WHERE owner_id = ? AND project = ?", deployment.ownerId, deployment.project);
    run(
      `INSERT INTO deployments (id, owner_id, project, username, hostname, artifact_digest, sprout_path, deployed_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      deployment.id,
      deployment.ownerId,
      deployment.project,
      deployment.username,
      deployment.hostname,
      deployment.artifact,
      deployment.sproutPath,
      deployment.deployedAt,
    );
    for (const resourceId of new Set(resourceIds)) {
      run(
        "INSERT OR IGNORE INTO deployment_resources (deployment_id, resource_id) VALUES (?, ?)",
        deployment.id,
        resourceId,
      );
    }
    return { ...deployment, active: true };
  })();
}

/** #78 — verified + pending custom domain counts per project, in one query. */
export function ownerDomainCounts(ownerId: string): Map<string, number> {
  const rows = q<{ project: string; n: number }>(
    "SELECT project, COUNT(*) AS n FROM custom_domains WHERE owner_id = ? GROUP BY project",
    ownerId,
  );
  return new Map(rows.map((row) => [row.project, row.n]));
}

/**
 * #77 — every owned resource's bound projects in one query, so a list view can
 * show "bound to" without running resourceReferencingProjects per row.
 */
export function ownerResourceProjects(ownerId: string): Map<string, string[]> {
  const rows = q<{ resource_id: string; project: string }>(
    `SELECT DISTINCT dr.resource_id AS resource_id, d.project AS project
       FROM deployment_resources dr
       JOIN deployments d ON d.id = dr.deployment_id
     WHERE d.owner_id = ?
     ORDER BY d.project`,
    ownerId,
  );
  const byResource = new Map<string, string[]>();
  for (const row of rows) byResource.set(row.resource_id, [...(byResource.get(row.resource_id) ?? []), row.project]);
  return byResource;
}

/**
 * #74 — distinct project names that still have a deployment (any version) bound
 * to `resourceId`. Empty means the resource can be deleted.
 */
/**
 * #76 — the storage resources one version was recorded against, for its detail
 * view. Scoped on the *deployment's* owner as well as the resource's, so asking
 * for someone else's deployment id returns nothing rather than the caller's own
 * resources that happen to be bound to it.
 */
export function deploymentResources(ownerId: string, deploymentId: string): StorageResource[] {
  return q<ResourceRow>(
    `SELECT r.* FROM deployment_resources dr
       JOIN deployments d ON d.id = dr.deployment_id
       JOIN resources r ON r.id = dr.resource_id
     WHERE dr.deployment_id = ? AND d.owner_id = ? AND r.owner_id = ?
     ORDER BY r.kind, r.name`,
    deploymentId,
    ownerId,
    ownerId,
  ).map(toResource);
}

export function resourceReferencingProjects(ownerId: string, resourceId: string): string[] {
  return q<{ project: string }>(
    `SELECT DISTINCT d.project FROM deployment_resources dr
       JOIN deployments d ON d.id = dr.deployment_id
     WHERE dr.resource_id = ? AND d.owner_id = ?
     ORDER BY d.project`,
    resourceId,
    ownerId,
  ).map((row) => row.project);
}

/** Returns the now-active deployment, or undefined if `id` is not a version of this project. */
export function activateDeployment(ownerId: string, project: string, id: string): Deployment | undefined {
  return connection().transaction(() => {
    const target = q1<DeploymentRow>(
      "SELECT * FROM deployments WHERE id = ? AND owner_id = ? AND project = ?",
      id,
      ownerId,
      project,
    );
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
    return {
      removed: rows.length,
      hostnames: [...new Set(rows.map((row) => row.hostname))],
      orphanedArtifacts: orphanedAmong(digests),
    };
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
    const row = q1<DeploymentRow>(
      "SELECT * FROM deployments WHERE id = ? AND owner_id = ? AND project = ?",
      id,
      ownerId,
      project,
    );
    if (!row) return undefined;
    if (row.active === 1) return { deleted: false, active: true, orphanedArtifacts: [] };
    run("DELETE FROM deployments WHERE id = ?", id);
    return { deleted: true, active: false, orphanedArtifacts: orphanedAmong([row.artifact_digest]) };
  })();
}

// --- owner bans (admin action; stops the owner's routes) --------------

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
    run("DELETE FROM resources WHERE owner_id = ?", ownerId);
    return {
      removed: rows.length,
      hostnames: [...new Set(rows.map((row) => row.hostname))],
      orphanedArtifacts: orphanedAmong(digests),
    };
  })();
}

// --- custom domains (#2) ----------------------------------------------

export type CustomDomain = {
  hostname: string;
  project: string;
  ownerId: string;
  token: string;
  verifiedAt: string | null;
  createdAt: string;
};
type CustomDomainRow = {
  hostname: string;
  owner_id: string;
  project: string;
  token: string;
  verified_at: string | null;
  created_at: string;
};
const toCustomDomain = (row: CustomDomainRow): CustomDomain => ({
  hostname: row.hostname,
  project: row.project,
  ownerId: row.owner_id,
  token: row.token,
  verifiedAt: row.verified_at,
  createdAt: row.created_at,
});

export function projectCustomDomains(ownerId: string, project: string): CustomDomain[] {
  return q<CustomDomainRow>(
    "SELECT * FROM custom_domains WHERE owner_id = ? AND project = ? ORDER BY hostname",
    ownerId,
    project,
  ).map(toCustomDomain);
}

/** Any owner's claim on `hostname` — hostname is globally unique (the PK). */
export function customDomainByHostname(hostname: string): CustomDomain | undefined {
  const row = q1<CustomDomainRow>("SELECT * FROM custom_domains WHERE hostname = ?", hostname);
  return row ? toCustomDomain(row) : undefined;
}

/** Claims `hostname` for a project, unverified. Returns undefined if it is
 *  already claimed (by this project or anyone else). */
export function addCustomDomain(input: {
  hostname: string;
  ownerId: string;
  project: string;
  token: string;
}): CustomDomain | undefined {
  if (customDomainByHostname(input.hostname)) return undefined;
  const createdAt = new Date().toISOString();
  run(
    "INSERT INTO custom_domains (hostname, owner_id, project, token, verified_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
    input.hostname,
    input.ownerId,
    input.project,
    input.token,
    createdAt,
  );
  return { ...input, verifiedAt: null, createdAt };
}

export function markCustomDomainVerified(ownerId: string, project: string, hostname: string): boolean {
  return (
    run(
      "UPDATE custom_domains SET verified_at = ? WHERE hostname = ? AND owner_id = ? AND project = ? AND verified_at IS NULL",
      new Date().toISOString(),
      hostname,
      ownerId,
      project,
    ) > 0
  );
}

export function deleteCustomDomain(ownerId: string, project: string, hostname: string): boolean {
  return (
    run("DELETE FROM custom_domains WHERE hostname = ? AND owner_id = ? AND project = ?", hostname, ownerId, project) >
    0
  );
}

// --- project secrets (#2) -------------------------------------------------

export function setSecret(ownerId: string, project: string, name: string, value: string): void {
  run(
    `INSERT INTO secrets (owner_id, project, name, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, project, name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
    ownerId,
    project,
    name,
    encryptSecret(value),
    new Date().toISOString(),
  );
}

/** Secret names for one project — never the values. Backs the API list. */
export function secretNames(ownerId: string, project: string): string[] {
  return q<{ name: string }>(
    "SELECT name FROM secrets WHERE owner_id = ? AND project = ? ORDER BY name",
    ownerId,
    project,
  ).map((row) => row.name);
}

export function secretCount(ownerId: string, project: string): number {
  return (
    q1<{ n: number }>("SELECT COUNT(*) AS n FROM secrets WHERE owner_id = ? AND project = ?", ownerId, project)?.n ?? 0
  );
}

export function deleteSecret(ownerId: string, project: string, name: string): boolean {
  return run("DELETE FROM secrets WHERE owner_id = ? AND project = ? AND name = ?", ownerId, project, name) > 0;
}

/** Decrypted `{ NAME: value }` for one project — internal only (writes `secrets.json`). */
function projectSecretValues(ownerId: string, project: string) {
  const rows = q<{ name: string; ciphertext: string }>(
    "SELECT name, ciphertext FROM secrets WHERE owner_id = ? AND project = ?",
    ownerId,
    project,
  );
  return Object.fromEntries(rows.map((row) => [row.name, decryptSecret(row.ciphertext)]));
}

// --- account-level storage resources (#74) ------------------------------
//
// KV namespaces, D1 databases, R2 buckets and queues as first-class owned
// objects with a stable id, independent of any deployment. A later chunk
// resolves `{ binding, id }` config entries against this table at deploy time
// and keys the broker's backing store by `id` instead of digest.
//
// Analytics Engine datasets are deliberately absent — they aren't provisioned
// (a dataset appears on first writeDataPoint) so there's no resource to own.

export type ResourceKind = "kv" | "d1" | "r2" | "queue";
export const RESOURCE_KINDS: readonly ResourceKind[] = ["kv", "d1", "r2", "queue"];

export type StorageResource = { id: string; ownerId: string; kind: ResourceKind; name: string; createdAt: string };
type ResourceRow = { id: string; owner_id: string; kind: string; name: string; created_at: string };
function toResource(row: ResourceRow): StorageResource {
  // SAFETY: `kind` is only ever written by createResource(), whose parameter is
  // typed ResourceKind — the column holds nothing else.
  const kind = row.kind as ResourceKind;
  return { id: row.id, ownerId: row.owner_id, kind, name: row.name, createdAt: row.created_at };
}

export function ownerResources(ownerId: string): StorageResource[] {
  return q<ResourceRow>("SELECT * FROM resources WHERE owner_id = ? ORDER BY kind, name", ownerId).map(toResource);
}

export function resourceById(ownerId: string, id: string): StorageResource | undefined {
  const row = q1<ResourceRow>("SELECT * FROM resources WHERE id = ? AND owner_id = ?", id, ownerId);
  return row ? toResource(row) : undefined;
}

export function resourceCount(ownerId: string): number {
  return q1<{ n: number }>("SELECT COUNT(*) AS n FROM resources WHERE owner_id = ?", ownerId)?.n ?? 0;
}

/** Creates a resource with a fresh `<kind>_<24hex>` id. Throws on a name collision
 *  (the unique index) — callers check first and return 409. */
export function createResource(ownerId: string, kind: ResourceKind, name: string): StorageResource {
  const resource: StorageResource = {
    id: `${kind}_${randomBytes(12).toString("hex")}`,
    ownerId,
    kind,
    name,
    createdAt: new Date().toISOString(),
  };
  run(
    "INSERT INTO resources (id, owner_id, kind, name, created_at) VALUES (?, ?, ?, ?, ?)",
    resource.id,
    ownerId,
    kind,
    name,
    resource.createdAt,
  );
  return resource;
}

export function renameResource(ownerId: string, id: string, name: string): boolean {
  return run("UPDATE resources SET name = ? WHERE id = ? AND owner_id = ?", name, id, ownerId) > 0;
}

export function deleteResource(ownerId: string, id: string): boolean {
  return run("DELETE FROM resources WHERE id = ? AND owner_id = ?", id, ownerId) > 0;
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
const secretsDir = () => resolve(dirname(routesPath()), "secrets");
const secretsFile = (ownerId: string, project: string) =>
  resolve(secretsDir(), `${ownerId}__${project}`.replace(/[^A-Za-z0-9_-]/g, "_") + ".json");

async function writeRouteSnapshot(): Promise<void> {
  // Generated `<project>.<user>.<domain>` hosts, plus every verified custom
  // domain (#2) pointed at whatever version of its project is active right now.
  // owner_id/project ride along so each route can carry its decrypted secrets
  // file path (#2) — the supervisor hands it to the per-deployment broker.
  const rows = q<{ hostname: string; sprout_path: string; owner_id: string; project: string }>(
    `SELECT hostname, sprout_path, owner_id, project FROM deployments
       WHERE active = 1 AND owner_id NOT IN (SELECT owner_id FROM banned_owners)
     UNION
     SELECT cd.hostname AS hostname, d.sprout_path AS sprout_path, d.owner_id AS owner_id, d.project AS project
       FROM custom_domains cd
       JOIN deployments d
         ON d.owner_id = cd.owner_id AND d.project = cd.project AND d.active = 1
       WHERE cd.verified_at IS NOT NULL
         AND cd.owner_id NOT IN (SELECT owner_id FROM banned_owners)
     ORDER BY hostname`,
  );

  await mkdir(secretsDir(), { recursive: true, mode: 0o700 });
  const written = new Map<string, { secretsPath: string; secretsHash: string } | null>(); // "<owner>\0<project>" -> file info
  const routes: Array<{ hostname: string; sproutPath: string; secretsPath?: string; secretsHash?: string }> = [];
  for (const row of rows) {
    const key = `${row.owner_id}\0${row.project}`;
    if (!written.has(key)) {
      const values = projectSecretValues(row.owner_id, row.project);
      const path = secretsFile(row.owner_id, row.project);
      if (Object.keys(values).length > 0) {
        // Deterministic bytes so the hash only moves when a value actually changes.
        const content = JSON.stringify(values, Object.keys(values).sort());
        await writeFile(path, content, { mode: 0o600 });
        written.set(key, {
          secretsPath: path,
          secretsHash: createHash("sha256").update(content).digest("hex").slice(0, 16),
        });
      } else {
        await rm(path, { force: true });
        written.set(key, null);
      }
    }
    const info = written.get(key);
    routes.push(
      info
        ? { hostname: row.hostname, sproutPath: row.sprout_path, ...info }
        : { hostname: row.hostname, sproutPath: row.sprout_path },
    );
  }

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
      digest,
      digest,
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
