import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const state = resolve(process.env.SPROUTBOAT_LOCAL_STATE || ".local/sproutboat");
const localDomain = "sproutboat.localhost";
const processes: Bun.Subprocess[] = [];

function requireCommand(command: string) {
  if (!Bun.which(command)) throw new Error(`${command} is required. Install it, then run bun run dev:local again.`);
}

function environment(extra: Record<string, string> = {}) {
  return {
    ...Bun.env,
    BETTER_AUTH_SECRET: "sproutboat-local-development-secret-at-least-32-characters",
    BETTER_AUTH_URL: `https://dashboard.${localDomain}`,
    GITHUB_CLIENT_ID: "sproutboat-local",
    GITHUB_CLIENT_SECRET: "sproutboat-local-secret",
    GITHUB_EMULATOR_URL: "http://localhost:4000",
    SPROUTBOAT_ARTIFACTS_DIR: `${state}/artifacts`,
    SPROUTBOAT_DATABASE_PATH: `${state}/sproutboat.sqlite`,
    SPROUTBOAT_DEPLOYMENT_DOMAIN: localDomain,
    SPROUTBOAT_DEPLOYMENTS_PATH: `${state}/deployments.json`,
    SPROUTBOAT_DASHBOARD_URL: "https://dashboard.sproutboat.localhost",
    SPROUTBOAT_LOG_PATH: `${state}/edge.log`,
    SPROUTBOAT_ROUTE_SNAPSHOT: `${state}/routes.json`,
    SPROUTBOAT_RUNTIME_IMAGE: "sproutboat/build:dev",
    ...extra,
  };
}

async function checked(label: string, command: string[], env = environment()) {
  console.log(`→ ${label}`);
  const child = Bun.spawn(command, { cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`${label} failed`);
}

function start(label: string, command: string[], env = environment()) {
  console.log(`→ ${label}`);
  const child = Bun.spawn(command, { cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  processes.push(child);
  void child.exited.then((code) => {
    if (code !== 0) console.error(`${label} exited with status ${code}`);
  });
}

async function main() {
  requireCommand("docker");
  requireCommand("portless");
  requireCommand("npx");
  await mkdir(state, { recursive: true });

  const image = Bun.spawn(["docker", "image", "inspect", "sproutboat/build:dev"], { cwd: root, stdout: "ignore", stderr: "ignore" });
  if (await image.exited !== 0) await checked("building the local Sproutboat image", ["docker", "build", "--platform", "linux/amd64", "-t", "sproutboat/build:dev", "-f", "build-image/Dockerfile", "."]);

  await checked("starting Portless HTTPS and wildcard routing", ["portless", "proxy", "start", "--wildcard"]);
  await checked("migrating local Control state", ["bunx", "--bun", "auth@1.7.1", "migrate", "--config", "apps/control/src/auth.migrate.ts", "--yes"]);
  if (await fetch("http://127.0.0.1:4000").then(() => true).catch(() => false)) console.log("→ reusing GitHub emulator at http://localhost:4000");
  else start("GitHub emulator", ["npx", "emulate", "--service", "github", "--seed", "tests/emulate.github.yaml"]);
  start("Control at https://control.sproutboat.localhost", ["portless", "--force", "control.sproutboat", "bun", "run", "control"]);
  start("Edge wildcard at https://*.sproutboat.localhost", ["portless", "--force", "sproutboat", "bun", "run", "edge"]);
  start("dashboard at https://dashboard.sproutboat.localhost", ["portless", "--force", "dashboard.sproutboat", "bun", "run", "web"]);
  console.log("\nReady:\n  Marketing  https://sproutboat.localhost\n  Dashboard  https://dashboard.sproutboat.localhost\n  Control    https://control.sproutboat.localhost\n  Deployments https://<project>.<owner>.sproutboat.localhost\n\nUse: bun run sproutboat -- login --api-url https://control.sproutboat.localhost\n");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  for (const child of processes) child.kill(signal);
  process.exit();
});

await main();
await new Promise<void>(() => {});
