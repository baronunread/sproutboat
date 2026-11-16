// bun summarize.ts results.jsonl  -> markdown tables (median of the repetitions)
import { readFileSync } from "node:fs";
const rows = readFileSync(process.argv[2] ?? "results.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const med = (v: number[]) => { const s = v.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
const f = (x: number, d = 0) => (Number.isNaN(x) ? "-" : x.toFixed(d));

console.log("### Memory and reload\n");
console.log("| proxy | certs | start ms | idle RSS MiB | RSS after every cert used | peak RSS | reload ms | first-handshake p50/p99 us |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of rows.filter((r) => r.scenario === "mem" && r.certs > 0))
  console.log(`| ${r.proxy} | ${r.certs} | ${f(r.start_ms)} | ${f(r.idle_rss_mib, 1)} | ${f(r.after_touch.rss_mib, 1)} | ${f(Math.max(r.after_touch.hwm_mib, r.after_reload?.hwm_mib ?? 0), 1)} | ${r.reload_ms ?? "-"} | ${r.touch.connect_p50_us} / ${r.touch.connect_p99_us} |`);
const plain = rows.find((r) => r.proxy === "edge-plain");
if (plain) console.log(`\nedge without TLS, idle: ${plain.rss_mib} MiB RSS (${plain.pss_mib} PSS)`);

console.log("\n### Latency and CPU (median of repetitions)\n");
const tests = [...new Set(rows.filter((r) => r.scenario === "perf").map((r) => r.test))];
for (const test of tests) {
  console.log(`\n**${test}**\n`);
  console.log("| target | p50 us | p99 us | req/s or conn/s | CPU us per request: total | by process |");
  console.log("|---|---|---|---|---|---|");
  const targets = [...new Set(rows.filter((r) => r.test === test).map((r) => r.target))];
  for (const t of targets) {
    const g = rows.filter((r) => r.test === test && r.target === t && !r.error);
    if (!g.length) continue;
    const p50 = med(g.map((r) => r.p50_us ?? r.total_p50_us));
    const p99 = med(g.map((r) => r.p99_us ?? r.total_p99_us));
    const rate = med(g.map((r) => r.rps ?? r.per_sec));
    const cpu = med(g.map((r) => r.cpu_us_total));
    const procs = Object.keys(g[0].cpu_us).map((k) => `${k} ${f(med(g.map((r) => r.cpu_us[k])), 1)}`).join(", ");
    const extra = test.startsWith("hs") ? ` (connect p50 ${f(med(g.map((r) => r.connect_p50_us)))} / p99 ${f(med(g.map((r) => r.connect_p99_us)))})` : "";
    console.log(`| ${t} | ${f(p50)}${extra} | ${f(p99)} | ${f(rate)} | ${f(cpu, 1)} | ${procs} |`);
  }
}
