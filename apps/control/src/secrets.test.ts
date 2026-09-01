import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #2 — secret storage (encrypted at rest) + injection into the route snapshot.
let dir: string;
let store: typeof import("./store");
let crypto: typeof import("./secrets-crypto");
const roots: string[] = [];

async function routes(): Promise<Array<{ hostname: string; sproutPath: string; secretsPath?: string; secretsHash?: string }>> {
  return JSON.parse(await readFile(join(dir, "routes.json"), "utf8"));
}
async function deploy(project = "app", id = "d1"): Promise<void> {
  const artifactDir = join(dir, "artifacts", id);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "sprout"), "binary");
  store.recordDeployment({ id, ownerId: "user-1", project, username: "alice", hostname: `${project}.alice.test`, artifact: id, sproutPath: join(artifactDir, "sprout"), deployedAt: new Date().toISOString() });
  await store.syncRoutes();
}

beforeAll(async () => {
  store = await import("./store");
  crypto = await import("./secrets-crypto");
});
afterAll(async () => { store.closeStore(); await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }))); });
beforeEach(async () => {
  store.closeStore();
  crypto.resetSecretsKeyForTest();
  dir = await mkdtemp(join(tmpdir(), "sb-secrets-"));
  roots.push(dir);
  process.env.SPROUTBOAT_DATABASE_PATH = join(dir, "control.sqlite");
  process.env.SPROUTBOAT_ROUTE_SNAPSHOT = join(dir, "routes.json");
  process.env.SPROUTBOAT_ARTIFACTS_DIR = join(dir, "artifacts");
  process.env.SPROUTBOAT_DEPLOYMENTS_PATH = join(dir, "deployments.json");
  delete process.env.SPROUTBOAT_SECRETS_KEY;
});

test("encrypt/decrypt round-trips and ciphertext is not the plaintext", () => {
  const secret = "hunter2-\u{1F510}";
  const box = crypto.encryptSecret(secret);
  expect(box).not.toContain("hunter2");
  expect(crypto.decryptSecret(box)).toBe(secret);
});

test("a tampered ciphertext fails the auth tag", () => {
  const box = crypto.encryptSecret("x");
  const bytes = Buffer.from(box, "base64");
  bytes[bytes.length - 1] ^= 0xff; // flip a tag bit
  expect(() => crypto.decryptSecret(bytes.toString("base64"))).toThrow();
});

test("setSecret stores ciphertext; the DB never holds the plaintext", async () => {
  await deploy();
  store.setSecret("user-1", "app", "API_KEY", "s3cr3t-value");
  expect(store.secretNames("user-1", "app")).toEqual(["API_KEY"]);
  const raw = await readFile(join(dir, "control.sqlite"));
  expect(raw.includes(Buffer.from("s3cr3t-value"))).toBe(false);
});

test("syncRoutes writes a 0600 secrets.json and points the route at it", async () => {
  await deploy();
  store.setSecret("user-1", "app", "TOKEN", "abc");
  store.setSecret("user-1", "app", "OTHER", "def");
  await store.syncRoutes();

  const [route] = await routes();
  expect(route.secretsPath).toBeString();
  expect(route.secretsHash).toBeString();
  const written = JSON.parse(await readFile(route.secretsPath!, "utf8"));
  expect(written).toEqual({ OTHER: "def", TOKEN: "abc" });
});

test("the secrets hash moves only when a value changes", async () => {
  await deploy();
  store.setSecret("user-1", "app", "TOKEN", "one");
  await store.syncRoutes();
  const first = (await routes())[0].secretsHash ?? "";
  expect(first).not.toBe("");

  await store.syncRoutes(); // no change
  expect((await routes())[0].secretsHash ?? "").toBe(first);

  store.setSecret("user-1", "app", "TOKEN", "two");
  await store.syncRoutes();
  expect((await routes())[0].secretsHash ?? "").not.toBe(first);
});

test("deleting the last secret drops secretsPath from the route", async () => {
  await deploy();
  store.setSecret("user-1", "app", "ONLY", "v");
  await store.syncRoutes();
  expect((await routes())[0].secretsPath).toBeString();

  expect(store.deleteSecret("user-1", "app", "ONLY")).toBe(true);
  await store.syncRoutes();
  expect((await routes())[0].secretsPath).toBeUndefined();
});

test("deleting the project removes its secrets (FK cascade)", async () => {
  await deploy();
  store.setSecret("user-1", "app", "GONE", "v");
  store.deleteProject("user-1", "app");
  expect(store.secretNames("user-1", "app")).toEqual([]);
  expect(store.secretCount("user-1", "app")).toBe(0);
});
