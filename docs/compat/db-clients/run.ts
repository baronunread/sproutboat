// usage: bun run.ts <appdir> <binary-name>
import { $ } from "bun";
import { appendFileSync, writeFileSync } from "node:fs";
const [dir, bin] = process.argv.slice(2);
const abs = `${process.cwd()}/${dir}`;
const SB = 19001,
  WD = 19002;
const LOG = `/tmp/dbc/run-${bin}.log`;
writeFileSync(LOG, "");
const log = (...a: any[]) => appendFileSync(LOG, a.join(" ") + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rss = async (pid: number) => Number((await $`ps -o rss= -p ${pid}`.text()).trim() || 0) / 1024;
async function waitUp(port: number, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(2000) });
      await r.text();
      return Date.now() - t0;
    } catch {}
    await sleep(150);
  }
  throw new Error("not up " + port);
}
let sb: any, wd: any;
const startSb = () => {
  sb = Bun.spawn([`${abs}/dist/${bin}`], {
    env: { ...process.env, PORT: String(SB), SB_EGRESS_ALLOW: "127.0.0.1", SB_DATA_DIR: `/tmp/dbc/data-${bin}` },
    stdout: Bun.file(`/tmp/dbc/sb-${bin}.out`),
    stderr: Bun.file(`/tmp/dbc/sb-${bin}.out`),
  });
};
const stop = async () => {
  for (const p of [sb, wd]) {
    try {
      p?.kill("SIGTERM");
    } catch {}
  }
  await sleep(500);
};
const gt = async (port: number, path: string, to = 20000) => {
  const t0 = performance.now();
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(to) });
    const txt = await r.text();
    return { status: r.status, txt, ms: performance.now() - t0 };
  } catch (e: any) {
    return { status: 0, txt: "TIMEOUT/" + e.name, ms: performance.now() - t0 };
  }
};
const pj = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return t.slice(0, 200);
  }
};
try {
  startSb();
  wd = Bun.spawn(
    ["/tmp/dbc/wr/node_modules/.bin/wrangler", "dev", "--port", String(WD), "--ip", "127.0.0.1", "--local"],
    {
      cwd: abs,
      stdout: Bun.file(`/tmp/dbc/wd-${bin}.out`),
      stderr: Bun.file(`/tmp/dbc/wd-${bin}.out`),
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    },
  );
  const sbStart = await waitUp(SB);
  await waitUp(WD);
  const res: any = {
    idleRssMiB: { sb: await rss(sb.pid) },
    sbStartMs: sbStart,
    binMiB: Bun.file(`${abs}/dist/${bin}`).size / 1048576,
  };
  const names: string[] = JSON.parse((await gt(SB, "/cases")).txt);
  const all: any = { wd: {}, sb: {} };
  res.caseMs = {};
  for (const [name, port] of [
    ["wd", WD],
    ["sb", SB],
  ] as const) {
    for (const c of names) {
      const r = await gt(port, `/case?c=${encodeURIComponent(c)}&p=${name}`, 15000);
      all[name][c] = r.status === 200 ? r.txt : "HTTP " + r.status + " " + r.txt.slice(0, 300);
      (res.caseMs[c] ??= {})[name] = Math.round(r.ms);
      log(name, c, Math.round(r.ms) + "ms", all[name][c].slice(0, 120));
      if (name === "sb" && r.status === 0) {
        try {
          sb.kill("SIGKILL");
        } catch {}
        await sleep(300);
        startSb();
        await waitUp(SB);
        log("sb restarted after timeout");
      }
    }
  }
  const norm = (o: any, p: string) =>
    JSON.parse(
      JSON.stringify(o)
        .replaceAll(p + "_", "P_")
        .replaceAll(p + ":", "P:")
        .replaceAll("_" + p, "_P"),
    );
  const a = norm(all.wd, "wd"),
    b = norm(all.sb, "sb");
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  let pass = 0;
  const diffs: any[] = [];
  for (const k of keys) {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) pass++;
    else diffs.push({ case: k, wd: a[k], sb: b[k] });
  }
  res.cases = keys.length;
  res.pass = pass;
  res.diffs = diffs;
  // RSS after requests (restart for a clean baseline)
  sb.kill("SIGKILL");
  await sleep(300);
  startSb();
  await waitUp(SB);
  res.rssFreshMiB = await rss(sb.pid);
  let okq = 0;
  for (let i = 0; i < 200; i++) {
    const r = await gt(SB, "/q", 10000);
    if (r.status === 200) okq++;
  }
  await Promise.all(Array.from({ length: 20 }, () => gt(SB, "/q", 10000)));
  res.qOk = okq;
  res.rssAfter220Req = await rss(sb.pid);
  res.bench = { wd: pj((await gt(WD, "/bench?n=40", 60000)).txt), sb: pj((await gt(SB, "/bench?n=40", 60000)).txt) };
  if (bin.includes("neon"))
    res.benchWs = {
      wd: pj((await gt(WD, "/bench?n=40&mode=ws", 60000)).txt),
      sb: pj((await gt(SB, "/bench?n=40&mode=ws", 60000)).txt),
    };
  res.rssAfterBench = await rss(sb.pid);
  Bun.write(`${abs}/result.json`, JSON.stringify({ ...res, all }, null, 2));
  console.log(JSON.stringify(res, null, 2));
} finally {
  await stop();
}
