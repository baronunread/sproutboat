import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { compileHandler } from "./compile";
import { fixtures } from "./fixtures";
import { invokeHandler, loadHandler } from "./refserve";
import type { CompatReport, FileResult, RequestFixture, ResponseShape } from "./types";

const root = resolve(import.meta.dir, "..");
const capabilitiesDir = resolve(root, "tests/porffor/capabilities");
const porfforPackage = await Bun.file(resolve(root, "node_modules/porffor/package.json")).json() as { version: string };
const porfforVersion = process.env.PORFFOR_VERSION || porfforPackage.version;
const nativeFetchMode = process.env.PORFFOR_MODE === "native-fetch";
const nativeFetchPort = Number(process.env.PORFFOR_BENCH_PORT || 43129);
const reuseBinaries = process.env.PORFFOR_REUSE_BINARIES === "1";
const previousReport = reuseBinaries
  ? JSON.parse(await readFile(resolve(root, "report.json"), "utf8")) as CompatReport
  : null;

function requestFrom(fixture: RequestFixture): Request {
  const init: RequestInit = { method: fixture.method, headers: fixture.headers };
  if (fixture.method !== "GET" && fixture.method !== "HEAD") init.body = fixture.body;
  return new Request(fixture.url, init);
}

async function normalize(response: Response): Promise<ResponseShape> {
  return {
    status: response.status,
    body: await response.text(),
    "content-type": response.headers.get("content-type"),
  };
}

async function runBinary(binary: string, fixture: RequestFixture): Promise<ResponseShape> {
  if (nativeFetchMode) return runNativeFetchBinary(binary, fixture);
  const child = Bun.spawn([binary], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify(fixture));
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 5_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `binary exited ${exitCode}`);
  const parsed = JSON.parse(stdout.trim()) as { status: number; headers?: Record<string, string | null>; body: string };
  return { status: parsed.status, body: parsed.body, "content-type": parsed.headers?.["content-type"] ?? null };
}

async function runNativeFetchBinary(binary: string, fixture: RequestFixture): Promise<ResponseShape> {
  const child = Bun.spawn([binary], { stdout: "ignore", stderr: "pipe" });
  const target = new URL(fixture.url);
  target.protocol = "http:";
  target.hostname = "127.0.0.1";
  target.port = String(nativeFetchPort);
  const init: RequestInit = { method: fixture.method, headers: fixture.headers };
  if (fixture.method !== "GET" && fixture.method !== "HEAD") init.body = fixture.body;

  let lastError: unknown;
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await Promise.race([child.exited.then(() => true), Bun.sleep(25).then(() => false)])) break;
      try {
        return await normalize(await fetch(target, init));
      } catch (error) {
        lastError = error;
      }
    }
    const stderr = await new Response(child.stderr).text();
    throw new Error(stderr.trim() || String(lastError || "native fetch server did not become ready"));
  } finally {
    child.kill();
    await child.exited;
  }
}

function same(left: ResponseShape, right: ResponseShape): boolean {
  return left.status === right.status && left.body === right.body && left["content-type"] === right["content-type"];
}

function concise(error: unknown): string {
  return String(error).replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim().slice(0, 500);
}

async function testFile(file: string): Promise<FileResult> {
  const sourcePath = resolve(capabilitiesDir, file);
  const previous = previousReport?.files.find((item) => item.file === file);
  const reusedPath = resolve(root, ".phase0/bin", basename(file, ".js"));
  const compiled = reuseBinaries && previous?.compiles
    ? {
        ok: true,
        binaryPath: reusedPath,
        sizeBytes: (await stat(reusedPath)).size,
        compileMs: previous.compileMs,
        error: null,
      }
    : await compileHandler(sourcePath);
  const base = { file, compiles: compiled.ok, sizeBytes: compiled.sizeBytes, compileMs: Math.round(compiled.compileMs), runMs: null };
  if (!compiled.ok || !compiled.binaryPath) return { ...base, matches: false, error: concise(compiled.error) };

  const started = performance.now();
  let requestNumber = 0;
  try {
    const handler = await loadHandler(sourcePath);
    for (let index = 0; index < fixtures.length; index++) {
      requestNumber = index + 1;
      const fixture = fixtures[index];
      const reference = await normalize(await invokeHandler(handler, requestFrom(fixture)));
      const native = await runBinary(compiled.binaryPath, fixture);
      if (!same(reference, native)) {
        return {
          ...base,
          matches: false,
          runMs: Math.round(performance.now() - started),
          error: `request ${index + 1} mismatch: expected ${JSON.stringify(reference)}, got ${JSON.stringify(native)}`,
        };
      }
    }
    return { ...base, matches: true, runMs: Math.round(performance.now() - started), error: null };
  } catch (error) {
    return { ...base, matches: false, runMs: Math.round(performance.now() - started), error: `request ${requestNumber}: ${concise(error)}` };
  }
}

const files = (await readdir(capabilitiesDir)).filter((file) => file.endsWith(".js")).sort();
const results: FileResult[] = [];
for (const [index, file] of files.entries()) {
  console.log(`[${index + 1}/${files.length}] ${file}`);
  results.push(await testFile(file));
}

const report: CompatReport = {
  generatedAt: new Date().toISOString(),
  porfforVersion,
  requestsPerFile: fixtures.length,
  files: results,
};
await writeFile(resolve(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote report.json (${results.filter((item) => item.matches).length}/${results.length} match)`);
