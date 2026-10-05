/**
 * #141: start a deployment on the edge before its route goes live, so a version
 * that can't start never replaces a working one.
 *
 * Control and edge are different users. They meet in SPROUTBOAT_ACTIVATION_DIR,
 * a directory only the `sproutboat` group can write and the sprout sandbox never
 * mounts: control drops `<id>.request.json` (a one-entry route snapshot), the
 * edge starts that exact runtime with timers held and answers in
 * `<id>.reply.json`. Control removes both.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RouteEntry } from "./store";

// Above the supervisor's 10s readiness timeout, so the edge's own error wins.
const timeoutMs = () => Number(process.env.SPROUTBOAT_ACTIVATION_TIMEOUT_MS) || 20_000;

export async function stageCandidate(route: RouteEntry): Promise<void> {
  const root = process.env.SPROUTBOAT_ACTIVATION_DIR;
  // No edge watches for requests (local dev without the edge, unit tests):
  // route straight away, as before #141.
  if (!root) return;
  const id = randomUUID();
  const request = resolve(root, `${id}.request.json`);
  const reply = resolve(root, `${id}.reply.json`);
  await writeFile(`${request}.tmp`, JSON.stringify([route]), { mode: 0o640 });
  await rename(`${request}.tmp`, request);
  try {
    const deadline = Date.now() + timeoutMs();
    while (Date.now() < deadline) {
      const text = await readFile(reply, "utf8").catch(() => null);
      if (text !== null) {
        // SAFETY: written by the edge's activation spool as { ok, error? }.
        const result = JSON.parse(text) as { ok: boolean; error?: string };
        if (!result.ok) throw new Error(`new version did not start: ${result.error ?? "unknown error"}`);
        return;
      }
      await Bun.sleep(50);
    }
    throw new Error(`new version did not start within ${timeoutMs()}ms`);
  } finally {
    // Request first: an edge that picks it up late then finds nothing to do.
    await rm(request, { force: true });
    await rm(reply, { force: true });
  }
}
