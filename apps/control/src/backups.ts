/**
 * #27 — back up the control-plane state: the SQLite metadata store plus the
 * artifact directory and route snapshot. One gzipped tar per backup, kept under
 * `<state>/backups/`. A systemd timer runs createBackup() daily
 * (`bun apps/control/src/backups.ts`); the admin dashboard lists / triggers /
 * downloads them.
 *
 * The SQLite file is snapshotted with `VACUUM INTO` (consistent even while
 * control is writing, WAL and all) rather than copied raw.
 *
 * Off-box copy is optional: set SPROUTBOAT_BACKUP_S3_BUCKET (+ keys, + endpoint
 * for a non-AWS S3-compatible store like R2 / B2 / MinIO) and each new archive
 * is uploaded and the remote copies are pruned to the same retention. An upload
 * failure never fails the backup — the local archive still exists.
 */
import { S3Client } from "bun";
import { Database } from "bun:sqlite";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const NAME_RE = /^sproutboat-\d{8}-\d{6}\.tar\.gz$/;

function stateDir(): string {
  if (process.env.SPROUTBOAT_STATE_DIR) return resolve(process.env.SPROUTBOAT_STATE_DIR);
  const db = process.env.SPROUTBOAT_DATABASE_PATH;
  return db ? dirname(resolve(db)) : "/var/lib/sproutboat";
}
function dbPath(): string {
  return process.env.SPROUTBOAT_DATABASE_PATH || resolve(stateDir(), "sproutboat.sqlite");
}
function artifactsDir(): string {
  return process.env.SPROUTBOAT_ARTIFACTS_DIR || resolve(stateDir(), "artifacts");
}
function routesPath(): string {
  return process.env.SPROUTBOAT_ROUTE_SNAPSHOT || resolve(stateDir(), "routes.json");
}
function backupsDir(): string {
  return resolve(stateDir(), "backups");
}
function keepCount(): number {
  const n = Number(process.env.SPROUTBOAT_BACKUP_KEEP);
  return Number.isInteger(n) && n > 0 ? n : 7;
}

const S3_PREFIX = () => (process.env.SPROUTBOAT_BACKUP_S3_PREFIX || "").replace(/^\/+|\/+$/g, "");
const s3Key = (name: string) => (S3_PREFIX() ? `${S3_PREFIX()}/${name}` : name);

/** Configured off-box target, or null. Works with AWS S3 and any S3-compatible endpoint. */
function s3(): S3Client | null {
  const bucket = process.env.SPROUTBOAT_BACKUP_S3_BUCKET;
  const accessKeyId = process.env.SPROUTBOAT_BACKUP_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SPROUTBOAT_BACKUP_S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return new S3Client({
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint: process.env.SPROUTBOAT_BACKUP_S3_ENDPOINT || undefined,
    region: process.env.SPROUTBOAT_BACKUP_S3_REGION || undefined,
  });
}

export type BackupEntry = { name: string; sizeBytes: number; createdAt: string; offsite: boolean };

function stamp(date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

/** Resolve a caller-supplied backup name to a path inside backupsDir(), or null. */
export function backupPath(name: string): string | null {
  if (!NAME_RE.test(name)) return null;
  const path = resolve(backupsDir(), name);
  return path.startsWith(backupsDir() + "/") ? path : null;
}

/** Names currently present in the off-box store (empty if not configured). */
async function remoteNames(): Promise<Set<string>> {
  const client = s3();
  if (!client) return new Set();
  try {
    const listed = await client.list({ prefix: S3_PREFIX() ? `${S3_PREFIX()}/` : undefined, maxKeys: 1000 });
    const names = (listed.contents ?? []).map((object) => basename(object.key)).filter((name) => NAME_RE.test(name));
    return new Set(names);
  } catch {
    return new Set();
  }
}

export async function listBackups(): Promise<BackupEntry[]> {
  let names: string[];
  try {
    names = await readdir(backupsDir());
  } catch {
    return [];
  }
  const offsite = await remoteNames();
  const entries: BackupEntry[] = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    const info = await stat(resolve(backupsDir(), name));
    entries.push({ name, sizeBytes: info.size, createdAt: info.mtime.toISOString(), offsite: offsite.has(name) });
  }
  return entries.sort((a, b) => (a.name < b.name ? 1 : -1));
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${command[0]} failed: ${stderr.trim() || `exit ${code}`}`);
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

/** Upload one archive off-box and prune remote copies to keepCount(). Best-effort. */
async function copyOffsite(localPath: string, name: string): Promise<boolean> {
  const client = s3();
  if (!client) return false;
  try {
    await client.write(s3Key(name), Bun.file(localPath), { type: "application/gzip" });
    const remote = [...await remoteNames()].sort().reverse();
    for (const stale of remote.slice(keepCount())) {
      await client.delete(s3Key(stale)).catch(() => { /* prune is best-effort */ });
    }
    return true;
  } catch (error) {
    console.error(`backup: off-box upload failed (${error instanceof Error ? error.message : String(error)}); local copy kept`);
    return false;
  }
}

export async function createBackup(): Promise<BackupEntry> {
  const dir = backupsDir();
  await mkdir(dir, { recursive: true });
  const name = `sproutboat-${stamp()}.tar.gz`;
  const outPath = resolve(dir, name);
  const staging = resolve(dir, `.staging-${crypto.randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    // Consistent SQLite snapshot (safe while control keeps writing).
    const source = new Database(dbPath(), { readonly: true, create: false });
    try { source.run("VACUUM INTO ?", [resolve(staging, "sproutboat.sqlite")]); }
    finally { source.close(); }

    // Archive root: sproutboat.sqlite + the artifacts dir + routes.json (+ the
    // legacy deployments.json) + secrets.key. The key MUST be in the backup —
    // without it the encrypted secrets in the SQLite snapshot are unrecoverable
    // (#2). The decrypted secrets/ dir is not archived: `syncRoutes()`
    // regenerates it from the DB on restore.
    const tar = ["tar", "-czf", outPath, "-C", staging, "sproutboat.sqlite"];
    for (const path of [artifactsDir(), routesPath(), resolve(stateDir(), "deployments.json"), resolve(stateDir(), "secrets.key")]) {
      if (await exists(path)) tar.push("-C", dirname(path), basename(path));
    }
    await run(tar);
    await pruneOldBackups();
    const info = await stat(outPath);
    const offsite = await copyOffsite(outPath, name);
    return { name, sizeBytes: info.size, createdAt: info.mtime.toISOString(), offsite };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function deleteBackup(name: string): Promise<boolean> {
  const path = backupPath(name);
  if (!path) return false;
  const client = s3();
  if (client && NAME_RE.test(name)) await client.delete(s3Key(name)).catch(() => { /* may not be offsite */ });
  if (!(await exists(path))) return false;
  await rm(path, { force: true });
  return true;
}

async function pruneOldBackups(): Promise<void> {
  let names: string[];
  try { names = await readdir(backupsDir()); } catch { return; }
  const stale = names.filter((name) => NAME_RE.test(name)).sort().reverse().slice(keepCount());
  for (const name of stale) await rm(resolve(backupsDir(), name), { force: true });
}

if (import.meta.main) {
  const entry = await createBackup();
  console.log(JSON.stringify(entry));
}
