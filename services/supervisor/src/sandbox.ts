import { resolve } from "node:path";

/**
 * #25 — per-worker cgroup v2 caps. Opt-in (`SPROUTBOAT_WORKER_CGROUP=1`, Linux
 * only): each worker runs in its own transient `systemd-run --scope` with
 * memory / CPU / pids limits, so one tenant's runaway handler cannot starve the
 * others. The aggregate caps on `sproutboat-edge.service` stay as a backstop.
 *
 * Needs `systemd-run` reachable for the edge unit's user — verify on the host
 * (`Delegate=yes` on the slice, or run the supervisor with the right scope
 * privileges). Off by default until that is confirmed.
 */
function cgroupWrapper(): string[] {
  if (process.env.SPROUTBOAT_WORKER_CGROUP !== "1" || process.platform !== "linux") return [];
  const mem = process.env.SPROUTBOAT_WORKER_MEMORY_MAX || "128M";
  const cpu = process.env.SPROUTBOAT_WORKER_CPU_QUOTA || "50%";
  const pids = process.env.SPROUTBOAT_WORKER_TASKS_MAX || "64";
  return [
    "systemd-run", "--scope", "--quiet", "--collect",
    "-p", `MemoryMax=${mem}`, "-p", `CPUQuota=${cpu}`, "-p", `TasksMax=${pids}`,
    "--",
  ];
}

/**
 * Argv that starts one native-fetch worker. On Linux the worker is untrusted
 * native code and must run inside the bubblewrap sandbox launcher
 * (infra/sandbox/worker-sandbox.sh). Running it unsandboxed is only allowed off
 * Linux (local dev) or with an explicit unsafe opt-out.
 *
 * The worker now binds a loopback port, so the sandbox must keep a usable
 * loopback interface — see infra/sandbox/worker-sandbox.sh.
 */
export function workerCommand(workerPath: string): string[] {
  const mode = process.env.SPROUTBOAT_WORKER_SANDBOX ?? (process.platform === "linux" ? "bwrap" : "none");
  if (mode === "bwrap") {
    const launcher = process.env.SPROUTBOAT_WORKER_SANDBOX_CMD || resolve(import.meta.dir, "../../../infra/sandbox/worker-sandbox.sh");
    return [...cgroupWrapper(), launcher, workerPath];
  }
  if (mode === "none") {
    if (process.platform === "linux" && process.env.SPROUTBOAT_UNSAFE_NO_SANDBOX !== "1") {
      throw new Error("refusing to run an untrusted native worker unsandboxed on Linux; set SPROUTBOAT_WORKER_SANDBOX=bwrap (or SPROUTBOAT_UNSAFE_NO_SANDBOX=1 for a trusted local test)");
    }
    return [...cgroupWrapper(), workerPath];
  }
  throw new Error(`unknown SPROUTBOAT_WORKER_SANDBOX value: ${mode}`);
}
