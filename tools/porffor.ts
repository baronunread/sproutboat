import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

/**
 * The pinned Porffor identity. The `alpha-3` git tag ships no package.json, so
 * bun records the resolved commit in bun.lock — read it from there. PORFFOR_VERSION
 * overrides for one-off retests of another build.
 */
export function porfforVersion(): string {
  if (process.env.PORFFOR_VERSION) return process.env.PORFFOR_VERSION;
  try {
    const match = /CanadaHonk\/porffor#([0-9a-f]{7,40})/.exec(readFileSync(resolve(root, "bun.lock"), "utf8"));
    if (match) return `alpha-3 (${match[1].slice(0, 7)})`;
  } catch { /* fall through */ }
  return "alpha-3";
}
