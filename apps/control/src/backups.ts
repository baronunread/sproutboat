/**
 * #27, #139: back up the control-plane state: the SQLite metadata store, binding
 * data (resources/, brokers/), the artifact directory, the route snapshot and,
 * when staged, the host config (`/etc/sproutboat` and Caddy's data dir). One
 * archive per backup, kept under `<state>/backups/`; `backups.ts restore`
 * unpacks one onto an empty install. A systemd timer runs createBackup() daily
 * (`bun apps/control/src/backups.ts`); the admin dashboard lists / triggers /
 * downloads them.
 *
 * Format v2 (`manifest.json` first, then the state files, then `config/`):
 * the archive is a gzipped tar, encrypted at rest by default with AES-256-GCM
 * (`.tar.gz.enc`: magic `SBBK1\n`, 12-byte nonce, ciphertext, 16-byte tag). The
 * key is a 64-hex file (`SPROUTBOAT_BACKUP_KEY_FILE`, default
 * `/etc/sproutboat/backup.key`). `SPROUTBOAT_BACKUP_ENCRYPT=off` writes a plain
 * `.tar.gz`. Every archive is verified right after it is written.
 *
 * The backup user cannot read root-only host config, so a root step
 * (`infra/sb-backup-stage`) copies it into `<state>/config-snapshot/` first;
 * this file only archives that snapshot.
 *
 * The SQLite file is snapshotted with `VACUUM INTO` (consistent even while
 * control is writing, WAL and all) rather than copied raw.
 *
 * Off-box copy is optional: set SPROUTBOAT_BACKUP_S3_BUCKET (+ keys, + endpoint
 * for a non-AWS S3-compatible store like R2 / B2 / MinIO) and each new archive
 * is uploaded and the remote copies are pruned to the same retention. An upload
 * failure never fails the backup: the local archive still exists.
 */
import { S3Client } from "bun";
import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, copyFile, link, mkdir, mkdtemp, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { CONTROL_VERSION } from "./version";

const NAME_RE = /^sproutboat-\d{8}-\d{6}\.tar\.gz(\.enc)?$/;
const MAGIC = Buffer.from("SBBK1\n");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + NONCE_BYTES;
const BAD_KEY = "wrong backup key or corrupted archive";

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
/** Root-staged copy of the host config; see infra/sb-backup-stage. */
function configSnapshotDir(): string {
  return resolve(stateDir(), "config-snapshot");
}
function encryptionOn(): boolean {
  return (process.env.SPROUTBOAT_BACKUP_ENCRYPT || "").toLowerCase() !== "off";
}
function keyFilePath(override?: string): string {
  return override || process.env.SPROUTBOAT_BACKUP_KEY_FILE || "/etc/sproutboat/backup.key";
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

export type BackupEntry = {
  name: string;
  sizeBytes: number;
  createdAt: string;
  offsite: boolean;
  encrypted: boolean;
  warning?: string;
};

export type BackupManifest = {
  format: number;
  platformVersion: string;
  createdAt: string;
  includesConfig: boolean;
  files: { path: string; sizeBytes: number; sha256: string; mode?: number }[];
};

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
              encrypted: name.endsWith(".enc"),
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
    await client.write(s3Key(name), Bun.file(localPath), {
      type: name.endsWith(".enc") ? "application/octet-stream" : "application/gzip",
    });
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

// --- encryption at rest + streaming helpers ---------------------------------

async function readKey(path: string): Promise<Buffer> {
  let text: string;
  try {
    text = (await Bun.file(path).text()).trim();
  } catch {
    throw new Error(`backup key ${path} is missing or unreadable (pass --key FILE or set SPROUTBOAT_BACKUP_KEY_FILE)`);
  }
  if (!/^[0-9a-f]{64}$/i.test(text)) throw new Error(`backup key ${path} must hold 64 hex characters`);
  return Buffer.from(text, "hex");
}

/** An archive is encrypted when it starts with the magic, whatever its name says. */
async function isEncrypted(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(MAGIC.length);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead === head.length && head.equals(MAGIC);
  } finally {
    await handle.close();
  }
}

async function keyFileReadable(path: string): Promise<boolean> {
  try {
    await Bun.file(path).text();
    return true;
  } catch {
    return false;
  }
}

/**
 * The key an archive needs: null for a plain `.tar.gz`. On an install that has
 * a backup key, a plain archive is refused unless `allowPlain`: an encrypted
 * backup swapped for a plain one would otherwise be restored without a word.
 */
async function keyFor(archive: string, keyFile?: string, allowPlain = false): Promise<Buffer | null> {
  if (await isEncrypted(archive)) return readKey(keyFilePath(keyFile));
  const path = keyFilePath(keyFile);
  if (!allowPlain && (await keyFileReadable(path)))
    throw new Error(
      `${archive} is not encrypted but this install has a backup key (${path}); refusing it. Pass --allow-plain if it is a backup you made with encryption off`,
    );
  return null;
}

class BackupKeyError extends Error {}

/**
 * Plaintext of an encrypted archive, streamed. The GCM tag is only checked once
 * the last chunk is read, so a caller must drain the generator before trusting
 * what it extracted; a bad tag or key throws BackupKeyError at the very end.
 */
async function* decrypted(path: string, key: Buffer): AsyncGenerator<Uint8Array> {
  const size = (await stat(path)).size;
  if (size <= HEADER_BYTES + TAG_BYTES) throw new BackupKeyError(`${BAD_KEY} (archive is truncated)`);
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(head, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupKeyError("not an encrypted sproutboat archive");
    const decipher = createDecipheriv("aes-256-gcm", key, head.subarray(MAGIC.length), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    for await (const chunk of handle.createReadStream({
      start: HEADER_BYTES,
      end: size - TAG_BYTES - 1,
      autoClose: false,
    }))
      yield decipher.update(chunk);
    try {
      const rest = decipher.final();
      if (rest.length > 0) yield rest;
    } catch {
      throw new BackupKeyError(BAD_KEY);
    }
  } finally {
    await handle.close();
  }
}

/** Extract as the invoking user with the umask applied, whatever the archive says. */
const SAFE_EXTRACT = ["--no-same-owner", "--no-same-permissions"];

type TarResult = { code: number; out: string; err: string };

/**
 * Run `tar <flags> -z -f <archive|-> <rest>` over a plain or encrypted archive.
 * Encrypted ones are decrypted into tar's stdin. The generator is always
 * drained, even after tar stops reading (it ignores the gzip trailer), so the
 * GCM tag is always checked; its error wins over whatever tar made of the bytes.
 */
async function tarRead(archive: string, key: Buffer | null, flags: string[], rest: string[] = []): Promise<TarResult> {
  const child = Bun.spawn(["tar", ...flags, "-z", "-f", key ? "-" : archive, ...rest], {
    stdin: key ? "pipe" : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  let failure: BackupKeyError | undefined;
  const feed = async () => {
    if (!key) return;
    let open = true;
    try {
      for await (const chunk of decrypted(archive, key)) {
        if (!open) continue;
        try {
          child.stdin!.write(chunk);
          await child.stdin!.flush();
        } catch {
          open = false; // tar stopped reading; keep draining for the tag check
        }
      }
    } catch (error) {
      if (error instanceof BackupKeyError) failure = error;
      else throw error;
    } finally {
      try {
        await child.stdin!.end();
      } catch {
        /* tar already closed its end */
      }
    }
  };
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    feed(),
  ]).then(([c, o, e]) => [c, o, e] as const);
  if (failure) throw failure;
  return { code, out, err: err.trim() };
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/** `tar -czf - <args>` piped through AES-256-GCM into `out`; no plaintext archive touches the disk. */
async function tarEncrypt(args: string[], out: string, key: Buffer): Promise<void> {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  const child = Bun.spawn(
    ["tar", "-czf", "-", ...(process.platform === "linux" ? ["--hard-dereference"] : []), ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = new Response(child.stderr).text();
  const handle = await open(out, "w", 0o600);
  try {
    await handle.write(MAGIC);
    await handle.write(nonce);
    for await (const chunk of child.stdout) await handle.write(cipher.update(chunk));
    await handle.write(cipher.final());
    await handle.write(cipher.getAuthTag());
  } finally {
    await handle.close();
  }
  const code = await child.exited;
  if (code !== 0) throw new Error(`tar failed: ${(await stderr).trim() || `exit ${code}`}`);
}

// --- verify ------------------------------------------------------------------

export type BackupInspection = {
  members: string[];
  manifest: BackupManifest | null;
  encrypted: boolean;
  key: Buffer | null;
};

/**
 * Stream the whole archive through `tar -t` (decrypting first when needed): the
 * GCM tag proves integrity, gzip and tar prove their own structure. Throws a
 * one-line reason on any failure. A v1 archive has no manifest: `manifest` is null.
 */
export async function inspectBackup(archive: string, keyFile?: string, allowPlain = false): Promise<BackupInspection> {
  const key = await keyFor(archive, keyFile, allowPlain);
  // Only regular files and directories belong in a backup: a link or device
  // entry could redirect a later member outside the extraction directory.
  const detailed = await tarRead(archive, key, ["-tv"]);
  if (detailed.code !== 0)
    throw new Error(`${archive} is unreadable or incomplete: ${detailed.err || `tar exit ${detailed.code}`}`);
  const odd = detailed.out.split("\n").find((line) => line !== "" && !/^[-d]/.test(line));
  if (odd !== undefined) throw new Error(`${archive} has a member that is not a regular file or directory: ${odd}`);
  const listing = await tarRead(archive, key, ["-t"]);
  if (listing.code !== 0)
    throw new Error(`${archive} is unreadable or incomplete: ${listing.err || `tar exit ${listing.code}`}`);
  const members = listing.out.split("\n").filter(Boolean);
  let manifest: BackupManifest | null = null;
  if (members.includes("manifest.json")) {
    const read = await tarRead(archive, key, ["-x", "-O"], ["manifest.json"]);
    try {
      // SAFETY: written by createBackup(); a mangled one fails the checks below.
      manifest = JSON.parse(read.out) as BackupManifest;
    } catch {
      throw new Error(`${archive} has an unreadable manifest.json`);
    }
    if (read.code !== 0 || manifest.format !== 2 || !Array.isArray(manifest.files))
      throw new Error(`${archive} has an unsupported manifest (format ${String(manifest.format)})`);
  }
  return { members, manifest, encrypted: key !== null, key };
}

export type VerifySummary = {
  format: number | null;
  platformVersion: string | null;
  createdAt: string | null;
  includesConfig: boolean | null;
  encrypted: boolean;
  members: number;
  full: boolean;
};

/**
 * Quick (default): decrypt and stream through `tar -t`. Full: also extract into a
 * scratch dir, check every manifest size and sha256, run `PRAGMA integrity_check`
 * on every SQLite member, and remove the scratch dir.
 */
export async function verifyBackup(
  archive: string,
  {
    full = false,
    keyFile,
    scratch,
    allowPlain = false,
  }: { full?: boolean; keyFile?: string; scratch?: string; allowPlain?: boolean } = {},
): Promise<VerifySummary> {
  const { members, manifest, encrypted, key } = await inspectBackup(archive, keyFile, allowPlain);
  const summary: VerifySummary = {
    format: manifest?.format ?? null,
    platformVersion: manifest?.platformVersion ?? null,
    createdAt: manifest?.createdAt ?? null,
    includesConfig: manifest?.includesConfig ?? null,
    encrypted,
    members: members.length,
    full,
  };
  if (!full) return summary;
  const work = resolve(scratch ?? backupsDir(), `.verify-${crypto.randomUUID()}`);
  await mkdir(work, { recursive: true });
  try {
    const extract = await tarRead(archive, key, ["-x", ...SAFE_EXTRACT], ["-C", work]);
    if (extract.code !== 0)
      throw new Error(`${archive} failed to extract: ${extract.err || `tar exit ${extract.code}`}`);
    // One file at a time: an artifact tree can hold thousands of files.
    const check = async (file: BackupManifest["files"][number]) => {
      const path = resolve(work, file.path);
      const info = await stat(path).catch(() => null);
      if (!info) throw new Error(`${file.path} is listed in the manifest but missing from the archive`);
      if (info.size !== file.sizeBytes) throw new Error(`${file.path} has the wrong size`);
      if ((await sha256(path)) !== file.sha256) throw new Error(`${file.path} does not match its sha256`);
    };
    await (manifest?.files ?? []).reduce((previous, file) => previous.then(() => check(file)), Promise.resolve());
    const databases = (await readdir(work, { recursive: true })).filter((name) => name.endsWith(".sqlite"));
    for (const name of databases) {
      const db = new Database(resolve(work, name), { readonly: true });
      try {
        const verdict = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check;
        if (verdict !== "ok") throw new Error(`${name} failed integrity_check: ${verdict ?? "no result"}`);
      } finally {
        db.close();
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return summary;
}

// --- create ------------------------------------------------------------------

/** Every regular file under `root`, relative, with size, sha256 and mode. */
async function manifestFiles(root: string): Promise<BackupManifest["files"]> {
  const entries = (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(entry.parentPath, entry.name);
      const info = await stat(path);
      return { path: relative(root, path), sizeBytes: info.size, sha256: await sha256(path), mode: info.mode & 0o777 };
    }),
  );
  return files.toSorted((a, b) => (a.path < b.path ? -1 : 1));
}

export async function createBackup(): Promise<BackupEntry> {
  const dir = backupsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const encrypt = encryptionOn();
  // Fail before doing any work: a silent plaintext fallback would be worse than no backup.
  const key = encrypt ? await readKey(keyFilePath()) : null;
  const name = `sproutboat-${stamp()}.tar.gz${encrypt ? ".enc" : ""}`;
  const outPath = resolve(dir, name);
  const partial = `${outPath}.partial`;
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
    // Everything is staged first so the manifest hashes exactly what is archived.
    for (const [member, from] of [
      ["resources", resourceDir()],
      ["brokers", brokersDir()],
      [basename(artifactsDir()), artifactsDir()],
      ["config", configSnapshotDir()],
    ]) {
      await stageTree(from, resolve(staging, member));
    }
    for (const path of [routesPath(), resolve(stateDir(), "deployments.json"), resolve(stateDir(), "secrets.key")])
      if (await exists(path)) await copyFile(path, resolve(staging, basename(path)));

    const files = await manifestFiles(staging);
    const manifest: BackupManifest = {
      format: 2,
      platformVersion: CONTROL_VERSION,
      createdAt: new Date().toISOString(),
      includesConfig: files.some((file) => file.path.startsWith("config/")),
      files,
    };
    await writeFile(resolve(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
    const members = ["manifest.json", ...(await readdir(staging)).filter((entry) => entry !== "manifest.json").sort()];

    if (key) await tarEncrypt(["-C", staging, ...members], partial, key);
    else await run(["tar", "-czf", partial, "-C", staging, ...members]);
    await chmod(partial, 0o600);
    await rename(partial, outPath);
    // A backup nobody can read is worse than none: check it before it counts
    // toward retention or goes off-box. A failure fails the unit.
    try {
      await verifyBackup(outPath, { allowPlain: true });
    } catch (error) {
      await rm(outPath, { force: true });
      throw new Error(`backup verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await pruneOldBackups();
    const info = await stat(outPath);
    const offsite = await copyOffsite(outPath, name);
    const entry: BackupEntry = {
      name,
      sizeBytes: info.size,
      createdAt: info.mtime.toISOString(),
      offsite,
      encrypted: encrypt,
    };
    if (!encrypt && s3()) {
      entry.warning =
        "off-box upload is configured but encryption is off: the archive (secrets.key, config) goes off this box in clear";
      console.error(`backup: WARNING ${entry.warning}`);
    }
    return entry;
  } finally {
    await rm(partial, { force: true });
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
 * Restored binding data must be writable by the edge, which shares the
 * `sproutboat` group with control (install.sh gives these trees group rw).
 * tar applies the archived modes, which for SQLite stores are 0644, so the
 * edge's brokers failed with EACCES. Best-effort: `sbctl restore` also resets
 * owners as root.
 */
async function shareBindingData(root: string, members: string[]): Promise<void> {
  const share = async (path: string) => {
    const info = await stat(path).catch(() => null);
    if (info) await chmod(path, info.mode | (info.isDirectory() ? 0o2070 : 0o060)).catch(() => {});
  };
  await Promise.all(members.flatMap((m) => (/^(resources|brokers)\//.test(m) ? [share(resolve(root, m))] : [])));
}

/** Compare major.minor.patch (prerelease tags ignored); >0 when `a` is newer. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export type RestoreOptions = {
  force?: boolean;
  keyFile?: string;
  /** Restore an archive made by a newer platform version (`--force` does not imply this). */
  allowNewer?: boolean;
  /** Where to extract `config/`; default a fresh 0700 dir under the OS temp dir. */
  configDir?: string;
  /** Leave `config/` in the archive alone. */
  skipConfig?: boolean;
  /** Accept a plain archive although this install has a backup key (`--allow-plain`). */
  allowPlain?: boolean;
};

/**
 * Extract whole top-level entries (`artifacts`, `routes.json`, ...) by name.
 * A bare top-level name extracts the entry and everything under it on both GNU
 * tar and bsdtar. Per-member names from a listing do not round-trip through
 * `-T` on GNU tar, and `--exclude` anchoring differs between the two.
 */
async function extractTop(archive: string, key: Buffer | null, into: string, tops: string[]): Promise<void> {
  if (tops.length === 0) return;
  // GNU tar fails on the install's directories that another service user owns
  // (it can't set their mode or times). Keep those as install.sh made them.
  const flags = process.platform === "linux" ? ["--no-overwrite-dir"] : [];
  const result = await tarRead(archive, key, ["-x", ...SAFE_EXTRACT, ...flags], ["-C", into, ...tops]);
  if (result.code !== 0) throw new Error(`tar failed: ${result.err || `exit ${result.code}`}`);
}

/**
 * #139: unpack an archive into the state dir. Refuses a dir that already holds
 * a control database unless `force`, so a mistyped path can't overwrite a live
 * install. `config/` (host config) never lands in the state dir: it goes to a
 * scratch dir, `configDir` in the result, for `sbctl restore` to apply as root.
 * Returns warnings the operator must act on.
 */
export async function restoreBackup(
  archive: string,
  {
    force = false,
    keyFile,
    allowNewer = false,
    configDir,
    skipConfig = false,
    allowPlain = false,
  }: RestoreOptions = {},
): Promise<{ warnings: string[]; configDir: string | null }> {
  // Reading the whole stream catches a truncated download, and for an encrypted
  // archive authenticates every byte before anything is extracted.
  const { members, manifest, key } = await inspectBackup(archive, keyFile, allowPlain);
  if (!members.includes("sproutboat.sqlite")) throw new Error(`${archive} has no sproutboat.sqlite; not a backup`);
  if (manifest && !allowNewer && compareVersions(manifest.platformVersion, CONTROL_VERSION) > 0)
    throw new Error(
      `${archive} was made by sproutboat ${manifest.platformVersion}, newer than this install (${CONTROL_VERSION}); update first or pass --allow-newer`,
    );
  if (!force && (await exists(dbPath())))
    throw new Error(`${stateDir()} already has a sproutboat.sqlite; restore onto an empty install or pass --force`);
  const root = resolve(stateDir());
  const outside = members.find((m) => !resolve(root, m).startsWith(root + "/"));
  if (outside !== undefined) throw new Error(`${archive} has a member outside the state dir: ${outside}`);
  await mkdir(root, { recursive: true });
  const isConfig = (m: string) => m === "config" || m.startsWith("config/");
  const stateMembers = members.filter((m) => m !== "manifest.json" && !isConfig(m));
  // A database restored beside the install's own -wal is not the backup: SQLite
  // replays that log over it on the next open, so control came back with the new
  // install's users and no projects. Remove every restored database's sidecars.
  const sidecars = ["-wal", "-shm", "-journal"];
  await Promise.all(
    stateMembers.flatMap((m) =>
      m.endsWith(".sqlite") ? sidecars.map((suffix) => rm(resolve(root, m + suffix), { force: true })) : [],
    ),
  );
  const topOf = (m: string) => m.replace(/^\.\//, "").split("/")[0]!;
  await extractTop(archive, key, root, [...new Set(stateMembers.map(topOf))]);
  await shareBindingData(root, stateMembers);
  let extractedConfig: string | null = null;
  const configMembers = members.filter(isConfig);
  if (!skipConfig && configMembers.length > 0) {
    const target = configDir ? resolve(configDir) : await mkdtemp(join(tmpdir(), "sb-restore-config-"));
    await mkdir(target, { recursive: true, mode: 0o700 });
    await extractTop(archive, key, target, ["config"]);
    extractedConfig = join(target, "config");
  }
  const warnings: string[] = [];
  if (!members.includes("secrets.key") && !process.env.SPROUTBOAT_SECRETS_KEY)
    warnings.push(
      "no secrets.key in the archive and SPROUTBOAT_SECRETS_KEY is unset: stored secrets can't be decrypted",
    );
  if (!members.some((m) => m.startsWith("resources/")))
    warnings.push("no resources/ in the archive: it predates #139, so KV / D1 / R2 / queue data is not restored");
  return { warnings, configDir: extractedConfig };
}

/** `--flag` booleans and `--flag VALUE` pairs after the command; the first bare word is the archive. */
function parseArgs(argv: string[]) {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const bare: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (["--key", "--scratch", "--config-dir"].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a value`);
      values.set(arg, value);
    } else if (arg.startsWith("--")) flags.add(arg);
    else bare.push(arg);
  }
  return { flags, values, archive: bare[0] };
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  // Operator commands: a refusal is one line and exit 1, not a stack trace.
  try {
    const { flags, values, archive } = parseArgs(rest);
    if (command === "restore") {
      if (!archive)
        throw new Error(
          "usage: backups.ts restore <archive> [--force] [--no-config] [--key FILE] [--allow-newer] [--allow-plain]",
        );
      const result = await restoreBackup(resolve(archive), {
        force: flags.has("--force"),
        allowNewer: flags.has("--allow-newer"),
        skipConfig: flags.has("--no-config"),
        keyFile: values.get("--key"),
        configDir: values.get("--config-dir"),
        allowPlain: flags.has("--allow-plain"),
      });
      for (const warning of result.warnings) console.error(`warning: ${warning}`);
      console.log(`restored ${archive} into ${stateDir()}`);
      if (result.configDir) console.log(`config extracted to ${result.configDir}`);
    } else if (command === "verify") {
      if (!archive)
        throw new Error("usage: backups.ts verify <archive> [--full] [--scratch DIR] [--key FILE] [--allow-plain]");
      const s = await verifyBackup(resolve(archive), {
        full: flags.has("--full"),
        keyFile: values.get("--key"),
        scratch: values.get("--scratch"),
        allowPlain: flags.has("--allow-plain"),
      });
      console.log(
        `ok ${s.full ? "(full)" : "(quick)"}: format ${s.format ?? "1 (no manifest)"}, version ${s.platformVersion ?? "unknown"}, created ${s.createdAt ?? "unknown"}, config ${s.includesConfig === null ? "unknown" : s.includesConfig ? "included" : "not included"}, ${s.encrypted ? "encrypted" : "plain"}, ${s.members} members`,
      );
    } else if (command === "list") {
      for (const b of await listBackups())
        console.log(`${b.name}\t${b.sizeBytes}\t${b.createdAt}\t${b.offsite ? "offsite" : "local"}`);
    } else if (command === undefined || command === "create") {
      console.log(JSON.stringify(await createBackup()));
    } else throw new Error(`unknown command '${command}' (create|list|verify|restore)`);
  } catch (error) {
    console.error(`${command ?? "backup"}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
