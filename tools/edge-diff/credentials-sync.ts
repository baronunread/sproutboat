/**
 * Harness-only: keeps the supervisor's scoped binding credentials (services/supervisor/src/
 * run.ts) equal to the contents of `$EDGE_DIFF_CREDENTIALS_FILE`, so both edges
 * get the same known per-app credentials and a case can revoke one mid-run (an exited broker).
 *
 * The file is `{"version": n, "credentials": {"<credential>": ["host", ...]}}`. Each applied
 * version is acknowledged in `<file>.<role>.ack` (one per process that applies it: the Bun edge,
 * or the Rust edge's sidecar), which `Ctx.setCredentials` waits for.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { registerBindingCredential } from "../../services/supervisor/src/run";

export function syncCredentials(role: string): void {
  const file = process.env.EDGE_DIFF_CREDENTIALS_FILE;
  if (!file) return;
  const live = new Map<string, () => void>();
  let applied = -1;
  const apply = (): void => {
    let wanted: { version: number; credentials: Record<string, string[]> };
    try {
      wanted = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return; // not written yet, or caught mid-write
    }
    if (wanted.version === applied) return;
    for (const [credential, revoke] of live) {
      if (!(credential in wanted.credentials)) {
        revoke();
        live.delete(credential);
      }
    }
    for (const [credential, hosts] of Object.entries(wanted.credentials)) {
      live.get(credential)?.();
      live.set(credential, registerBindingCredential(credential, hosts));
    }
    applied = wanted.version;
    writeFileSync(`${file}.${role}.ack`, String(applied));
  };
  apply();
  setInterval(apply, 10).unref();
}
