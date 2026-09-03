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
 *      SPROUTBOAT_CONTROL_URL (default https://control.sproutboat.localhost),
 *      SPROUTBOAT_DASHBOARD_URL (default https://dashboard.<domain>) — must match
 *      the control plane's BETTER_AUTH_URL, or sign-in fails the origin check.
 *      Both accept a port, which is what you get when the portless proxy could
 *      not take 443 (no sudo): control on http://127.0.0.1:<port> works too,
 *      since Bun's resolver does not resolve *.localhost subdomains.
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
const dashboardUrl = (process.env.SPROUTBOAT_DASHBOARD_URL || `https://dashboard.${domain}`).replace(/\/$/, "");
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

type DemoDeployment = {
  project: string; versions: number; active: boolean;
  /** #76 — storage resources to create and bind, so the Bindings and Storage views have content. */
  resources?: Array<{ kind: "kv" | "d1" | "r2" | "queue"; name: string; binding: string }>;
  secrets?: Record<string, string>;
  outbound?: string[];
  /** An unverified custom domain, so the Triggers view shows the TXT-record step. */
  domain?: string;
};
type DemoUser = { login: string; namespace: string; admin?: boolean; projects: DemoDeployment[] };

const DEMO: DemoUser[] = [
  { login: "andrea", namespace: "andrea", admin: true, projects: [
    {
      project: "blog", versions: 3, active: true,
      resources: [
        { kind: "kv", name: "sessions", binding: "SESSIONS" },
        { kind: "r2", name: "uploads", binding: "MEDIA" },
      ],
      secrets: { API_KEY: "seed-api-key", WEBHOOK_SECRET: "seed-webhook-secret" },
      outbound: ["https://api.github.com"],
      domain: "www.example.test",
    },
    {
      project: "api", versions: 1, active: true,
      resources: [
        { kind: "d1", name: "records", binding: "DB" },
        { kind: "queue", name: "jobs", binding: "JOBS" },
      ],
      secrets: { DATABASE_TOKEN: "seed-db-token" },
    },
    { project: "scratch", versions: 1, active: true },
  ] },
  { login: "sofia", namespace: "sofia", projects: [
    { project: "shop", versions: 2, active: true, resources: [{ kind: "kv", name: "carts", binding: "CARTS" }] },
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
    headers: { "content-type": "application/json", origin: dashboardUrl },
    body: JSON.stringify({ provider: "github", callbackURL: `${dashboardUrl}/profile` }),
  });
  stash(res);
  // SAFETY: Better Auth sign-in/social returns { url } on success.
  const { url } = await res.json() as { url: string };
  const state = new URL(url).searchParams.get("state") ?? "";
  const authorize = await fetch(`${emulatorUrl}/login/oauth/callback`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login, redirect_uri: `${dashboardUrl}/api/auth/callback/github`, scope: "user:email", state, client_id: "sproutboat-local" }),
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

const METHODS = ["GET", "GET", "GET", "POST", "PUT", "DELETE"] as const;

/**
 * One request record per line, carrying the fields the dashboard reads: method
 * and cold-start drive the log query builder (#3), and ttfb/cpu/boot/bytes and
 * cacheStatus drive the metrics panels (#10/#37). Older seeds only wrote
 * at/hostname/status/durationMs, which left those panels empty.
 */
function seedTraffic(hostname: string, lines: string[]): void {
  const now = Date.now();
  for (let i = 0; i < 150; i++) {
    const at = new Date(now - Math.random() * 24 * 3_600_000).toISOString();
    const roll = Math.random();
    const status = roll < 0.85 ? 200 : roll < 0.93 ? 404 : roll < 0.98 ? 503 : 301;
    const method = METHODS[Math.floor(Math.random() * METHODS.length)];
    const coldStart = Math.random() < 0.06;
    const durationMs = status >= 500 ? 350 + Math.floor(Math.random() * 600) : 3 + Math.floor(Math.random() * 55);
    const bootMs = 8 + Math.floor(Math.random() * 14);
    const record = {
      at, hostname, status, durationMs, method,
      ttfbMs: Math.max(1, Math.round(durationMs * 0.6)),
      reqBytes: method === "GET" ? 0 : 40 + Math.floor(Math.random() * 400),
      resBytes: status === 200 ? 200 + Math.floor(Math.random() * 4000) : 0,
      cpuMs: Math.max(1, Math.round(durationMs * 0.35)),
      cacheStatus: Math.random() < 0.3 ? "hit" : "miss",
    };
    const withStart = coldStart
      ? { ...record, coldStart: true, startupMs: bootMs + 10 + Math.floor(Math.random() * 40), bootMs }
      : record;
    lines.push(JSON.stringify(status >= 500 ? { ...withStart, error: "sprout failure" } : withStart));
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
    for (const table of ["deployments", "projects", "artifacts", "banned_owners", "resources", "deployment_resources", "secrets", "custom_domains"]) {
      try { db.run(`DELETE FROM ${table}`); } catch { /* table absent on a fresh DB */ }
    }
    // Also the issued API keys: the seeder inserts one per demo user below, and
    // a key left over from a real `sproutboat login` against this box makes the
    // credentials list longer than the tests (and the demo) expect.
    try { db.run("DELETE FROM apikey"); } catch { /* absent before the api-key migration */ }
    db.close();
    await rm(process.env.SPROUTBOAT_ARTIFACTS_DIR!, { recursive: true, force: true });
    await writeFile(process.env.SPROUTBOAT_LOG_PATH!, "");
    console.log("reset: cleared projects, deployments, artifacts, resources, secrets, domains, API keys, edge log");
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
      // #74/#76 — real account resources the artifact then binds by id.
      const created = (spec.resources ?? []).map((resource) => ({
        binding: resource.binding,
        kind: resource.kind,
        record: store.createResource(ownerId, resource.kind, resource.name),
      }));
      const bindings = created.length || spec.secrets || spec.outbound
        ? {
          kv: created.filter((entry) => entry.kind === "kv").map((entry) => entry.binding),
          d1: created.filter((entry) => entry.kind === "d1").map((entry) => entry.binding),
          r2: created.filter((entry) => entry.kind === "r2").map((entry) => entry.binding),
          queues: created.filter((entry) => entry.kind === "queue").map((entry) => entry.binding),
          secrets: Object.keys(spec.secrets ?? {}),
          outbound: spec.outbound ?? [],
          resources: Object.fromEntries(created.map((entry) => [entry.binding, { kind: entry.kind, id: entry.record.id }])),
        }
        : undefined;

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
        if (bindings) await writeFile(resolve(dir, "bindings.json"), JSON.stringify(bindings, null, 2));
        const hostname = `${spec.project}.${user.namespace}.${domain}`;
        store.recordDeployment({
          id, ownerId, project: spec.project, username: user.namespace, hostname, artifact: digest,
          sproutPath: resolve(dir, "sprout"), deployedAt: builtAt,
          resourceIds: created.map((entry) => entry.record.id),
        });
        activeId = id;
      }
      for (const [name, value] of Object.entries(spec.secrets ?? {})) {
        store.setSecret(ownerId, spec.project, name, value);
      }
      if (spec.domain) {
        // Left unverified on purpose: the Triggers view then shows the TXT record step.
        store.addCustomDomain({ hostname: spec.domain, ownerId, project: spec.project, token: randomUUID().replace(/-/g, "") });
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
