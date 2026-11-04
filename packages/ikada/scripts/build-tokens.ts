/**
 * Generates theme.css, tokens.generated.ts and the tables in DESIGN.md.
 * `--check` writes nothing and exits 1 when the files on disk are stale.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDocRegions, renderThemeCss, renderTokensTs } from "../tokens/generate";

const root = join(import.meta.dir, "..");
const repo = join(root, "..", "..");
const outputs = [
  { path: join(root, "src/theme.css"), next: () => renderThemeCss() },
  { path: join(root, "src/tokens.generated.ts"), next: () => renderTokensTs() },
  { path: join(root, "DESIGN.md"), next: () => applyDocRegions(readFileSync(join(root, "DESIGN.md"), "utf8")) },
];

const format = (path: string): void => {
  const run = spawnSync(join(repo, "node_modules/.bin/oxfmt"), ["--write", path], { cwd: repo, stdio: "inherit" });
  if (run.status !== 0) throw new Error(`oxfmt failed on ${path}`);
};

const strip = (s: string): string =>
  s
    .replace(/\s+/g, "")
    .replace(/-{3,}/g, "---")
    .replace(/,([)\]}])/g, "$1");
const check = process.argv.includes("--check");
const scratch = check ? mkdtempSync(join(tmpdir(), "sb-tokens-")) : "";
let stale = false;

for (const out of outputs) {
  const next = out.next();
  if (check) {
    const probe = join(scratch, out.path.split("/").pop() ?? "out");
    writeFileSync(probe, next);
    format(probe);
    if (strip(readFileSync(probe, "utf8")) !== strip(readFileSync(out.path, "utf8"))) {
      stale = true;
      console.error(`stale: ${out.path}`);
    }
  } else {
    writeFileSync(out.path, next);
    format(out.path);
    console.log(`wrote ${out.path}`);
  }
}
if (check) rmSync(scratch, { recursive: true, force: true });
if (stale) {
  console.error("Run `bun run --cwd packages/ikada tokens` and commit the result.");
  process.exit(1);
}
