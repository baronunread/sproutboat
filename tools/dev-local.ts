import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const state = resolve(process.env.PORFFER_LOCAL_STATE || ".local/porffor");
const localDomain = "porffer.localhost";
const processes: Bun.Subprocess[] = [];

function requireCommand(command: string) {
  if (!Bun.which(command)) throw new Error(`${command} is required. Install it, then run bun run dev:local again.`);
}

function environment(extra: Record<string, string> = {}) {
  return {
    ...Bun.env,
    BETTER_AUTH_SECRET: "porffer-local-development-secret-at-least-32-characters",
    BETTER_AUTH_URL: `https://dashboard.${localDomain}`,
    GITHUB_CLIENT_ID: "porffer-local",
    GITHUB_CLIENT_SECRET: "porffer-local-secret",
    GITHUB_EMULATOR_URL: "http://localhost:4000",
    PORFFER_ARTIFACTS_DIR: `${state}/artifacts`,
    PORFFER_DATABASE_PATH: `${state}/porffer.sqlite`,
    PORFFER_DEPLOYMENT_DOMAIN: localDomain,
    PORFFER_DEPLOYMENTS_PATH: `${state}/deployments.json`,
    PORFFER_DASHBOARD_URL: "https://dashboard.porffer.localhost",
    PORFFER_LOG_PATH: `${state}/edge.log`,
    PORFFER_ROUTE_SNAPSHOT: `${state}/routes.json`,
    PORFFER_RUNTIME_IMAGE: "porffer/build:dev",
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

  const image = Bun.spawn(["docker", "image", "inspect", "porffer/build:dev"], { cwd: root, stdout: "ignore", stderr: "ignore" });
  if (await image.exited !== 0) await checked("building the local Porffer image", ["docker", "build", "--platform", "linux/amd64", "-t", "porffer/build:dev", "-f", "build-image/Dockerfile", "."]);

  await checked("starting Portless HTTPS and wildcard routing", ["portless", "proxy", "start", "--wildcard"]);
  await checked("migrating local Control state", ["bunx", "--bun", "auth@1.7.1", "migrate", "--config", "apps/control/src/auth.migrate.ts", "--yes"]);
  if (await fetch("http://127.0.0.1:4000").then(() => true).catch(() => false)) console.log("→ reusing GitHub emulator at http://localhost:4000");
  else start("GitHub emulator", ["npx", "emulate", "--service", "github", "--seed", "tests/emulate.github.yaml"]);
  start("Control at https://control.porffer.localhost", ["portless", "--force", "control.porffer", "bun", "run", "control"]);
  start("Edge wildcard at https://*.porffer.localhost", ["portless", "--force", "porffer", "bun", "run", "edge"]);
  start("dashboard at https://dashboard.porffer.localhost", ["portless", "--force", "dashboard.porffer", "bun", "run", "web"]);
  console.log("\nReady:\n  Dashboard  https://dashboard.porffer.localhost/dashboard\n  Control    https://control.porffer.localhost/dashboard\n  Deployments https://<project>.<owner>.porffer.localhost\n\nUse: bun run porffer -- login --api-url https://control.porffer.localhost\n");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  for (const child of processes) child.kill(signal);
  process.exit();
});

await main();
await new Promise<void>(() => {});
