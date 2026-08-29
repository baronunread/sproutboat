import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let dbFile: string;
let identity: typeof import("./identity");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-identity-"));
  dbFile = join(dir, "control.sqlite");
  process.env.SPROUTBOAT_DATABASE_PATH = dbFile;
  const seed = new Database(dbFile);
  seed.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, userId TEXT);
    CREATE TABLE account (id TEXT PRIMARY KEY, userId TEXT);
    CREATE TABLE apikey (id TEXT PRIMARY KEY, referenceId TEXT);
    CREATE TABLE cli_authorizations (user_code TEXT PRIMARY KEY, user_id TEXT);
  `);
  seed.run("INSERT INTO user VALUES ('u1', 'a@x.test'), ('u2', 'b@x.test')");
  seed.run("INSERT INTO session VALUES ('s1', 'u1'), ('s2', 'u2')");
  seed.run("INSERT INTO account VALUES ('a1', 'u1')");
  seed.run("INSERT INTO apikey VALUES ('k1', 'u1'), ('k2', 'u1')");
  seed.run("INSERT INTO cli_authorizations VALUES ('AAAA-BBBB', 'u1')");
  seed.close();
  identity = await import("./identity");
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

test("purgeUser removes every identity row for one user and leaves others intact", () => {
  const touched = identity.purgeUser("u1").sort();
  expect(touched).toEqual(["account", "apikey", "cli_authorizations", "session", "user"]); // no profiles row existed

  const check = new Database(dbFile, { readonly: true });
  for (const table of ["user", "session", "account", "apikey", "cli_authorizations"]) {
    // SAFETY: fixed literal table name from this test's own schema.
    const left = check.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    expect(left.n).toBe(table === "user" || table === "session" ? 1 : 0); // u2's rows survive
  }
  check.close();
});

test("purgeUser is idempotent", () => {
  expect(identity.purgeUser("u1")).toEqual([]);
});

test("safeSessionUser exposes only id/name/email/image and drops OAuth tokens", () => {
  const raw = {
    id: "u9", name: "Ada", email: "ada@x.test", image: "https://avatars.example/ada.png",
    emailVerified: true, accessToken: "gho_secret", refreshToken: "ghr_secret", createdAt: "2026-01-01",
  };
  const safe = identity.safeSessionUser(raw);
  expect(safe).toEqual({ id: "u9", name: "Ada", email: "ada@x.test", image: "https://avatars.example/ada.png" });
  expect(JSON.stringify(safe)).not.toContain("secret");
});

test("safeSessionUser normalises a missing avatar and name to null", () => {
  expect(identity.safeSessionUser({ id: "u1", email: "a@x.test" }))
    .toEqual({ id: "u1", name: null, email: "a@x.test", image: null });
});
