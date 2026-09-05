import { afterAll, beforeAll, expect, test } from "bun:test";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let store: typeof import("./store");
const deployedAt = () => new Date().toISOString();

async function routes(): Promise<Array<{ hostname: string; sproutPath: string }>> {
  return JSON.parse(await readFile(join(dir, "routes.json"), "utf8"));
}
async function makeArtifact(digest: string): Promise<string> {
  const path = join(dir, "artifacts", digest);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "sprout"), "binary");
  return join(path, "sprout");
}
const D = (over: Partial<import("./store").Deployment> & { id: string; artifact: string }) => ({
  id: over.id,
  project: over.project ?? "app",
  ownerId: over.ownerId ?? "user-1",
  username: over.username ?? "alice",
  hostname: over.hostname ?? `${over.project ?? "app"}.alice.test`,
  artifact: over.artifact,
  sproutPath: over.sproutPath ?? join(dir, "artifacts", over.artifact, "sprout"),
  deployedAt: over.deployedAt ?? deployedAt(),
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-store-"));
  process.env.SPROUTBOAT_DATABASE_PATH = join(dir, "control.sqlite");
  process.env.SPROUTBOAT_ROUTE_SNAPSHOT = join(dir, "routes.json");
  process.env.SPROUTBOAT_ARTIFACTS_DIR = join(dir, "artifacts");
  process.env.SPROUTBOAT_DEPLOYMENTS_PATH = join(dir, "deployments.json");
  store = await import("./store");
});
afterAll(async () => {
  store.closeStore();
  await rm(dir, { recursive: true, force: true });
});

test("recordDeployment keeps exactly one active version per project", async () => {
  const a = "a".repeat(64),
    b = "b".repeat(64);
  await makeArtifact(a);
  await makeArtifact(b);
  store.recordDeployment(D({ id: "d1", artifact: a }));
  store.recordDeployment(D({ id: "d2", artifact: b }));
  const versions = store.projectDeployments("user-1", "app");
  expect(versions.map((v) => v.active)).toEqual([true, false]); // newest first, only d2 active
  expect(store.activeProjects("user-1")).toHaveLength(1);
  await store.syncRoutes();
  expect(await routes()).toEqual([{ hostname: "app.alice.test", sproutPath: join(dir, "artifacts", b, "sprout") }]);
});

test("activateDeployment rolls back to an older version without a second active row", () => {
  const back = store.activateDeployment("user-1", "app", "d1");
  expect(back?.id).toBe("d1");
  const active = store.projectDeployments("user-1", "app").filter((v) => v.active);
  expect(active.map((v) => v.id)).toEqual(["d1"]);
  expect(store.activateDeployment("user-1", "app", "missing")).toBeUndefined();
});

test("deleteProject drops the route and GCs only unreferenced artifacts", async () => {
  const shared = "c".repeat(64);
  await makeArtifact(shared);
  store.recordDeployment(D({ id: "d3", project: "app", artifact: shared })); // app -> shared (active)
  store.recordDeployment(D({ id: "d4", project: "other", hostname: "other.alice.test", artifact: shared })); // other -> shared

  const result = store.deleteProject("user-1", "app");
  expect(result.removed).toBe(3); // d1, d2, d3
  expect(result.orphanedArtifacts.sort()).toEqual(["a".repeat(64), "b".repeat(64)]); // not shared: still used by "other"
  const cleanup = await store.collectArtifacts(result.orphanedArtifacts);
  expect(cleanup.removed.sort()).toEqual(["a".repeat(64), "b".repeat(64)]);
  expect(cleanup.failed).toEqual([]);
  await store.syncRoutes();
  expect((await routes()).map((r) => r.hostname)).toEqual(["other.alice.test"]);
  expect(store.projectDeployments("user-1", "app")).toEqual([]);
});

test("deleteOwner removes every project, route, and now-orphaned artifact", async () => {
  const result = store.deleteOwner("user-1");
  expect(result.removed).toBe(1); // the "other" deployment
  expect(result.hostnames).toEqual(["other.alice.test"]);
  expect(result.orphanedArtifacts).toEqual(["c".repeat(64)]);
  await store.syncRoutes();
  expect(await routes()).toEqual([]);
  expect(store.ownerDeployments("user-1")).toEqual([]);
});

test("collectArtifacts ignores digests it has no record of and never throws", async () => {
  const out = await store.collectArtifacts(["../etc", "not-hex", "d".repeat(64)]);
  expect(out).toEqual({ removed: [], failed: [] });
});

test("collectArtifacts never removes an artifact a deployment still references", async () => {
  const e = "e".repeat(64);
  await makeArtifact(e);
  store.recordDeployment(D({ id: "d5", project: "keep", hostname: "keep.alice.test", artifact: e }));

  const out = await store.collectArtifacts([e]);
  expect(out).toEqual({ removed: [], failed: [] });
  let bytesGone = false;
  try {
    await access(join(dir, "artifacts", e, "sprout"));
  } catch {
    bytesGone = true;
  }
  expect(bytesGone).toBe(false); // bytes untouched

  store.deleteProject("user-1", "keep");
  await store.syncRoutes();
});

test("syncRoutes serializes so a later mutation is never lost to an earlier snapshot", async () => {
  store.deleteOwner("user-1");
  await store.syncRoutes();
  const f = "f".repeat(64),
    g = "0".repeat(64);
  await makeArtifact(f);
  await makeArtifact(g);

  store.recordDeployment(D({ id: "s1", project: "one", hostname: "one.alice.test", artifact: f }));
  const first = store.syncRoutes();
  store.recordDeployment(D({ id: "s2", project: "two", hostname: "two.alice.test", artifact: g }));
  const second = store.syncRoutes();
  await Promise.all([first, second]);

  expect((await routes()).map((r) => r.hostname).sort()).toEqual(["one.alice.test", "two.alice.test"]);
  store.deleteOwner("user-1");
});

test("deleteDeployment removes an inactive version only, GCs its orphan, scoped to owner", async () => {
  const h1 = "1".repeat(64),
    h2 = "2".repeat(64);
  await makeArtifact(h1);
  await makeArtifact(h2);
  store.recordDeployment(D({ id: "v1", project: "site", hostname: "site.alice.test", artifact: h1 }));
  store.recordDeployment(D({ id: "v2", project: "site", hostname: "site.alice.test", artifact: h2 })); // v2 active, v1 superseded

  expect(store.projectDeployment("user-1", "site", "v1")?.artifact).toBe(h1);
  expect(store.projectDeployment("user-1", "site", "missing")).toBeUndefined();
  expect(store.projectDeployment("user-2", "site", "v1")).toBeUndefined();

  expect(store.deleteDeployment("user-1", "site", "v2")).toEqual({
    deleted: false,
    active: true,
    orphanedArtifacts: [],
  });
  expect(store.deleteDeployment("user-2", "site", "v1")).toBeUndefined();

  const gone = store.deleteDeployment("user-1", "site", "v1");
  expect(gone).toEqual({ deleted: true, active: false, orphanedArtifacts: [h1] });
  const cleanup = await store.collectArtifacts(gone?.orphanedArtifacts ?? []);
  expect(cleanup.removed).toEqual([h1]);
  expect(store.projectDeployments("user-1", "site").map((deployment) => deployment.id)).toEqual(["v2"]);

  store.deleteOwner("user-1");
});

test("banOwner drops the owner's routes from the snapshot; unbanOwner restores them", async () => {
  const x = "e".repeat(64),
    y = "f".repeat(64);
  await makeArtifact(x);
  await makeArtifact(y);
  store.recordDeployment(
    D({ id: "ba1", ownerId: "acct-a", username: "ann", project: "a1", hostname: "a1.ann.test", artifact: x }),
  );
  store.recordDeployment(
    D({ id: "bb1", ownerId: "acct-b", username: "bo", project: "b1", hostname: "b1.bo.test", artifact: y }),
  );
  await store.syncRoutes();
  expect((await routes()).map((r) => r.hostname).sort()).toEqual(["a1.ann.test", "b1.bo.test"]);

  store.banOwner("acct-a");
  await store.syncRoutes();
  expect((await routes()).map((r) => r.hostname)).toEqual(["b1.bo.test"]);
  expect(store.bannedOwners()).toEqual(["acct-a"]);

  store.unbanOwner("acct-a");
  await store.syncRoutes();
  expect((await routes()).map((r) => r.hostname).sort()).toEqual(["a1.ann.test", "b1.bo.test"]);
});

test("globalStats and ownerRollups aggregate across owners", () => {
  store.banOwner("acct-b");
  const stats = store.globalStats();
  expect({
    owners: stats.owners,
    projects: stats.projects,
    deployments: stats.deployments,
    bannedOwners: stats.bannedOwners,
  }).toEqual({ owners: 2, projects: 2, deployments: 2, bannedOwners: 1 });

  const rollups = store.ownerRollups().sort((left, right) => left.ownerId.localeCompare(right.ownerId));
  expect(rollups).toEqual([
    { ownerId: "acct-a", username: "ann", projects: 1, deployments: 1, activeProjects: 1, banned: false },
    { ownerId: "acct-b", username: "bo", projects: 1, deployments: 1, activeProjects: 1, banned: true },
  ]);

  store.deleteOwner("acct-a");
  store.deleteOwner("acct-b");
  store.unbanOwner("acct-b");
});

test("#76 — deploymentResources returns the version's bound resources, owner-scoped", async () => {
  const digest = "9".repeat(64);
  await makeArtifact(digest);
  const kv = store.createResource("res-owner", "kv", "sessions");
  const r2 = store.createResource("res-owner", "r2", "uploads");
  const other = store.createResource("other-owner", "kv", "theirs");
  store.recordDeployment({
    ...D({ id: "dr1", ownerId: "res-owner", project: "bound", hostname: "bound.res.test", artifact: digest }),
    resourceIds: [kv.id, r2.id, other.id, kv.id], // duplicate + a resource this owner does not hold
  });

  expect(store.deploymentResources("res-owner", "dr1").map((resource) => resource.name)).toEqual([
    "sessions",
    "uploads",
  ]);
  expect(store.deploymentResources("other-owner", "dr1")).toEqual([]); // another owner sees nothing
  expect(store.deploymentResources("res-owner", "missing")).toEqual([]);

  store.deleteOwner("res-owner");
  store.deleteResource("res-owner", kv.id);
  store.deleteResource("res-owner", r2.id);
  store.deleteResource("other-owner", other.id);
});
