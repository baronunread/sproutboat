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
const shimPath = resolve(root, "tools/shim.js");
const porfPath = resolve(process.env.PORFFOR_BIN || resolve(root, "node_modules/.bin/porf"));
const nativeFetchMode = process.env.PORFFOR_MODE === "native-fetch";
const nativeFetchPort = Number(process.env.PORFFOR_BENCH_PORT || 43129);

function wrapHandler(source: string): string {
  const match = /^\s*export\s+default\s*{\s*(async\s+)?fetch\s*\(([^)]*)\)\s*{([\s\S]*)}\s*}\s*;?\s*$/.exec(source);
  const bundled = /\s*export\s*{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*};?\s*$/.exec(source);
  if (!match && !bundled) throw new Error("handler bundle must default-export an object with fetch(request)");
  const wrapped = match
    ? `${match[1] || ""}function __fetch(${match[2]}) {${match[3]}}`
    : `${source.slice(0, bundled!.index)}\nfunction __fetch(request) { return ${bundled![1]}.fetch(request); }`;
  return wrapped
    .replace(/\bnew\s+Response\s*\(/g, "makeResponse(")
    .replace(/\bResponse\.json\s*\(/g, "makeJsonResponse(")
    .replace(/\brequest\.headers\.get\s*\(/g, "getRequestHeader(")
    .replace(/\brequest\.text\s*\(\s*\)/g, "requestText()")
    .replace(/\brequest\.json\s*\(\s*\)/g, "requestJson()")
    .replace(/\brequest\.(method|url|body)\b/g, 'request["$1"]');
}

function wrapNativeFetchHandler(source: string): string {
  const match = /^\s*export\s+default\s*{\s*(async\s+)?fetch\s*\(([^)]*)\)\s*{([\s\S]*)}\s*}\s*;?\s*$/.exec(source);
  if (!match) throw new Error("handler must only default-export an object with fetch(request)");
  return `export default {\n  ${match[1] || ""}fetch(${match[2]}) {${match[3]}},\n  port: ${nativeFetchPort}\n};\n`;
}

export async function compileHandler(input: string, output?: string): Promise<CompileResult> {
  const inputPath = resolve(input);
  const outputPath = resolve(output || `.phase0/bin/${basename(input, ".js")}`);
  const generatedPath = resolve(root, ".phase0/generated", `${basename(input, ".js")}.js`);
  const started = performance.now();

  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await mkdir(dirname(generatedPath), { recursive: true });
    const source = await readFile(inputPath, "utf8");
    const generated = nativeFetchMode
      ? wrapNativeFetchHandler(source)
      : (await readFile(shimPath, "utf8"))
        .replace("/*__HANDLER_SOURCE__*/", wrapHandler(source))
        .replace("/*__LIBC_PATH__*/", process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6");
    await writeFile(generatedPath, generated);

    const args = nativeFetchMode
      ? [porfPath, "native", generatedPath, "-o", outputPath]
      : [porfPath, "native", generatedPath, outputPath];
    const child = Bun.spawn(args, {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timeout);
    const compileMs = performance.now() - started;
    if (timedOut) {
      return { ok: false, binaryPath: null, sizeBytes: null, compileMs, error: "Porffor compile timed out after 30 seconds" };
    }
    if (exitCode !== 0) {
      return { ok: false, binaryPath: null, sizeBytes: null, compileMs, error: (stderr || stdout).trim() || `porf exited ${exitCode}` };
    }
    const sizeBytes = (await stat(outputPath)).size;
    return { ok: true, binaryPath: outputPath, sizeBytes, compileMs, error: null };
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
