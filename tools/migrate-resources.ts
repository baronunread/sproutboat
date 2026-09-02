#!/usr/bin/env bun
/**
 * #74 one-shot migration. For every active deployment that binds a KV / D1 / R2
 * / queue by bare name, register an account-level resource for it and copy the
 * existing per-deployment store into the new per-resource file, so the data is
 * already there when the owner updates `sproutboat.jsonc` to `{ binding, id }`
 * and redeploys.
 *
 * Idempotent: a name that already has a resource is left alone; a target file
 * that already exists is not overwritten. Run with the same environment as the
 * control plane (SPROUTBOAT_DATABASE_PATH, SPROUTBOAT_LOG_PATH, and optionally
 * SPROUTBOAT_BROKER_STATE_DIR / SPROUTBOAT_RESOURCE_DIR).
 *
 *   bun tools/migrate-resources.ts [--dry-run]
 */
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

type Kind = "kv" | "d1" | "r2" | "queue";
type BindingNames = { kv: string[]; r2: string[]; queues: string[]; d1: string[] };

/** Per KV/R2/queue kind: the table and the SELECT that re-partitions every
 *  column onto the new resource id (bound as `?1`, old name as `?2`). */
const TABLES = {
  kv: { table: "kv", select: "SELECT ?1 AS ns, key, value FROM src.kv WHERE ns = ?2" },
  r2: {
    table: "r2",
    select: "SELECT ?1 AS bucket, key, body, size, etag, uploaded, http_json, custom_json FROM src.r2 WHERE bucket = ?2",
  },
  queue: {
    table: "mq",
    select: "SELECT ?1 AS queue, id, body, visible_at, attempts, dead FROM src.mq WHERE queue = ?2",
  },
} satisfies Record<Exclude<Kind, "d1">, { table: string; select: string }>;

type RawBindings = { kv?: unknown; r2?: unknown; queues?: unknown; d1?: unknown };

function bindingNames(raw: string): BindingNames {
  const parsed = JSON.parse(raw);
  // SAFETY: bindings.json is written by this project's own build. We read only
  // these four fields and keep just their string entries.
  const record = (Object(parsed) === parsed ? parsed : {}) as RawBindings;
  const onlyStrings = (entries: unknown[]): string[] => entries.filter((entry): entry is string => entry === String(entry));
  return {
    kv: Array.isArray(record.kv) ? onlyStrings(record.kv) : [],
    r2: Array.isArray(record.r2) ? onlyStrings(record.r2) : [],
    queues: Array.isArray(record.queues) ? onlyStrings(record.queues) : [],
    d1: Array.isArray(record.d1) ? onlyStrings(record.d1) : [],
  };
}

const dryRun = process.argv.includes("--dry-run");
const dbPath = process.env.SPROUTBOAT_DATABASE_PATH || "/var/lib/sproutboat/sproutboat.sqlite";
const logPath = process.env.SPROUTBOAT_LOG_PATH;
const brokerBase = process.env.SPROUTBOAT_BROKER_STATE_DIR || (logPath ? resolve(dirname(logPath), "brokers") : "");
const resourceDir = process.env.SPROUTBOAT_RESOURCE_DIR || (logPath ? resolve(dirname(logPath), "resources") : "");
if (!brokerBase || !resourceDir) {
  console.error("set SPROUTBOAT_LOG_PATH (or SPROUTBOAT_BROKER_STATE_DIR + SPROUTBOAT_RESOURCE_DIR)");
  process.exit(2);
}
if (!dryRun) mkdirSync(resourceDir, { recursive: true });

const db = new Database(dbPath);

function openStore(path: string): Database {
  const conn = new Database(path, { create: true });
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
  conn.exec("CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (ns, key))");
  conn.exec(
    "CREATE TABLE IF NOT EXISTS r2 (bucket TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, size INTEGER NOT NULL, " +
      "etag TEXT NOT NULL, uploaded TEXT NOT NULL, http_json TEXT NOT NULL DEFAULT '{}', custom_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (bucket, key))",
  );
  conn.exec(
    "CREATE TABLE IF NOT EXISTS mq (queue TEXT NOT NULL, id TEXT PRIMARY KEY, body TEXT NOT NULL, " +
      "visible_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, dead INTEGER NOT NULL DEFAULT 0)",
  );
  return conn;
}

/** Copy one binding's rows from the deployment's `state.sqlite` into `<id>.sqlite`. */
function copyRows(kind: Exclude<Kind, "d1">, oldState: string, target: string, name: string, id: string): void {
  const spec = TABLES[kind];
  const dest = openStore(target);
  dest.exec(`ATTACH DATABASE '${oldState.replaceAll("'", "''")}' AS src`);
  dest.query(`INSERT OR REPLACE INTO ${spec.table} ${spec.select}`).run(id, name);
  dest.exec("DETACH DATABASE src");
  dest.close();
}

type DeploymentRow = { id: string; owner_id: string; project: string; sprout_path: string };
const active = db.query<DeploymentRow, []>(
  "SELECT id, owner_id, project, sprout_path FROM deployments WHERE active = 1",
).all();

let created = 0;
let copied = 0;
const perProject = new Map<string, string[]>();
const note = (project: string, line: string): void => {
  const lines = perProject.get(project) ?? [];
  lines.push(line);
  perProject.set(project, lines);
};

for (const deployment of active) {
  const workerDir = dirname(deployment.sprout_path);
  const bindingsPath = resolve(workerDir, "bindings.json");
  if (!existsSync(bindingsPath)) continue;

  let names: ReturnType<typeof bindingNames>;
  try { names = bindingNames(readFileSync(bindingsPath, "utf8")); }
  catch { console.warn(`skip ${deployment.project}: unreadable bindings.json`); continue; }

  const stateDir = resolve(brokerBase, basename(workerDir));
  const oldState = resolve(stateDir, "state.sqlite");
  const jobs: Array<{ kind: Kind; name: string }> = [
    ...names.kv.map((name) => ({ kind: "kv" as const, name })),
    ...names.r2.map((name) => ({ kind: "r2" as const, name })),
    ...names.queues.map((name) => ({ kind: "queue" as const, name })),
    ...names.d1.map((name) => ({ kind: "d1" as const, name })),
  ];

  for (const job of jobs) {
    const existing = db.query<{ id: string }, [string, string, string]>(
      "SELECT id FROM resources WHERE owner_id = ? AND kind = ? AND name = ?",
    ).get(deployment.owner_id, job.kind, job.name);
    const id = existing?.id ?? `${job.kind}_${randomBytes(12).toString("hex")}`;
    note(deployment.project, `  ${job.kind}: { binding: "${job.name}", id: "${id}" }`);

    if (!dryRun) {
      if (!existing) {
        db.query("INSERT INTO resources (id, owner_id, kind, name, created_at) VALUES (?, ?, ?, ?, ?)").run(
          id, deployment.owner_id, job.kind, job.name, new Date().toISOString());
      }
      db.query("INSERT OR IGNORE INTO deployment_resources (deployment_id, resource_id) VALUES (?, ?)").run(deployment.id, id);
    }
    if (!existing) created++;

    const target = resolve(resourceDir, `${id}.sqlite`);
    if (existsSync(target)) continue; // already migrated

    if (job.kind === "d1") {
      const source = resolve(stateDir, "d1", `${job.name}.sqlite`);
      if (!existsSync(source)) continue;
      if (!dryRun) copyFileSync(source, target);
      copied++;
      continue;
    }
    if (!existsSync(oldState)) continue;
    if (!dryRun) copyRows(job.kind, oldState, target, job.name, id);
    copied++;
  }
}

console.log(`${dryRun ? "[dry-run] " : ""}${created} resource(s) registered, ${copied} store(s) copied\n`);
for (const [project, lines] of perProject) {
  console.log(`${project} — set these in sproutboat.jsonc, then redeploy:`);
  console.log(lines.join("\n"));
  console.log();
}
db.close();
