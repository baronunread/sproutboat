/**
 * #27, #139: back up the control-plane state: the SQLite metadata store, binding
 * data (resources/, brokers/), the artifact directory and route snapshot. One
 * gzipped tar per backup, kept under `<state>/backups/`; `backups.ts restore`
 * unpacks one onto an empty install. A systemd timer runs createBackup() daily
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
import { copyFile, link, mkdir, readdir, rm, stat } from "node:fs/promises";
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
// #139: binding data (KV / D1 / R2 / queues / Durable Objects). Same env vars
// the supervisor reads; the backup unit doesn't set them, so the fallback must
// be where install.sh puts them.
function resourceDir(): string {
  return process.env.SPROUTBOAT_RESOURCE_DIR || resolve(stateDir(), "resources");
}
function brokersDir(): string {
  return process.env.SPROUTBOAT_BROKER_STATE_DIR || resolve(stateDir(), "brokers");
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
    const names = new Set<string>();
    for (const object of listed.contents ?? []) if (NAME_RE.test(basename(object.key))) names.add(basename(object.key));
    return names;
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
  const entries = await Promise.all(
    names.flatMap((name) =>
      NAME_RE.test(name)
        ? [
            stat(resolve(backupsDir(), name)).then((info): BackupEntry => ({
              name,
              sizeBytes: info.size,
              createdAt: info.mtime.toISOString(),
              offsite: offsite.has(name),
            })),
          ]
        : [],
    ),
  );
  return entries.sort((a, b) => (a.name < b.name ? 1 : -1));
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${command[0]} failed: ${stderr.trim() || `exit ${code}`}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** VACUUM INTO: a consistent snapshot of a live WAL database, never a raw copy. */
function snapshotSqlite(from: string, to: string): void {
  const source = new Database(from, { readonly: true, create: false });
  try {
    source.run("VACUUM INTO ?", [to]);
  } finally {
    source.close();
  }
}

/**
 * #139: copy one binding-data tree into `to`: every SQLite store snapshotted,
 * every other file (R2 object bodies, `r2-blobs/*.blob`) hard-linked, or copied
 * across filesystems. Blob files are write-once per object generation, so a
 * link is a stable copy. Databases go first: an object written after its
 * snapshot only leaves an unreferenced blob behind.
 * ponytail: an object deleted between the snapshot and the blob pass restores
 * as metadata without a body; pause the edge during backup if that matters.
 */
async function stageTree(from: string, to: string): Promise<boolean> {
  if (!(await exists(from))) return false;
  const files = (await readdir(from, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  const path = (entry: (typeof files)[number]) => resolve(entry.parentPath, entry.name);
  const target = (entry: (typeof files)[number]) => resolve(to, path(entry).slice(from.length + 1));
  const isDb = (name: string) => name.endsWith(".sqlite");
  const skip = (name: string) => /-(wal|shm|journal)$|\.tmp$/.test(name);
  await mkdir(to, { recursive: true });
  for (const entry of files.filter((f) => isDb(f.name))) {
    await mkdir(dirname(target(entry)), { recursive: true });
    snapshotSqlite(path(entry), target(entry));
  }
  for (const entry of files.filter((f) => !isDb(f.name) && !skip(f.name))) {
    await mkdir(dirname(target(entry)), { recursive: true });
    await link(path(entry), target(entry)).catch(() => copyFile(path(entry), target(entry)));
  }
  return true;
}

/** Upload one archive off-box and prune remote copies to keepCount(). Best-effort. */
async function copyOffsite(localPath: string, name: string): Promise<boolean> {
  const client = s3();
  if (!client) return false;
  try {
    await client.write(s3Key(name), Bun.file(localPath), { type: "application/gzip" });
    const remote = Array.from(await remoteNames())
      .toSorted()
      .reverse();
    await Promise.all(
      remote.slice(keepCount()).map((stale) =>
        client.delete(s3Key(stale)).catch(() => {
          /* prune is best-effort */
        }),
      ),
    );
    return true;
  } catch (error) {
    console.error(
      `backup: off-box upload failed (${error instanceof Error ? error.message : String(error)}); local copy kept`,
    );
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
    snapshotSqlite(dbPath(), resolve(staging, "sproutboat.sqlite"));

    // Archive root: sproutboat.sqlite + resources/ + brokers/ + the artifacts
    // dir + routes.json (+ the legacy deployments.json) + secrets.key. The key
    // MUST be in the backup: without it the encrypted secrets in the SQLite
    // snapshot are unrecoverable (#2). The decrypted secrets/ dir is not
    // archived: `syncRoutes()` regenerates it from the DB on restore.
    const tar = ["tar", "-czf", outPath, "-C", staging, "sproutboat.sqlite"];
    for (const [name, from] of [
      ["resources", resourceDir()],
      ["brokers", brokersDir()],
    ]) {
      if (await stageTree(from, resolve(staging, name))) tar.push("-C", staging, name);
    }
    const extras = [
      artifactsDir(),
      routesPath(),
      resolve(stateDir(), "deployments.json"),
      resolve(stateDir(), "secrets.key"),
    ];
    const present = await Promise.all(extras.map(exists));
    extras.forEach((path, i) => present[i] && tar.push("-C", dirname(path), basename(path)));
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
  if (client && NAME_RE.test(name))
    await client.delete(s3Key(name)).catch(() => {
      /* may not be offsite */
    });
  if (!(await exists(path))) return false;
  await rm(path, { force: true });
  return true;
}

async function pruneOldBackups(): Promise<void> {
  let names: string[];
  try {
    names = await readdir(backupsDir());
  } catch {
    return;
  }
  const stale = names
    .filter((name) => NAME_RE.test(name))
    .sort()
    .reverse()
    .slice(keepCount());
  for (const name of stale) await rm(resolve(backupsDir(), name), { force: true });
}

/**
 * #139: unpack an archive into the state dir. Refuses a dir that already holds
 * a control database unless `force`, so a mistyped path can't overwrite a live
 * install. Returns warnings the operator must act on.
 */
export async function restoreBackup(archive: string, { force = false } = {}): Promise<string[]> {
  // `tar -t` reads the whole gzip stream, so a truncated download fails here.
  const child = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
  const [code, listing, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${archive} is unreadable or incomplete: ${stderr.trim() || `tar exit ${code}`}`);
  const members = listing.split("\n");
  if (!members.includes("sproutboat.sqlite")) throw new Error(`${archive} has no sproutboat.sqlite; not a backup`);
  if (!force && (await exists(dbPath())))
    throw new Error(`${stateDir()} already has a sproutboat.sqlite; restore onto an empty install or pass --force`);
  await mkdir(stateDir(), { recursive: true });
  await run(["tar", "-xzf", archive, "-C", stateDir()]);
  const warnings: string[] = [];
  if (!members.includes("secrets.key") && !process.env.SPROUTBOAT_SECRETS_KEY)
    warnings.push(
      "no secrets.key in the archive and SPROUTBOAT_SECRETS_KEY is unset: stored secrets can't be decrypted",
    );
  if (!members.some((m) => m.startsWith("resources/")))
    warnings.push("no resources/ in the archive: it predates #139, so KV / D1 / R2 / queue data is not restored");
  return warnings;
}

if (import.meta.main) {
  const [command, archive, flag] = process.argv.slice(2);
  if (command === "restore") {
    // An operator command: a refusal is one line and exit 1, not a stack trace.
    try {
      if (!archive) throw new Error("usage: backups.ts restore <archive.tar.gz> [--force]");
      for (const warning of await restoreBackup(resolve(archive), { force: flag === "--force" }))
        console.error(`warning: ${warning}`);
      console.log(`restored ${archive} into ${stateDir()}`);
    } catch (error) {
      console.error(`restore: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else {
    const entry = await createBackup();
    console.log(JSON.stringify(entry));
  }
}
