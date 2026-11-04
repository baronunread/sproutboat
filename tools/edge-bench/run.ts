#!/usr/bin/env bun
// Edge benchmark orchestrator. See README.md.
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, resolve } from "node:path";
import { walkAssets } from "@sproutboat/assets";

const HERE = import.meta.dir;
const ROOT = resolve(HERE, "../..");
const HOST = "bench.sproutboat.local";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const EDGES = ["bun", "rust", "direct", "caddy-bun", "caddy-rust", "caddy-direct"];
const edge = opt("edge", "")!;
if (!EDGES.includes(edge) || flag("help")) {
  console.error(`usage: bun tools/edge-bench/run.ts --edge ${EDGES.join("|")} [--conns 1,8,32,128] [--duration 15] [--warmup 3]
  [--scenario hello|asset|cached] [--bun-main PATH] [--caddy /path/to/caddy] [--rust-bin PATH] [--no-newconn] [--out FILE.jsonl] [--dry-run]`);
  process.exit(flag("help") ? 0 : 2);
}
const conns = opt("conns", "1,8,32,128")!.split(",").map(Number);
const duration = Number(opt("duration", "15"));
const warmup = Number(opt("warmup", "3"));
const dry = flag("dry-run");
/** hello: proxied to a trivial upstream; asset: a 4 KiB static file served by the edge; cached: a public response served from the edge cache. */
const SCENARIOS = ["hello", "asset", "cached"];
const scenario = opt("scenario", "hello") ?? "hello";
if (!SCENARIOS.includes(scenario)) {
  console.error(`unknown --scenario ${scenario}; use ${SCENARIOS.join("|")}`);
  process.exit(2);
}
if (scenario !== "hello" && (edge === "direct" || edge === "caddy-direct")) {
  console.error("the asset and cached scenarios need an edge (bun or rust)");
  process.exit(2);
}
const ASSET_BYTES = 4096;
const SCENARIO_PATH = scenario === "asset" ? "/app.js" : scenario === "cached" ? "/hello" : "/";
const caddyBin = opt("caddy", "caddy")!;
/** The Bun edge entry point, relative to the repo root (a bundled copy works on a box without the checkout). */
const bunMain = opt("bun-main", "services/edge/src/main.ts") ?? "services/edge/src/main.ts";
const rustBin = resolve(opt("rust-bin", join(ROOT, "services/edge-rs/target/release/sproutboat-edge"))!);
const loadgenBin = join(HERE, "loadgen/target/release/loadgen");
const upstreamBin = join(HERE, "loadgen/target/release/fake-upstream");
const isCaddy = edge.startsWith("caddy-");
const inner = isCaddy ? edge.slice(6) : edge; // bun | rust | direct
const isLinux = platform() === "linux";
const CAPS = { edge: "512M", upstream: "256M", loadgen: "512M", caddy: "512M" } as const;

// ---- memory cap wrapper (Linux only) ----
let capPrefix: ((cap: string) => string[]) | null = null;
if (isLinux && !dry) {
  const t = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  if (t(["systemd-run", "--user", "--scope", "-p", "MemoryMax=64M", "--", "true"]))
    capPrefix = (c) => ["systemd-run", "--user", "--scope", "-q", "-p", `MemoryMax=${c}`, "--"];
  else if (t(["sudo", "-n", "systemd-run", "--scope", "-p", "MemoryMax=64M", "--", "true"])) {
    capPrefix = (c) => ["sudo", "-n", "systemd-run", "--scope", "-q", "-p", `MemoryMax=${c}`, "--"];
    console.error("warn: using sudo systemd-run; spawned PIDs may be sudo's, CPU numbers may be wrong");
  } else console.error("warn: no systemd-run available; running WITHOUT memory caps");
} else if (isLinux && dry) {
  capPrefix = (c) => ["systemd-run", "--user", "--scope", "-q", "-p", `MemoryMax=${c}`, "--"];
}
const capped = (cap: string, cmd: string[]) => (capPrefix ? [...capPrefix(cap), ...cmd] : cmd);

// ---- process tracking: only PIDs we started ----
type PipedProc = Bun.Subprocess<"ignore", "pipe", "pipe">;
type P = { name: string; proc: PipedProc };
const started: P[] = [];
let cleaning = false;
async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  for (const p of started)
    try {
      p.proc.kill("SIGTERM");
    } catch {}
  const deadline = Date.now() + 3000;
  for (const p of started) {
    await Promise.race([p.proc.exited, Bun.sleep(Math.max(0, deadline - Date.now()))]);
    if (p.proc.exitCode === null)
      try {
        p.proc.kill("SIGKILL");
      } catch {}
  }
}
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => cleanup().then(() => process.exit(130)));

const q = (a: string[]) => a.map((x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : JSON.stringify(x))).join(" ");

/** Read a stream to the end and discard it so the pipe never fills. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {}
}

async function spawnProc(name: string, cmd: string[], env: Record<string, string> = {}, cwd = ROOT) {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  started.push({ name, proc });
  return proc;
}

/** Read stdout until `re` matches (deadline-bound), then keep draining so the pipe never fills. */
async function waitLine(name: string, proc: PipedProc, re: RegExp, ms = 15000): Promise<RegExpMatchArray> {
  const reader = proc.stdout.getReader();
  void drain(proc.stderr);
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + ms;
  while (true) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`${name}: timed out waiting for ${re}; output so far: ${buf}`);
    const r = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)]);
    if (r === null) continue;
    if (r.done) throw new Error(`${name} exited before ready; output: ${buf}`);
    buf += dec.decode(r.value);
    const m = buf.match(re);
    if (m) {
      void (async () => {
        while (!(await reader.read()).done) {}
      })();
      return m;
    }
  }
}

async function waitTcp(port: number, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const s = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
          open(s) {
            s.end();
          },
        },
      });
      s.end();
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`port ${port} not accepting connections after ${ms}ms`);
}

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = s.port!;
  s.stop(true);
  return p;
}

// ---- coarse CPU via `ps -o time=` (macOS fallback) ----
function psCpuUs(pid: number): number | null {
  const r = Bun.spawnSync(["ps", "-o", "time=", "-p", String(pid)]);
  const t = r.stdout.toString().trim();
  if (!t) return null;
  const [dayPart, rest] = t.includes("-") ? t.split("-") : ["0", t];
  const parts = rest.split(":").map(Number);
  let s = 0;
  for (const x of parts) s = s * 60 + x;
  return (Number(dayPart) * 86400 + s) * 1e6;
}

type CpuUsPerReq = {
  edge: number | null;
  caddy: number | null;
  upstream: number | null;
  loadgen: number | null;
};
type RssMib = { edge: number | null; caddy: number | null };
type BenchRow = {
  scenario: string;
  edge: string;
  conns: number;
  rps: number;
  p50_us: number;
  p90_us: number;
  p99_us: number;
  p999_us: number;
  max_us: number;
  errors: number;
  non2xx: number;
  requests: number;
  cpu_us_per_req: CpuUsPerReq;
  rss_mib: RssMib;
  rss_peak_mib: RssMib;
  cpu_source: string;
  duration: number;
  warmup: number;
  host: string;
  ts: string;
};
const rows: BenchRow[] = [];

/** Resident set (VmRSS) and its peak (VmHWM) of a process, in MiB (Linux). */
function rssMib(pid: number): { now: number; peak: number } | null {
  if (!pid || !isLinux) return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(status)?.[1] ?? Number.NaN);
    const now = kb("VmRSS");
    const peak = kb("VmHWM");
    return Number.isNaN(now) || Number.isNaN(peak) ? null : { now: now / 1024, peak: peak / 1024 };
  } catch {
    return null;
  }
}

/** Loadgen's `--json` summary line; `cpu` is null when /proc accounting is unavailable. */
type LoadgenSummary = {
  rps: number;
  p50_us: number;
  p90_us: number;
  p99_us: number;
  p999_us: number;
  max_us: number;
  errors: number;
  non2xx: number;
  requests: number;
  cpu: { per_pid_us_per_req: Record<string, number> } | null;
};

/** Unvalidated shape of the JSON line; every field may be missing or wrongly typed until checked. */
type RawLoadgenSummary = {
  [K in keyof LoadgenSummary]?: LoadgenSummary[K];
};

function finite(n: number | undefined, key: string): number {
  if (n === undefined || !Number.isFinite(n)) throw new Error(`loadgen summary: field "${key}" is not a finite number`);
  return n;
}

function parseCpu(cpu: RawLoadgenSummary["cpu"]): LoadgenSummary["cpu"] {
  if (!cpu) return null;
  const perPid = cpu.per_pid_us_per_req;
  if (!perPid) throw new Error("loadgen summary: cpu.per_pid_us_per_req is missing");
  const out: Record<string, number> = {};
  for (const [pid, us] of Object.entries(perPid)) out[pid] = finite(us, `cpu.per_pid_us_per_req.${pid}`);
  return { per_pid_us_per_req: out };
}

/** Validate loadgen's JSON summary line at the process boundary. */
function parseLoadgenSummary(line: string): LoadgenSummary {
  const raw: RawLoadgenSummary | null = JSON.parse(line);
  if (!raw) throw new Error("loadgen summary is not a JSON object");
  return {
    rps: finite(raw.rps, "rps"),
    p50_us: finite(raw.p50_us, "p50_us"),
    p90_us: finite(raw.p90_us, "p90_us"),
    p99_us: finite(raw.p99_us, "p99_us"),
    p999_us: finite(raw.p999_us, "p999_us"),
    max_us: finite(raw.max_us, "max_us"),
    errors: finite(raw.errors, "errors"),
    non2xx: finite(raw.non2xx, "non2xx"),
    requests: finite(raw.requests, "requests"),
    cpu: parseCpu(raw.cpu),
  };
}

const outFile = resolve(
  opt("out", join(HERE, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}-${edge}.jsonl`))!,
);

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "edge-bench-"));
  const routesPath = join(tmp, "routes.json");
  let upPort = 0,
    edgePort = 0,
    caddyPort = 0;
  let upPid = 0,
    edgePid = 0,
    caddyPid = 0;

  const upCmd = capped(CAPS.upstream, [upstreamBin, "--sproutd-like"]);
  /** The route under test: a sproutd backend (hello), or a supervisor route (asset, cached). */
  const routeFor = (upstreamPort: number) => {
    if (scenario === "hello")
      return {
        hostname: HOST,
        sproutPath: "/tmp/x/worker",
        backend: { kind: "sproutd", url: `http://127.0.0.1:${upstreamPort}` },
      };
    const dir = join(tmp, "artifact");
    mkdirSync(join(dir, "assets"), { recursive: true });
    const sproutPath = join(dir, "sprout");
    // The asset scenario never starts the sprout; the cached one fills the edge cache once.
    const script =
      scenario === "cached"
        ? `#!/bin/sh\nexec ${upstreamBin} --sproutd-like --cache-control --port "$PORT"\n`
        : "#!/bin/sh\nexit 1\n";
    writeFileSync(sproutPath, script);
    chmodSync(sproutPath, 0o755);
    if (scenario === "asset") {
      writeFileSync(join(dir, "assets", "app.js"), "a".repeat(ASSET_BYTES));
      writeFileSync(
        join(dir, "assets.json"),
        JSON.stringify({ notFound: "none", runSproutFirst: false, files: walkAssets(join(dir, "assets")) }),
      );
    }
    return { hostname: HOST, sproutPath };
  };
  const edgeCmd = inner === "bun" ? ["bun", bunMain] : [rustBin];
  const edgeCapped = capped(CAPS.edge, edgeCmd);
  const edgeEnv = () => ({
    PORT: "0",
    SPROUTBOAT_BIND_HOST: "127.0.0.1",
    SPROUTBOAT_ROUTE_SNAPSHOT: routesPath,
    SPROUTBOAT_SPROUT_SANDBOX: "none",
    SPROUTBOAT_UNSAFE_NO_SANDBOX: "1",
  });
  const caddyfile = (port: number, target: number) => `{
\tadmin off
\tauto_https disable_redirects
\tlocal_certs
\tskip_install_trust
}
https://${HOST}:${port} {
\ttls internal
\tbind 127.0.0.1
\treverse_proxy 127.0.0.1:${target}
}
`;
  const caddyCmd = (cf: string) => capped(CAPS.caddy, [caddyBin, "run", "--config", cf, "--adapter", "caddyfile"]);
  const lgBase = (url: string, c: number, extra: string[]) =>
    capped(CAPS.loadgen, [
      loadgenBin,
      "--url",
      url,
      "--host-header",
      HOST,
      "--conns",
      String(c),
      "--duration",
      String(duration),
      "--warmup",
      String(warmup),
      "--json",
      ...extra,
    ]);

  if (dry) {
    console.log(
      `# dry run: edge=${edge} conns=${conns.join(",")} duration=${duration}s warmup=${warmup}s (tmp dir ${tmp})`,
    );
    console.log(`cd ${ROOT}`);
    console.log(
      `# routes.json: ${JSON.stringify([{ hostname: HOST, sproutPath: "/tmp/x/worker", backend: { kind: "sproutd", url: "http://127.0.0.1:<UPPORT>" } }])}`,
    );
    console.log(q(upCmd) + "   # prints 'fake-upstream listening on http://127.0.0.1:PORT'");
    if (inner !== "direct")
      console.log(
        `PORT=0 SPROUTBOAT_BIND_HOST=127.0.0.1 SPROUTBOAT_ROUTE_SNAPSHOT=${routesPath} ${q(edgeCapped)}   # prints 'Sproutboat edge router listening on http://host:port'`,
      );
    if (isCaddy) {
      console.log(`# Caddyfile:\n${caddyfile(0, 0).replace(/^/gm, "#   ")}`);
      console.log(q(caddyCmd(join(tmp, "Caddyfile"))) + "   # env XDG_DATA_HOME/XDG_CONFIG_HOME under tmp");
    }
    const url = isCaddy
      ? `https://127.0.0.1:<CADDYPORT>${SCENARIO_PATH}`
      : `http://127.0.0.1:<TARGETPORT>${SCENARIO_PATH}`;
    const tlsFlag = isCaddy ? ["--tls-insecure"] : [];
    for (const c of conns) console.log(q(lgBase(url, c, [...tlsFlag, "--pid", "<edge>,<upstream>,<caddy>,self"])));
    if (isCaddy && !flag("no-newconn"))
      console.log(
        q(lgBase(url, 32, [...tlsFlag, "--no-keepalive", "--pid", "<...>,self"])) + "   # row <edge>-newconn",
      );
    return;
  }

  for (const b of [loadgenBin, upstreamBin])
    if (!existsSync(b))
      throw new Error(`missing ${b}; run: cargo build --release --manifest-path ${HERE}/loadgen/Cargo.toml`);
  if (inner === "rust" && !existsSync(rustBin)) throw new Error(`missing Rust edge binary ${rustBin} (use --rust-bin)`);
  if (isCaddy) {
    const w = Bun.spawnSync(["sh", "-c", `command -v ${JSON.stringify(caddyBin)}`]);
    if (w.exitCode !== 0) throw new Error(`caddy not found (${caddyBin}); see README for how to fetch it`);
  }

  // Only the hello scenario has a separate upstream (asset: none; cached: the sprout is the upstream).
  if (scenario === "hello") {
    const up = await spawnProc("upstream", upCmd);
    upPid = up.pid;
    upPort = Number((await waitLine("upstream", up, /listening on http:\/\/[^:\s]+:(\d+)/))[1]);
  }

  let targetPort = upPort; // what the loadgen (or Caddy) talks to
  if (inner !== "direct") {
    writeFileSync(routesPath, JSON.stringify([routeFor(upPort)]));
    const e = await spawnProc("edge", edgeCapped, edgeEnv());
    edgePid = e.pid;
    edgePort = Number((await waitLine("edge", e, /edge router listening on http:\/\/[^:\s]+:(\d+)/))[1]);
    targetPort = edgePort;
  }
  let url = `http://127.0.0.1:${targetPort}${SCENARIO_PATH}`;
  if (isCaddy) {
    caddyPort = freePort();
    const cf = join(tmp, "Caddyfile");
    writeFileSync(cf, caddyfile(caddyPort, targetPort));
    mkdirSync(join(tmp, "xdg-data"), { recursive: true });
    mkdirSync(join(tmp, "xdg-config"), { recursive: true });
    const c = await spawnProc("caddy", caddyCmd(cf), {
      XDG_DATA_HOME: join(tmp, "xdg-data"),
      XDG_CONFIG_HOME: join(tmp, "xdg-config"),
      HOME: tmp,
    });
    caddyPid = c.pid;
    void drain(c.stdout);
    void drain(c.stderr);
    await waitTcp(caddyPort);
    url = `https://127.0.0.1:${caddyPort}${SCENARIO_PATH}`;
  }

  // sanity: one request through the whole chain
  {
    const probe = await fetch(`http://127.0.0.1:${targetPort}${SCENARIO_PATH}`, { headers: { host: HOST } }).catch(
      () => null,
    );
    if (!probe || !probe.ok) throw new Error(`sanity probe against ${targetPort} failed: ${probe?.status}`);
  }

  const runs: { label: string; c: number; extra: string[] }[] = conns.map((c) => ({ label: edge, c, extra: [] }));
  if (isCaddy && !flag("no-newconn")) runs.push({ label: `${edge}-newconn`, c: 32, extra: ["--no-keepalive"] });

  mkdirSync(join(HERE, "results"), { recursive: true });
  console.log(
    `| scenario | edge | C | req/s | p50 ms | p99 ms | edge CPU us/req | caddy CPU us/req | upstream CPU us/req | loadgen CPU us/req | edge RSS MiB | caddy RSS MiB | errors | non-2xx | cpu source |`,
  );
  console.log(`|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|`);

  for (const r of runs) {
    const tlsFlag = isCaddy ? ["--tls-insecure"] : [];
    const pidArg = [edgePid, upPid, caddyPid].filter(Boolean).join(",") + ",self";
    const cmd = lgBase(url, r.c, [...tlsFlag, ...r.extra, ...(isLinux ? ["--pid", pidArg] : [])]);
    const watched: [keyof CpuUsPerReq, number][] = [
      ["edge", edgePid],
      ["caddy", caddyPid],
      ["upstream", upPid],
    ];
    const psBefore = isLinux ? null : watched.map(([, p]) => (p ? psCpuUs(p) : null));
    const lg = await spawnProc("loadgen", cmd);
    const text = await new Response(lg.stdout).text();
    const err = await new Response(lg.stderr).text();
    await lg.exited;
    if (lg.exitCode !== 0) throw new Error(`loadgen failed: ${err || text}`);
    const j = parseLoadgenSummary(text.trim().split("\n").pop() ?? "");
    const cpu: CpuUsPerReq = { edge: null, caddy: null, upstream: null, loadgen: null };
    let source = "none";
    if (isLinux && j.cpu) {
      source = "/proc utime+stime (measured window)";
      const m = j.cpu.per_pid_us_per_req;
      if (edgePid) cpu.edge = m[edgePid] ?? null;
      if (caddyPid) cpu.caddy = m[caddyPid] ?? null;
      cpu.upstream = m[upPid] ?? null;
      cpu.loadgen = m[lg.pid] ?? null;
    } else if (psBefore) {
      source = "ps time (coarse 10ms; whole run incl. warmup; requests estimated)";
      const reqs = j.rps * (duration + warmup);
      watched.forEach(([n, p], i) => {
        const a = p ? psCpuUs(p) : null,
          b = psBefore[i];
        if (a != null && b != null && reqs > 0) cpu[n] = (a - b) / reqs;
      });
    }
    const edgeRss = rssMib(edgePid);
    const caddyRss = rssMib(caddyPid);
    const row: BenchRow = {
      scenario,
      edge: r.label,
      conns: r.c,
      rps: j.rps,
      p50_us: j.p50_us,
      p90_us: j.p90_us,
      p99_us: j.p99_us,
      p999_us: j.p999_us,
      max_us: j.max_us,
      errors: j.errors,
      non2xx: j.non2xx,
      requests: j.requests,
      cpu_us_per_req: cpu,
      rss_mib: { edge: edgeRss?.now ?? null, caddy: caddyRss?.now ?? null },
      rss_peak_mib: { edge: edgeRss?.peak ?? null, caddy: caddyRss?.peak ?? null },
      cpu_source: source,
      duration,
      warmup,
      host: platform(),
      ts: new Date().toISOString(),
    };
    rows.push(row);
    appendFileSync(outFile, JSON.stringify(row) + "\n");
    const f = (x: number | null) => (x == null ? "n/a" : x.toFixed(1));
    console.log(
      `| ${scenario} | ${r.label} | ${r.c} | ${j.rps.toFixed(0)} | ${(j.p50_us / 1000).toFixed(3)} | ${(j.p99_us / 1000).toFixed(3)} | ${f(cpu.edge)} | ${f(cpu.caddy)} | ${f(cpu.upstream)} | ${f(cpu.loadgen)} | ${f(row.rss_mib.edge)} | ${f(row.rss_mib.caddy)} | ${j.errors} | ${j.non2xx} | ${source} |`,
    );
  }
  console.error(`results appended to ${outFile}`);
}

main().then(
  () => cleanup().then(() => process.exit(0)),
  (e) => {
    console.error(String(e?.stack || e));
    cleanup().then(() => process.exit(1));
  },
);
