import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fixtures } from "./fixtures";
import { invokeHandler, loadHandler } from "./refserve";
import { validateHttpSyncSource } from "../packages/config/src/source";

const root = resolve(import.meta.dir, "..");
const capabilitiesDir = resolve(root, "tests/porffor/capabilities");
const rejectedDir = resolve(root, "tests/porffor/rejected");
const files = (await readdir(capabilitiesDir)).filter((file) => file.endsWith(".js")).sort();
const problems: string[] = [];

if (files.length < 30) problems.push(`Porffor capability suite has ${files.length} handlers; expected at least 30`);
if (process.env.PORFFOR_MODE !== "native-fetch" && process.platform !== "darwin" && process.platform !== "linux") {
  problems.push(`native stdin shim supports macOS and Linux, not ${process.platform}`);
}
if (!Bun.which("cc")) problems.push("no C compiler found on PATH (install clang or gcc)");

const porf = resolve(process.env.PORFFOR_BIN || resolve(root, "node_modules/.bin/porf"));
if (!(await Bun.file(porf).exists())) problems.push("Porffor is not installed (run bun install)");

for (const file of files) {
  const path = resolve(capabilitiesDir, file);
  const source = await readFile(path, "utf8");
  const lines = source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0);
  if (lines > 40) problems.push(`${file} has ${lines} lines; maximum is 40`);
  if (/^\s*import\s|\brequire\s*\(/m.test(source)) problems.push(`${file} contains an import`);
  const sourceValidation = validateHttpSyncSource(source);
  if (!sourceValidation.ok) problems.push(`${file} is outside http-sync-v0: ${sourceValidation.errors.join(", ")}`);

  try {
    const handler = await loadHandler(path);
    for (const fixture of fixtures) {
      const init: RequestInit = { method: fixture.method, headers: fixture.headers };
      if (fixture.method !== "GET" && fixture.method !== "HEAD") init.body = fixture.body;
      const response = await invokeHandler(handler, new Request(fixture.url, init));
      await response.text();
    }
  } catch (error) {
    problems.push(`${file} failed under Bun: ${String(error).replace(/\s+/g, " ").slice(0, 300)}`);
  }
}

const rejectedFiles = (await readdir(rejectedDir)).filter((file) => file.endsWith(".js")).sort();
if (!rejectedFiles.length) problems.push("no rejected Porffor fixtures found");
for (const file of rejectedFiles) {
  const validation = validateHttpSyncSource(await readFile(resolve(rejectedDir, file), "utf8"));
  if (validation.ok) problems.push(`${file} is expected to be rejected by http-sync-v0`);
}

if (problems.length) {
  console.error("Phase 0 preflight failed:\n" + problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}

const porfforPackage = await Bun.file(resolve(root, "node_modules/porffor/package.json")).json() as { version: string };
const porfforVersion = process.env.PORFFOR_VERSION || porfforPackage.version;
console.log(`preflight passed: Porffor ${porfforVersion}, ${files.length} accepted and ${rejectedFiles.length} rejected handlers, ${fixtures.length} probes each`);
