import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import {
  EMPTY_BINDINGS,
  preludePath as preludeUrl,
  readBindingsFromEnv,
  readVarsFromEnv,
  wrapNativeFetchHandler,
  type Bindings,
} from "sproutboat/runtime/wrap";

// The wrapper, the Bindings shape and the SPROUTBOAT_*_JSON readers now live in
// the CLI package (`sproutboat/runtime/wrap`); re-export them so the existing
// `../tools/compile` import sites keep working. Only `compileHandler` below —
// the host-native, non-musl compile that drives the Porffor compat suite and
// coldstart bench — is monorepo-specific.
export { EMPTY_BINDINGS, readBindingsFromEnv, readVarsFromEnv, wrapNativeFetchHandler, type Bindings };

export type CompileResult = {
  ok: boolean;
  binaryPath: string | null;
  sizeBytes: number | null;
  compileMs: number;
  error: string | null;
};

const root = resolve(import.meta.dir, "..");
const porfEntry = resolve(root, "node_modules/porffor/runtime/index.js");
export const preludePath = fileURLToPath(preludeUrl);
// First compile builds uWebSockets from source; later ones are ~4-8s.
const compileTimeoutMs = Number(process.env.PORFFOR_COMPILE_TIMEOUT_MS || 300_000);
// The supervisor overrides this per worker via $PORT (patches/porffor-render.patch);
// the baked value is only a fallback for a directly-run binary.
const defaultPort = Number(process.env.PORFFOR_BENCH_PORT || 8080);

export async function compileHandler(input: string, output?: string): Promise<CompileResult> {
  const inputPath = resolve(input);
  const outputPath = resolve(output || `.phase0/bin/${basename(input, ".js")}`);
  const generatedPath = resolve(root, ".phase0/generated", `${basename(input, ".js")}.js`);
  const started = performance.now();

  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await mkdir(dirname(generatedPath), { recursive: true });
    const [source, prelude] = await Promise.all([readFile(inputPath, "utf8"), readFile(preludePath, "utf8")]);
    await writeFile(generatedPath, wrapNativeFetchHandler(source, prelude, readVarsFromEnv(), readBindingsFromEnv(), defaultPort));

    // `-s`: strip at link. Porffor emits full DWARF by default (~90% of a
    // static-musl binary); nothing needs it at runtime.
    const child = Bun.spawn(["node", porfEntry, "native", generatedPath, "-o", outputPath, "-s"], {
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
