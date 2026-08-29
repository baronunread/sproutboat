import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

/**
 * The pinned Porffor identity. The `alpha-*` git tags ship no package.json, so
 * bun records both the requested tag and the resolved commit in bun.lock — read
 * the channel from the dep spec and the commit from the resolution entry.
 * PORFFOR_VERSION overrides for one-off retests of another build.
 */
export function porfforVersion(): string {
  if (process.env.PORFFOR_VERSION) return process.env.PORFFOR_VERSION;
  try {
    const lock = readFileSync(resolve(root, "bun.lock"), "utf8");
    const channel = /"porffor":\s*"github:CanadaHonk\/porffor#([\w.-]+)"/.exec(lock)?.[1];
    const commit = /CanadaHonk\/porffor#([0-9a-f]{7,40})/.exec(lock)?.[1];
    if (channel) return commit ? `${channel} (${commit.slice(0, 7)})` : channel;
  } catch { /* fall through */ }
  return "unknown";
}
