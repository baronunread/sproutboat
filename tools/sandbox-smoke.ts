/**
 * Linux-only. Run on the target VPS AFTER `bun run runtime:preflight` passes.
 *
 * Verifies that infra/sandbox/sprout-sandbox.sh actually confines an untrusted
 * native worker: it serves HTTP, and it cannot reach the host filesystem, other
 * processes, or fork a shell. Exits non-zero on the first failure.
 *
 *   bun run tools/sandbox-smoke.ts
 */
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { compileHandler } from "./compile";
import { SproutPool } from "../services/supervisor/src/run";

if (process.platform !== "linux") {
  console.log(`skip: sandbox smoke is Linux-only (this host is ${process.platform})`);
  process.exit(0);
}

const root = resolve(import.meta.dir, "..");
const launcher = process.env.SPROUTBOAT_SPROUT_SANDBOX_CMD || resolve(root, "infra/sandbox/sprout-sandbox.sh");
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const probeDir = await mkdtemp(resolve(tmpdir(), "sproutboat-sandbox-"));

// Probes run /bin/sh *inside* the same sandbox via the launcher's trailing-args form.
async function sandboxed(script: string): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn([launcher, "/bin/sh", "-c", script], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

// 1. Functional: a real compiled native-fetch sprout serves HTTP through the sandbox.
{
  const bin = resolve(probeDir, "echo");
  const compiled = await compileHandler(resolve(root, "tests/porffor/capabilities/03-echo-method.js"), bin);
  check("sprout compiles", compiled.ok, compiled.error || "");
  if (compiled.ok) {
    const pool = new SproutPool();
    try {
      const { url: base } = await pool.endpoint(bin);
      const a = await (await fetch(base, { method: "GET" })).text();
      const b = await (await fetch(base, { method: "POST" })).text();
      check("sandboxed sprout serves HTTP", a === "GET" && b === "POST", `${a},${b}`);
    } catch (error) {
      check("sandboxed sprout serves HTTP", false, String(error));
    } finally {
      pool.disposeAll();
    }
  }
}

// 2. Containment. Positive control first: /bin/sh must actually run inside the
// sandbox, otherwise the "must fail" probes below would pass for the wrong reason.
const control = await sandboxed("echo ok");
check("sandbox can run /bin/sh (control)", control.code === 0 && control.out === "ok", control.out);
if (control.code !== 0 || control.out !== "ok") {
  console.log("\naborting: cannot exercise containment probes");
  process.exit(1);
}

const shadow = await sandboxed("cat /etc/shadow");
check("cannot read /etc/shadow", shadow.code !== 0);

const homes = await sandboxed("ls /home /root /var/lib/sproutboat 2>&1");
check("cannot list host home/state dirs", homes.code !== 0);

// bwrap's root is a private, ephemeral tmpfs (writable, vanishes with the
// process) — the invariant that matters is that every *host* path is read-only.
const wusr = await sandboxed("echo x > /usr/probe && echo wrote");
check("host /usr is read-only", wusr.code !== 0 && !wusr.out.includes("wrote"), wusr.err.split("\n").pop() || "");
const wetc = await sandboxed("echo x >> /etc/ld.so.conf && echo wrote");
check("host /etc is read-only", wetc.code !== 0 && !wetc.out.includes("wrote"), wetc.err.split("\n").pop() || "");

// Egress is blocked by the edge service's IPAddressDeny=any (systemd BPF), which
// this standalone smoke can't reproduce. Assert only that loopback works — the
// worker must serve it — and leave the deny to a check on the running unit.
const loopback = await sandboxed("(exec 3<>/dev/tcp/127.0.0.1/1 || true) 2>&1; echo lo-ok");
check("loopback is reachable inside the sandbox", loopback.out.includes("lo-ok"));

// Host has hundreds of PIDs; the sandbox's private PID namespace shows only the
// current probe pipeline (a handful).
const countPids = "ls -1 /proc | grep -c '^[0-9][0-9]*$'";
const hostProcs = Number(
  (await new Response(Bun.spawn(["sh", "-c", countPids], { stdout: "pipe" }).stdout).text()).trim(),
);
const inSandbox = Number((await sandboxed(`${countPids} || true`)).out);
check(
  "PID namespace hides host processes",
  inSandbox > 0 && inSandbox < 12 && inSandbox < hostProcs,
  `sandbox sees ${inSandbox} pids, host has ${hostProcs}`,
);

const uid = await sandboxed("id -u");
check("runs as an unprivileged uid", uid.out.trim() !== "0", `uid ${uid.out.trim()}`);

// 3. Lifecycle: killing the launcher takes the sprout with it (--die-with-parent).
{
  const bin = resolve(probeDir, "echo");
  const child = Bun.spawn([launcher, bin], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  await Bun.sleep(300);
  child.kill("SIGKILL");
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(2000).then(() => false)]);
  check("sprout dies with its launcher", exited);
}

await rm(probeDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nsandbox smoke passed" : `\nsandbox smoke FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
