import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { ActivationSpool } from "./activation";
import { stageCandidate } from "../../../apps/control/src/activation";

test("activation spool only stages the validated artifact then promotes its matching id (#141)", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-activation-"));
  const artifacts = join(root, "artifacts");
  const id = "11111111-1111-4111-8111-111111111111";
  const sproutPath = join(artifacts, "a".repeat(64), "sprout");
  await mkdir(join(root, "requests"), { recursive: true });
  await mkdir(join(root, "responses"), { recursive: true });
  await mkdir(join(artifacts, "a".repeat(64)), { recursive: true });
  const calls: string[] = [];
  const pool = {
    stageCandidate: async (candidate: { id: string }) => calls.push(`stage:${candidate.id}`),
    promoteCandidate: (candidateId: string) => calls.push(`promote:${candidateId}`),
    discardCandidate: (candidateId: string) => calls.push(`discard:${candidateId}`),
  };
  const previous = process.env.SPROUTBOAT_ARTIFACTS_DIR;
  process.env.SPROUTBOAT_ARTIFACTS_DIR = artifacts;
  try {
    await writeFile(join(root, "requests", `${id}.json`), JSON.stringify({ op: "stage", id, sproutPath }));
    const spool = new ActivationSpool(pool as never, root);
    await spool.poll();
    expect(calls).toEqual([`stage:${id}`]);
    expect(JSON.parse(await readFile(join(root, "responses", `${id}.json`), "utf8"))).toEqual({ id, ok: true });
  } finally {
    if (previous === undefined) delete process.env.SPROUTBOAT_ARTIFACTS_DIR;
    else process.env.SPROUTBOAT_ARTIFACTS_DIR = previous;
  }
});

test("control waits for edge's matching staged readiness reply over the private spool (#141)", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-activation-e2e-"));
  const artifacts = join(root, "artifacts");
  const id = "22222222-2222-4222-8222-222222222222";
  const sproutPath = join(artifacts, "b".repeat(64), "sprout");
  await mkdir(join(root, "requests"), { recursive: true });
  await mkdir(join(root, "responses"), { recursive: true });
  await mkdir(join(artifacts, "b".repeat(64)), { recursive: true });
  const before = {
    root: process.env.SPROUTBOAT_ACTIVATION_DIR,
    artifacts: process.env.SPROUTBOAT_ARTIFACTS_DIR,
    database: process.env.SPROUTBOAT_DATABASE_PATH,
    routes: process.env.SPROUTBOAT_ROUTE_SNAPSHOT,
  };
  process.env.SPROUTBOAT_ACTIVATION_DIR = root;
  process.env.SPROUTBOAT_ARTIFACTS_DIR = artifacts;
  process.env.SPROUTBOAT_DATABASE_PATH = join(root, "control.sqlite");
  process.env.SPROUTBOAT_ROUTE_SNAPSHOT = join(root, "routes.json");
  const calls: string[] = [];
  const spool = new ActivationSpool({ stageCandidate: async () => calls.push("stage") } as never, root);
  const timer = setInterval(() => void spool.poll(), 5);
  try {
    await stageCandidate({
      id,
      ownerId: "owner",
      project: "app",
      username: "alice",
      hostname: "app.alice.test",
      artifact: "b".repeat(64),
      sproutPath,
      deployedAt: new Date().toISOString(),
      active: false,
      lifecycle: "staged",
    });
    expect(calls).toEqual(["stage"]);
  } finally {
    clearInterval(timer);
    if (before.root === undefined) delete process.env.SPROUTBOAT_ACTIVATION_DIR;
    else process.env.SPROUTBOAT_ACTIVATION_DIR = before.root;
    if (before.artifacts === undefined) delete process.env.SPROUTBOAT_ARTIFACTS_DIR;
    else process.env.SPROUTBOAT_ARTIFACTS_DIR = before.artifacts;
    if (before.database === undefined) delete process.env.SPROUTBOAT_DATABASE_PATH;
    else process.env.SPROUTBOAT_DATABASE_PATH = before.database;
    if (before.routes === undefined) delete process.env.SPROUTBOAT_ROUTE_SNAPSHOT;
    else process.env.SPROUTBOAT_ROUTE_SNAPSHOT = before.routes;
  }
});
