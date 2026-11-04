/**
 * Differential test of the Bun egress service (@sproutboat/wire egress.ts, plus tcp.ts when
 * the wire package has it) against the Rust one (services/egress-rs).
 *
 *   bun tools/egress-diff/run.ts [--rust-bin PATH] [--build] [--only id,prefix*]
 *                                [--list] [--ts-vs-ts] [--raw results.json] [--out report.md] [--json summary.json]
 *
 * Per suite the harness starts a fresh service of each kind with identical environment, runs
 * every case against fresh fake upstreams, normalises (ports, Date, hop-by-hop framing, error
 * texts from the HTTP client) and compares status, headers, body, what the upstream received,
 * refusal reasons and DNS lookup counts. Exit 1 when a case differs and is not listed in
 * known-differences.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffPaths, norm } from "./compare";
import { cases as httpCases, DNS_SCRIPT, type Ctx } from "./cases-http";
import { tunnelCases } from "./cases-tunnel";
import {
  DEFAULT_RUST_BIN,
  ROOT,
  cleanupNow,
  dnsStub,
  echoServer,
  fakeUpstream,
  selfSigned,
  startService,
  tempDir,
  type Json,
  type Service,
  type TunnelCtx,
} from "./lib";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

type Suite = "default" | "loopback" | "tls" | "rebind" | "tunnel";
const LOOPBACK = "127.0.0.1,::1";

const all: Array<{
  id: string;
  suite: Suite;
  run: (svc: Service, ctx: Ctx & TunnelCtx) => Promise<Json>;
  dropHeaders?: string[];
}> = [...httpCases, ...tunnelCases];

if (flag("list")) {
  for (const c of all) console.log(`${c.suite}\t${c.id}`);
  process.exit(0);
}

const rustBin = opt("rust-bin") ?? process.env.SB_EGRESS_RS_BIN ?? DEFAULT_RUST_BIN;
if (flag("build")) {
  const p = Bun.spawnSync(
    [
      "cargo",
      "build",
      "--release",
      "--features",
      "test-resolver",
      "--target-dir",
      join(ROOT, "services/egress-rs/target/diff"),
      "--manifest-path",
      join(ROOT, "services/egress-rs/Cargo.toml"),
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (p.exitCode !== 0) process.exit(2);
}
const tsVsTs = flag("ts-vs-ts");
if (!tsVsTs && !existsSync(rustBin)) {
  console.error(`Rust binary not found: ${rustBin} (build with --build; it needs the test-resolver feature)`);
  process.exit(2);
}

const only = (opt("only") ?? "").split(",").filter(Boolean);
const selected = all.filter(
  (c) => only.length === 0 || only.some((o) => (o.endsWith("*") ? c.id.startsWith(o.slice(0, -1)) : c.id === o)),
);
const known: Record<string, string> = JSON.parse(readFileSync(join(import.meta.dir, "known-differences.json"), "utf8"));
const knownReason = (id: string) => {
  if (known[id]) return known[id];
  for (const [k, v] of Object.entries(known)) if (k.endsWith("*") && id.startsWith(k.slice(0, -1))) return v;
  return undefined;
};

const dir = tempDir("egress-diff-");
const tls = await selfSigned(dir, "up", "DNS:localhost");

type Runs = { [id: string]: Json };
type PortMap = { [suite: string]: { [name: string]: number } };
const emptyRuns = (): Runs => ({});
const emptyPorts = (): PortMap => ({});
const results = { ts: emptyRuns(), rust: emptyRuns() };
const ports = { ts: emptyPorts(), rust: emptyPorts() };

const suites: Suite[] = ["default", "loopback", "tls", "rebind", "tunnel"];
for (const suite of suites) {
  const inSuite = selected.filter((c) => c.suite === suite);
  if (inSuite.length === 0) continue;
  for (const impl of ["ts", "rust"] as const) {
    const dns = suite === "rebind" ? dnsStub(DNS_SCRIPT) : null;
    const env = {
      SB_EGRESS_ALLOW: suite === "default" ? "" : LOOPBACK,
      NODE_EXTRA_CA_CERTS: tls.certPath,
      SB_CA_BUNDLE: tls.certPath,
      SB_EGRESS_TEST_RESOLVER: dns ? dns.url : "",
    };
    const svc = await startService(impl, env, tsVsTs && impl === "rust" ? "" : rustBin).catch(async (e) => {
      if (!(tsVsTs && impl === "rust")) throw e;
      return startService("ts", env, "");
    });
    const up = fakeUpstream();
    const tlsUp = suite === "tls" ? fakeUpstream({ tls: { cert: tls.cert, key: tls.key } }) : null;
    const echo = echoServer({ banner: "" });
    const tlsEcho = suite === "tunnel" ? echoServer({ tls: { cert: tls.cert, key: tls.key } }) : null;
    const ctx = { up, tlsUp, dns, echo, tlsEcho };
    ports[impl][suite] = {
      up: up.port,
      tls: tlsUp?.port ?? 0,
      dns: dns ? Number(new URL(dns.url).port) : 0,
      echo: echo.port,
      tlsEcho: tlsEcho?.port ?? 0,
      svc: svc.http,
      tcp: svc.tcp,
    };
    for (const c of inSuite) {
      process.stderr.write(`[${impl}] ${c.id}\n`);
      try {
        results[impl][c.id] = await Promise.race([
          c.run(svc, ctx),
          new Promise<Json>((_, reject) => setTimeout(() => reject(new Error("case timeout")), 30_000)),
        ]);
      } catch (error) {
        results[impl][c.id] = { harnessError: String(error) };
      }
    }
    await svc.stop();
    up.stop();
    echo.stop();
    tlsUp?.stop();
    tlsEcho?.stop();
    dns?.stop();
  }
}

// --- normalise and compare ---------------------------------------------------------------

function scrub(text: string, impl: "ts" | "rust", suite: string): string {
  let out = text;
  for (const [name, port] of Object.entries(ports[impl][suite] ?? {})) {
    if (port) out = out.replace(new RegExp(`(?<![0-9])${port}(?![0-9])`, "g"), `<${name}>`);
  }
  return out;
}

const rows: Array<{
  id: string;
  verdict: "SAME" | "KNOWN" | "DIFFERENT" | "SKIP";
  reason?: string;
  details?: string[];
}> = [];
for (const c of selected) {
  if (results.ts[c.id] === "UNSUPPORTED") {
    rows.push({ id: c.id, verdict: "SKIP", reason: "the Bun wire package in use has no tcp.ts" });
    continue;
  }
  const mk = (impl: "ts" | "rust") =>
    JSON.parse(scrub(JSON.stringify(norm(results[impl][c.id], c.dropHeaders ?? [])), impl, c.suite));
  const a = mk("ts");
  const b = mk("rust");
  const d = diffPaths(a, b);
  if (d.length === 0) rows.push({ id: c.id, verdict: "SAME" });
  else if (knownReason(c.id)) rows.push({ id: c.id, verdict: "KNOWN", reason: knownReason(c.id), details: d });
  else rows.push({ id: c.id, verdict: "DIFFERENT", details: d });
}

const count = (v: string) => rows.filter((r) => r.verdict === v).length;
const lines: string[] = [];
lines.push(
  `# egress differential: ${rows.length} cases, ${count("SAME")} same, ${count("KNOWN")} known differences, ${count("SKIP")} skipped, ${count("DIFFERENT")} different`,
);
lines.push("");
for (const r of rows.filter((r) => r.verdict !== "SAME")) {
  lines.push(`## ${r.verdict}: ${r.id}${r.reason ? ` (${r.reason})` : ""}`);
  for (const d of r.details ?? []) lines.push(`- ${d}`);
  lines.push("");
}
lines.push("| case | verdict |", "|---|---|");
for (const r of rows) lines.push(`| ${r.id} | ${r.verdict} |`);
const report = lines.join("\n");
console.log(report);
const raw = opt("raw");
if (raw) writeFileSync(raw, JSON.stringify({ results, ports }, null, 2));
const out = opt("out");
if (out) writeFileSync(out, `${report}\n`);
const json = opt("json");
if (json)
  writeFileSync(
    json,
    JSON.stringify(
      { total: rows.length, same: count("SAME"), known: count("KNOWN"), different: count("DIFFERENT"), rows },
      null,
      2,
    ),
  );
cleanupNow();
process.exit(count("DIFFERENT") > 0 ? 1 : 0);
