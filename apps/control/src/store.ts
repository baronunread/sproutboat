import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { validateManifest } from "@sproutboat/artifact";
import { logPath } from "./logs";
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
// The edge keeps each artifact's broker state in `brokers/<ownerDir>-<digest>/`
// (see runtimeName in logs.ts); same env var it reads, defaulting to where install.sh puts it.
const brokersDir = () => resolve(process.env.SPROUTBOAT_BROKER_STATE_DIR || resolve(dirname(dbPath()), "brokers"));

/**
 * Artifacts live at `artifacts/<ownerDir>/<digest>/`, so two accounts that upload identical bytes
 * never share a directory, a log or broker state. Same hash as `ownerDirName` in
 * services/supervisor/src/resource-layout.ts: keep the two in step.
 */
export const artifactOwnerDir = (ownerId: string): string =>
  createHash("sha256").update(ownerId).digest("hex").slice(0, 32);
export const artifactDir = (ownerId: string, digest: string): string =>
  resolve(artifactRoot(), artifactOwnerDir(ownerId), digest);

/** The pair a deployment's artifact is stored under: the digest alone no longer names a directory. */
export type ArtifactRef = { ownerId: string; digest: string };

let artifactLock: Promise<unknown> = Promise.resolve();
/**
 * Serializes deploy placement against artifact GC and the broker-state sweep,
 * so a collection can never remove a directory a deploy has just reused but not yet recorded.
 * Not re-entrant: do not call it from inside `fn`.
 */
export function withArtifactLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = artifactLock.then(fn);
  artifactLock = next.catch(() => {});
  return next;
}

/**
 * Artifacts a deploy has placed but not yet recorded. The lock above is held only
 * for the quick steps (rename, row insert); a candidate start can take seconds and
 * must not hold every other account's deploy behind it. GC skips these instead.
 */
const inFlight = new Set<string>();
const inFlightKey = (ref: ArtifactRef): string => `${ref.ownerId}\0${ref.digest}`;
export function holdArtifact(ref: ArtifactRef): () => void {
  const key = inFlightKey(ref);
  inFlight.add(key);
  return () => inFlight.delete(key);
}
export const artifactInFlight = (ref: ArtifactRef): boolean => inFlight.has(inFlightKey(ref));

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
  binarySize: number | null;
  compileMs: number | null;
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
  binary_size: number | null;
  compile_ms: number | null;
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
  binarySize: row.binary_size,
  compileMs: row.compile_ms,
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
      owner_id TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (owner_id, digest)
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
      artifact_digest TEXT NOT NULL,
      sprout_path TEXT NOT NULL,
      deployed_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      binary_size INTEGER,
      compile_ms INTEGER,
      FOREIGN KEY (owner_id, artifact_digest) REFERENCES artifacts(owner_id, digest),
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
    -- Several owners may hold an unverified claim on one hostname (each has its own token); at most one verifies.
    CREATE TABLE IF NOT EXISTS custom_domains (
      hostname TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      project TEXT NOT NULL,
      token TEXT NOT NULL,
      verified_at TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (hostname, owner_id),
      FOREIGN KEY (owner_id, project) REFERENCES projects(owner_id, name) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS custom_domains_by_project ON custom_domains(owner_id, project);
    CREATE UNIQUE INDEX IF NOT EXISTS custom_domains_one_verified ON custom_domains(hostname) WHERE verified_at IS NOT NULL;
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
  const addedBinarySize = !cols.some((column) => column.name === "binary_size");
  if (cols.some((column) => column.name === "worker_path") && !cols.some((column) => column.name === "sprout_path")) {
    database.run("ALTER TABLE deployments RENAME COLUMN worker_path TO sprout_path");
  }
  if (addedBinarySize) database.run("ALTER TABLE deployments ADD COLUMN binary_size INTEGER");
  if (!cols.some((column) => column.name === "compile_ms"))
    database.run("ALTER TABLE deployments ADD COLUMN compile_ms INTEGER");
  retireSproutdColumns(database);
  keyArtifactsByOwner(database);
  claimCustomDomainsPerOwner(database);
  db = database;
  dbConnectedPath = dbPath();
  importLegacyDeployments();
  if (addedBinarySize) backfillBinarySizes(database);
  if (migrateArtifactLayout(database)) {
    // The edge reloads routes.json on change: hand it the new sprout paths.
    void syncRoutes().catch((error) => console.error("store: route sync after artifact migration failed", error));
  }
  return database;
}

/**
 * Releases 0.13.0 and 0.13.1 added two columns to `projects` (runtime, runtime_limits) and two to `deployments`
 * (sproutd_vid, fallback_reason) for the optional sproutd runtime, which Community no longer has. Drop them so the
 * schema is the one a fresh install gets. Nothing here reads them, and an older release adds them back on its own
 * if you roll back. A database that really holds a sproutd project or version keeps the columns: dropping them would
 * turn those rows into supervisor rows that cannot start.
 */
function retireSproutdColumns(database: Database): void {
  const columns = (table: string): Set<string> => {
    // SAFETY: PRAGMA table_info rows always expose a string `name` column.
    const rows = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((column) => column.name));
  };
  const projectCols = columns("projects");
  const deploymentCols = columns("deployments");
  const stale: Array<{ table: string; column: string }> = [];
  for (const column of ["runtime", "runtime_limits"])
    if (projectCols.has(column)) stale.push({ table: "projects", column });
  for (const column of ["sproutd_vid", "fallback_reason"])
    if (deploymentCols.has(column)) stale.push({ table: "deployments", column });
  if (stale.length === 0) return;
  const inUse =
    (projectCols.has("runtime") &&
      database.query("SELECT 1 FROM projects WHERE runtime = 'sproutd' LIMIT 1").get() !== null) ||
    (deploymentCols.has("sproutd_vid") &&
      database.query("SELECT 1 FROM deployments WHERE sproutd_vid IS NOT NULL LIMIT 1").get() !== null);
  if (inUse) {
    console.warn(
      "store: this database has projects or versions on sproutd, which Sproutboat Community does not run. " +
        "They are left untouched (and will not serve); redeploy those projects on the supervisor.",
    );
    return;
  }
  for (const { table, column } of stale) database.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

/** custom_domains used to key on hostname alone, so one unverified claim blocked everyone else for good. */
function claimCustomDomainsPerOwner(database: Database): void {
  const found = database.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'custom_domains'").get();
  // SAFETY: sqlite_master.sql is the CREATE statement text for an existing table.
  if (!/hostname TEXT PRIMARY KEY/.test((found as { sql: string } | null)?.sql ?? "")) return;
  database.transaction(() => {
    database.exec(`
      CREATE TABLE custom_domains_rebuilt (
        hostname TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        project TEXT NOT NULL,
        token TEXT NOT NULL,
        verified_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (hostname, owner_id),
        FOREIGN KEY (owner_id, project) REFERENCES projects(owner_id, name) ON DELETE CASCADE
      );
      INSERT INTO custom_domains_rebuilt SELECT hostname, owner_id, project, token, verified_at, created_at FROM custom_domains;
      DROP TABLE custom_domains;
      ALTER TABLE custom_domains_rebuilt RENAME TO custom_domains;
      CREATE INDEX IF NOT EXISTS custom_domains_by_project ON custom_domains(owner_id, project);
      CREATE UNIQUE INDEX IF NOT EXISTS custom_domains_one_verified ON custom_domains(hostname) WHERE verified_at IS NOT NULL;
    `);
  })();
}

/**
 * Artifacts were keyed by digest alone, which let two accounts share one row and one directory. Rebuild the
 * table keyed by (owner_id, digest) with the owner taken from the deployments that reference each digest, and
 * rebuild `deployments` so its foreign key points at the new key. Rows no deployment references are dropped
 * (their owner is unknown). SQLite cannot alter a primary key, so this is the documented table rebuild, with
 * foreign keys off while it runs.
 */
function keyArtifactsByOwner(database: Database): void {
  // SAFETY: PRAGMA table_info rows always expose a string `name` column.
  const cols = database.query("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
  if (cols.some((column) => column.name === "owner_id")) return;
  const found = database.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deployments'").get();
  // SAFETY: sqlite_master.sql is the CREATE statement text for an existing table.
  const sql = (found as { sql: string } | null)?.sql ?? "";
  const oldReference = /artifact_digest TEXT NOT NULL REFERENCES artifacts\(digest\)/;
  const projectKey = "FOREIGN KEY (owner_id, project)";
  if (!oldReference.test(sql) || !sql.includes(projectKey))
    throw new Error("store: unrecognised deployments schema; cannot key artifacts by owner");
  const rebuilt = sql
    .replace(oldReference, "artifact_digest TEXT NOT NULL")
    .replace(
      projectKey,
      `FOREIGN KEY (owner_id, artifact_digest) REFERENCES artifacts(owner_id, digest),\n      ${projectKey}`,
    )
    .replace(/CREATE TABLE (IF NOT EXISTS )?"?deployments"?/, "CREATE TABLE deployments_rebuilt");
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE artifacts_rebuilt (
          owner_id TEXT NOT NULL,
          digest TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (owner_id, digest)
        );
        INSERT INTO artifacts_rebuilt (owner_id, digest, created_at)
          SELECT d.owner_id, d.artifact_digest, MIN(a.created_at)
            FROM deployments d JOIN artifacts a ON a.digest = d.artifact_digest
            GROUP BY d.owner_id, d.artifact_digest;
      `);
      database.exec(rebuilt);
      database.exec(`
        INSERT INTO deployments_rebuilt SELECT * FROM deployments;
        DROP TABLE deployments;
        DROP TABLE artifacts;
        ALTER TABLE artifacts_rebuilt RENAME TO artifacts;
        ALTER TABLE deployments_rebuilt RENAME TO deployments;
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_deployment_per_project
          ON deployments(owner_id, project) WHERE active = 1;
        CREATE INDEX IF NOT EXISTS deployments_by_owner ON deployments(owner_id);
        CREATE INDEX IF NOT EXISTS deployments_by_artifact ON deployments(artifact_digest);
      `);
    })();
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * Move an existing install's artifacts from `artifacts/<digest>/` to `artifacts/<ownerDir>/<digest>/`, with the
 * broker state (`brokers/<digest>` -> `brokers/<ownerDir>-<digest>`) and sprout log
 * (`logs/sprouts/<digest>.log` -> `<ownerDir>-<digest>.log`) that go with them. A directory several accounts
 * share is copied once per account, then removed. Each copy is skipped when its target already exists and the
 * legacy source is removed only after every copy is in place, with the database update last, so a crash at
 * any point is finished by the next start. Returns whether any row was rewritten.
 */
export function migrateArtifactLayout(database: Database = connection()): boolean {
  // SAFETY: SQLite returns exactly the columns selected here.
  const rows = database.query("SELECT id, owner_id, artifact_digest, sprout_path FROM deployments").all() as Array<{
    id: string;
    owner_id: string;
    artifact_digest: string;
    sprout_path: string;
  }>;
  const legacy = rows.filter(
    (row) =>
      /^[a-f0-9]{64}$/.test(row.artifact_digest) &&
      row.sprout_path === resolve(artifactRoot(), row.artifact_digest, "sprout"),
  );
  if (legacy.length === 0) return false;
  const owners = new Map<string, Set<string>>();
  for (const row of legacy) {
    const set = owners.get(row.artifact_digest) ?? new Set<string>();
    owners.set(row.artifact_digest, set.add(row.owner_id));
  }
  const logs = resolve(dirname(logPath()), "sprouts");

  // Copy a legacy path to each target that does not exist yet (via a `.migrating` sibling, so a crash never
  // leaves a half-copied target), then remove the legacy path.
  const spread = (from: string, targets: string[], what: string, directory: boolean) => {
    if (!existsSync(from)) return;
    for (const to of targets) {
      if (existsSync(to)) continue;
      const partial = `${to}.migrating`;
      mkdirSync(dirname(to), { recursive: true, mode: 0o750 });
      rmSync(partial, { recursive: true, force: true });
      cpSync(from, partial, { recursive: directory, preserveTimestamps: true });
      renameSync(partial, to);
      console.log(`store: copied ${what} ${from} -> ${to}`);
    }
    rmSync(from, { recursive: true, force: true });
    console.log(`store: removed legacy ${what} ${from}`);
  };

  for (const [digest, set] of owners) {
    const ownerIds = [...set];
    const named = (ownerId: string) => `${artifactOwnerDir(ownerId)}-${digest}`;
    spread(
      resolve(artifactRoot(), digest),
      ownerIds.map((ownerId) => artifactDir(ownerId, digest)),
      "artifact",
      true,
    );
    spread(
      resolve(brokersDir(), digest),
      ownerIds.map((ownerId) => resolve(brokersDir(), named(ownerId))),
      "broker state",
      true,
    );
    spread(
      resolve(logs, `${digest}.log`),
      ownerIds.map((ownerId) => resolve(logs, `${named(ownerId)}.log`)),
      "sprout log",
      false,
    );
  }
  const update = database.query("UPDATE deployments SET sprout_path = ? WHERE id = ?");
  database.transaction(() => {
    for (const row of legacy) update.run(resolve(artifactDir(row.owner_id, row.artifact_digest), "sprout"), row.id);
  })();
  console.log(`store: moved ${legacy.length} deployment(s) to per-owner artifact directories`);
  return true;
}

const legacyOrOwnerDir = (ownerId: string, digest: string): string =>
  existsSync(artifactDir(ownerId, digest)) ? artifactDir(ownerId, digest) : resolve(artifactRoot(), digest);

/** Read each retained artifact once when adding the size column to an old store. */
function backfillBinarySizes(database: Database): void {
  // SAFETY: SQLite returns exactly the id and artifact_digest columns selected here.
  const rows = database
    .query("SELECT id, owner_id, artifact_digest FROM deployments WHERE binary_size IS NULL")
    .all() as Array<{ id: string; owner_id: string; artifact_digest: string }>;
  const update = database.query("UPDATE deployments SET binary_size = ? WHERE id = ?");
  for (const row of rows) {
    if (!/^[a-f0-9]{64}$/.test(row.artifact_digest)) continue;
    try {
      const manifest = validateManifest(
        // Still the pre-owner layout at this point in a first open; migrateArtifactLayout moves it right after.
        JSON.parse(readFileSync(resolve(legacyOrOwnerDir(row.owner_id, row.artifact_digest), "manifest.json"), "utf8")),
      );
      if (manifest.ok) update.run(manifest.value.binarySize, row.id);
    } catch {
      // A missing or unreadable retained artifact remains unavailable in the list.
    }
  }
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
      run("INSERT OR IGNORE INTO artifacts (owner_id, digest, created_at) VALUES (?, ?, ?)", d.ownerId, d.artifact, at);
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

/** Of the given artifacts, the ones we still hold a row for that none of the owner's deployments reference. */
function orphanedAmong(refs: ArtifactRef[]): ArtifactRef[] {
  const seen = new Set<string>();
  return refs.filter(({ ownerId, digest }) => {
    const key = `${ownerId}\0${digest}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return (
      q1("SELECT 1 FROM artifacts WHERE owner_id = ? AND digest = ?", ownerId, digest) &&
      !q1("SELECT 1 FROM deployments WHERE owner_id = ? AND artifact_digest = ? LIMIT 1", ownerId, digest)
    );
  });
}
const refOf = (row: DeploymentRow): ArtifactRef => ({ ownerId: row.owner_id, digest: row.artifact_digest });

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
export function pruneProjectDeployments(ownerId: string, project: string, keep: number): ArtifactRef[] {
  if (!Number.isInteger(keep) || keep < 1) return [];
  return connection().transaction(() => {
    const rows = q<DeploymentRow>(
      "SELECT * FROM deployments WHERE owner_id = ? AND project = ? ORDER BY deployed_at DESC",
      ownerId,
      project,
    );
    const doomed = rows.filter((row) => row.active !== 1).slice(keep);
    if (doomed.length === 0) return [];
    const refs = doomed.map(refOf);
    for (const row of doomed) run("DELETE FROM deployments WHERE id = ?", row.id);
    return orphanedAmong(refs);
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

export function recordDeployment(
  input: Omit<Deployment, "active" | "binarySize" | "compileMs"> & {
    binarySize?: number | null;
    compileMs?: number | null;
    resourceIds?: string[];
  },
): Deployment {
  const { resourceIds = [], ...fields } = input;
  const deployment = { ...fields, binarySize: fields.binarySize ?? null, compileMs: fields.compileMs ?? null };
  return connection().transaction(() => {
    run(
      "INSERT OR IGNORE INTO projects (owner_id, name, username, created_at) VALUES (?, ?, ?, ?)",
      deployment.ownerId,
      deployment.project,
      deployment.username,
      deployment.deployedAt,
    );
    run(
      "INSERT OR IGNORE INTO artifacts (owner_id, digest, created_at) VALUES (?, ?, ?)",
      deployment.ownerId,
      deployment.artifact,
      deployment.deployedAt,
    );
    run("UPDATE deployments SET active = 0 WHERE owner_id = ? AND project = ?", deployment.ownerId, deployment.project);
    run(
      `INSERT INTO deployments (id, owner_id, project, username, hostname, artifact_digest, sprout_path, deployed_at, active, binary_size, compile_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      deployment.id,
      deployment.ownerId,
      deployment.project,
      deployment.username,
      deployment.hostname,
      deployment.artifact,
      deployment.sproutPath,
      deployment.deployedAt,
      deployment.binarySize,
      deployment.compileMs,
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

export type ProjectDeletion = { removed: number; hostnames: string[]; orphanedArtifacts: ArtifactRef[] };

/** Deletes one project and all its versions. Returns hostnames to unroute and digests now unreferenced. */
export function deleteProject(ownerId: string, project: string): ProjectDeletion {
  return connection().transaction(() => {
    const rows = q<DeploymentRow>("SELECT * FROM deployments WHERE owner_id = ? AND project = ?", ownerId, project);
    const refs = rows.map(refOf);
    run("DELETE FROM projects WHERE owner_id = ? AND name = ?", ownerId, project); // cascades to deployments
    return {
      removed: rows.length,
      hostnames: [...new Set(rows.map((row) => row.hostname))],
      orphanedArtifacts: orphanedAmong(refs),
    };
  })();
}

export type DeploymentDeletion = { deleted: boolean; active: boolean; orphanedArtifacts: ArtifactRef[] };

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
    return { deleted: true, active: false, orphanedArtifacts: orphanedAmong([refOf(row)]) };
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
    const refs = rows.map(refOf);
    run("DELETE FROM projects WHERE owner_id = ?", ownerId);
    run("DELETE FROM resources WHERE owner_id = ?", ownerId);
    return {
      removed: rows.length,
      hostnames: [...new Set(rows.map((row) => row.hostname))],
      orphanedArtifacts: orphanedAmong(refs),
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
/** An unverified claim older than this no longer holds its hostname. */
export const DOMAIN_CLAIM_TTL_MS = 24 * 60 * 60_000;
const claimIsStale = (row: CustomDomainRow): boolean =>
  row.verified_at === null && Date.parse(row.created_at) < Date.now() - DOMAIN_CLAIM_TTL_MS;

/** Lapsed unverified claims on `hostname`, dropped so the hostname is free for the next claimant. */
function dropStaleClaims(hostname: string): void {
  const cutoff = new Date(Date.now() - DOMAIN_CLAIM_TTL_MS).toISOString();
  run("DELETE FROM custom_domains WHERE hostname = ? AND verified_at IS NULL AND created_at < ?", hostname, cutoff);
}

/**
 * Who holds `hostname` right now: its verified owner if there is one, otherwise the newest live unverified claim.
 * `blocking` is true only for a verified holder, since that is the only claim another account cannot displace.
 */
export function customDomainByHostname(hostname: string): CustomDomain | undefined {
  const rows = q<CustomDomainRow>("SELECT * FROM custom_domains WHERE hostname = ? ORDER BY created_at DESC", hostname);
  const live = rows.filter((row) => !claimIsStale(row));
  const row = live.find((entry) => entry.verified_at !== null) ?? live[0];
  return row ? toCustomDomain(row) : undefined;
}
export type ClaimResult =
  | { claimed: CustomDomain }
  | { claimed?: undefined; reason: "verified-elsewhere" | "already-yours" };

/**
 * Claim `hostname` for a project. A verified holder keeps it. Unverified claims by other accounts do not block
 * the claim (whoever proves the TXT record first wins), and ones older than 24 hours are dropped outright.
 */
export function addCustomDomain(input: {
  hostname: string;
  ownerId: string;
  project: string;
  token: string;
}): CustomDomain | undefined {
  return claimCustomDomain(input).claimed;
}

export function claimCustomDomain(input: {
  hostname: string;
  ownerId: string;
  project: string;
  token: string;
}): ClaimResult {
  return connection().transaction((): ClaimResult => {
    dropStaleClaims(input.hostname);
    if (q1("SELECT 1 FROM custom_domains WHERE hostname = ? AND verified_at IS NOT NULL", input.hostname))
      return { reason: "verified-elsewhere" };
    if (q1("SELECT 1 FROM custom_domains WHERE hostname = ? AND owner_id = ?", input.hostname, input.ownerId))
      return { reason: "already-yours" };
    const createdAt = new Date().toISOString();
    run(
      "INSERT INTO custom_domains (hostname, owner_id, project, token, verified_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
      input.hostname,
      input.ownerId,
      input.project,
      input.token,
      createdAt,
    );
    return { claimed: { ...input, verifiedAt: null, createdAt } };
  })();
}

/**
 * Mark a claim verified after its TXT record matched. Any other account's unverified claim on the same
 * hostname is superseded (removed). Returns false when the claim is gone or another account verified first.
 */
export function markCustomDomainVerified(ownerId: string, project: string, hostname: string): boolean {
  return connection().transaction(() => {
    if (q1("SELECT 1 FROM custom_domains WHERE hostname = ? AND verified_at IS NOT NULL", hostname)) return false;
    const marked =
      run(
        "UPDATE custom_domains SET verified_at = ? WHERE hostname = ? AND owner_id = ? AND project = ? AND verified_at IS NULL",
        new Date().toISOString(),
        hostname,
        ownerId,
        project,
      ) > 0;
    if (marked) run("DELETE FROM custom_domains WHERE hostname = ? AND owner_id <> ?", hostname, ownerId);
    return marked;
  })();
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

/** Every hostname routed to a project: the generated one and each verified custom domain. */
export function projectHosts(ownerId: string, project: string): string[] {
  const generated = q<{ hostname: string }>(
    "SELECT hostname FROM deployments WHERE owner_id = ? AND project = ? AND active = 1",
    ownerId,
    project,
  ).map((row) => row.hostname);
  const custom = q<{ hostname: string }>(
    "SELECT hostname FROM custom_domains WHERE owner_id = ? AND project = ? AND verified_at IS NOT NULL",
    ownerId,
    project,
  ).map((row) => row.hostname);
  return [...new Set([...generated, ...custom])].sort();
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

/**
 * #48 — the service bindings a deployment declares, read from the artifact
 * beside its sprout.
 *
 * Bindings are a sidecar of the immutable artifact rather than a database
 * column, and this snapshot is rewritten on deploy/rollback/delete rather than
 * per request, so reading the file here is cheaper than a schema migration.
 * Anything unreadable or malformed yields []: the project still routes, its
 * service calls just report the target as undeployed.
 */
type BindingsJson = null | boolean | number | string | BindingsJson[] | { readonly [key: string]: BindingsJson };
const isJsonObj = (value: BindingsJson | undefined): value is { readonly [key: string]: BindingsJson } =>
  value !== null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function);
const isJsonStr = (value: BindingsJson | undefined): value is string =>
  Object(value) !== value && value === String(value);

function declaredServices(sproutPath: string): Array<{ binding: string; service: string }> {
  let parsed: BindingsJson;
  try {
    // SAFETY: bindings.json was validated by artifact.ts before this deployment
    // could be stored; every field below is still read through a guard.
    parsed = JSON.parse(readFileSync(resolve(dirname(sproutPath), "bindings.json"), "utf8")) as BindingsJson;
  } catch {
    return []; // no sidecar, unreadable, or not JSON
  }
  if (!isJsonObj(parsed) || !Array.isArray(parsed.services)) return [];
  return parsed.services.flatMap((entry) =>
    isJsonObj(entry) && isJsonStr(entry.binding) && isJsonStr(entry.service)
      ? [{ binding: entry.binding, service: entry.service }]
      : [],
  );
}

export type RouteEntry = {
  hostname: string;
  sproutPath: string;
  secretsPath?: string;
  secretsHash?: string;
  services?: Record<string, string>;
  ownerId: string;
  r2ResourceIds: string[];
  doStoreId: string;
};
type RouteRow = { hostname: string; sprout_path: string; owner_id: string; project: string };

/**
 * One routes.json entry per row: the runtime context the edge starts a sprout
 * with. #141 stages a candidate from the same entry, so the process it starts
 * is the one the route later points at. Per-snapshot caches live in the closure.
 */
function routeContext() {
  // #48: canonical hostname of every active deployment, keyed by owner and
  // project, so a service binding can be resolved to something the edge routes.
  // Same-owner only: on a multi-user box, naming another user's project must not
  // be a way to call it.
  const activeHosts = new Map<string, string>();
  for (const row of q<{ owner_id: string; project: string; hostname: string }>(
    "SELECT owner_id, project, hostname FROM deployments WHERE active = 1",
  )) {
    activeHosts.set(`${row.owner_id}\0${row.project}`, row.hostname);
  }
  const written = new Map<string, { secretsPath: string; secretsHash: string } | null>(); // "<owner>\0<project>" -> file info
  const r2Resources = new Map<string, string[]>();
  return {
    async entry(row: RouteRow): Promise<RouteEntry> {
      const key = `${row.owner_id}\0${row.project}`;
      if (!written.has(key)) {
        await mkdir(secretsDir(), { recursive: true, mode: 0o700 });
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
      // Resolve each declared service to the target's hostname. An entry that
      // resolves to nothing is left out on purpose: the broker then reports the
      // target as undeployed, which is what it is.
      const services: Record<string, string> = {};
      for (const entry of declaredServices(row.sprout_path)) {
        const host = activeHosts.get(`${row.owner_id}\0${entry.service}`);
        if (host) services[entry.binding] = host;
      }
      let r2ResourceIds = r2Resources.get(row.owner_id);
      if (!r2ResourceIds) {
        r2ResourceIds = [];
        for (const resource of ownerResources(row.owner_id))
          if (resource.kind === "r2") r2ResourceIds.push(resource.id);
        r2Resources.set(row.owner_id, r2ResourceIds);
      }
      // #207: Durable Object state is keyed by owner + project, not by the
      // deployment, so it survives redeploys. Derived, so it needs no migration.
      const doStoreId = `do_${createHash("sha256").update(`${row.owner_id}\0${row.project}`).digest("hex").slice(0, 24)}`;
      const base = {
        hostname: row.hostname,
        sproutPath: row.sprout_path,
        ownerId: row.owner_id,
        r2ResourceIds,
        doStoreId,
      };
      const route = info ? { ...base, ...info } : base;
      return Object.keys(services).length > 0 ? { ...route, services } : route;
    },
  };
}

/** #141: the route entry a not-yet-active deployment would get. */
export function candidateRoute(deployment: Pick<Deployment, "hostname" | "sproutPath" | "ownerId" | "project">) {
  return routeContext().entry({
    hostname: deployment.hostname,
    sprout_path: deployment.sproutPath,
    owner_id: deployment.ownerId,
    project: deployment.project,
  });
}

async function writeRouteSnapshot(): Promise<void> {
  // Generated `<project>.<user>.<domain>` hosts, plus every verified custom
  // domain (#2) pointed at whatever version of its project is active right now.
  // owner_id/project ride along so each route can carry its decrypted secrets
  // file path (#2) — the supervisor hands it to the per-deployment broker.
  const rows = q<RouteRow>(
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

  const context = routeContext();
  const routes = await Promise.all(rows.map((row) => context.entry(row)));

  await mkdir(dirname(routesPath()), { recursive: true });
  const temporary = `${routesPath()}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(routes, null, 2)}\n`, { mode: 0o640 });
  await rename(temporary, routesPath());
}

/**
 * Removes the on-disk artifact directory for each artifact that is no longer
 * referenced by any of its owner's deployments, then drops its row. Never throws:
 * it returns the artifacts it could not remove so the caller can report partial
 * failure instead of claiming success. Holds the artifact lock, so it cannot
 * interleave with a deploy placing the same digest.
 */
export function collectArtifacts(refs: ArtifactRef[]): Promise<{ removed: string[]; failed: string[] }> {
  return withArtifactLock(async () => {
    const removed: string[] = [];
    const failed: string[] = [];
    const seen = new Set<string>();
    for (const { ownerId, digest } of refs) {
      const key = `${ownerId}\0${digest}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Placed by a deploy that is still starting its candidate: leave it for a later collection.
      if (artifactInFlight({ ownerId, digest })) continue;
      if (!/^[a-f0-9]{64}$/.test(digest)) {
        // junk input is not our problem; a real digest we still hold is
        if (q1("SELECT 1 FROM artifacts WHERE owner_id = ? AND digest = ?", ownerId, digest)) failed.push(digest);
        continue;
      }
      // Drop the row first, and only while none of the owner's deployments references it, then the
      // bytes. A failed rm leaves the row gone and the dir orphaned for a future sweep, not a broken deployment.
      const dropped = run(
        "DELETE FROM artifacts WHERE owner_id = ? AND digest = ? AND NOT EXISTS (SELECT 1 FROM deployments WHERE owner_id = ? AND artifact_digest = ?)",
        ownerId,
        digest,
        ownerId,
        digest,
      );
      if (!dropped) continue;
      try {
        await rm(artifactDir(ownerId, digest), { recursive: true, force: true });
        removed.push(digest);
      } catch {
        failed.push(digest);
      }
    }
    await sweepBrokerStateLocked();
    return { removed, failed };
  });
}

/**
 * Remove `brokers/<ownerDir>-<digest>/` for every artifact no row holds any more:
 * the per-deployment KV / D1 / queue state of a version that can no longer be
 * routed or rolled back to. It used to be kept forever, one copy per deploy.
 * Skips anything changed in the last 10 minutes, because a deploy stages its
 * candidate (which creates this dir) before it records the artifact. Also clears
 * abandoned `.upload-*` directories. Never throws.
 */
export function sweepBrokerState(): Promise<string[]> {
  return withArtifactLock(sweepBrokerStateLocked);
}

async function sweepBrokerStateLocked(): Promise<string[]> {
  await sweepUploads();
  const cutoff = Date.now() - 10 * 60_000;
  const held = (name: string): boolean => {
    const [ownerDir, digest] = [name.slice(0, 32), name.slice(33)];
    return q<{ owner_id: string }>("SELECT owner_id FROM artifacts WHERE digest = ?", digest).some(
      (row) => artifactOwnerDir(row.owner_id) === ownerDir,
    );
  };
  const names = (await readdir(brokersDir()).catch((): string[] => [])).filter(
    (name) => /^[a-f0-9]{32}-[a-f0-9]{64}$/.test(name) && !held(name),
  );
  const removed = await Promise.all(
    names.map(async (name) => {
      const path = resolve(brokersDir(), name);
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs > cutoff) return null;
      return rm(path, { recursive: true, force: true }).then(
        () => name,
        () => null,
      );
    }),
  );
  return removed.filter((name): name is string => name !== null);
}

/**
 * Remove `.upload-*` staging directories a crashed or aborted deploy left in the artifacts root. One hour
 * is far longer than any upload takes. Never throws; returns the names it removed.
 */
export async function sweepUploads(maxAgeMs = 60 * 60_000): Promise<string[]> {
  const cutoff = Date.now() - maxAgeMs;
  const names = (await readdir(artifactRoot()).catch((): string[] => [])).filter((name) => name.startsWith(".upload-"));
  const removed = await Promise.all(
    names.map(async (name) => {
      const path = resolve(artifactRoot(), name);
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs > cutoff) return null;
      return rm(path, { recursive: true, force: true }).then(
        () => name,
        () => null,
      );
    }),
  );
  return removed.filter((name): name is string => name !== null);
}

/** The shared connection, for tests that need to age rows. */
export function storeDatabase(): Database {
  return connection();
}

/** Test/ops helper: close and forget the connection. */
export function closeStore(): void {
  db?.close();
  db = undefined;
}
