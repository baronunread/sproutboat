import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #74 — account-level storage resource registry (store layer).
let dir: string;
let store: typeof import("./store");
const roots: string[] = [];

beforeAll(async () => { store = await import("./store"); });
afterAll(async () => { store.closeStore(); await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }))); });
beforeEach(async () => {
  store.closeStore();
  dir = await mkdtemp(join(tmpdir(), "sb-resources-"));
  roots.push(dir);
  process.env.SPROUTBOAT_DATABASE_PATH = join(dir, "control.sqlite");
  process.env.SPROUTBOAT_ROUTE_SNAPSHOT = join(dir, "routes.json");
  process.env.SPROUTBOAT_ARTIFACTS_DIR = join(dir, "artifacts");
  process.env.SPROUTBOAT_DEPLOYMENTS_PATH = join(dir, "deployments.json");
});

test("create mints a kind-prefixed 24-hex id and round-trips through the reads", () => {
  const kv = store.createResource("user-1", "kv", "links");
  expect(kv.id).toMatch(/^kv_[0-9a-f]{24}$/);
  expect(store.resourceById("user-1", kv.id)).toEqual(kv);
  expect(store.ownerResources("user-1")).toEqual([kv]);
  expect(store.resourceCount("user-1")).toBe(1);
});

test("resources are account-scoped, not visible to another owner", () => {
  const kv = store.createResource("user-1", "kv", "shared");
  expect(store.resourceById("user-2", kv.id)).toBeUndefined();
  expect(store.ownerResources("user-2")).toEqual([]);
  expect(store.deleteResource("user-2", kv.id)).toBe(false);
});

test("the same (owner, kind, name) can't be created twice; a different kind or owner can", () => {
  store.createResource("user-1", "kv", "cache");
  expect(() => store.createResource("user-1", "kv", "cache")).toThrow();
  expect(store.createResource("user-1", "r2", "cache").id).toMatch(/^r2_/); // different kind is fine
  expect(store.createResource("user-2", "kv", "cache").id).toMatch(/^kv_/); // different owner is fine
});

test("ownerResources is ordered by kind then name", () => {
  store.createResource("user-1", "r2", "bravo");
  store.createResource("user-1", "kv", "zulu");
  store.createResource("user-1", "kv", "alpha");
  expect(store.ownerResources("user-1").map((r) => `${r.kind}/${r.name}`))
    .toEqual(["kv/alpha", "kv/zulu", "r2/bravo"]);
});

test("rename changes the name, keeps the id, and is owner-scoped", () => {
  const d1 = store.createResource("user-1", "d1", "old");
  expect(store.renameResource("user-2", d1.id, "hijack")).toBe(false);
  expect(store.renameResource("user-1", d1.id, "new")).toBe(true);
  expect(store.resourceById("user-1", d1.id)?.name).toBe("new");
});

test("delete removes exactly one resource and reports miss on a second call", () => {
  const q = store.createResource("user-1", "queue", "jobs");
  expect(store.deleteResource("user-1", q.id)).toBe(true);
  expect(store.deleteResource("user-1", q.id)).toBe(false);
  expect(store.resourceCount("user-1")).toBe(0);
});

test("deleteOwner purges the owner's resources", () => {
  store.createResource("user-1", "kv", "a");
  store.createResource("user-1", "analytics", "b");
  store.createResource("user-2", "kv", "keep");
  store.deleteOwner("user-1");
  expect(store.ownerResources("user-1")).toEqual([]);
  expect(store.ownerResources("user-2")).toHaveLength(1);
});
