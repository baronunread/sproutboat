import { constants } from "node:fs";
import { access, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";

type Status = "pass" | "fail" | "warn";
type Check = { name: string; status: Status; detail: string; fix?: string };

const checks: Check[] = [];

function add(name: string, status: Status, detail: string, fix?: string): void {
  const check: Check = { name, status, detail };
  if (fix) check.fix = fix;
  checks.push(check);
}

async function readable(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandOutput(command: string, args: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: `${stdout}${stderr}`.trim() };
}

async function namespaceCheck(name: string, label = name): Promise<void> {
  const namespacePath = `/proc/self/ns/${name}`;
  const limitPath = `/proc/sys/user/max_${name}_namespaces`;
  try {
    await readlink(namespacePath);
  } catch {
    add(`${label} namespace`, "fail", `${namespacePath} is unavailable`, "Use a Linux kernel with namespace support enabled.");
    return;
  }

  const limit = (await readable(limitPath))?.trim();
  if (limit === "0") add(`${label} namespace`, "fail", `${limitPath}=0`, `Raise ${limitPath} above zero.`);
  else if (limit === null) add(`${label} namespace`, "warn", `${limitPath} is unavailable; namespace exists but its host limit could not be verified.`);
  else add(`${label} namespace`, "pass", `${limitPath}=${limit}`);
}

if (process.platform !== "linux") {
  add("operating system", "fail", `detected ${process.platform}`, "Run this probe on the target Linux VPS.");
} else {
  add("operating system", "pass", "Linux detected");
}

if (process.arch !== "x64") {
  add("architecture", "fail", `detected ${process.arch}`, "Use an x86-64 VPS; artifact-v1 targets linux-x86_64.");
} else {
  add("architecture", "pass", "x86-64 detected");
}

const controllers = await readable("/sys/fs/cgroup/cgroup.controllers");
if (controllers === null) {
  add("cgroups v2", "fail", "/sys/fs/cgroup/cgroup.controllers is unavailable", "Boot with a unified cgroup v2 hierarchy.");
} else {
  const missing = ["cpu", "memory", "pids"].filter((controller) => !controllers.split(/\s+/).includes(controller));
  if (missing.length) add("cgroups v2", "fail", `missing controllers: ${missing.join(", ")}`, "Enable cpu, memory, and pids controllers in cgroup v2.");
  else add("cgroups v2", "pass", `controllers: ${controllers.trim()}`);
}

if (controllers !== null) {
  const canWrite = await writable("/sys/fs/cgroup");
  add("cgroup delegation", canWrite ? "pass" : "warn", canWrite ? "current process can create cgroups" : "current process cannot create cgroups", "The future supervisor systemd unit must use Delegate=yes and have a writable delegated cgroup.");
}

// The worker keeps the caller's netns (it must serve loopback for the edge to
// proxy to it); egress is denied by the edge unit's IPAddressDeny=any instead.
for (const [name, label] of [["user", "user"], ["pid", "PID"], ["mnt", "mount"]]) await namespaceCheck(name, label);

// Old Debian/Ubuntu knob; removed in 6.6+ kernels (Ubuntu 24.04), where AppArmor
// gates unprivileged userns instead. The functional bwrap check above is the
// authoritative signal — this is only advisory.
const usernsClone = (await readable("/proc/sys/kernel/unprivileged_userns_clone"))?.trim();
const apparmorUserns = (await readable("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"))?.trim();
if (usernsClone === "0") add("unprivileged user namespaces", "fail", "kernel.unprivileged_userns_clone=0", "Set it to 1, or rely on a kernel that has dropped this knob.");
else if (usernsClone === "1") add("unprivileged user namespaces", "pass", "kernel.unprivileged_userns_clone=1");
else if (apparmorUserns === "1") add("unprivileged user namespaces", "warn", "kernel.apparmor_restrict_unprivileged_userns=1; unconfined processes may be blocked from userns", "Ship an AppArmor profile for the edge, or set the sysctl to 0.");
else add("unprivileged user namespaces", "warn", "no unprivileged-userns sysctl present (normal on 6.6+); trusting the live bwrap check above.");

const bwrap = Bun.which("bwrap");
if (!bwrap) {
  add("bubblewrap", "fail", "bwrap is not on PATH", "Install the bubblewrap package.");
} else {
  const version = await commandOutput(bwrap, ["--version"]);
  const help = await commandOutput(bwrap, ["--help"]);
  if (version.code !== 0 || help.code !== 0) add("bubblewrap", "fail", `bwrap could not run: ${version.output || help.output}`, "Install a working bubblewrap package.");
  else if (!help.output.includes("--seccomp")) add("bubblewrap", "fail", "bwrap does not advertise --seccomp", "Install a bubblewrap build with seccomp support.");
  else {
    // Functional check: the exact isolation worker-sandbox.sh relies on.
    const sandboxRun = await commandOutput(bwrap, [
      "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts",
      "--clearenv", "--uid", "65534", "--gid", "65534",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", "/usr", "/usr",
      "--ro-bind-try", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64", "--chdir", "/",
      "--", "/usr/bin/env", "true",
    ]);
    if (sandboxRun.code === 0) add("bubblewrap", "pass", `${version.output}; unprivileged user+net namespace sandbox works`);
    else add("bubblewrap", "fail", `bwrap cannot create the sandbox: ${sandboxRun.output || `exit ${sandboxRun.code}`}`, "Permit unprivileged user namespaces (kernel.unprivileged_userns_clone=1) and ensure /usr, /lib are readable.");
  }
}

const systemdRun = Bun.which("systemd-run");
add("systemd-run", "warn",
  systemdRun
    ? "present; the POC still uses aggregate edge-cgroup limits (SPROUTBOAT_WORKER_CGROUP=off) rather than per-worker scopes"
    : "absent; the POC caps the whole edge cgroup instead of per-worker scopes",
  "For per-worker CPU/memory/pids limits: loginctl enable-linger sproutboat-edge, Delegate=yes on its user slice, then SPROUTBOAT_WORKER_CGROUP=auto.");

const sandboxScript = resolve(import.meta.dir, "../infra/sandbox/worker-sandbox.sh");
try {
  await access(sandboxScript, constants.X_OK);
  add("worker-sandbox launcher", "pass", sandboxScript);
} catch {
  add("worker-sandbox launcher", "fail", `${sandboxScript} is missing or not executable`, "chmod +x infra/sandbox/worker-sandbox.sh");
}

const seccompActions = await readable("/proc/sys/kernel/seccomp/actions_avail");
const seccompStatus = await readable("/proc/self/status");
if (seccompActions === null || !/^Seccomp:\s*\d+/m.test(seccompStatus || "")) {
  add("seccomp", "fail", "kernel seccomp interfaces are unavailable", "Use a kernel built with CONFIG_SECCOMP and CONFIG_SECCOMP_FILTER.");
} else {
  add("seccomp", "pass", `actions: ${seccompActions.trim()}`);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ok: !checks.some((check) => check.status === "fail"), checks }, null, 2));
} else {
  for (const check of checks) {
    console.log(`${check.status.toUpperCase()} ${check.name}: ${check.detail}`);
    if (check.fix) console.log(`  fix: ${check.fix}`);
  }
}

if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
