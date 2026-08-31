#!/usr/bin/env bun
/**
 * Measure cold-start for a Sproutboat worker, split into the two phases from
 * #41: `boot` (spawn -> bundled JS starts: process create + ld.so + runtime
 * init) and `eval` (JS starts -> listening: module eval + socket bind).
 *
 *   bun tools/measure-coldstart.ts                     # kitchen-sink, 25 runs
 *   bun tools/measure-coldstart.ts <project-dir> -n 50
 *   bun tools/measure-coldstart.ts --bin ./worker.bin  # skip the build
 *
 * Compiles a host-native binary once (Porffor, no --musl), then repeatedly
 * spawns it exactly as the supervisor does — PORT + SB_STARTUP_FILE in the env,
 * a tight loopback connect() poll for readiness — and reads the marker file the
 * prelude writes. No broker: this is spawn -> listening, which is what
 * `startupMs` measures.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { EMPTY_BINDINGS, wrapNativeFetchHandler, type Bindings } from "./compile";
import { parseConfig } from "../packages/config/src/config";
import { startupFilePath } from "../services/supervisor/src/run";

const ROOT = join(import.meta.dir, "..");
const PORF = join(ROOT, "node_modules/porffor/runtime/index.js");

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const runs = Number(flag("-n") ?? flag("--runs") ?? 25);
const prebuilt = flag("--bin");
const projectDir = argv.find((a) => !a.startsWith("-") && a !== flag("-n") && a !== flag("--runs"))
  ?? join(ROOT, "examples/kitchen-sink");

const work = mkdtempSync(join(tmpdir(), "sb-coldstart-"));
process.on("exit", () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } });

// ---- build the worker (host-native) -------------------------------------------
let bin: string;
if (prebuilt) {
  bin = prebuilt;
  console.log(`using prebuilt binary: ${bin}`);
} else {
  const cfg = parseConfig(readFileSync(join(projectDir, "sproutboat.jsonc"), "utf8"));
  if (!cfg.ok) { console.error("bad config:", cfg.errors.join("; ")); process.exit(1); }
  const c = cfg.value;
  const bindings: Bindings = {
    ...EMPTY_BINDINGS,
    kv: c.kv_namespaces ?? [],
    secrets: c.secrets ?? [],
    outbound: (c.outbound ?? []).map(String),
    d1: c.d1_databases ?? [],
    r2: c.r2_buckets ?? [],
    queues: c.queues ?? [],
    analytics: c.analytics_engine_datasets ?? [],
    do: Object.entries(c.durable_objects ?? {}).map(([binding, className]) => ({ binding, className })),
    crons: c.triggers?.crons ?? [],
    assets: c.assets?.binding ?? "",
  };
  const prelude = readFileSync(join(ROOT, "tools/native-fetch-prelude.js"), "utf8");
  const src = readFileSync(join(projectDir, c.main ?? "src/index.js"), "utf8");
  const gen = join(work, "worker.generated.js");
  bin = join(work, "worker.bin");
  writeFileSync(gen, wrapNativeFetchHandler(src, prelude, c.vars ?? {}, bindings));

  console.log(`compiling ${projectDir} (host native)…`);
  const t = performance.now();
  const r = Bun.spawnSync(["node", PORF, "native", gen, "-o", bin], {
    env: { ...process.env, PATH: `${join(ROOT, "node_modules/.bin")}:${process.env.PATH}` },
    stdout: "pipe", stderr: "pipe",
  });
  if (r.exitCode !== 0) { console.error("compile failed:\n" + r.stderr.toString() + r.stdout.toString()); process.exit(1); }
  console.log(`compiled in ${((performance.now() - t) / 1000).toFixed(1)}s\n`);
}

// ---- one cold start ---------------------------------------------------------
const listens = (port: number) =>
  new Promise<boolean>((done) => {
    const s = connect({ host: "127.0.0.1", port }, () => { s.destroy(); done(true); });
    s.on("error", () => done(false));
  });

async function once(port: number): Promise<{ total: number; boot: number; evalPhase: number }> {
  const file = startupFilePath(bin, port);
  try { rmSync(file, { force: true }); } catch { /* fresh */ }

  const spawnedWall = Date.now();
  const t0 = performance.now();
  const child = Bun.spawn([bin], {
    env: { ...process.env, PORT: String(port), SB_STARTUP_FILE: file },
    stdout: "ignore", stderr: "ignore",
  });
  const deadline = t0 + 10_000;
  // Spin for the first few ms (a cold start is single-digit ms), then back off
  // so a stuck worker doesn't peg a core. The spin keeps poll granularity off
  // the `eval` phase where it would otherwise dominate.
  while (performance.now() < deadline) {
    if (await listens(port)) break;
    if (performance.now() - t0 > 8) await Bun.sleep(1);
  }
  const total = performance.now() - t0;
  child.kill(9);
  await child.exited;

  let boot = 0;
  try {
    const jsStarted = Number(readFileSync(file, "utf8").trim());
    if (Number.isFinite(jsStarted)) boot = Math.max(0, Math.min(total, jsStarted - spawnedWall));
  } catch { /* marker missing -> boot unknown, report 0 */ }
  return { total, boot, evalPhase: Math.max(0, total - boot) };
}

// ---- run + summarise ------------------------------------------------------
const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (n: number) => `${n.toFixed(2)} ms`;
const col = (xs: number[]) =>
  `min ${ms(Math.min(...xs))}  p50 ${ms(q(xs, 50))}  p90 ${ms(q(xs, 90))}  max ${ms(Math.max(...xs))}`;

const totals: number[] = [];
const boots: number[] = [];
const evals: number[] = [];

// two throwaway spawns: first exec of a just-written binary pays dyld + page
// cache + (on macOS) code-signing costs that a deployed worker never sees.
for (let i = 0; i < 2; i++) await once(41_000 + Math.floor(Math.random() * 4000));

console.log(`cold start x${runs}  (spawn -> listening; 2 warmup runs discarded)\n`);
for (let i = 0; i < runs; i++) {
  const port = 41_000 + Math.floor(Math.random() * 4000);
  const { total, boot, evalPhase } = await once(port);
  totals.push(total); boots.push(boot); evals.push(evalPhase);
  process.stdout.write(
    `  ${String(i + 1).padStart(3)}  total ${ms(total).padStart(9)}` +
    `   boot ${ms(boot).padStart(9)}   eval ${ms(evalPhase).padStart(9)}\n`,
  );
}
const haveBoot = boots.some((b) => b > 0);
console.log("\n  total  " + col(totals));
if (haveBoot) {
  console.log("  boot   " + col(boots) + "   (process + runtime)");
  console.log("  eval   " + col(evals) + "   (module + bind)");
} else {
  console.log("  boot   unavailable — the worker did not write SB_STARTUP_FILE (old prelude?)");
}
