import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fixtures } from "./fixtures";
import { invokeHandler, loadHandler } from "./refserve";
import { validateHttpSyncSource } from "sproutboat/runtime/source";
import { porfforVersion } from "./porffor";

const root = resolve(import.meta.dir, "..");
const capabilitiesDir = resolve(root, "tests/porffor/capabilities");
const rejectedDir = resolve(root, "tests/porffor/rejected");
const files = (await readdir(capabilitiesDir)).filter((file) => file.endsWith(".js")).sort();
const problems: string[] = [];

if (files.length < 30) problems.push(`capability suite has ${files.length} handlers; expected at least 30`);
if (!Bun.which("cc") && !Bun.which("clang") && !Bun.which("gcc"))
  problems.push("no C compiler on PATH (install clang or gcc)");
if (!Bun.which("c++") && !Bun.which("clang++") && !Bun.which("g++"))
  problems.push("no C++ compiler on PATH (native-fetch links uWebSockets with c++)");
if (!(await Bun.file(resolve(root, "node_modules/.bin/esbuild")).exists()) && !Bun.which("esbuild")) {
  problems.push("esbuild is not installed (native-fetch auto-bundles handlers with it)");
}
if (!(await Bun.file(resolve(root, "node_modules/porffor/runtime/index.js")).exists()))
  problems.push("Porffor is not installed (run bun install)");
if (
  !(await readFile(resolve(root, "node_modules/porffor/compiler/render.js"), "utf8").catch(() => "")).includes(
    'getenv("PORT")',
  )
) {
  problems.push("Porffor $PORT patch not applied (run: bun run tools/patch-porffor.ts)");
}

for (const file of files) {
  const path = resolve(capabilitiesDir, file);
  const source = await readFile(path, "utf8");
  const lines = source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0);
  if (lines > 40) problems.push(`${file} has ${lines} lines; maximum is 40`);
  if (/^\s*import\s|\brequire\s*\(/m.test(source)) problems.push(`${file} contains an import`);
  const sourceValidation = validateHttpSyncSource(source);
  if (!sourceValidation.ok)
    problems.push(`${file} is outside the capability profile: ${sourceValidation.errors.join(", ")}`);

  try {
    const handler = await loadHandler(path);
    for (const fixture of fixtures) {
      const init: RequestInit = { method: fixture.method, headers: fixture.headers };
      if (fixture.method !== "GET" && fixture.method !== "HEAD") init.body = fixture.body;
      await (await invokeHandler(handler, new Request(fixture.url, init))).text();
    }
  } catch (error) {
    problems.push(`${file} failed under Bun: ${String(error).replace(/\s+/g, " ").slice(0, 300)}`);
  }
}

const rejectedFiles = (await readdir(rejectedDir)).filter((file) => file.endsWith(".js")).sort();
if (!rejectedFiles.length) problems.push("no rejected fixtures found");
for (const file of rejectedFiles) {
  if (validateHttpSyncSource(await readFile(resolve(rejectedDir, file), "utf8")).ok)
    problems.push(`${file} is expected to be rejected`);
}

if (problems.length) {
  console.error("preflight failed:\n" + problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}

console.log(
  `preflight passed: Porffor ${porfforVersion()}, ${files.length} accepted and ${rejectedFiles.length} rejected handlers, ${fixtures.length} probes each`,
);
