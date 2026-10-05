import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mod from "./backups";

// backups.ts reads SPROUTBOAT_STATE_DIR / SPROUTBOAT_DATABASE_PATH on every call,
// so a fresh temp dir per test is enough — no module reload needed.
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-backups-"));
  process.env.SPROUTBOAT_STATE_DIR = dir;
  process.env.SPROUTBOAT_DATABASE_PATH = join(dir, "sproutboat.sqlite");
  process.env.SPROUTBOAT_ARTIFACTS_DIR = join(dir, "artifacts");
  process.env.SPROUTBOAT_ROUTE_SNAPSHOT = join(dir, "routes.json");
  delete process.env.SPROUTBOAT_BACKUP_KEEP;
  delete process.env.SPROUTBOAT_BACKUP_S3_BUCKET;
  delete process.env.SPROUTBOAT_BACKUP_S3_ACCESS_KEY_ID;
  delete process.env.SPROUTBOAT_BACKUP_S3_SECRET_ACCESS_KEY;
  const db = new Database(join(dir, "sproutboat.sqlite"));
  db.run("CREATE TABLE deployment (id TEXT)");
  db.run("INSERT INTO deployment VALUES ('d1')");
  db.close();
  await mkdir(join(dir, "artifacts", "abc123"), { recursive: true });
  await writeFile(join(dir, "artifacts", "abc123", "sprout"), "ELFDATA");
  await writeFile(join(dir, "routes.json"), "[]");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function tarList(path: string): Promise<string[]> {
  const child = Bun.spawn(["tar", "-tzf", path], { stdout: "pipe" });
  await child.exited;
  return (await new Response(child.stdout).text()).trim().split("\n").sort();
}

test("createBackup: bundles the sqlite snapshot + artifacts + routes.json", async () => {
  const entry = await mod.createBackup();
  expect(entry.name).toMatch(/^sproutboat-\d{8}-\d{6}\.tar\.gz$/);
  expect(entry.sizeBytes).toBeGreaterThan(0);
  expect(entry.offsite).toBe(false); // no SPROUTBOAT_BACKUP_S3_* -> local only
  const members = await tarList(join(dir, "backups", entry.name));
  expect(members).toContain("sproutboat.sqlite");
  expect(members).toContain("artifacts/abc123/sprout");
  expect(members).toContain("routes.json");
});

test("createBackup: includes secrets.key so encrypted secrets stay recoverable (#2)", async () => {
  await writeFile(join(dir, "secrets.key"), Buffer.alloc(32, 7));
  const entry = await mod.createBackup();
  expect(await tarList(join(dir, "backups", entry.name))).toContain("secrets.key");
});

test("listBackups: newest first, ignores non-backup files", async () => {
  await mod.createBackup();
  await Bun.sleep(1100); // distinct second-resolution stamp
  const second = await mod.createBackup();
  await writeFile(join(dir, "backups", "notes.txt"), "hi");
  const list = await mod.listBackups();
  expect(list.map((b) => b.name)).toEqual([second.name, expect.stringMatching(/sproutboat-/)]);
  expect(list).toHaveLength(2);
});

test("retention: keeps only SPROUTBOAT_BACKUP_KEEP newest", async () => {
  process.env.SPROUTBOAT_BACKUP_KEEP = "2";
  for (let i = 0; i < 3; i++) {
    await mod.createBackup();
    await Bun.sleep(1100);
  }
  expect(await mod.listBackups()).toHaveLength(2);
});

test("backupPath: rejects traversal and bad names, accepts a real name", () => {
  expect(mod.backupPath("../../etc/passwd")).toBeNull();
  expect(mod.backupPath("sproutboat-2026.tar.gz")).toBeNull();
  expect(mod.backupPath("sproutboat-20260101-000000.tar.gz")).toContain("/backups/");
});

/** A WAL store with its newest row still only in the -wal file (connection left open). */
function walStore(path: string, value: string): Database {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA wal_autocheckpoint = 0");
  db.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO kv VALUES ('k', ?)", [value]);
  return db;
}

test("createBackup + restoreBackup: binding data survives onto an empty install (#139)", async () => {
  await mkdir(join(dir, "resources", "r2-blobs"), { recursive: true });
  await mkdir(join(dir, "brokers", "abc123", "d1"), { recursive: true });
  const kv = walStore(join(dir, "resources", "kv_1.sqlite"), "resource-value");
  const d1 = walStore(join(dir, "brokers", "abc123", "d1", "DB.sqlite"), "broker-value");
  await writeFile(join(dir, "resources", "r2-blobs", "obj.blob"), "BYTES");
  await writeFile(join(dir, "resources", "r2-blobs", "upload.tmp"), "partial");
  await writeFile(join(dir, "secrets.key"), Buffer.alloc(32, 7));
  const entry = await mod.createBackup();
  kv.close();
  d1.close();

  const members = await tarList(join(dir, "backups", entry.name));
  expect(members).toContain("resources/kv_1.sqlite");
  expect(members).toContain("resources/r2-blobs/obj.blob");
  expect(members).toContain("brokers/abc123/d1/DB.sqlite");
  expect(members.some((m) => /-(wal|shm)$|\.tmp$/.test(m))).toBe(false);

  const archive = join(tmpdir(), entry.name);
  await Bun.write(archive, Bun.file(join(dir, "backups", entry.name)));
  const fresh = await mkdtemp(join(tmpdir(), "sb-restore-"));
  try {
    process.env.SPROUTBOAT_STATE_DIR = fresh;
    process.env.SPROUTBOAT_DATABASE_PATH = join(fresh, "sproutboat.sqlite");
    expect(await mod.restoreBackup(archive)).toEqual([]);
    const read = (path: string) => {
      const db = new Database(path, { readonly: true });
      try {
        return db.query<{ value: string }, []>("SELECT value FROM kv").get()?.value;
      } finally {
        db.close();
      }
    };
    expect(read(join(fresh, "resources", "kv_1.sqlite"))).toBe("resource-value");
    expect(read(join(fresh, "brokers", "abc123", "d1", "DB.sqlite"))).toBe("broker-value");
    expect(await Bun.file(join(fresh, "resources", "r2-blobs", "obj.blob")).text()).toBe("BYTES");
    // A second restore onto the now-populated dir needs --force.
    await expect(mod.restoreBackup(archive)).rejects.toThrow(/already has a sproutboat.sqlite/);
    expect(await mod.restoreBackup(archive, { force: true })).toEqual([]);
  } finally {
    await rm(fresh, { recursive: true, force: true });
    await rm(archive, { force: true });
  }
});

test("restoreBackup: rejects a truncated archive and warns about a missing key", async () => {
  const entry = await mod.createBackup();
  const full = await Bun.file(join(dir, "backups", entry.name)).arrayBuffer();
  const fresh = await mkdtemp(join(tmpdir(), "sb-restore-"));
  try {
    const truncated = join(fresh, "cut.tar.gz");
    await Bun.write(truncated, full.slice(0, Math.floor(full.byteLength / 2)));
    process.env.SPROUTBOAT_STATE_DIR = join(fresh, "state");
    process.env.SPROUTBOAT_DATABASE_PATH = join(fresh, "state", "sproutboat.sqlite");
    await expect(mod.restoreBackup(truncated)).rejects.toThrow(/unreadable or incomplete/);
    delete process.env.SPROUTBOAT_SECRETS_KEY;
    const warnings = await mod.restoreBackup(join(dir, "backups", entry.name));
    expect(warnings.join("\n")).toContain("secrets.key");
    expect(warnings.join("\n")).toContain("predates #139");
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test("deleteBackup: removes a real backup, false for a missing one", async () => {
  const entry = await mod.createBackup();
  expect(await mod.deleteBackup(entry.name)).toBe(true);
  expect(await mod.deleteBackup(entry.name)).toBe(false);
  expect(await mod.deleteBackup("../x")).toBe(false);
});
