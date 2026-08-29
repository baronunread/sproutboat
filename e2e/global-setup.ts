import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default async function globalSetup(): Promise<void> {
  const control = process.env.E2E_CONTROL_URL || "https://control.sproutboat.localhost";
  const healthy = await fetch(`${control}/internal/health`, {
    tls: { rejectUnauthorized: false },
  }).then((response) => response.ok).catch(() => false);

  if (!healthy) {
    throw new Error(
      `Sproutboat stack not reachable at ${control}.\n` +
      `Start it first:  bun run dev:local`,
    );
  }

  execSync("bun run seed --reset --e2e", { cwd: root, stdio: "inherit" });
}
