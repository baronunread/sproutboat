import { readdirSync, readFileSync } from "fs";
const rows: Record<string, number[]> = {};
const errs: Record<string, number[]> = {};
for (const f of readdirSync(".").filter((f) => /^cmp(-like)?-t\d(-do)?\.out$/.test(f))) {
  for (const l of readFileSync(f, "utf8").split("\n")) {
    const m = l.match(/^\d+ (\S+) (\S+) rate=(\d+) user=(\d+)e-1 sys=(\d+)e-1 total=(\d+)e-1 :: .*errors=([\d.]+)%/);
    if (!m) continue;
    const [, t, ep, rate, u, s, tot, e] = m;
    if (f.startsWith("cmp-t") && ep === "like") continue; // like comes from the 32-connection runs
    if (f.startsWith("cmp-t") && rate === "100") continue; // 100/s on 512 connections: workerd resets idle connections
    if (t === "standalone" && f.endsWith("-do.out")) {
      const kk = `${ep}@${rate} standalone(ctl)`;
      (rows[kk] ??= []).push(+tot / 10);
      (errs[kk] ??= []).push(+e);
      continue;
    }
    const k = `${ep}@${rate} ${t}`;
    (rows[k] ??= []).push(+tot / 10);
    (errs[k] ??= []).push(+e);
  }
}
const med = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
for (const k of Object.keys(rows).sort())
  console.log(
    k.padEnd(28),
    "n=" + rows[k].length,
    "median",
    med(rows[k]).toFixed(0),
    "all",
    rows[k].map((x) => x.toFixed(0)).join("/"),
    "err",
    errs[k].join("/"),
  );
