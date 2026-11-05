import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  // kv.test.ts and r2.test.ts set this for the whole process; backups read it, so a run
  // that reaches this file after them archived their directory (#289 CI).
  delete process.env.SPROUTBOAT_RESOURCE_DIR;
  delete process.env.SPROUTBOAT_BACKUP_KEEP;
  // Most tests read the archive with plain tar; the encrypted ones turn this back on.
  process.env.SPROUTBOAT_BACKUP_ENCRYPT = "off";
  process.env.SPROUTBOAT_BACKUP_KEY_FILE = join(dir, "backup.key");
  delete process.env.SPROUTBOAT_BACKUP_S3_ENDPOINT;
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
  // Durable Object storage.sql (wire 0.19, compat 2026-10-29): one database per object,
  // under `<doStoreId>.do-sql/CLASS/` beside the project's Durable Object store.
  const doSqlPath = join("resources", "do_0123456789abcdef01234567.do-sql", "Room", `${"a".repeat(64)}.sqlite`);
  await mkdir(join(dir, doSqlPath, ".."), { recursive: true });
  const doSql = walStore(join(dir, doSqlPath), "do-sql-value");
  await writeFile(join(dir, "resources", "r2-blobs", "obj.blob"), "BYTES");
  await writeFile(join(dir, "resources", "r2-blobs", "upload.tmp"), "partial");
  await writeFile(join(dir, "secrets.key"), Buffer.alloc(32, 7));
  const entry = await mod.createBackup();
  kv.close();
  d1.close();
  doSql.close();

  const members = await tarList(join(dir, "backups", entry.name));
  expect(members).toContain("resources/kv_1.sqlite");
  expect(members).toContain("resources/r2-blobs/obj.blob");
  expect(members).toContain("brokers/abc123/d1/DB.sqlite");
  expect(members).toContain(doSqlPath);
  expect(members.some((m) => /-(wal|shm)$|\.tmp$/.test(m))).toBe(false);

  const archive = join(tmpdir(), entry.name);
  await Bun.write(archive, Bun.file(join(dir, "backups", entry.name)));
  const fresh = await mkdtemp(join(tmpdir(), "sb-restore-"));
  try {
    process.env.SPROUTBOAT_STATE_DIR = fresh;
    process.env.SPROUTBOAT_DATABASE_PATH = join(fresh, "sproutboat.sqlite");
    expect((await mod.restoreBackup(archive)).warnings).toEqual([]);
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
    expect(read(join(fresh, doSqlPath))).toBe("do-sql-value");
    expect((await stat(join(fresh, doSqlPath))).mode & 0o060).toBe(0o060);
    expect(await Bun.file(join(fresh, "resources", "r2-blobs", "obj.blob")).text()).toBe("BYTES");
    // The edge shares the group with control and must be able to write the stores.
    expect((await stat(join(fresh, "resources", "kv_1.sqlite"))).mode & 0o060).toBe(0o060);
    // A second restore onto the now-populated dir needs --force.
    await expect(mod.restoreBackup(archive)).rejects.toThrow(/already has a sproutboat.sqlite/);

    // The install being restored over has its own -wal beside sproutboat.sqlite.
    // Left in place, SQLite replays it over the restored file on the next open.
    const target = join(fresh, "sproutboat.sqlite");
    const live = new Database(target);
    live.exec("PRAGMA journal_mode = WAL; CREATE TABLE stale_install (x); INSERT INTO stale_install VALUES (1);");
    const staleWal = await Bun.file(`${target}-wal`).bytes();
    live.close();
    await writeFile(`${target}-wal`, staleWal);
    expect((await mod.restoreBackup(archive, { force: true })).warnings).toEqual([]);
    expect(await Bun.file(`${target}-wal`).exists()).toBe(false);
    const restored = new Database(target, { readonly: true });
    try {
      expect(restored.query("SELECT name FROM sqlite_master WHERE name = 'stale_install'").get()).toBeNull();
    } finally {
      restored.close();
    }
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
    const { warnings } = await mod.restoreBackup(join(dir, "backups", entry.name));
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

// --- v2: manifest, encryption, verify, restore ---------------------------------

const KEY_A = "a1".repeat(32);
const KEY_B = "b2".repeat(32);

async function useKey(hex: string, name = "backup.key"): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, hex + "\n");
  process.env.SPROUTBOAT_BACKUP_KEY_FILE = path;
  return path;
}

async function stageConfigSnapshot() {
  await mkdir(join(dir, "config-snapshot", "etc", "sproutboat"), { recursive: true });
  await mkdir(join(dir, "config-snapshot", "caddy", "certificates", "acme"), { recursive: true });
  await writeFile(join(dir, "config-snapshot", "etc", "sproutboat", "control.env"), "SPROUTBOAT_BOOTSTRAP_TOKEN=t\n");
  await writeFile(join(dir, "config-snapshot", "caddy", "certificates", "acme", "site.crt"), "CERT");
}

/** Point the state dir at a fresh, empty install. */
async function freshInstall(): Promise<string> {
  const fresh = await mkdtemp(join(tmpdir(), "sb-restore-"));
  process.env.SPROUTBOAT_STATE_DIR = fresh;
  process.env.SPROUTBOAT_DATABASE_PATH = join(fresh, "sproutboat.sqlite");
  return fresh;
}

test("manifest: first member, hashes and sizes match every archived file, config included", async () => {
  await stageConfigSnapshot();
  await writeFile(join(dir, "secrets.key"), Buffer.alloc(32, 7));
  const entry = await mod.createBackup();
  const archive = join(dir, "backups", entry.name);
  const first = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe" });
  expect((await new Response(first.stdout).text()).split("\n")[0]).toBe("manifest.json");

  const { manifest, members } = await mod.inspectBackup(archive);
  expect(manifest).toMatchObject({ format: 2, includesConfig: true });
  expect(manifest!.platformVersion).toMatch(/^\d+\.\d+\.\d+/);
  expect(Number.isNaN(Date.parse(manifest!.createdAt))).toBe(false);
  const paths = manifest!.files.map((f) => f.path);
  expect(paths).toContain("config/etc/sproutboat/control.env");
  expect(paths).toContain("config/caddy/certificates/acme/site.crt");
  expect(paths).toContain("secrets.key");
  expect(paths).not.toContain("manifest.json");
  // Every regular member is in the manifest, and vice versa.
  expect(members.filter((m) => !m.endsWith("/") && m !== "manifest.json").sort()).toEqual(paths);
  const control = manifest!.files.find((f) => f.path === "config/etc/sproutboat/control.env")!;
  expect(control.sizeBytes).toBe("SPROUTBOAT_BOOTSTRAP_TOKEN=t\n".length);
  expect(control.sha256).toBe(new Bun.CryptoHasher("sha256").update("SPROUTBOAT_BOOTSTRAP_TOKEN=t\n").digest("hex"));
});

test("encrypted: create -> quick verify -> full verify -> restore, config lands in a scratch dir", async () => {
  process.env.SPROUTBOAT_BACKUP_ENCRYPT = "on";
  await useKey(KEY_A);
  await stageConfigSnapshot();
  await writeFile(join(dir, "secrets.key"), Buffer.alloc(32, 7));
  const entry = await mod.createBackup();
  expect(entry.name).toMatch(/^sproutboat-\d{8}-\d{6}\.tar\.gz\.enc$/);
  expect(entry.encrypted).toBe(true);
  const archive = join(dir, "backups", entry.name);

  // Documented layout: magic, 12-byte nonce, ciphertext, 16-byte tag; no gzip or tar in clear.
  const bytes = await readFile(archive);
  expect(bytes.subarray(0, 6).toString()).toBe("SBBK1\n");
  expect(bytes.includes(Buffer.from("sproutboat.sqlite"))).toBe(false);
  expect(bytes.subarray(18, 20).equals(Buffer.from([0x1f, 0x8b]))).toBe(false);
  expect(mod.backupPath(entry.name)).toBe(archive);
  expect((await mod.listBackups())[0]).toMatchObject({ name: entry.name, encrypted: true });
  // No plaintext archive or partial file is left behind.
  expect((await Array.fromAsync(new Bun.Glob("*").scan(join(dir, "backups")))).sort()).toEqual([entry.name]);

  const quick = await mod.verifyBackup(archive);
  expect(quick).toMatchObject({ format: 2, includesConfig: true, encrypted: true, full: false });
  const full = await mod.verifyBackup(archive, { full: true });
  expect(full.full).toBe(true);
  expect(await Array.fromAsync(new Bun.Glob(".verify-*").scan({ cwd: join(dir, "backups"), dot: true }))).toEqual([]);

  const fresh = await freshInstall();
  try {
    const { warnings, configDir } = await mod.restoreBackup(archive);
    expect(warnings.join("\n")).not.toContain("secrets.key");
    expect(await Bun.file(join(fresh, "secrets.key")).exists()).toBe(true);
    expect(await Bun.file(join(fresh, "manifest.json")).exists()).toBe(false);
    // config never touches the state dir.
    expect(await Bun.file(join(fresh, "config", "etc", "sproutboat", "control.env")).exists()).toBe(false);
    expect(configDir).not.toBeNull();
    expect(await Bun.file(join(configDir!, "etc", "sproutboat", "control.env")).text()).toBe(
      "SPROUTBOAT_BOOTSTRAP_TOKEN=t\n",
    );
    expect(await Bun.file(join(configDir!, "caddy", "certificates", "acme", "site.crt")).text()).toBe("CERT");
    const db = new Database(join(fresh, "sproutboat.sqlite"), { readonly: true });
    expect(db.query("SELECT id FROM deployment").get()).toEqual({ id: "d1" });
    db.close();
    await rm(join(configDir!, ".."), { recursive: true, force: true });

    // skipConfig leaves it in the archive.
    const second = await mod.restoreBackup(archive, { force: true, skipConfig: true });
    expect(second.configDir).toBeNull();
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test("encrypted: the wrong key fails with a clear message, and so does a missing key file", async () => {
  process.env.SPROUTBOAT_BACKUP_ENCRYPT = "on";
  await useKey(KEY_A);
  const entry = await mod.createBackup();
  const archive = join(dir, "backups", entry.name);
  const wrong = await useKey(KEY_B, "other.key");
  await expect(mod.verifyBackup(archive)).rejects.toThrow("wrong backup key or corrupted archive");
  const fresh = await freshInstall();
  try {
    await expect(mod.restoreBackup(archive)).rejects.toThrow("wrong backup key or corrupted archive");
    expect(await Bun.file(join(fresh, "sproutboat.sqlite")).exists()).toBe(false);
    // An explicit key file wins over the environment.
    const right = await useKey(KEY_A, "right.key");
    process.env.SPROUTBOAT_BACKUP_KEY_FILE = wrong;
    await mod.restoreBackup(archive, { keyFile: right });
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
  process.env.SPROUTBOAT_BACKUP_KEY_FILE = join(dir, "nope.key");
  await expect(mod.verifyBackup(archive)).rejects.toThrow(/nope\.key is missing or unreadable/);
  // Encryption on with no key refuses to write a backup rather than falling back to plaintext.
  await expect(mod.createBackup()).rejects.toThrow(/missing or unreadable/);
});

test("verify: a truncated or tampered archive fails, plain and encrypted", async () => {
  process.env.SPROUTBOAT_BACKUP_ENCRYPT = "on";
  await useKey(KEY_A);
  const enc = await mod.createBackup();
  process.env.SPROUTBOAT_BACKUP_ENCRYPT = "off";
  await Bun.sleep(1100);
  const plain = await mod.createBackup();
  const scratch = await mkdtemp(join(tmpdir(), "sb-verify-"));
  try {
    for (const entry of [enc, plain]) {
      const bytes = await readFile(join(dir, "backups", entry.name));
      const cut = join(scratch, entry.name);
      await writeFile(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
      await expect(mod.verifyBackup(cut)).rejects.toThrow();
    }
    const flipped = Buffer.from(await readFile(join(dir, "backups", enc.name)));
    flipped[flipped.length - 40] ^= 0xff;
    const tampered = join(scratch, "tampered.tar.gz.enc");
    await writeFile(tampered, flipped);
    await expect(mod.verifyBackup(tampered)).rejects.toThrow("wrong backup key or corrupted archive");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("verify --full: catches a file whose content no longer matches its manifest hash", async () => {
  await writeFile(join(dir, "routes.json"), "[1]");
  const entry = await mod.createBackup();
  const stage = await mkdtemp(join(tmpdir(), "sb-forge-"));
  try {
    const source = join(dir, "backups", entry.name);
    await Bun.spawn(["tar", "-xzf", source, "-C", stage]).exited;
    await writeFile(join(stage, "routes.json"), "[2]"); // same size, different bytes
    const forged = join(stage, "forged.tar.gz");
    await Bun.spawn([
      "tar",
      "-czf",
      forged,
      "-C",
      stage,
      "manifest.json",
      "sproutboat.sqlite",
      "routes.json",
      "artifacts",
    ]).exited;
    await expect(mod.verifyBackup(forged)).resolves.toMatchObject({ full: false });
    await expect(mod.verifyBackup(forged, { full: true })).rejects.toThrow("routes.json does not match its sha256");
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test("restoreBackup: refuses an archive from a newer platform unless --allow-newer", async () => {
  const stage = await mkdtemp(join(tmpdir(), "sb-newer-"));
  const entry = await mod.createBackup();
  const fresh = await freshInstall();
  try {
    await Bun.spawn(["tar", "-xzf", join(dir, "backups", entry.name), "-C", stage]).exited;
    const manifest = JSON.parse(await Bun.file(join(stage, "manifest.json")).text());
    manifest.platformVersion = "999.0.0";
    await writeFile(join(stage, "manifest.json"), JSON.stringify(manifest));
    const archive = join(stage, "newer.tar.gz");
    await Bun.spawn(["tar", "-czf", archive, "-C", stage, "manifest.json", "sproutboat.sqlite"]).exited;
    await expect(mod.restoreBackup(archive)).rejects.toThrow(/made by sproutboat 999\.0\.0, newer than this install/);
    // --force overrides the non-empty-install check, not the version check.
    await expect(mod.restoreBackup(archive, { force: true })).rejects.toThrow(/newer than this install/);
    expect(await Bun.file(join(fresh, "sproutboat.sqlite")).exists()).toBe(false);
    await mod.restoreBackup(archive, { allowNewer: true });
    expect(await Bun.file(join(fresh, "sproutboat.sqlite")).exists()).toBe(true);
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(fresh, { recursive: true, force: true });
  }
});

test("SPROUTBOAT_BACKUP_ENCRYPT=off writes a plain .tar.gz that needs no key and restores", async () => {
  process.env.SPROUTBOAT_BACKUP_ENCRYPT = "off";
  delete process.env.SPROUTBOAT_BACKUP_KEY_FILE;
  const entry = await mod.createBackup();
  expect(entry.name).toMatch(/\.tar\.gz$/);
  expect(entry.encrypted).toBe(false);
  expect(entry.warning).toBeUndefined();
  const archive = join(dir, "backups", entry.name);
  expect((await readFile(archive)).subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))).toBe(true);
  const fresh = await freshInstall();
  try {
    await mod.restoreBackup(archive);
    expect(await Bun.file(join(fresh, "sproutboat.sqlite")).exists()).toBe(true);
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test("createBackup: warns when off-box upload is configured without encryption", async () => {
  process.env.SPROUTBOAT_BACKUP_S3_BUCKET = "b";
  process.env.SPROUTBOAT_BACKUP_S3_ACCESS_KEY_ID = "k";
  process.env.SPROUTBOAT_BACKUP_S3_SECRET_ACCESS_KEY = "s";
  process.env.SPROUTBOAT_BACKUP_S3_ENDPOINT = "http://127.0.0.1:9"; // nothing listens: the upload fails, the backup does not
  const entry = await mod.createBackup();
  expect(entry.warning).toContain("encryption is off");
  expect(entry.offsite).toBe(false);
});

test("events recorded before a backup restore with it; the backup itself is recorded as a system event", async () => {
  const store = await import("./store");
  const events = await import("./events");
  store.closeStore();
  events.recordEvent({
    ownerId: "user-1",
    project: "app",
    type: "secret.set",
    actor: "alice",
    summary: "Set secret API_KEY on app",
    data: { name: "API_KEY" },
  });
  const entry = await mod.createBackup();
  const live = events.listEvents({ all: true, limit: 10 }).events;
  expect(live.map((event) => event.type)).toEqual(["backup.created", "secret.set"]);
  expect(live[0]).toMatchObject({
    ownerId: "system",
    actor: "timer",
    data: { name: entry.name, encrypted: false, offsite: false },
  });
  store.closeStore();

  const fresh = await mkdtemp(join(tmpdir(), "sb-restore-events-"));
  try {
    process.env.SPROUTBOAT_STATE_DIR = fresh;
    process.env.SPROUTBOAT_DATABASE_PATH = join(fresh, "sproutboat.sqlite");
    await mod.restoreBackup(join(dir, "backups", entry.name));
    const restored = new Database(join(fresh, "sproutboat.sqlite"), { readonly: true });
    try {
      const rows = restored
        .query<{ type: string; owner_id: string; data: string }, []>("SELECT type, owner_id, data FROM events")
        .all();
      expect(rows).toEqual([{ type: "secret.set", owner_id: "user-1", data: '{"name":"API_KEY"}' }]);
    } finally {
      restored.close();
    }
  } finally {
    store.closeStore();
    await rm(fresh, { recursive: true, force: true });
  }
});

test("a plain archive is refused when the install has a backup key, unless allowPlain", async () => {
  const entry = await mod.createBackup(); // encryption off: plain archive
  const archive = join(dir, "backups", entry.name);
  await useKey(KEY_A);
  await expect(mod.verifyBackup(archive)).rejects.toThrow("not encrypted but this install has a backup key");
  await expect(mod.inspectBackup(archive)).rejects.toThrow("--allow-plain");
  const fresh = await freshInstall();
  try {
    await expect(mod.restoreBackup(archive)).rejects.toThrow("--allow-plain");
    expect(await Bun.file(join(fresh, "sproutboat.sqlite")).exists()).toBe(false);
    expect((await mod.verifyBackup(archive, { allowPlain: true })).encrypted).toBe(false);
    await mod.restoreBackup(archive, { allowPlain: true });
    expect(await Bun.file(join(fresh, "sproutboat.sqlite")).exists()).toBe(true);
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test("an encrypted archive still verifies and restores with a key and no allowPlain", async () => {
  process.env.SPROUTBOAT_BACKUP_ENCRYPT = "on";
  await useKey(KEY_A);
  const entry = await mod.createBackup();
  const archive = join(dir, "backups", entry.name);
  expect((await mod.verifyBackup(archive)).encrypted).toBe(true);
  const fresh = await freshInstall();
  try {
    await mod.restoreBackup(archive);
    expect(await Bun.file(join(fresh, "sproutboat.sqlite")).exists()).toBe(true);
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test("the backups directory is private, and an archive with a link member is refused", async () => {
  const entry = await mod.createBackup();
  expect((await stat(join(dir, "backups"))).mode & 0o777).toBe(0o700);
  const src = await mkdtemp(join(tmpdir(), "sb-link-"));
  try {
    await writeFile(join(src, "sproutboat.sqlite"), "x");
    await symlink("/etc/passwd", join(src, "evil"));
    const bad = join(dir, "backups", "sproutboat-20260101-000000.tar.gz");
    expect(Bun.spawnSync(["tar", "-czf", bad, "-C", src, "sproutboat.sqlite", "evil"]).exitCode).toBe(0);
    await expect(mod.inspectBackup(bad)).rejects.toThrow("not a regular file or directory");
    const fresh = await freshInstall();
    try {
      await expect(mod.restoreBackup(bad)).rejects.toThrow("not a regular file or directory");
      expect(await Bun.file(join(fresh, "evil")).exists()).toBe(false);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
    expect(entry.name).toBeTruthy();
  } finally {
    await rm(src, { recursive: true, force: true });
  }
});
