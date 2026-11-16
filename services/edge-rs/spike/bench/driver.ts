// SPIKE benchmark driver (bun, runs on the bench box): Caddy + edge against the edge's own TLS.
// Usage: bun driver.ts mem | perf | all     (results append to results.jsonl)
// Every process is started under `systemd-run --user --scope` with a memory cap, its PID recorded,
// and only recorded PIDs are ever signalled. Never pkill.
import { $ } from "bun";
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync, rmSync } from "node:fs";

const D = process.cwd();
const BIN = `${D}/bin`;
const RES = `${D}/results.jsonl`;
const P = { backend: 28600, edge: 28610, edgeTls: 28643, edgeHttp: 28681, term: 28644, termPlain: 28611, caddy: 28443, caddyHttp: 28680 };
const TICK = 100; // clock ticks per second (getconf CLK_TCK)

type Proc = { name: string; pid: number; proc: ReturnType<typeof Bun.spawn> };
const live: Proc[] = [];

function log(o: object) {
  appendFileSync(RES, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
  console.log(JSON.stringify(o));
}

function start(name: string, cmd: string[], env: Record<string, string> = {}, memMax = "1G"): Proc {
  const proc = Bun.spawn(["systemd-run", "--user", "--scope", "--quiet", "-p", `MemoryMax=${memMax}`, ...cmd], {
    env: { ...process.env, ...env } as Record<string, string>,
    stdout: Bun.file(`${D}/logs/${name}.log`),
    stderr: Bun.file(`${D}/logs/${name}.log`),
  });
  const p = { name, pid: proc.pid, proc };
  live.push(p);
  return p;
}
function stop(p: Proc) {
  try { process.kill(p.pid, "SIGTERM"); } catch {}
  const i = live.indexOf(p);
  if (i >= 0) live.splice(i, 1);
}
async function stopAll() {
  for (const p of [...live]) stop(p);
  await Bun.sleep(1500);
  for (const p of live) { try { process.kill(p.pid, 0); process.kill(p.pid, "SIGKILL"); } catch {} }
  live.length = 0;
}

const stat = (pid: number) => {
  const f = readFileSync(`/proc/${pid}/stat`, "utf8");
  const rest = f.slice(f.lastIndexOf(")") + 2).split(" ");
  return Number(rest[11]) + Number(rest[12]); // utime + stime, ticks
};
function mem(pid: number) {
  const s = readFileSync(`/proc/${pid}/status`, "utf8");
  const kb = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(s)?.[1] ?? 0);
  let pss = 0;
  try { pss = Number(/Pss:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))?.[1] ?? 0); } catch {}
  const mib = (k: number) => Math.round((k / 1024) * 10) / 10;
  return { rss_mib: mib(kb("VmRSS")), hwm_mib: mib(kb("VmHWM")), pss_mib: mib(pss), anon_mib: mib(kb("RssAnon")) };
}

async function bench(args: string[]): Promise<any> {
  const r = await $`${BIN}/bench ${args}`.quiet().nothrow();
  const out = r.stdout.toString().trim().split("\n").pop() ?? "";
  try { return JSON.parse(out); } catch { return { error: out || r.stderr.toString().slice(0, 300) }; }
}

async function waitFor(fn: () => Promise<boolean>, what: string, ms = 60000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn().catch(() => false)) return Date.now() - t; await Bun.sleep(25); }
  throw new Error(`timeout waiting for ${what}`);
}
const answers = (addr: string, tls: boolean, sni = "hello.acct-00000.sproutboat.app") => async () => {
  const r = await bench(["lat", "--addr", addr, ...(tls ? ["--tls"] : []), "--sni-fmt", sni, "--n", "1"]);
  return r.errors === 0;
};

// ---------------------------------------------------------------- stacks
function startBackend() {
  return start("backend", [`${BIN}/backend`, `127.0.0.1:${P.backend}`], {}, "256M");
}
function edgeEnv(extra: Record<string, string> = {}) {
  writeFileSync(`${D}/routes.json`, '{"version":1,"apps":[]}');
  mkdirSync(`${D}/edge-log`, { recursive: true });
  return {
    PORT: String(P.edge),
    SPROUTBOAT_BIND_HOST: "127.0.0.1",
    SPROUTBOAT_EDGE_BACKEND: `http://127.0.0.1:${P.backend}`,
    SPROUTBOAT_ROUTE_SNAPSHOT: `${D}/routes.json`,
    SPROUTBOAT_LOG_PATH: `${D}/edge-log/requests.ndjson`,
    SPROUTBOAT_ASSET_CACHE_BYTES: "33554432",
    SPROUTBOAT_REQUEST_TIMEOUT_MS: "30000",
    ...extra,
  };
}
const tlsEnv = (certs: string, extra: Record<string, string> = {}) => ({
  SPROUTBOAT_TLS_LISTEN: `127.0.0.1:${P.edgeTls}`,
  SPROUTBOAT_TLS_HTTP_LISTEN: `127.0.0.1:${P.edgeHttp}`,
  SPROUTBOAT_TLS_CERT_DIR: certs,
  ...extra,
});
function startEdge(extra: Record<string, string> = {}) {
  return start("edge", [`${BIN}/sproutboat-edge`], edgeEnv(extra), "512M");
}
function caddyfile(drops: string) {
  mkdirSync(`${D}/caddy/run`, { recursive: true });
  writeFileSync(
    `${D}/caddy/Caddyfile`,
    `{\n\tadmin unix/${D}/caddy/run/admin.sock\n\thttp_port ${P.caddyHttp}\n\thttps_port ${P.caddy}\n\tskip_install_trust\n}\n\nimport ${drops}/*.caddy\n`,
  );
}
function startCaddy() {
  return start(
    "caddy",
    [`${BIN}/caddy`, "run", "--config", `${D}/caddy/Caddyfile`, "--adapter", "caddyfile"],
    { XDG_DATA_HOME: `${D}/caddy/data`, XDG_CONFIG_HOME: `${D}/caddy/config` },
    "2G",
  );
}
async function genCerts(n: number) {
  const certs = `${D}/certs${n}`;
  if (existsSync(`${certs}/acct-${String(n - 1).padStart(5, "0")}/privkey.pem`)) return certs;
  rmSync(certs, { recursive: true, force: true });
  rmSync(`${D}/caddy-${n}.d`, { recursive: true, force: true });
  await $`${BIN}/certgen --out ${certs} --accounts ${n} --caddy-dir ${D}/caddy-${n}.d --cert-root ${certs} --edge 127.0.0.1:${P.edge}`.quiet();
  return certs;
}

// ---------------------------------------------------------------- memory and reload
async function memScenario() {
  for (const n of [1, 1000, 5000]) {
    const certs = await genCerts(n);
    const touch = ["hs", "--tls", "--sni-fmt", "hello.acct-{}.sproutboat.app", "--accounts", String(n), "--n", String(n), "--conns", "8"];

    // Caddy: N site blocks, each with its own certificate files, as sbcloud writes them today.
    {
      const be = startBackend(); const edge = startEdge(); // the edge sits behind Caddy as today
      await waitFor(answers(`127.0.0.1:${P.edge}`, false), "edge");
      caddyfile(`${D}/caddy-${n}.d`);
      const t0 = Date.now();
      const caddy = startCaddy();
      const up = await waitFor(answers(`127.0.0.1:${P.caddy}`, true), "caddy", 180000);
      const idle = mem(caddy.pid);
      const touched = await bench([...touch, "--addr", `127.0.0.1:${P.caddy}`]);
      const afterTouch = mem(caddy.pid);
      const r0 = Date.now();
      const rl = await $`${BIN}/caddy reload --config ${D}/caddy/Caddyfile --adapter caddyfile --force`.env({ ...process.env, XDG_DATA_HOME: `${D}/caddy/data`, XDG_CONFIG_HOME: `${D}/caddy/config` }).quiet().nothrow();
      const reloadMs = Date.now() - r0;
      await Bun.sleep(500);
      const afterReload = mem(caddy.pid);
      log({ scenario: "mem", proxy: "caddy", certs: n, start_ms: up, ...Object.fromEntries(Object.entries(idle).map(([k, v]) => ["idle_" + k, v])), touch: touched, after_touch: afterTouch, reload_ms: reloadMs, reload_ok: rl.exitCode === 0, after_reload: afterReload });
      await stopAll();
    }
    // The edge's own TLS: lazy (loaded on first handshake) and preloaded.
    for (const preload of [false, true]) {
      const be = startBackend();
      const t0 = Date.now();
      const edge = startEdge(tlsEnv(certs, preload ? { SPROUTBOAT_TLS_PRELOAD: "1" } : {}));
      const up = await waitFor(answers(`127.0.0.1:${P.edgeTls}`, true), "edge tls", 180000);
      const idle = mem(edge.pid);
      const touched = await bench([...touch, "--addr", `127.0.0.1:${P.edgeTls}`]);
      const afterTouch = mem(edge.pid);
      log({ scenario: "mem", proxy: preload ? "edge-rustls-preload" : "edge-rustls-lazy", certs: n, start_ms: up, ...Object.fromEntries(Object.entries(idle).map(([k, v]) => ["idle_" + k, v])), touch: touched, after_touch: afterTouch });
      await stopAll();
    }
  }
  // The edge without TLS, for the size of the TLS code itself.
  startBackend(); const plain = startEdge();
  await waitFor(answers(`127.0.0.1:${P.edge}`, false), "plain edge");
  log({ scenario: "mem", proxy: "edge-plain", certs: 0, ...mem(plain.pid) });
  await stopAll();
}

// ---------------------------------------------------------------- CPU, latency, handshakes
type Target = { label: string; addr: string; tls: boolean; h1only?: boolean; pids: () => Record<string, number> };
async function perfScenario() {
  const n = 1000;
  const certs = await genCerts(n);
  const caddyN = Number(process.env.CADDYN ?? n);
  await genCerts(caddyN);
  caddyfile(`${D}/caddy-${caddyN}.d`);
  const be = startBackend();
  const edge = startEdge(tlsEnv(certs)); // one edge process: plain :28610 for Caddy and P, TLS :28643 for R
  // The key-isolation variant: a second process that only terminates TLS and pumps bytes to the edge (h1).
  const term = start("term", [`${BIN}/sproutboat-edge`], edgeEnv({ PORT: String(P.termPlain), SPROUTBOAT_LOG_PATH: "", SPROUTBOAT_TLS_LISTEN: `127.0.0.1:${P.term}`, SPROUTBOAT_TLS_CERT_DIR: certs, SPROUTBOAT_TLS_PUMP_TO: `127.0.0.1:${P.edge}` }), "512M");
  const caddy = startCaddy();
  await waitFor(answers(`127.0.0.1:${P.term}`, true), "terminator");
  await waitFor(answers(`127.0.0.1:${P.caddy}`, true), "caddy", 180000);
  await waitFor(answers(`127.0.0.1:${P.edgeTls}`, true), "edge tls");
  await waitFor(answers(`127.0.0.1:${P.edge}`, false), "edge plain");
  // warm every certificate in both
  for (const addr of [P.caddy, P.edgeTls, P.term]) { const k = addr === P.caddy ? caddyN : n; await bench(["hs", "--tls", "--addr", `127.0.0.1:${addr}`, "--sni-fmt", "hello.acct-{}.sproutboat.app", "--accounts", String(k), "--n", String(k), "--conns", "8"]); }

  const targets: Target[] = [
    { label: "B backend direct", addr: `127.0.0.1:${P.backend}`, tls: false, pids: () => ({ backend: be.pid }) },
    { label: "P edge plain", addr: `127.0.0.1:${P.edge}`, tls: false, pids: () => ({ edge: edge.pid, backend: be.pid }) },
    { label: "C caddy+edge (today)", addr: `127.0.0.1:${P.caddy}`, tls: true, pids: () => ({ caddy: caddy.pid, edge: edge.pid, backend: be.pid }) },
    { label: "R edge-rustls", addr: `127.0.0.1:${P.edgeTls}`, tls: true, pids: () => ({ edge: edge.pid, backend: be.pid }) },
    { label: "T tlsterm then edge", addr: `127.0.0.1:${P.term}`, tls: true, h1only: true, pids: () => ({ term: term.pid, edge: edge.pid, backend: be.pid }) },
  ];
  const REPS = 3;
  const only = process.env.TESTS?.split(",");
  const onlyTargets = process.env.TARGETS?.split(",");
  const suffix = process.env.SUFFIX ?? "";
  const wanted = (test: string) => !only || only.includes(test);
  const measured = async (t: Target, args: string[], requests: (r: any) => number) => {
    const pids = t.pids();
    const before = Object.fromEntries(Object.entries(pids).map(([k, p]) => [k, stat(p)]));
    const r = await bench([args[0], "--addr", t.addr, ...(t.tls ? ["--tls"] : []), ...args.slice(1)]);
    const after = Object.fromEntries(Object.entries(pids).map(([k, p]) => [k, stat(p)]));
    const reqs = requests(r);
    const cpu_us: Record<string, number> = {};
    let total = 0;
    for (const k of Object.keys(pids)) { cpu_us[k] = Math.round(((after[k] - before[k]) / TICK / reqs) * 1e6 * 10) / 10; total += cpu_us[k]; }
    return { ...r, cpu_us, cpu_us_total: Math.round(total * 10) / 10 };
  };
  for (let rep = 0; rep < REPS; rep++) {
    for (const t of targets) {
      if (onlyTargets && !onlyTargets.includes(t.label[0])) continue;
      const h1 = t.tls ? ["--h", "1"] : [];
      wanted("lat-h1") && log({ scenario: "perf", test: "lat-h1", target: t.label + suffix, rep, ...(await measured(t, ["lat", ...h1, "--sni-fmt", "hello.acct-00000.sproutboat.app", "--n", "20000", "--warm", "2000"], () => 22000)) });
      wanted("thr-h1") && log({ scenario: "perf", test: "thr-h1", target: t.label + suffix, rep, ...(await measured(t, ["thr", ...h1, "--sni-fmt", "hello.acct-{}.sproutboat.app", "--accounts", "32", "--conns", "32", "--n", "100000"], (r) => r.requests)) });
      if (t.tls && !t.h1only) {
        wanted("lat-h2") && log({ scenario: "perf", test: "lat-h2", target: t.label + suffix, rep, ...(await measured(t, ["lat", "--h", "2", "--sni-fmt", "hello.acct-00000.sproutboat.app", "--n", "20000", "--warm", "2000"], () => 22000)) });
        wanted("thr-h2") && log({ scenario: "perf", test: "thr-h2", target: t.label + suffix, rep, ...(await measured(t, ["thr", "--h", "2", "--sni-fmt", "hello.acct-{}.sproutboat.app", "--accounts", "4", "--conns", "4", "--streams", "8", "--n", "100000"], (r) => r.requests)) });
      }
      if (t.tls) {
        // New connection per request, full handshake, no resumption.
        wanted("hs-1sni-seq") && log({ scenario: "perf", test: "hs-1sni-seq", target: t.label + suffix, rep, ...(await measured(t, ["hs", "--h", "1", "--sni-fmt", "hello.acct-00000.sproutboat.app", "--n", "3000", "--conns", "1"], (r) => r.connections)) });
        wanted("hs-1sni-par") && log({ scenario: "perf", test: "hs-1sni-par", target: t.label + suffix, rep, ...(await measured(t, ["hs", "--h", "1", "--sni-fmt", "hello.acct-00000.sproutboat.app", "--n", "12000", "--conns", "4"], (r) => r.connections)) });
        wanted("hs-1000sni-par") && log({ scenario: "perf", test: "hs-1000sni-par", target: t.label + suffix, rep, ...(await measured(t, ["hs", "--h", "1", "--sni-fmt", "hello.acct-{}.sproutboat.app", "--accounts", "1000", "--n", "12000", "--conns", "4"], (r) => r.connections)) });
      }
    }
  }
  await stopAll();
}

// Caddy with ONE catch-all site and `get_certificate http` (no drop-in per account, no reload per certificate).
async function getHttpScenario() {
  for (const n of [1000, 5000]) {
    const certs = await genCerts(n);
    startBackend(); startEdge();
    await waitFor(answers(`127.0.0.1:${P.edge}`, false), "edge");
    const cs = start("certserver", ["bun", `${D}/certserver.ts`, certs, "28700"], {}, "512M");
    await Bun.sleep(500);
    mkdirSync(`${D}/caddy/run`, { recursive: true });
    writeFileSync(`${D}/caddy/Caddyfile`, `{\n\tadmin unix/${D}/caddy/run/admin.sock\n\thttp_port ${P.caddyHttp}\n\thttps_port ${P.caddy}\n\tskip_install_trust\n}\n\nhttps:// {\n\ttls {\n\t\tget_certificate http http://127.0.0.1:28700/cert\n\t}\n\treverse_proxy 127.0.0.1:${P.edge}\n}\n`);
    const caddy = startCaddy();
    const up = await waitFor(answers(`127.0.0.1:${P.caddy}`, true), "caddy", 120000);
    const idle = mem(caddy.pid);
    const touched = await bench(["hs", "--tls", "--addr", `127.0.0.1:${P.caddy}`, "--sni-fmt", "hello.acct-{}.sproutboat.app", "--accounts", String(n), "--n", String(n), "--conns", "8"]);
    const afterTouch = mem(caddy.pid);
    const before = stat(caddy.pid);
    const steady = await bench(["hs", "--tls", "--addr", `127.0.0.1:${P.caddy}`, "--sni-fmt", "hello.acct-{}.sproutboat.app", "--accounts", String(n), "--n", "12000", "--conns", "4"]);
    const cpu = Math.round(((stat(caddy.pid) - before) / TICK / 12000) * 1e6);
    const r0 = Date.now();
    const rl = await $`${BIN}/caddy reload --config ${D}/caddy/Caddyfile --adapter caddyfile --force`.env({ ...process.env, XDG_DATA_HOME: `${D}/caddy/data`, XDG_CONFIG_HOME: `${D}/caddy/config` }).quiet().nothrow();
    log({ scenario: "mem", proxy: "caddy-get_certificate-http", certs: n, start_ms: up, ...Object.fromEntries(Object.entries(idle).map(([k, v]) => ["idle_" + k, v])), touch: touched, after_touch: afterTouch, reload_ms: Date.now() - r0, reload_ok: rl.exitCode === 0, hs_steady: steady, hs_steady_caddy_cpu_us: cpu, errors_seen: touched.errors });
    await stopAll();
  }
}

process.on("SIGINT", async () => { await stopAll(); process.exit(130); });
mkdirSync(`${D}/logs`, { recursive: true });
const what = process.argv[2] ?? "all";
try {
  if (what === "mem" || what === "all") await memScenario();
  if (what === "perf" || what === "all") await perfScenario();
  if (what === "gethttp") await getHttpScenario();
} finally {
  await stopAll();
}
