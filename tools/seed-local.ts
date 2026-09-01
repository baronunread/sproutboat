/**
 * Local test seeder. Requires `bun run dev:local` to be running (control API +
 * GitHub emulator). Logs a handful of demo users in through the emulator,
 * reserves their namespaces, then writes projects, deployment versions,
 * artifacts, and edge-log traffic straight into the control-plane state so the
 * dashboard has something to show without an OAuth click-through or a Docker
 * build per version.
 *
 *   bun run seed              # seed (leaves existing data in place)
 *   bun run seed --reset      # wipe .local/sproutboat first, then seed
 *   bun run seed --e2e        # also write e2e/.auth/<user>.json storage states
 *
 * Env: SPROUTBOAT_LOCAL_STATE (default .local/sproutboat),
 *      SPROUTBOAT_CONTROL_URL (default https://control.sproutboat.localhost).
 */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const stateDir = resolve(process.env.SPROUTBOAT_LOCAL_STATE || `${root}/.local/sproutboat`);
const controlUrl = (process.env.SPROUTBOAT_CONTROL_URL || "https://control.sproutboat.localhost").replace(/\/$/, "");
const emulatorUrl = (process.env.GITHUB_EMULATOR_URL || "http://localhost:4000").replace(/\/$/, "");
const domain = "sproutboat.localhost";
const reset = process.argv.includes("--reset");
const writeAuth = process.argv.includes("--e2e");

// Point store.ts at the dev-local state dir before importing it.
process.env.SPROUTBOAT_DATABASE_PATH ||= `${stateDir}/sproutboat.sqlite`;
process.env.SPROUTBOAT_ARTIFACTS_DIR ||= `${stateDir}/artifacts`;
process.env.SPROUTBOAT_ROUTE_SNAPSHOT ||= `${stateDir}/routes.json`;
process.env.SPROUTBOAT_LOG_PATH ||= `${stateDir}/edge.log`;
process.env.SPROUTBOAT_DEPLOYMENT_DOMAIN ||= domain;

const fetchInsecure = (input: string | URL, init?: RequestInit): Promise<Response> =>
  fetch(input, { ...init, tls: { rejectUnauthorized: false } });

type DemoDeployment = { project: string; versions: number; active: boolean };
type DemoUser = { login: string; namespace: string; admin?: boolean; projects: DemoDeployment[] };

const DEMO: DemoUser[] = [
  { login: "andrea", namespace: "andrea", admin: true, projects: [
    { project: "blog", versions: 3, active: true },
    { project: "api", versions: 1, active: true },
    { project: "scratch", versions: 1, active: true },
  ] },
  { login: "sofia", namespace: "sofia", projects: [
    { project: "shop", versions: 2, active: true },
  ] },
  { login: "deletable", namespace: "deletable", projects: [
    { project: "throwaway", versions: 1, active: true },
  ] },
];

function elfStub(seed: string): Uint8Array {
  const bytes = new Uint8Array(256);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0); // ELF64, little-endian
  new DataView(bytes.buffer).setUint16(18, 62, true);  // e_machine = x86-64
  for (let i = 32; i < bytes.length; i++) bytes[i] = (seed.charCodeAt(i % seed.length) + i) & 0xff;
  return bytes;
}
const sha256 = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Emulator OAuth dance -> a real signed Better Auth session cookie for `login`. */
async function signIn(login: string): Promise<{ cookie: string; id: string }> {
  const jar = new Map<string, string>();
  const stash = (res: Response) => {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

  let res = await fetchInsecure(`${controlUrl}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `https://dashboard.${domain}` },
    body: JSON.stringify({ provider: "github", callbackURL: `https://dashboard.${domain}/profile` }),
  });
  stash(res);
  // SAFETY: Better Auth sign-in/social returns { url } on success.
  const { url } = await res.json() as { url: string };
  const state = new URL(url).searchParams.get("state") ?? "";
  const authorize = await fetch(`${emulatorUrl}/login/oauth/callback`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login, redirect_uri: `https://dashboard.${domain}/api/auth/callback/github`, scope: "user:email", state, client_id: "sproutboat-local" }),
  });
  const callback = new URL(authorize.headers.get("location") ?? "");
  res = await fetchInsecure(`${controlUrl}/api/auth/callback/github${callback.search}`, { headers: { cookie: header() }, redirect: "manual" });
  stash(res);
  const location = res.headers.get("location") ?? "";
  if (location.includes("/api/auth/error")) throw new Error(`sign-in for ${login} failed: ${location}`);

  const cookie = header();
  // SAFETY: GET /api/account returns the account contract (with `id`) for a live session.
  const me = await fetchInsecure(`${controlUrl}/api/account`, { headers: { cookie } }).then((r) => r.json()) as { id: string };
  return { cookie, id: me.id };
}

async function reserveNamespace(cookie: string, username: string): Promise<void> {
  const res = await fetchInsecure(`${controlUrl}/api/account/namespace`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ username }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`namespace ${username}: ${res.status} ${await res.text()}`);
}

function seedTraffic(hostname: string, lines: string[]): void {
  const now = Date.now();
  for (let i = 0; i < 150; i++) {
    const at = new Date(now - Math.random() * 24 * 3_600_000).toISOString();
    const roll = Math.random();
    const status = roll < 0.85 ? 200 : roll < 0.93 ? 404 : roll < 0.98 ? 503 : 301;
    const durationMs = status >= 500 ? 350 + Math.floor(Math.random() * 600) : 3 + Math.floor(Math.random() * 55);
    lines.push(JSON.stringify(status >= 500
      ? { at, hostname, status, durationMs, error: "sprout failure" }
      : { at, hostname, status, durationMs }));
  }
}

async function main(): Promise<void> {
  await mkdir(stateDir, { recursive: true });

  if (!await fetchInsecure(`${controlUrl}/internal/health`).then((r) => r.ok).catch(() => false)) {
    console.error(`control API not reachable at ${controlUrl} — start \`bun run dev:local\` first.`); process.exit(1);
  }

  if (reset) {
    // Row-level clear (control keeps the DB file open, so do not unlink it).
    const db = new Database(process.env.SPROUTBOAT_DATABASE_PATH!);
    db.exec("PRAGMA busy_timeout = 5000");
    for (const table of ["deployments", "projects", "artifacts", "banned_owners"]) {
      try { db.run(`DELETE FROM ${table}`); } catch { /* table absent on a fresh DB */ }
    }
    db.close();
    await rm(process.env.SPROUTBOAT_ARTIFACTS_DIR!, { recursive: true, force: true });
    await writeFile(process.env.SPROUTBOAT_LOG_PATH!, "");
    console.log("reset: cleared projects, deployments, artifacts, edge log");
  }

  const store = await import("../apps/control/src/store");
  const logLines: string[] = [];
  const authStates: Array<{ login: string; cookie: string }> = [];
  const owners: Array<{ login: string; ownerId: string }> = [];

  for (const user of DEMO) {
    const { cookie, id: ownerId } = await signIn(user.login);
    await reserveNamespace(cookie, user.namespace);
    authStates.push({ login: user.login, cookie });
    owners.push({ login: user.login, ownerId });

    for (const spec of user.projects) {
      let activeId = "";
      for (let v = 0; v < spec.versions; v++) {
        const id = randomUUID();
        const sprout = elfStub(`${user.login}/${spec.project}/${v}`);
        const digest = sha256(sprout).slice("sha256:".length);
        const dir = resolve(process.env.SPROUTBOAT_ARTIFACTS_DIR!, digest);
        await mkdir(dir, { recursive: true });
        const builtAt = new Date(Date.now() - (spec.versions - v) * 36 * 3_600_000).toISOString();
        const manifest = {
          schemaVersion: 2, project: spec.project, target: "linux-x86_64", runtime: "native-fetch",
          capabilityProfile: "http-sync-v0", porfforVersion: "alpha-3 (seed000)", esbuildVersion: "0.28.2",
          buildImage: "zig-musl/0.16.0+porffor/a415d19+uws/360c276d",
          sourceHash: sha256(`src:${user.login}/${spec.project}/${v}`), binaryHash: sha256(sprout),
          binarySize: sprout.length, builtAt,
        };
        await writeFile(resolve(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
        await writeFile(resolve(dir, "sprout"), sprout, { mode: 0o555 });
        const hostname = `${spec.project}.${user.namespace}.${domain}`;
        store.recordDeployment({ id, ownerId, project: spec.project, username: user.namespace, hostname, artifact: digest, sproutPath: resolve(dir, "sprout"), deployedAt: builtAt });
        activeId = id;
      }
      if (spec.active) {
        const hostname = `${spec.project}.${user.namespace}.${domain}`;
        store.activateDeployment(ownerId, spec.project, activeId);
        seedTraffic(hostname, logLines);
      }
    }
    console.log(`  seeded ${user.login} (${user.namespace})${user.admin ? " — admin" : ""}: ${user.projects.map((p) => p.project).join(", ")}`);
  }

  await writeFile(process.env.SPROUTBOAT_LOG_PATH!, logLines.sort().map((l) => `${l}\n`).join(""));
  await store.syncRoutes();

  // A CLI credential per user so the Settings > CLI credentials view has a row.
  const db = new Database(process.env.SPROUTBOAT_DATABASE_PATH!);
  db.exec("PRAGMA busy_timeout = 5000");
  const nowIso = new Date().toISOString();
  const insertKey = db.query(
    `INSERT OR REPLACE INTO apikey (id, configId, name, start, referenceId, prefix, key, enabled, requestCount, remaining, createdAt, updatedAt, lastRequest)
     VALUES (?, 'default', ?, 'sproutboat_seedkey', ?, 'sproutboat_', ?, 1, 3, NULL, ?, ?, ?)`,
  );
  for (const { login, ownerId } of owners) {
    try {
      insertKey.run(`seed-key-${login}`, `${login}'s laptop`, ownerId, `seed-hash-${randomUUID()}`, nowIso, nowIso, new Date(Date.now() - 3_600_000).toISOString());
    } catch { /* apikey table absent before the admin/api-key migration */ }
  }
  db.close();

  if (writeAuth) {
    await mkdir(resolve(root, "e2e/.auth"), { recursive: true });
    for (const { login, cookie } of authStates) {
      const cookies = cookie.split("; ").map((pair) => {
        const eq = pair.indexOf("=");
        return { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: `dashboard.${domain}`, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const };
      });
      await writeFile(resolve(root, `e2e/.auth/${login}.json`), JSON.stringify({ cookies, origins: [] }, null, 2));
    }
    console.log(`  wrote e2e/.auth/*.json for ${authStates.map((a) => a.login).join(", ")}`);
  }

  console.log(`\nSeed complete. Sign in as andrea (admin) or paste a cookie:\n`);
  for (const { login, cookie } of authStates) console.log(`  ${login}:  ${cookie}`);
  store.closeStore();
}

await main();
