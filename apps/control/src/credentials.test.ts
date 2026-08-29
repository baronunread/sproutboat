import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let identity: typeof import("./identity");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-cred-"));
  process.env.SPROUTBOAT_DATABASE_PATH = join(dir, "control.sqlite");
  const seed = new Database(process.env.SPROUTBOAT_DATABASE_PATH);
  seed.exec(`CREATE TABLE apikey (
    id TEXT PRIMARY KEY, name TEXT, prefix TEXT, start TEXT, referenceId TEXT NOT NULL,
    key TEXT NOT NULL, enabled INTEGER DEFAULT 1, createdAt TEXT, lastRequest TEXT, expiresAt TEXT
  )`);
  seed.run(`INSERT INTO apikey (id,name,prefix,start,referenceId,key,enabled,createdAt,lastRequest,expiresAt) VALUES
    ('k1','laptop','sproutboat_','sproutboat_ab12','u1','HASH_ONE',1,'2026-01-01T00:00:00.000Z','2026-02-01T10:00:00.000Z',NULL),
    ('k2','ci','sproutboat_','sproutboat_cd34','u1','HASH_TWO',1,'2026-03-01T00:00:00.000Z',NULL,'2026-12-01T00:00:00.000Z'),
    ('k3','bob-key','sproutboat_','sproutboat_ef56','u2','HASH_THREE',1,'2026-01-15T00:00:00.000Z',NULL,NULL)`);
  seed.close();
  identity = await import("./identity");
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

test("listCredentials: owner-scoped, newest first, safe fields only, no hash", () => {
  const list = identity.listCredentials("u1");
  expect(list.map((credential) => credential.id)).toEqual(["k2", "k1"]);
  expect(list[0]).toEqual({
    id: "k2", name: "ci", prefix: "sproutboat_", start: "sproutboat_cd34",
    createdAt: "2026-03-01T00:00:00.000Z", lastUsedAt: null, expiresAt: "2026-12-01T00:00:00.000Z", enabled: true,
  });
  expect(list[1].lastUsedAt).toBe("2026-02-01T10:00:00.000Z");
  expect(JSON.stringify(list)).not.toContain("HASH");
});

test("listCredentials never returns another user's keys", () => {
  expect(identity.listCredentials("u2").map((credential) => credential.id)).toEqual(["k3"]);
  expect(identity.listCredentials("nobody")).toEqual([]);
});

test("revokeCredential removes only the caller's matching key", () => {
  expect(identity.revokeCredential("u2", "k1")).toBe(false); // k1 is u1's
  expect(identity.revokeCredential("u1", "k1")).toBe(true);
  expect(identity.listCredentials("u1").map((credential) => credential.id)).toEqual(["k2"]);
  expect(identity.revokeCredential("u1", "k1")).toBe(false); // already gone
});

test("revokeAllCredentials clears the caller's keys and nobody else's", () => {
  expect(identity.revokeAllCredentials("u1")).toBe(1); // k2 left over from the previous test
  expect(identity.listCredentials("u1")).toEqual([]);
  expect(identity.listCredentials("u2").map((credential) => credential.id)).toEqual(["k3"]);
});
