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
 * Binding names a project declares. `do` maps a binding name to a Durable Object
 * class name; `crons` are schedule expressions with no name. Kept in sync with
 * `sproutboat-cli/src/compile.ts` (the canonical copy — see its MIGRATION.md).
 */
export type Bindings = {
  kv: string[];
  secrets: string[];
  outbound: string[];
  d1: string[];
  r2: string[];
  queues: string[];
  analytics: string[];
  do: Array<{ binding: string; className: string }>;
  crons: string[];
  /** Static-asset binding name for `env.<NAME>.fetch(request)`; `""` when assets are edge-only. */
  assets: string;
};

export const EMPTY_BINDINGS: Bindings = { kv: [], secrets: [], outbound: [], d1: [], r2: [], queues: [], analytics: [], do: [], crons: [], assets: "" };

function hasBindings(b: Bindings): boolean {
  return (
    b.kv.length > 0 || b.secrets.length > 0 || b.outbound.length > 0 || b.d1.length > 0 || b.r2.length > 0 ||
    b.queues.length > 0 || b.analytics.length > 0 || b.do.length > 0 || b.assets !== ""
  );
}

/**
 * Build the final native-fetch module: the prelude (Web API shims + broker
 * binding shim + trigger dispatcher), `const env = {…}` with the baked `vars`,
 * one `__sbInstallBindings(env, …)` line when any binding is declared, the
 * user's source with its `export` keywords neutralised (its `export default {…}`
 * becomes `__sbHandlers`; `export class`/`function`/`const` become plain
 * declarations — Durable Object classes and helpers), then our single
 * `export default { fetch }` that routes through `__sbEntry` (HTTP →
 * `handlers.fetch`; `x-sb-trigger` → scheduled / queue).
 *
 * With no bindings and no `scheduled`/`queue`/DO it behaves exactly like a plain
 * `export default { fetch }` worker.
 *
 * ponytail: the worker process is long-lived, so a handler that mutates `env`
 * leaks that change to later requests. Freeze upstream once Porffor supports
 * Object.freeze in native mode.
 */
export function wrapNativeFetchHandler(
  source: string,
  prelude: string,
  vars: Record<string, string> = {},
  bindings: Bindings = EMPTY_BINDINGS,
): string {
  if (!/\bexport\s+default\s*\{/.test(source) || !/\bfetch\s*\(/.test(source)) {
    throw new Error("handler must default-export an object with a fetch(request) method");
  }
  const neutralised = source
    .replace(/^(\s*)export\s+default\s*/m, "$1const __sbHandlers = ")
    .replace(/^export\s+(async\s+function|function|class|const|let|var)\b/gm, "$1");

  const env = `const env = ${JSON.stringify(vars)};\nglobalThis.env = env;\n`;
  const wire = hasBindings(bindings) ? `__sbInstallBindings(env, ${JSON.stringify(bindings)});\n` : "";
  const registerDO = bindings.do.length
    ? `__sbRegisterDO({ ${bindings.do.map((d) => `${d.className}: ${d.className}`).join(", ")} });\n`
    : "";

  return (
    `${prelude}\n${env}${wire}` +
    `${neutralised}\n` +
    `${registerDO}` +
    `export default {\n  port: ${defaultPort},\n  fetch(request) { return __sbEntry(__sbHandlers, request); }\n};\n`
  );
}

type VarsJson = string | number | boolean | null | { readonly [key: string]: VarsJson } | VarsJson[];
function isVarsObject(value: VarsJson): value is { readonly [key: string]: VarsJson } {
  return value !== null && Object(value) === value && !Array.isArray(value);
}
function isVarsString(value: VarsJson): value is string {
  return Object(value) !== value && value === String(value);
}

/** `SPROUTBOAT_VARS_JSON` (set by the build image) → a validated flat string map. */
export function readVarsFromEnv() {
  const raw = process.env.SPROUTBOAT_VARS_JSON;
  const vars: Record<string, string> = {};
  if (!raw) return vars;
  const parsed: VarsJson = JSON.parse(raw);
  if (!isVarsObject(parsed)) throw new Error("SPROUTBOAT_VARS_JSON must be a JSON object");
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !isVarsString(value)) throw new Error(`SPROUTBOAT_VARS_JSON.${key} must map an UPPER_SNAKE name to a string`);
    vars[key] = value;
  }
  return vars;
}

/**
 * `SPROUTBOAT_BINDINGS_JSON` (the artifact's `bindings.json`, passed by the
 * build) → a `Bindings` shape. Every field is re-validated here; unknown keys
 * are dropped and a missing / empty payload is `EMPTY_BINDINGS`, so an old build
 * with no bindings still compiles.
 */
export function readBindingsFromEnv(): Bindings {
  const raw = process.env.SPROUTBOAT_BINDINGS_JSON;
  if (!raw) return EMPTY_BINDINGS;
  const parsed: VarsJson = JSON.parse(raw);
  if (!isVarsObject(parsed)) throw new Error("SPROUTBOAT_BINDINGS_JSON must be a JSON object");
  const strings = (v: VarsJson): string[] => (Array.isArray(v) ? v.filter(isVarsString) : []);
  const dos: Array<{ binding: string; className: string }> = [];
  if (Array.isArray(parsed.do)) {
    for (const entry of parsed.do) {
      if (isVarsObject(entry) && isVarsString(entry.binding) && isVarsString(entry.className)) {
        dos.push({ binding: entry.binding, className: entry.className });
      }
    }
  }
  return {
    kv: strings(parsed.kv),
    secrets: strings(parsed.secrets),
    outbound: strings(parsed.outbound),
    d1: strings(parsed.d1),
    r2: strings(parsed.r2),
    queues: strings(parsed.queues),
    analytics: strings(parsed.analytics),
    do: dos,
    crons: strings(parsed.crons),
    assets: isVarsString(parsed.assets) ? parsed.assets : "",
  };
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
    await writeFile(generatedPath, wrapNativeFetchHandler(source, prelude, readVarsFromEnv(), readBindingsFromEnv()));

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
