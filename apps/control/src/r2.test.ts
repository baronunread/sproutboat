import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let id: string;
let r2: typeof import("./r2");
let store: typeof import("./store");
const request = (path: string, init?: RequestInit) =>
  new Request(`http://control.test${path}`, { ...init, headers: { "x-api-key": "test-token", ...init?.headers } });

/** Writes a metadata row + blob file the same way transport-embedded.js /
 * broker.ts do (#56) — control never writes R2 data itself, only reads what
 * a deployed sprout already put there. */
async function seedObject(resourceDir: string, bucket: string, key: string, bytes: Uint8Array, contentType?: string) {
  await mkdir(resourceDir, { recursive: true });
  const dbPath = join(resourceDir, `${bucket}.sqlite`);
  const db = new Database(dbPath, { create: true });
  db.exec(
    "CREATE TABLE IF NOT EXISTS r2 (bucket TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL, " +
      "etag TEXT NOT NULL, uploaded TEXT NOT NULL, http_json TEXT NOT NULL DEFAULT '{}', custom_json TEXT NOT NULL DEFAULT '{}', " +
      "PRIMARY KEY (bucket, key))",
  );
  const etag = createHash("sha256").update(bytes).digest("hex");
  db.query(
    "INSERT INTO r2 (bucket, key, size, etag, uploaded, http_json, custom_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
  ).run(
    bucket,
    key,
    bytes.byteLength,
    etag,
    new Date().toISOString(),
    JSON.stringify(contentType ? { contentType } : {}),
    "{}",
  );
  db.close();
  const blobDir = join(resourceDir, "r2-blobs");
  await mkdir(blobDir, { recursive: true });
  const hash = createHash("sha256").update(`${bucket}\0${key}`).digest("hex");
  await writeFile(join(blobDir, `${hash}.blob`), bytes);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-r2-api-"));
  process.env.SPROUTBOAT_DATABASE_PATH = join(dir, "control.sqlite");
  process.env.SPROUTBOAT_RESOURCE_DIR = join(dir, "resources");
  process.env.SPROUTBOAT_BOOTSTRAP_TOKEN = "test-token";
  process.env.SPROUTBOAT_BOOTSTRAP_USERNAME = "tester";
  store = await import("./store");
  r2 = await import("./r2");
  id = store.createResource("bootstrap:tester", "r2", "uploads").id;
});

afterAll(async () => {
  store.closeStore();
  await rm(dir, { recursive: true, force: true });
});

test("lists objects, paginates, filters by prefix, and is owner-scoped", async () => {
  const resourceDir = join(dir, "resources");
  await seedObject(resourceDir, id, "a/1.txt", new TextEncoder().encode("one"));
  await seedObject(resourceDir, id, "a/2.txt", new TextEncoder().encode("two"));
  await seedObject(resourceDir, id, "b/3.txt", new TextEncoder().encode("three"));

  const all = await r2.listR2Objects(request(`/api/r2/${id}/objects`), id);
  expect(all.status).toBe(200);
  // SAFETY: status 200 above is listR2Objects' own contract for this shape.
  const allBody = (await all.json()) as { objects: { key: string }[]; cursor: string | null };
  expect(allBody.objects.map((o) => o.key)).toEqual(["a/1.txt", "a/2.txt", "b/3.txt"]);

  const first = await r2.listR2Objects(request(`/api/r2/${id}/objects?prefix=a%2F&limit=1`), id);
  expect(await first.json()).toMatchObject({
    objects: [{ key: "a/1.txt", size: 3 }],
    cursor: "a/1.txt",
  });
  const second = await r2.listR2Objects(request(`/api/r2/${id}/objects?prefix=a%2F&limit=1&cursor=a%2F1.txt`), id);
  expect(await second.json()).toMatchObject({ objects: [{ key: "a/2.txt" }], cursor: null });

  process.env.SPROUTBOAT_BOOTSTRAP_USERNAME = "stranger";
  expect((await r2.listR2Objects(request(`/api/r2/${id}/objects`), id)).status).toBe(404);
  process.env.SPROUTBOAT_BOOTSTRAP_USERNAME = "tester";
});

test("reports account R2 capacity and direct-transfer rejections", async () => {
  const resourceDir = join(dir, "resources");
  await seedObject(resourceDir, id, "usage.bin", new Uint8Array(7));
  const quota = new Database(join(resourceDir, "r2-quota.sqlite"), { create: true });
  try {
    quota.exec(
      "CREATE TABLE r2_account_quota (owner TEXT PRIMARY KEY, used_bytes INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL)",
    );
    quota.exec(
      "CREATE TABLE r2_transfer_metric (owner TEXT PRIMARY KEY, tickets_issued INTEGER NOT NULL, rejected_quota INTEGER NOT NULL, rejected_disk INTEGER NOT NULL, rejected_size INTEGER NOT NULL)",
    );
    quota.query("INSERT INTO r2_account_quota VALUES (?1, 0, 3)").run("bootstrap:tester");
    quota.query("INSERT INTO r2_transfer_metric VALUES (?1, 4, 2, 1, 3)").run("bootstrap:tester");
  } finally {
    quota.close();
  }
  const response = await r2.r2Usage(request("/api/r2/usage"));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    resources: 1,
    usedBytes: 18,
    reservedBytes: 3,
    ticketsIssued: 4,
    rejectedQuota: 2,
    rejectedDisk: 1,
    rejectedSize: 3,
  });
});

test("downloads an object's exact bytes with its content type, 404s a missing one", async () => {
  const resourceDir = join(dir, "resources");
  const bytes = new Uint8Array(256);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i;
  await seedObject(resourceDir, id, "bin.dat", bytes, "application/octet-stream");

  const found = await r2.r2Object(request(`/api/r2/${id}/objects/bin.dat`), id, "bin.dat");
  expect(found.status).toBe(200);
  expect(found.headers.get("content-type")).toBe("application/octet-stream");
  expect(new Uint8Array(await found.arrayBuffer())).toEqual(bytes);

  const missing = await r2.r2Object(request(`/api/r2/${id}/objects/nope`), id, "nope");
  expect(missing.status).toBe(404);
});
