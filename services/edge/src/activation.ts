/**
 * #141: answer control's "start this candidate" requests (see
 * apps/control/src/activation.ts). `start` gets the request path, parses it as
 * a route snapshot and resolves once the candidate listens; any throw is the
 * failure control reports to the deployer.
 */
import { existsSync } from "node:fs";
import { readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

let busy = false;

// ponytail: one request at a time, so a candidate that never listens holds the
// queue for the supervisor's readiness timeout. Fine at single-box deploy rates.
export async function serveActivations(dir: string, start: (request: string) => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const names = await readdir(dir).catch((): string[] => []);
    for (const name of names) {
      if (!name.endsWith(".request.json")) continue;
      const request = resolve(dir, name);
      const reply = request.replace(/\.request\.json$/, ".reply.json");
      if (existsSync(reply)) continue;
      let result: { ok: true } | { ok: false; error: string };
      try {
        await start(request);
        result = { ok: true };
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      await writeFile(`${reply}.tmp`, JSON.stringify(result), { mode: 0o640 });
      await rename(`${reply}.tmp`, reply);
      // Control timed out and removed its request while we worked; nobody reads this.
      if (!existsSync(request)) await rm(reply, { force: true });
    }
  } finally {
    busy = false;
  }
}
