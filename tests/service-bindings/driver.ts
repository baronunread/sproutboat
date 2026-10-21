// Drives the service-binding suite against one running caller (workerd or the platform)
// and writes what it saw as JSON, so two runs can be compared case by case.
//   bun tests/service-bindings/driver.ts BASE_URL OUT.json [HOST]
// BASE_URL reaches the caller; HOST, when given, is sent as the Host header (the platform
// edge routes by it).
import { parseCaseNames, parseJson, serializeRun, type CaseResult, type Reply } from "./run";

const [base, out, host] = process.argv.slice(2);
if (!base || !out) {
  console.error("usage: bun tests/service-bindings/driver.ts BASE_URL OUT.json [HOST]");
  process.exit(2);
}
const headers = new Headers(host ? { host } : {});
const get = async (path: string, timeoutMs = 45_000): Promise<Reply> => {
  const t0 = performance.now();
  try {
    const res = await fetch(base + path, { headers, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, text: await res.text(), ms: Math.round(performance.now() - t0) };
  } catch (error) {
    return {
      status: 0,
      text: error instanceof Error ? error.name : String(error),
      ms: Math.round(performance.now() - t0),
    };
  }
};

const cases = new Map<string, CaseResult>();
for (const name of parseCaseNames((await get("/cases")).text)) {
  const r = await get(`/case/${name}`);
  cases.set(name, { status: r.status, value: parseJson(r.text) });
  console.log(`case ${name}: ${r.status} ${r.text.slice(0, 100)}`);
}

// Reliability, measured from outside.
// Does the caller still answer while one of its requests waits 3 s on the callee?
const slow = get("/call/slow?ms=3000");
await Bun.sleep(300);
const ping = await get("/ping");
const slowDone = await slow;
// Eight calls at once to a callee that takes 500 ms each.
const t0 = performance.now();
const all = await Promise.all(Array.from({ length: 8 }, () => get("/call/slow?ms=500")));
const totalMs = Math.round(performance.now() - t0);
const timed = async (name: string, path: string): Promise<Reply> => {
  const r = await get(path, 60_000);
  console.log(`${name}: ${r.status} in ${r.ms} ms ${r.text.slice(0, 80)}`);
  return { ...r, text: r.text.slice(0, 120) };
};
const reliability = {
  responsiveDuringCall: { pingMs: ping.ms, pingStatus: ping.status, slowMs: slowDone.ms, slowStatus: slowDone.status },
  concurrent8x500ms: { totalMs, statuses: all.map((r) => r.status) },
  selfRecursion: await timed("selfRecursion", "/self"),
  mutualRecursion: await timed("mutualRecursion", "/mutual"),
  calleeNeverAnswers: await timed("calleeNeverAnswers", "/call/slow?ms=120000"),
};
console.log(JSON.stringify(reliability, null, 2));
await Bun.write(out, serializeRun({ base, host: host ?? null, cases, reliability }));
