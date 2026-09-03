import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const state = resolve(process.env.SPROUTBOAT_LOCAL_STATE || ".local/sproutboat");
const localDomain = "sproutboat.localhost";
const processes: Bun.Subprocess[] = [];

type PortlessRoute = { hostname: string; port: number; pid: number };

/**
 * Drop `pid <= 0` entries for the hostnames we are about to claim.
 *
 * We start every service with `portless --force`, and portless's route
 * registry (`~/.portless/routes.json`) then SIGTERMs whoever currently holds
 * the hostname. It decides "currently holds" with `process.kill(pid, 0)` — and
 * for pid 0 POSIX reads that as *the caller's entire process group*. So a
 * single `"pid": 0` row makes the liveness probe succeed and the eviction
 * signal land on this harness and every service it just started, a few hundred
 * ms after printing "Ready".
 *
 * Only rows we are about to overwrite anyway are touched, and only when the pid
 * is unusable. A real owner is left alone for `--force` to evict properly.
 */
function pruneUnownedRoutes(hostnames: readonly string[]): void {
  const path = resolve(homedir(), ".portless/routes.json");
  if (!existsSync(path)) return;
  let routes: PortlessRoute[];
  try { routes = JSON.parse(readFileSync(path, "utf8")); } catch { return; }
  if (!Array.isArray(routes)) return;
  const doomed = routes.filter((route) => hostnames.includes(route.hostname) && !(route.pid > 0));
  if (doomed.length === 0) return;
  console.log(`→ clearing ${doomed.length} unowned portless route(s): ${doomed.map((r) => r.hostname).join(", ")}`);
  writeFileSync(path, JSON.stringify(routes.filter((route) => !doomed.includes(route)), null, 2));
}

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
    // The __Secure- cookie prefix is rejected over the local dev cert, which
    // breaks the OAuth state cookie. Only the dev harness sets this.
    SPROUTBOAT_INSECURE_COOKIES: "1",
    SPROUTBOAT_ADMIN_EMAILS: Bun.env.SPROUTBOAT_ADMIN_EMAILS ?? "andrea@example.test",
    SPROUTBOAT_ARTIFACTS_DIR: `${state}/artifacts`,
    SPROUTBOAT_DATABASE_PATH: `${state}/sproutboat.sqlite`,
    SPROUTBOAT_DEPLOYMENT_DOMAIN: localDomain,
    SPROUTBOAT_DEPLOYMENTS_PATH: `${state}/deployments.json`,
    SPROUTBOAT_DASHBOARD_URL: "https://dashboard.sproutboat.localhost",
    SPROUTBOAT_LOG_PATH: `${state}/edge.log`,
    SPROUTBOAT_ROUTE_SNAPSHOT: `${state}/routes.json`,
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

/**
 * `portless proxy start` is a no-op when any proxy already holds the port: it
 * prints "Proxy is already running", exits 0, and silently drops the flags. A
 * proxy started earlier without `--wildcard` therefore leaves
 * `*.sproutboat.localhost` unroutable — the edge and every deployment URL —
 * while this step still looks like it succeeded. Say so instead.
 */
async function startProxy() {
  console.log("→ starting Portless HTTPS and wildcard routing");
  const child = Bun.spawn(["portless", "proxy", "start", "--wildcard"], {
    cwd: root, env: environment(), stdin: "inherit", stdout: "pipe", stderr: "inherit",
  });
  const output = await new Response(child.stdout).text();
  process.stdout.write(output);
  if (await child.exited !== 0) throw new Error("starting Portless HTTPS and wildcard routing failed");
  if (/already running/i.test(output)) {
    console.warn(
      "\n!  A proxy was already listening, so --wildcard was not re-applied. If that\n" +
      "   proxy was started without it, *.sproutboat.localhost will not route — no\n" +
      "   edge, no deployment URLs. A proxy this harness started already has it.\n" +
      "   To be sure: sudo ./node_modules/.bin/portless proxy stop -p 443 && bun run dev:local\n",
    );
  }
}

async function main() {
  requireCommand("portless");
  requireCommand("npx");
  await mkdir(state, { recursive: true });

  // Building worker artifacts is the CLI's job now (`bunx sproutboat`,
  // which cross-compiles with Porffor + Zig — no Docker). This harness only
  // brings up the platform: control, edge, dashboard.

  pruneUnownedRoutes([localDomain, `control.${localDomain}`, `dashboard.${localDomain}`]);
  await startProxy();
  await checked("migrating local Control state", ["bunx", "--bun", "auth@1.7.1", "migrate", "--config", "apps/control/src/auth.migrate.ts", "--yes"]);
  if (await fetch("http://127.0.0.1:4000").then(() => true).catch(() => false)) console.log("→ reusing GitHub emulator at http://localhost:4000");
  else start("GitHub emulator", ["npx", "emulate", "--service", "github", "--seed", "tests/emulate.github.yaml"]);
  start("Control at https://control.sproutboat.localhost", ["portless", "--force", "control.sproutboat", "bun", "run", "control"]);
  start("Edge wildcard at https://*.sproutboat.localhost", ["portless", "--force", "sproutboat", "bun", "run", "edge"]);
  // The dashboard's SSR auth loader fetches the control API over the self-signed
  // portless cert; let its process trust it for local dev.
  start("dashboard at https://dashboard.sproutboat.localhost", ["portless", "--force", "dashboard.sproutboat", "bun", "run", "web"], environment({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }));
  console.log("\nReady:\n  Dashboard  https://dashboard.sproutboat.localhost\n  Control    https://control.sproutboat.localhost\n  Deployments https://<project>.<owner>.sproutboat.localhost\n\nDeploy with the CLI:\n  bunx sproutboat login --api-url https://control.sproutboat.localhost\n  bunx sproutboat deploy\n");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  // Named, because this handler exits 0 — without it, "shut down on a signal"
  // and "fell off the end of the script" are indistinguishable from the shell.
  console.log(`\n→ ${signal} received, stopping ${processes.length} child processes`);
  for (const child of processes) child.kill(signal);
  process.exit();
});

await main();
// Hold the harness open for as long as the platform is up. Waiting on the
// children keeps their handles referenced; a bare `new Promise(() => {})` is
// not a handle, so the process could fall out from under the services it
// started and leave them orphaned or killed.
await Promise.all(processes.map((child) => child.exited));
