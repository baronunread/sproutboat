import { basename, dirname, resolve } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

export type CompileResult = {
  ok: boolean;
  binaryPath: string | null;
  sizeBytes: number | null;
  compileMs: number;
  error: string | null;
};

const root = resolve(import.meta.dir, "..");
const porfEntry = resolve(root, "node_modules/porffor/runtime/index.js");
const preludePath = resolve(root, "tools/native-fetch-prelude.js");
// The supervisor overrides this per worker via $PORT (patches/porffor-render.patch);
// the baked value is only a fallback for a directly-run binary.
const defaultPort = Number(process.env.PORFFOR_BENCH_PORT || 8080);
// First compile builds uWebSockets from source; later ones are ~4-8s.
const compileTimeoutMs = Number(process.env.PORFFOR_COMPILE_TIMEOUT_MS || 300_000);

/**
 * Turn `export default { [async] fetch(request) { … } }` into a native-fetch
 * server module: the prelude (URLSearchParams / Response.json shims for alpha-3)
 * then the handler body verbatim — no source rewriting.
 */
export function wrapNativeFetchHandler(source: string, prelude: string): string {
  const match = /^\s*export\s+default\s*\{\s*(async\s+)?fetch\s*\(([^)]*)\)\s*\{([\s\S]*)\}\s*\}\s*;?\s*$/.exec(source);
  if (!match) throw new Error("handler must default-export an object with a fetch(request) method");
  return `${prelude}\nexport default {\n  port: ${defaultPort},\n  ${match[1] || ""}fetch(${match[2] || "request"}) {${match[3]}}\n};\n`;
}

export async function compileHandler(input: string, output?: string): Promise<CompileResult> {
  const inputPath = resolve(input);
  const outputPath = resolve(output || `.phase0/bin/${basename(input, ".js")}`);
  const generatedPath = resolve(root, ".phase0/generated", `${basename(input, ".js")}.js`);
  const started = performance.now();

  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await mkdir(dirname(generatedPath), { recursive: true });
    const [source, prelude] = await Promise.all([readFile(inputPath, "utf8"), readFile(preludePath, "utf8")]);
    await writeFile(generatedPath, wrapNativeFetchHandler(source, prelude));

    const child = Bun.spawn(["node", porfEntry, "native", generatedPath, "-o", outputPath], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      // esbuild (auto-bundler) + the porffor launcher must be resolvable.
      env: { ...process.env, PATH: `${resolve(root, "node_modules/.bin")}:${process.env.PATH ?? ""}` },
    });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, compileTimeoutMs);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timeout);
    const compileMs = performance.now() - started;

    if (timedOut) return { ok: false, binaryPath: null, sizeBytes: null, compileMs, error: `porffor compile timed out after ${compileTimeoutMs}ms` };
    if (exitCode !== 0 || !(await Bun.file(outputPath).exists())) {
      return { ok: false, binaryPath: null, sizeBytes: null, compileMs, error: (stderr || stdout).trim() || `porf exited ${exitCode}` };
    }
    return { ok: true, binaryPath: outputPath, sizeBytes: (await stat(outputPath)).size, compileMs, error: null };
  } catch (error) {
    return { ok: false, binaryPath: null, sizeBytes: null, compileMs: performance.now() - started, error: String(error) };
  }
}

if (import.meta.main) {
  const input = process.argv[2];
  if (!input) throw new Error("usage: bun run tools/compile.ts <handler.js> [binary]");
  const result = await compileHandler(input, process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
