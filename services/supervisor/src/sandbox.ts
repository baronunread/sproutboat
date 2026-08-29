import { resolve } from "node:path";

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
    return [launcher, workerPath];
  }
  if (mode === "none") {
    if (process.platform === "linux" && process.env.SPROUTBOAT_UNSAFE_NO_SANDBOX !== "1") {
      throw new Error("refusing to run an untrusted native worker unsandboxed on Linux; set SPROUTBOAT_WORKER_SANDBOX=bwrap (or SPROUTBOAT_UNSAFE_NO_SANDBOX=1 for a trusted local test)");
    }
    return [workerPath];
  }
  throw new Error(`unknown SPROUTBOAT_WORKER_SANDBOX value: ${mode}`);
}
