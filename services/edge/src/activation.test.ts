import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { ActivationSpool } from "./activation";
import { stageCandidate } from "../../../apps/control/src/activation";

async function expectEmpty(directory: string): Promise<void> {
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    if ((await readdir(directory)).length === 0) return;
    await Bun.sleep(5);
  }
  expect(await readdir(directory)).toEqual([]);
}

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
    await writeFile(
      join(root, "requests", `${id}.json`),
      JSON.stringify({ op: "stage", id, sproutPath, hostname: "app.alice.test" }),
    );
    // SAFETY: this fixture implements exactly the pool methods this command invokes.
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
  // SAFETY: this fixture implements exactly the stage method this command invokes.
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

test("confirm forces the edge-side exact route-generation validator without enabling a candidate (#141)", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-activation-confirm-"));
  const artifacts = join(root, "artifacts");
  const id = "44444444-4444-4444-8444-444444444444";
  const sproutPath = join(artifacts, "d".repeat(64), "sprout");
  await mkdir(join(root, "requests"), { recursive: true });
  await mkdir(join(root, "responses"), { recursive: true });
  await mkdir(join(artifacts, "d".repeat(64)), { recursive: true });
  const previous = process.env.SPROUTBOAT_ARTIFACTS_DIR;
  process.env.SPROUTBOAT_ARTIFACTS_DIR = artifacts;
  let validated = "";
  const calls: string[] = [];
  try {
    await writeFile(
      join(root, "requests", `${id}.json`),
      JSON.stringify({
        op: "confirm",
        id,
        hostname: "app.alice.test",
        sproutPath,
        secretsPath: "/tmp/secrets.json",
        secretsHash: "rotated",
        services: { API: "api.alice.test" },
      }),
    );
    // SAFETY: this fixture implements only the pool method a confirm command
    // could call if it accidentally enabled a candidate.
    const spool = new ActivationSpool(
      {
        promoteCandidate: () => calls.push("promote"),
      } as never,
      root,
      async (candidate) => {
        validated = `${candidate.hostname}:${candidate.sproutPath}:${candidate.secretsHash}:${candidate.services?.API}`;
      },
    );
    await spool.poll();
    expect(validated).toBe(`app.alice.test:${sproutPath}:rotated:api.alice.test`);
    expect(calls).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.SPROUTBOAT_ARTIFACTS_DIR;
    else process.env.SPROUTBOAT_ARTIFACTS_DIR = previous;
  }
});

test("a timed-out stage waits for discard acknowledgement so a late spool poll cannot orphan it (#141)", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-activation-timeout-"));
  const artifacts = join(root, "artifacts");
  const id = "33333333-3333-4333-8333-333333333333";
  const sproutPath = join(artifacts, "c".repeat(64), "sprout");
  await mkdir(join(root, "requests"), { recursive: true });
  await mkdir(join(root, "responses"), { recursive: true });
  await mkdir(join(artifacts, "c".repeat(64)), { recursive: true });
  const before = {
    root: process.env.SPROUTBOAT_ACTIVATION_DIR,
    artifacts: process.env.SPROUTBOAT_ARTIFACTS_DIR,
    database: process.env.SPROUTBOAT_DATABASE_PATH,
    routes: process.env.SPROUTBOAT_ROUTE_SNAPSHOT,
    timeout: process.env.SPROUTBOAT_ACTIVATION_TIMEOUT_MS,
  };
  process.env.SPROUTBOAT_ACTIVATION_DIR = root;
  process.env.SPROUTBOAT_ARTIFACTS_DIR = artifacts;
  process.env.SPROUTBOAT_DATABASE_PATH = join(root, "control.sqlite");
  process.env.SPROUTBOAT_ROUTE_SNAPSHOT = join(root, "routes.json");
  process.env.SPROUTBOAT_ACTIVATION_TIMEOUT_MS = "1000";
  const calls: string[] = [];
  let liveCandidates = 0;
  // SAFETY: this fixture implements exactly the stage/discard methods this command invokes.
  const spool = new ActivationSpool(
    {
      stageCandidate: async () => {
        calls.push("stage");
        liveCandidates += 1;
      },
      discardCandidate: () => {
        calls.push("discard");
        liveCandidates = 0;
      },
    } as never,
    root,
  );
  try {
    const pending = stageCandidate({
      id,
      ownerId: "owner",
      project: "app",
      username: "alice",
      hostname: "app.alice.test",
      artifact: "c".repeat(64),
      sproutPath,
      deployedAt: new Date().toISOString(),
      active: false,
      lifecycle: "staged",
    });
    // Let control's stage wait expire before edge begins polling. The stage
    // request is still on disk, so the subsequent discard acknowledgement is
    // what prevents it becoming a late live candidate.
    await Bun.sleep(1_050);
    const timer = setInterval(() => void spool.poll(), 5);
    try {
      await expect(pending).rejects.toThrow("edge activation timed out");
    } finally {
      clearInterval(timer);
    }
    // Commands sort by their envelope UUID. Discard can win the race and stop
    // the stage before it starts, or stage can win and be discarded next. In
    // either order the final action is candidate cleanup, never a live orphan.
    expect(calls).toContain("discard");
    expect(calls.at(-1)).toBe("discard");
    expect(liveCandidates).toBe(0);
    await expectEmpty(join(root, "requests"));
    await expectEmpty(join(root, "responses"));
  } finally {
    if (before.root === undefined) delete process.env.SPROUTBOAT_ACTIVATION_DIR;
    else process.env.SPROUTBOAT_ACTIVATION_DIR = before.root;
    if (before.artifacts === undefined) delete process.env.SPROUTBOAT_ARTIFACTS_DIR;
    else process.env.SPROUTBOAT_ARTIFACTS_DIR = before.artifacts;
    if (before.database === undefined) delete process.env.SPROUTBOAT_DATABASE_PATH;
    else process.env.SPROUTBOAT_DATABASE_PATH = before.database;
    if (before.routes === undefined) delete process.env.SPROUTBOAT_ROUTE_SNAPSHOT;
    else process.env.SPROUTBOAT_ROUTE_SNAPSHOT = before.routes;
    if (before.timeout === undefined) delete process.env.SPROUTBOAT_ACTIVATION_TIMEOUT_MS;
    else process.env.SPROUTBOAT_ACTIVATION_TIMEOUT_MS = before.timeout;
  }
});
