#!/usr/bin/env bun
/**
 * Differential test harness: the Bun edge versus the Rust edge, black box.
 *
 *   bun tools/edge-diff/run.ts [--only id[,id|prefix*]] [--bun-only] [--bun-vs-bun]
 *                              [--out report.md] [--json summary.json] [--jobs N]
 *                              [--timeout ms] [--list] [--rust-bin path]
 *
 * Exit code is non-zero when any case is DIFFERENT (or ERROR) and not in known-differences.json.
 */
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cases } from "./cases";
import { compareRuns, renderLogs, renderObs, type Diff } from "./compare";
import { asRecord } from "./json";
import { DEFAULT_RUST_BIN, ROOT, cleanupNow, makeTempDir } from "./lib";
import type { HttpObs } from "./lib";
import { runCase, type AssertHelpers, type Case, type RunResult } from "./runner";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag("--help") || flag("-h")) {
  console.log(readFileSync(import.meta.path, "utf8").split("*/")[0]);
  process.exit(0);
}

const bunOnly = flag("--bun-only");
const bunVsBun = flag("--bun-vs-bun");
const rustBinSource = value("--rust-bin") ?? process.env.SB_EDGE_RS_BIN ?? DEFAULT_RUST_BIN;
let rustBin = rustBinSource;
const jobs = Math.max(1, Number(value("--jobs")) || 1);
const timeoutMs = Number(value("--timeout")) || 30_000;
const outPath = value("--out");
const jsonPath = value("--json");

if (flag("--list")) {
  for (const c of cases) console.log(`${c.id}\t${c.group}`);
  process.exit(0);
}

const only = value("--only")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const selected: Case[] = only
  ? cases.filter((c) => only.some((o) => (o.endsWith("*") ? c.id.startsWith(o.slice(0, -1)) : c.id === o)))
  : cases;
if (selected.length === 0) {
  console.error(`no case matches ${only?.join(", ")}`);
  process.exit(2);
}

if (!bunOnly && !bunVsBun && !existsSync(rustBinSource)) {
  console.error(
    `Rust edge binary not found at ${rustBinSource}.\nBuild it, set SB_EDGE_RS_BIN, or use --bun-only / --bun-vs-bun.`,
  );
  process.exit(2);
}

// Run a private copy so a concurrent `cargo build` cannot swap the binary under a running comparison.
if (!bunOnly && !bunVsBun) {
  const dir = makeTempDir("bin");
  rustBin = join(dir, "sproutboat-edge");
  copyFileSync(rustBinSource, rustBin);
  chmodSync(rustBin, 0o755);
}

const knownPath = join(import.meta.dir, "known-differences.json");
const known: Record<string, string> = existsSync(knownPath) ? JSON.parse(readFileSync(knownPath, "utf8")) : {};

type Status = "IDENTICAL" | "DIFFERENT" | "KNOWN DIFFERENCE" | "INTENTIONAL" | "ERROR" | "BASELINE";

const helpers: AssertHelpers = {
  http: (run, label) => run.obs.find((o): o is HttpObs => o.kind === "http" && o.label === label),
  note: (run, label) => {
    const found = run.obs.find((o) => o.kind === "note" && o.label === label);
    return found && found.kind === "note" ? found.value : undefined;
  },
  events: (run) =>
    run.logs.flatMap((e) => {
      const event = asRecord(e);
      return event === null ? [] : [event];
    }),
};
interface CaseOutcome {
  id: string;
  group: string;
  status: Status;
  reason?: string;
  diffs: Diff[];
  bun: RunResult;
  rust?: RunResult;
  ms: number;
}

async function runOne(c: Case): Promise<CaseOutcome> {
  const started = Date.now();
  const limit = c.timeoutMs ?? timeoutMs;
  const bun = await runCase(c, "bun", rustBin, limit);
  if (bunOnly) {
    return {
      id: c.id,
      group: c.group,
      status: bun.error ? "ERROR" : "BASELINE",
      diffs: [],
      bun,
      ms: Date.now() - started,
    };
  }
  const rust = await runCase(c, bunVsBun ? "bun" : "rust", rustBin, limit);
  if (c.intentional && !bunVsBun) {
    const failures = rust.error ? [`Rust run failed: ${rust.error}`] : c.intentional.assertRust(rust, helpers);
    const diffs: Diff[] = failures.length ? [{ where: "assert (rust)", lines: failures }] : [];
    return {
      id: c.id,
      group: c.group,
      status: failures.length ? "DIFFERENT" : "INTENTIONAL",
      reason: c.intentional.reason,
      diffs,
      bun,
      rust,
      ms: Date.now() - started,
    };
  }
  const diffs = compareRuns(c, bun, rust);
  let status: Status = diffs.length === 0 ? "IDENTICAL" : bun.error || rust.error ? "ERROR" : "DIFFERENT";
  let reason: string | undefined;
  if (status !== "IDENTICAL" && known[c.id]) {
    status = "KNOWN DIFFERENCE";
    reason = known[c.id];
  }
  return { id: c.id, group: c.group, status, reason, diffs, bun, rust, ms: Date.now() - started };
}

// Workers fill slots by case index; every slot is set before the report is built.
const outcomes: CaseOutcome[] = [];
let next = 0;
async function worker(): Promise<void> {
  for (;;) {
    const i = next++;
    if (i >= selected.length) return;
    const c = selected[i];
    const outcome = await runOne(c);
    outcomes[i] = outcome;
    console.error(`[${i + 1}/${selected.length}] ${c.id}: ${outcome.status} (${outcome.ms} ms)`);
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, selected.length) }, worker));

// ---- report ----

const count = (status: Status) => outcomes.filter((o) => o.status === status).length;
const md: string[] = [];
const mode = bunOnly ? "Bun only (baseline)" : bunVsBun ? "Bun vs Bun (self-check)" : `Bun vs Rust (${rustBinSource})`;
md.push("# Edge differential report", "", `- mode: ${mode}`, `- bun: ${Bun.version}`, `- cases: ${outcomes.length}`);
if (bunOnly) md.push(`- baseline: ${count("BASELINE")}, errors: ${count("ERROR")}`);
else
  md.push(
    `- identical: ${count("IDENTICAL")}, different: ${count("DIFFERENT")}, known difference: ${count("KNOWN DIFFERENCE")}, intentional (Rust asserted): ${count("INTENTIONAL")}, error: ${count("ERROR")}`,
  );
md.push("", "| case | result |", "| --- | --- |");
for (const o of outcomes) md.push(`| ${o.id} | ${o.status} |`);
md.push("");

for (const o of outcomes) {
  if (o.status === "IDENTICAL") continue;
  if (o.rust && (o.status === "INTENTIONAL" || o.reason) && cases.find((c) => c.id === o.id)?.intentional) {
    md.push(`## ${o.id}: ${o.status}`, "", `Intentional fix on the Rust side: ${o.reason}`, "");
    for (const d of o.diffs) {
      md.push(`- **${d.where}**`);
      for (const line of d.lines) md.push(`  - ${line}`);
    }
    md.push("", "Bun (reference only):");
    for (const obs of o.bun.obs) md.push(...renderObs(obs, o.bun.ports));
    md.push("", "Rust (asserted):");
    for (const obs of o.rust.obs) md.push(...renderObs(obs, o.rust.ports));
    md.push("", "Rust request log:", "```", ...renderLogs(o.rust), "```", "");
    continue;
  }
  md.push(`## ${o.id}: ${o.status}`, "");
  if (o.reason) md.push(`Reason: ${o.reason}`, "");
  if (o.status === "BASELINE" || (bunOnly && o.status === "ERROR")) {
    if (o.bun.error) md.push(`Error: ${o.bun.error}`, "");
    for (const obs of o.bun.obs) md.push(...renderObs(obs, o.bun.ports));
    if (o.bun.stdout.length) md.push(`- stdout: \`${JSON.stringify(o.bun.stdout)}\``);
    md.push("", "Request log:", "```", ...renderLogs(o.bun), "```", "");
    continue;
  }
  for (const d of o.diffs) {
    md.push(`- **${d.where}**`);
    for (const line of d.lines) md.push(`  - ${line}`);
  }
  md.push("");
}

if (!bunOnly) {
  const identical = outcomes.filter((o) => o.status === "IDENTICAL").map((o) => o.id);
  md.push("## Identical cases", "", identical.length ? identical.join(", ") : "none", "");
}

const summary = {
  mode,
  total: outcomes.length,
  identical: count("IDENTICAL"),
  different: count("DIFFERENT"),
  knownDifference: count("KNOWN DIFFERENCE"),
  intentional: count("INTENTIONAL"),
  error: count("ERROR"),
  cases: outcomes.map((o) => ({
    id: o.id,
    group: o.group,
    status: o.status,
    reason: o.reason ?? null,
    ms: o.ms,
    diffs: o.diffs,
  })),
};

const report = md.join("\n");
console.log(report);
console.log("\n## JSON summary\n\n```json\n" + JSON.stringify(summary, null, 2) + "\n```");
if (outPath) writeFileSync(outPath, `${report}\n`);
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);

cleanupNow();
const failing = count("DIFFERENT") + count("ERROR");
process.exit(failing > 0 ? 1 : 0);
void ROOT;
