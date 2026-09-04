import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default async function globalSetup(): Promise<void> {
  const control = process.env.E2E_CONTROL_URL || "https://control.sproutboat.localhost";
  // Playwright runs this file under Node, not Bun, so fetch's `tls` option is
  // silently ignored and portless's self-signed cert fails the probe — which
  // reported the running stack as down. This is the Node equivalent of the
  // `ignoreHTTPSErrors: true` the browser context already gets, scoped to the
  // probe so it can't leak into anything the tests do.
  const strictTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const healthy = await fetch(`${control}/internal/health`)
    .then((response) => response.ok).catch(() => false)
    .finally(() => {
      if (strictTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = strictTls;
    });

  if (!healthy) {
    throw new Error(
      `Sproutboat stack not reachable at ${control}.\n` +
      `Start it first:  bun run dev:local`,
    );
  }

  execSync("bun run seed --reset --e2e", { cwd: root, stdio: "inherit" });
}
