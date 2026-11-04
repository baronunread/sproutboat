/**
 * Benchmark: a small outbound GET through the Bun egress (`bun node_modules/@sproutboat/wire/src/egress.ts`,
 * as the platform runs it) versus the Rust one, both in front of a local fake upstream.
 *
 *   cargo build --release --manifest-path tools/egress-bench/loadgen/Cargo.toml
 *   (cd services/egress-rs && cargo build --release)
 *   bun tools/egress-bench/run.ts --impl ts|rust|direct [--conns 8,32] [--duration 10] [--warmup 3]
 *                                 [--rust-bin PATH] [--out results.jsonl] [--cap 512M] [--dry-run]
 *
 * One impl per invocation; run them one after another, never in parallel. On Linux every
 * process runs in `systemd-run --user --scope -p MemoryMax=<cap>`; the PID measured is the
 * command's own (a scope execs in place). CPU us/req is utime+stime of the egress process
 * over the measured window divided by completed requests (Linux: /proc, 10 ms ticks;
 * macOS: `ps`, 10 ms resolution, indicative). RSS is read right after the window.
 * Only PIDs started here are signalled (SIGTERM, then SIGKILL); no pkill, no pgrep.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const argv = process.argv.slice(2);
const opt = (name: string, d: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : d;
};
const impl = opt("impl", "rust");
const conns = opt("conns", "8,32").split(",").map(Number);
const duration = Number(opt("duration", "10"));
const warmup = Number(opt("warmup", "3"));
const cap = opt("cap", "512M");
const rustBin = opt("rust-bin", join(ROOT, "services/egress-rs/target/release/sproutboat-egress"));
const out = opt("out", "");
const dry = argv.includes("--dry-run");
const LOADGEN = join(import.meta.dir, "loadgen/target/release/loadgen");
const UPSTREAM = join(import.meta.dir, "loadgen/target/release/fake-upstream");
const TOKEN = "bench-token";
const linux = process.platform === "linux";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type EnvMap = { [key: string]: string };
type Row = {
  impl: string;
  conns: number;
  rps: number;
  p50_us: number;
  p99_us: number;
  egress_cpu_us_per_req: number | null;
  rss_mib: number;
  hwm_mib: number;
  errors: number;
  non2xx: number;
  os: string;
};

const children: Bun.Subprocess[] = [];
function cleanup() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      // gone
    }
  }
  setTimeout(() => {
    for (const c of children) {
      try {
        c.kill("SIGKILL");
      } catch {
        // gone
      }
    }
  }, 3000).unref();
}
process.on("exit", cleanup);
for (const s of ["SIGINT", "SIGTERM"] as const)
  process.on(s, () => {
    cleanup();
    process.exit(130);
  });

const scoped = (mem: string, cmd: string[]) =>
  linux ? ["systemd-run", "--user", "--scope", "-q", "-p", `MemoryMax=${mem}`, "--", ...cmd] : cmd;

async function spawnLine(cmd: string[], re: RegExp, env: EnvMap = {}) {
  if (dry) {
    console.log(cmd.join(" "));
    return { pid: 0, match: ["", "0"] };
  }
  const proc = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "inherit" });
  children.push(proc);
  const reader = proc.stdout.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`exited early: ${cmd.join(" ")}\n${text}`);
    text += new TextDecoder().decode(value);
    const m = re.exec(text);
    if (m) {
      void (async () => {
        while (!(await reader.read()).done);
      })();
      return { pid: proc.pid, match: m };
    }
  }
}

function cpuMicros(pid: number): number {
  if (linux) {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return (Number(f[11]) + Number(f[12])) * 10_000;
  }
  const r = Bun.spawnSync(["ps", "-o", "time=", "-p", String(pid)])
    .stdout.toString()
    .trim();
  const [m, rest] = r.split(":");
  return (Number(m) * 60 + Number(rest)) * 1e6;
}
function rssMiB(pid: number) {
  if (linux) {
    const s = readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(s)?.[1] ?? 0);
    return { rss: kb("VmRSS") / 1024, hwm: kb("VmHWM") / 1024 };
  }
  const kb = Number(
    Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)])
      .stdout.toString()
      .trim(),
  );
  return { rss: kb / 1024, hwm: kb / 1024 };
}

const up = await spawnLine(scoped("256M", [UPSTREAM, "--port", "0"]), /listening on http:\/\/127\.0\.0\.1:(\d+)/);
const upPort = up.match[1];

const noHeaders: string[] = [];
async function startTarget() {
  if (impl === "direct") return { pid: 0, url: `http://127.0.0.1:${upPort}/`, headers: noHeaders };
  const env = { SB_EGRESS_TOKEN: TOKEN, SB_EGRESS_ALLOW: "127.0.0.1" };
  const cmd =
    impl === "ts"
      ? scoped(cap, [
          "bun",
          join(ROOT, "node_modules/@sproutboat/wire/src/egress.ts"),
          "--host",
          "127.0.0.1",
          "--port",
          "18070",
        ])
      : scoped(cap, [rustBin, "--host", "127.0.0.1", "--port", "18070", "--tcp-port", "18071"]);
  const eg = await spawnLine(cmd, /listening on http:\/\/127\.0\.0\.1:(\d+)/, env);
  return {
    pid: eg.pid,
    url: `http://127.0.0.1:${eg.match[1]}/`,
    headers: ["--header", `x-sb-egress-url: http://127.0.0.1:${upPort}/`, "--header", `x-sb-egress-token: ${TOKEN}`],
  };
}

const target = await startTarget();
const rows: Row[] = [];
for (const c of conns) {
  const cmd = scoped("512M", [
    LOADGEN,
    "--url",
    target.url,
    "--conns",
    String(c),
    "--duration",
    String(duration),
    "--warmup",
    String(warmup),
    "--json",
    ...target.headers,
  ]);
  if (dry) {
    console.log(cmd.join(" "));
    continue;
  }
  const lg = Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
  children.push(lg);
  let cpu0 = 0;
  let cpu1 = 0;
  const t0 = Date.now();
  if (target.pid) {
    await sleep(warmup * 1000 - (Date.now() - t0));
    cpu0 = cpuMicros(target.pid);
    await sleep(duration * 1000 - (Date.now() - t0 - warmup * 1000));
    cpu1 = cpuMicros(target.pid);
  }
  const res = JSON.parse(await new Response(lg.stdout).text());
  await lg.exited;
  const mem = target.pid ? rssMiB(target.pid) : { rss: 0, hwm: 0 };
  const row = {
    impl,
    conns: c,
    rps: Math.round(res.rps),
    p50_us: res.p50_us,
    p99_us: res.p99_us,
    egress_cpu_us_per_req: target.pid ? Math.round(((cpu1 - cpu0) / res.requests) * 100) / 100 : null,
    rss_mib: Math.round(mem.rss * 10) / 10,
    hwm_mib: Math.round(mem.hwm * 10) / 10,
    errors: res.errors,
    non2xx: res.non2xx,
    os: process.platform,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  if (out) appendFileSync(out, `${JSON.stringify({ ...row, at: new Date().toISOString() })}\n`);
}
console.log(
  "\n| impl | C | req/s | p50 us | p99 us | egress CPU us/req | RSS MiB | peak RSS MiB | errors | non-2xx |\n|---|---|---|---|---|---|---|---|---|---|",
);
for (const r of rows)
  console.log(
    `| ${r.impl} | ${r.conns} | ${r.rps} | ${r.p50_us} | ${r.p99_us} | ${r.egress_cpu_us_per_req ?? "n/a"} | ${r.rss_mib} | ${r.hwm_mib} | ${r.errors} | ${r.non2xx} |`,
  );
cleanup();
await sleep(500);
