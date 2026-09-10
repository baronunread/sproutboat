import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateCandidate, activateCandidateSerialized } from "./deployments";
import { setActivationClientForTest } from "./activation";

let dir = "";
let store: typeof import("./store");
const deployment = (id: string, artifact: string) => ({
  id,
  ownerId: "owner",
  project: "app",
  username: "alice",
  hostname: "app.alice.test",
  artifact,
  sproutPath: join(dir, "artifacts", artifact, "sprout"),
  deployedAt: new Date().toISOString(),
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-activation-control-"));
  process.env.SPROUTBOAT_DATABASE_PATH = join(dir, "control.sqlite");
  process.env.SPROUTBOAT_ROUTE_SNAPSHOT = join(dir, "routes.json");
  process.env.SPROUTBOAT_ARTIFACTS_DIR = join(dir, "artifacts");
  store = await import(`./store?activation=${Date.now()}`);
  for (const digest of ["a".repeat(64), "b".repeat(64)]) {
    await mkdir(join(dir, "artifacts", digest), { recursive: true });
    await writeFile(join(dir, "artifacts", digest, "sprout"), "binary");
  }
});
afterEach(async () => {
  setActivationClientForTest(null);
  store.closeStore();
  await rm(dir, { recursive: true, force: true });
});

test("promotion happens only after a staged candidate is ready and the route snapshot switched (#141)", async () => {
  const old = store.recordDeployment(deployment("old", "a".repeat(64)));
  await store.syncRoutes();
  const candidate = store.stageDeployment(deployment("candidate", "b".repeat(64)));
  const calls: string[] = [];
  setActivationClientForTest({
    stage: async () => {
      calls.push("stage");
    },
    promote: async () => {
      calls.push("promote");
      expect(store.projectDeployments("owner", "app").find((row) => row.active)?.id).toBe(candidate.id);
      // SAFETY: syncRoutes writes route records with a string sproutPath.
      expect(
        (JSON.parse(await readFile(join(dir, "routes.json"), "utf8")) as Array<{ sproutPath: string }>)[0]?.sproutPath,
      ).toBe(candidate.sproutPath);
    },
    discard: async () => {
      calls.push("discard");
    },
  });
  await activateCandidate("owner", "app", candidate);
  expect(calls).toEqual(["stage", "promote"]);
  expect(store.projectDeployment("owner", "app", old.id)?.active).toBe(false);
});

test("failed stage or promotion restores the old active route (#141)", async () => {
  const old = store.recordDeployment(deployment("old", "a".repeat(64)));
  await store.syncRoutes();
  const candidate = store.stageDeployment(deployment("candidate", "b".repeat(64)));
  setActivationClientForTest({
    stage: async () => {},
    promote: async () => {
      throw new Error("candidate died");
    },
    discard: async () => {},
  });
  await expect(activateCandidate("owner", "app", candidate)).rejects.toThrow("candidate died");
  expect(store.projectDeployments("owner", "app").find((row) => row.active)?.id).toBe(old.id);
  expect(store.projectDeployment("owner", "app", candidate.id)?.lifecycle).toBe("failed");
  // SAFETY: syncRoutes writes route records with a string sproutPath.
  expect(
    (JSON.parse(await readFile(join(dir, "routes.json"), "utf8")) as Array<{ sproutPath: string }>)[0]?.sproutPath,
  ).toBe(old.sproutPath);
});

test("same-project activations are serialized, leaving one deterministic active version (#141)", async () => {
  store.recordDeployment(deployment("old", "a".repeat(64)));
  const first = store.stageDeployment(deployment("first", "b".repeat(64)));
  const second = store.stageDeployment({ ...deployment("second", "a".repeat(64)), id: "second" });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const calls: string[] = [];
  setActivationClientForTest({
    stage: async (candidate) => {
      calls.push(`stage:${candidate.id}`);
      if (candidate.id === first.id) await held;
    },
    promote: async (id) => {
      calls.push(`promote:${id}`);
    },
    discard: async () => {},
  });
  const one = activateCandidateSerialized("owner", "app", first);
  await Bun.sleep(5);
  const two = activateCandidateSerialized("owner", "app", second);
  await Bun.sleep(5);
  expect(calls).toEqual(["stage:first"]);
  release();
  await Promise.all([one, two]);
  expect(calls).toEqual(["stage:first", "promote:first", "stage:second", "promote:second"]);
  expect(store.projectDeployments("owner", "app").find((row) => row.active)?.id).toBe(second.id);
});
