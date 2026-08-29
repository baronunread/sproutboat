/**
 * #27 — back up the control-plane state: the SQLite metadata store plus the
 * artifact directory and route snapshot. One gzipped tar per backup, kept under
 * `<state>/backups/`. A systemd timer runs createBackup() daily
 * (`bun apps/control/src/backups.ts`); the admin dashboard lists / triggers /
 * downloads them.
 *
 * The SQLite file is snapshotted with `VACUUM INTO` (consistent even while
 * control is writing, WAL and all) rather than copied raw.
 */
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

export type BackupEntry = { name: string; sizeBytes: number; createdAt: string };

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

export async function listBackups(): Promise<BackupEntry[]> {
  let names: string[];
  try {
    names = await readdir(backupsDir());
  } catch {
    return [];
  }
  const entries: BackupEntry[] = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    const info = await stat(resolve(backupsDir(), name));
    entries.push({ name, sizeBytes: info.size, createdAt: info.mtime.toISOString() });
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
    // legacy deployments.json), each taken from its real location.
    const tar = ["tar", "-czf", outPath, "-C", staging, "sproutboat.sqlite"];
    for (const path of [artifactsDir(), routesPath(), resolve(stateDir(), "deployments.json")]) {
      if (await exists(path)) tar.push("-C", dirname(path), basename(path));
    }
    await run(tar);
    await pruneOldBackups();
    const info = await stat(outPath);
    return { name, sizeBytes: info.size, createdAt: info.mtime.toISOString() };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function deleteBackup(name: string): Promise<boolean> {
  const path = backupPath(name);
  if (!path || !(await exists(path))) return false;
  await rm(path, { force: true });
  return true;
}

async function pruneOldBackups(): Promise<void> {
  const all = await listBackups();
  for (const stale of all.slice(keepCount())) {
    await rm(resolve(backupsDir(), stale.name), { force: true });
  }
}

if (import.meta.main) {
  const entry = await createBackup();
  console.log(JSON.stringify(entry));
}
