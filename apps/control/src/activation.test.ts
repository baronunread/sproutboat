import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveActivations } from "../../../services/edge/src/activation";
import { stageCandidate } from "./activation";
import type { RouteEntry } from "./store";

const route: RouteEntry = {
  hostname: "app.alice.test",
  sproutPath: "/var/lib/sproutboat/artifacts/abc/sprout",
  ownerId: "user-1",
  r2ResourceIds: [],
  doStoreId: `do_${"0".repeat(24)}`,
};
let dir: string;
let edge: ReturnType<typeof setInterval> | null = null;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-activation-"));
  process.env.SPROUTBOAT_ACTIVATION_DIR = dir;
});
afterEach(async () => {
  if (edge) clearInterval(edge);
  edge = null;
  delete process.env.SPROUTBOAT_ACTIVATION_DIR;
  delete process.env.SPROUTBOAT_ACTIVATION_TIMEOUT_MS;
  await rm(dir, { recursive: true, force: true });
});
const runEdge = (start: (request: string) => Promise<void>) => {
  edge = setInterval(() => void serveActivations(dir, start), 20);
};

test("resolves once the edge starts the candidate, and leaves nothing behind", async () => {
  let seen: RouteEntry[] = [];
  runEdge(async (request) => {
    seen = await Bun.file(request).json();
  });
  await stageCandidate(route);
  expect(seen).toEqual([route]);
  expect(await readdir(dir)).toEqual([]);
});

test("reports the edge's start failure", async () => {
  runEdge(async () => {
    throw new Error("sprout exited before it began listening");
  });
  await expect(stageCandidate(route)).rejects.toThrow(
    "new version did not start: sprout exited before it began listening",
  );
  expect(await readdir(dir)).toEqual([]);
});

test("gives up after the timeout when no edge answers", async () => {
  process.env.SPROUTBOAT_ACTIVATION_TIMEOUT_MS = "200";
  await expect(stageCandidate(route)).rejects.toThrow("did not start within 200ms");
  expect(await readdir(dir)).toEqual([]);
});

test("without an activation dir it routes straight away", async () => {
  delete process.env.SPROUTBOAT_ACTIVATION_DIR;
  await stageCandidate(route);
});
