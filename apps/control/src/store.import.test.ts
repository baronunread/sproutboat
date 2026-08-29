import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fresh module per test file, so the first store call runs connection() +
// importLegacyDeployments() against whatever we staged in beforeAll.

let dir: string;
let store: typeof import("./store");

async function bootWith(deploymentsJson: string): Promise<typeof import("./store")> {
  dir = await mkdtemp(join(tmpdir(), "sb-import-"));
  process.env.SPROUTBOAT_DATABASE_PATH = join(dir, "control.sqlite");
  process.env.SPROUTBOAT_ROUTE_SNAPSHOT = join(dir, "routes.json");
  process.env.SPROUTBOAT_ARTIFACTS_DIR = join(dir, "artifacts");
  process.env.SPROUTBOAT_DEPLOYMENTS_PATH = join(dir, "deployments.json");
  await writeFile(process.env.SPROUTBOAT_DEPLOYMENTS_PATH, deploymentsJson);
  return import("./store");
}

const row = (over: Partial<import("./store").Deployment>) => ({
  id: "id", project: "app", ownerId: "user-1", username: "alice",
  hostname: "app.alice.test", artifact: "a".repeat(64),
  workerPath: "/w", deployedAt: "2026-01-01T00:00:00.000Z", active: false, ...over,
});

afterEach(async () => {
  store?.closeStore();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("imports legacy deployments.json once, then renames it aside", async () => {
  store = await bootWith(JSON.stringify([
    row({ id: "d1", project: "app", artifact: "a".repeat(64), active: false }),
    row({ id: "d2", project: "app", artifact: "b".repeat(64), active: true }),
    row({ id: "d3", project: "blog", hostname: "blog.alice.test", artifact: "b".repeat(64), active: true }),
  ]));

  expect(store.ownerDeployments("user-1").map((d) => d.id).sort()).toEqual(["d1", "d2", "d3"]);
  expect(store.activeProjects("user-1").map((p) => p.name).sort()).toEqual(["app", "blog"]);

  await expect(readFile(join(dir, "deployments.json"), "utf8")).rejects.toThrow();
  await expect(readFile(join(dir, "deployments.json.imported"), "utf8")).resolves.toContain("d1");

  // Re-open: deployments table is non-empty, so no re-import and no throw.
  store.closeStore();
  expect(store.ownerDeployments("user-1")).toHaveLength(3);
});

test("a corrupt legacy file is skipped, not fatal", async () => {
  store = await bootWith("{ this is not json");
  expect(store.ownerDeployments("user-1")).toEqual([]);
});

test("import is atomic: a duplicate id in the file does not half-populate", async () => {
  // Second row reuses d1's id; INSERT OR IGNORE keeps the first, the rest still land.
  store = await bootWith(JSON.stringify([
    row({ id: "d1", project: "app", artifact: "a".repeat(64) }),
    row({ id: "d1", project: "app", artifact: "c".repeat(64) }),
    row({ id: "d9", project: "app", artifact: "c".repeat(64), active: true }),
  ]));
  expect(store.ownerDeployments("user-1").map((d) => d.id).sort()).toEqual(["d1", "d9"]);
  expect(store.projectDeployments("user-1", "app").find((d) => d.id === "d1")?.artifact).toBe("a".repeat(64));
});
