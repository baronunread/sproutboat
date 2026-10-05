import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveActivations } from "./activation";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-activation-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const reply = async (id: string) => JSON.parse(await readFile(join(dir, `${id}.reply.json`), "utf8"));

test("answers each request once: ok when the candidate starts, the error when it doesn't", async () => {
  await writeFile(join(dir, "good.request.json"), "[]");
  await writeFile(join(dir, "bad.request.json"), "[]");
  const started: string[] = [];
  await serveActivations(dir, async (request) => {
    started.push(request);
    if (request.endsWith("bad.request.json")) throw new Error("sprout exited before it began listening");
  });
  expect(await reply("good")).toEqual({ ok: true });
  expect(await reply("bad")).toEqual({ ok: false, error: "sprout exited before it began listening" });
  // Already answered: the next poll leaves them alone until control cleans up.
  await serveActivations(dir, async () => {
    throw new Error("must not run twice");
  });
  expect(started).toHaveLength(2);
});

test("drops its reply when control gave up while the candidate was starting", async () => {
  await writeFile(join(dir, "late.request.json"), "[]");
  await serveActivations(dir, async (request) => {
    await rm(request); // control's timeout cleanup
  });
  expect(existsSync(join(dir, "late.reply.json"))).toBe(false);
});
