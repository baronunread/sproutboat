/**
 * Design 05, phase 1: running a project on sproutd instead of the supervisor.
 *
 * Control stays the source of truth (projects, owners, deployments, secrets, domains). For a
 * project whose `runtime` is "sproutd" it is also a client of sproutd's control adapter
 * (sproutd repo, deploy/adapter): it uploads the module with the project's secrets and limits,
 * keeps its own copy of every module (so a rollback never depends on sproutd's retention), and
 * reconciles what sproutd serves with what control believes: at startup, after each routes
 * sync, and on a timer. The edge keeps routing and metrics and forwards these projects to
 * sproutd's frontend (route entry `backend`).
 *
 * Nothing here runs unless SPROUTBOAT_SPROUTD_* is configured, and a project can only opt in
 * when its owner is listed in SPROUTBOAT_SPROUTD_OWNERS (default: nobody).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  onRoutesSynced,
  projectHosts,
  projectSecrets,
  type RuntimeLimits,
  type SproutdProject,
  sproutdProjects,
  sproutdUrl,
} from "./store";

// --- configuration ---------------------------------------------------------

const adapterSocket = () => process.env.SPROUTBOAT_SPROUTD_ADAPTER_SOCKET || "";
function adapterToken(): string {
  if (process.env.SPROUTBOAT_SPROUTD_ADAPTER_TOKEN) return process.env.SPROUTBOAT_SPROUTD_ADAPTER_TOKEN;
  const file = process.env.SPROUTBOAT_SPROUTD_ADAPTER_TOKEN_FILE;
  if (!file) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/** sproutd is usable on this box: an adapter socket and token, and a URL for the edge to forward to. */
export const sproutdEnabled = (): boolean => adapterSocket() !== "" && adapterToken() !== "" && sproutdUrl() !== "";

/** Which owners may put a project on sproutd. A security-bar decision (design 05, decision 5), so closed by default. */
export function sproutdOwnerAllowed(username: string): boolean {
  const list = (process.env.SPROUTBOAT_SPROUTD_OWNERS || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return list.includes("*") || list.includes(username);
}

const num = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };
const isObject = (value: Json | undefined): value is { readonly [key: string]: Json } =>
  value !== null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function);
const isInteger = (value: Json | undefined): value is number =>
  Object(value) !== value && value === Number(value) && Number.isInteger(value);
const isText = (value: Json | undefined): value is string => Object(value) !== value && value === String(value);

/** What sproutd accepts for each limit (native-host.cpp parse_limits). */
const LIMIT_RANGES = {
  memoryMb: [8, 4096],
  cpuMs: [10, 600_000],
  wallMs: [100, 600_000],
} as const satisfies Record<keyof RuntimeLimits, readonly [number, number]>;
const limitNames = (): Array<keyof RuntimeLimits> => ["memoryMb", "cpuMs", "wallMs"];

/** The limits control asks sproutd for: the project's own, else the platform's defaults. CPU stays at sproutd's default ("not yet"). */
export function effectiveLimits(
  limits: RuntimeLimits,
): Required<Pick<RuntimeLimits, "memoryMb" | "wallMs">> & RuntimeLimits {
  const out: Required<Pick<RuntimeLimits, "memoryMb" | "wallMs">> & RuntimeLimits = {
    memoryMb: limits.memoryMb ?? num("SPROUTBOAT_SPROUTD_MEMORY_MB", 128),
    wallMs: limits.wallMs ?? num("SPROUTBOAT_REQUEST_TIMEOUT_MS", 30_000),
  };
  if (limits.cpuMs !== undefined) out.cpuMs = limits.cpuMs;
  return out;
}

/** Parse and range-check a limits object from a request. */
export function parseLimits(input: Json | undefined): { limits: RuntimeLimits } | { error: string } {
  if (input === undefined || input === null) return { limits: {} };
  if (!isObject(input)) return { error: "limits must be an object" };
  const out: RuntimeLimits = {};
  for (const [key, value] of Object.entries(input)) {
    const name = limitNames().find((known) => known === key);
    if (!name) return { error: `unknown limit ${key}; known: ${limitNames().join(", ")}` };
    const [min, max] = LIMIT_RANGES[name];
    if (!isInteger(value) || value < min || value > max)
      return { error: `${key} must be an integer from ${min} to ${max}` };
    out[name] = value;
  }
  return { limits: out };
}

/**
 * What sproutd's secrets file cannot carry: a NUL in a value, and the host-owned SB_ / SPROUTBOAT_ names. Line
 * breaks and backslashes are fine: the adapter writes sproutd's escaped format (secrets file v2, sproutd
 * native-host.cpp load_secrets). Rejecting at `secrets put` tells the user when they set it, not when the app
 * fails to start. Needs a sproutd host that reads v2; one that does not would fail such an app closed.
 */
export function sproutdSecretProblem(name: string, value: string): string | null {
  if (name.startsWith("SB_") || name.startsWith("SPROUTBOAT_"))
    return "names starting with SB_ or SPROUTBOAT_ are reserved on sproutd";
  if (value.includes("\0")) return "a value with a NUL byte cannot be stored on sproutd";
  return null;
}

// --- the adapter client ----------------------------------------------------

export type AdapterStatus =
  | { id: string; exists: false }
  | {
      id: string;
      exists: true;
      state: string;
      hosts: string[];
      activeVersion: string | null;
      versions: Array<{ id: string; uploadedAt: number; active: boolean }>;
      limits: { memoryMb?: number; cpuMs?: number; wallMs?: number; storageMb?: number };
    };

export class AdapterError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: { readonly [key: string]: Json } = {},
  ) {
    super(message);
  }
  get unknownVersion() {
    return this.status === 404 && this.body.reason === "unknown-version";
  }
}

type CallInit = { owner?: string; json?: Json; form?: FormData };

export class SproutdClient {
  constructor(
    private readonly socket: string,
    private readonly token: string,
  ) {}

  private async call<T>(method: string, path: string, init: CallInit = {}): Promise<T> {
    const headers = new Headers({ authorization: `Bearer ${this.token}` });
    if (init.owner) headers.set("x-sb-owner", init.owner);
    let body: BodyInit | undefined;
    if (init.form) body = init.form;
    else if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    // Bun's fetch takes a unix socket path; the host in the URL is not used.
    // The status is checked right below, before the body is used.
    // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check
    const response = await fetch(`http://sproutd-adapter${path}`, { method, headers, body, unix: this.socket });
    const text = await response.text();
    let parsed: Json = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      /* a non-JSON error body */
    }
    const object = isObject(parsed) ? parsed : {};
    if (!response.ok)
      throw new AdapterError(
        response.status,
        isText(object.error) ? object.error : `adapter answered ${response.status}`,
        object,
      );
    // SAFETY: the adapter is our own process (sproutd repo, deploy/adapter) and answers each route with the shape
    // its caller below names; a mismatch is a version skew between the two, caught by the adapter's tests.
    return object as T;
  }

  health() {
    return this.call<{ ok: boolean; apps: number }>("GET", "/v1/health");
  }
  apps() {
    return this.call<{ apps: Array<{ id: string; state: string; hosts: string[] }> }>("GET", "/v1/apps");
  }
  status(owner: string, project: string) {
    return this.call<AdapterStatus>("GET", `/v1/projects/${project}`, { owner });
  }
  deploy(
    owner: string,
    project: string,
    module: Uint8Array<ArrayBuffer>,
    vid: string,
    secrets: Record<string, string>,
    limits: RuntimeLimits,
  ) {
    const form = new FormData();
    form.set("module", new File([module], "app.so"));
    form.set("expectedVid", vid);
    form.set("secrets", JSON.stringify(secrets));
    form.set("limits", JSON.stringify(limits));
    return this.call<{ id: string; vid: string; created: boolean }>("POST", `/v1/projects/${project}/deploy`, {
      owner,
      form,
    });
  }
  rollback(owner: string, project: string, vid: string, secrets: Record<string, string>) {
    return this.call<{ id: string; vid: string; via: "rollback" | "deploy" }>(
      "POST",
      `/v1/projects/${project}/rollback`,
      {
        owner,
        json: { vid, secrets },
      },
    );
  }
  applySecrets(owner: string, project: string, secrets: Record<string, string>) {
    return this.call<{ id: string; changed: boolean }>("PUT", `/v1/projects/${project}/secrets`, {
      owner,
      json: { secrets },
    });
  }
  setHosts(owner: string, project: string, hosts: string[]) {
    return this.call<{ id: string; hosts: string[] }>("PUT", `/v1/projects/${project}/hosts`, {
      owner,
      json: { hosts },
    });
  }
  setLimits(owner: string, project: string, limits: RuntimeLimits) {
    return this.call<{ id: string; ok: boolean }>("PUT", `/v1/projects/${project}/limits`, { owner, json: limits });
  }
  logs(owner: string, project: string, lines: number) {
    return this.call<{ id: string; lines: string[] }>("GET", `/v1/projects/${project}/logs?lines=${lines}`, { owner });
  }
  remove(owner: string, project: string) {
    return this.call<{ id: string; removed: boolean }>("DELETE", `/v1/projects/${project}`, { owner });
  }
}

export function sproutdClient(): SproutdClient | null {
  return sproutdEnabled() ? new SproutdClient(adapterSocket(), adapterToken()) : null;
}

// --- modules ---------------------------------------------------------------

const artifactRoot = () => resolve(process.env.SPROUTBOAT_ARTIFACTS_DIR || "/var/lib/sproutboat/artifacts");

/** sproutd's version id for a module: the first 16 hex digits of its SHA-256, as the daemon computes it. */
export const moduleVid = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
export const moduleDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Control's copy of a module, content-addressed like every artifact so the existing GC and backups cover it. */
export async function storeModule(bytes: Uint8Array): Promise<{ digest: string; path: string; placed: boolean }> {
  const digest = moduleDigest(bytes);
  const dir = resolve(artifactRoot(), digest);
  const path = resolve(dir, "app.so");
  await mkdir(artifactRoot(), { recursive: true, mode: 0o750 });
  let placed = false;
  try {
    await readFile(path);
  } catch {
    const temporary = resolve(artifactRoot(), `.upload-${crypto.randomUUID()}`);
    await mkdir(temporary, { recursive: true, mode: 0o750 });
    await writeFile(resolve(temporary, "app.so"), bytes, { mode: 0o640 });
    try {
      await rename(temporary, dir);
      placed = true;
    } catch {
      await rm(temporary, { recursive: true, force: true }); // another request stored the same bytes first
    }
  }
  return { digest, path, placed };
}

export const isElf = (bytes: Uint8Array): boolean =>
  bytes.length > 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;

// --- reconcile -------------------------------------------------------------

export type ReconcileAction = { owner: string; project: string; action: string };
export type ReconcileReport = {
  checked: number;
  actions: ReconcileAction[];
  errors: Array<{ owner: string; project: string; error: string }>;
  /** sproutd apps no control project maps to. Reported, never removed: a human decides. */
  orphans: string[];
};

const fingerprints = new Map<string, string>(); // "<owner>\0<project>" -> what was last applied

/** What this project should look like in sproutd, summarised so an unchanged project costs nothing to check. */
function fingerprint(project: SproutdProject): string {
  const secrets = projectSecrets(project.ownerId, project.project);
  const secretsHash = createHash("sha256")
    .update(JSON.stringify(secrets, Object.keys(secrets).sort()))
    .digest("hex");
  return JSON.stringify([
    project.active?.vid,
    projectHosts(project.ownerId, project.project),
    effectiveLimits(project.limits),
    secretsHash,
  ]);
}

async function reconcileOne(client: SproutdClient, project: SproutdProject, actions: ReconcileAction[]): Promise<void> {
  const { ownerId: owner, project: name, active } = project;
  if (!active?.vid) return; // nothing deployed yet
  const secrets = projectSecrets(owner, name);
  const limits = effectiveLimits(project.limits);
  const note = (action: string) => actions.push({ owner, project: name, action });
  let status = await client.status(owner, name);
  if (!status.exists || status.activeVersion !== active.vid) {
    // Lost (a sproutd with an empty STATE) or on another version than control's active one.
    const had = status.exists && status.versions.some((version) => version.id === active.vid);
    let done = false;
    if (had) {
      try {
        await client.rollback(owner, name, active.vid, secrets);
        note("rolled back to the active version");
        done = true;
      } catch (error) {
        if (!(error instanceof AdapterError && error.unknownVersion)) throw error;
      }
    }
    if (!done) {
      const bytes = new Uint8Array(await readFile(active.sproutPath));
      await client.deploy(owner, name, bytes, active.vid, secrets, limits);
      note(status.exists ? "redeployed the active version" : "deployed (sproutd had no such app)");
    }
    status = await client.status(owner, name);
  } else if ((await client.applySecrets(owner, name, secrets)).changed) note("applied changed secrets");
  if (!status.exists) throw new Error("app missing after deploy");
  const running = status.limits;
  const differing = limitNames().filter((key) => limits[key] !== undefined && limits[key] !== running[key]);
  if (differing.length > 0) {
    await client.setLimits(owner, name, limits);
    note(`limits ${differing.map((key) => `${key}=${limits[key]}`).join(" ")}`);
  }
  const hosts = projectHosts(owner, name);
  if (JSON.stringify(status.hosts.toSorted()) !== JSON.stringify(hosts)) {
    await client.setHosts(owner, name, hosts);
    note(`hosts ${hosts.join(",")}`);
  }
}

let running: Promise<ReconcileReport> | null = null;

/**
 * Make sproutd serve what control says. `force` ignores the fingerprint cache (startup, the admin
 * endpoint, the timer); a routes-sync pass only touches projects whose desired state changed.
 */
export function reconcileSproutd(options: { force?: boolean } = {}): Promise<ReconcileReport> {
  // One pass at a time; a request that arrives during a pass runs after it.
  const next = (running ?? Promise.resolve()).catch(() => {}).then(() => pass(options));
  running = next;
  return next.finally(() => {
    if (running === next) running = null;
  });
}

async function pass(options: { force?: boolean }): Promise<ReconcileReport> {
  const report: ReconcileReport = { checked: 0, actions: [], errors: [], orphans: [] };
  const client = sproutdClient();
  if (!client) return report;
  const known = new Set<string>();
  for (const project of sproutdProjects()) {
    const key = `${project.ownerId}\0${project.project}`;
    report.checked++;
    const wanted = fingerprint(project);
    try {
      const status = await client.status(project.ownerId, project.project);
      known.add(status.id);
      if (!options.force && fingerprints.get(key) === wanted) continue;
      await reconcileOne(client, project, report.actions);
      fingerprints.set(key, wanted);
    } catch (error) {
      fingerprints.delete(key);
      report.errors.push({
        owner: project.ownerId,
        project: project.project,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  try {
    for (const app of (await client.apps()).apps) if (!known.has(app.id)) report.orphans.push(app.id);
  } catch {
    /* the per-project errors above already say sproutd is unreachable */
  }
  return report;
}

/** Forget what was applied for a project (after it is deleted or moved). */
export function forgetSproutdProject(ownerId: string, project: string): void {
  fingerprints.delete(`${ownerId}\0${project}`);
}

let started = false;
/**
 * Startup: reconcile (retrying while the adapter comes up), then follow routes syncs and a timer.
 * Safe to call when sproutd is not configured: it does nothing.
 */
export function startSproutdReconciler(log: (message: string) => void = console.log): void {
  if (started || !sproutdEnabled()) return;
  started = true;
  const report = (label: string, result: ReconcileReport) => {
    if (result.actions.length > 0 || result.errors.length > 0 || result.orphans.length > 0)
      log(`sproutd reconcile (${label}): ${JSON.stringify(result)}`);
  };
  void (async () => {
    for (let attempt = 1; attempt <= 30; attempt++) {
      const result = await reconcileSproutd({ force: true });
      report("startup", result);
      // Errors on every project mean the adapter is not up yet, not that the projects are wrong.
      if (result.checked === 0 || result.errors.length < result.checked) break;
      await Bun.sleep(2_000);
    }
  })();
  let pending: ReturnType<typeof setTimeout> | undefined;
  onRoutesSynced(() => {
    clearTimeout(pending);
    pending = setTimeout(() => void reconcileSproutd().then((result) => report("sync", result)), 250);
  });
  const interval = num("SPROUTBOAT_SPROUTD_RECONCILE_MS", 60_000);
  setInterval(() => void reconcileSproutd({ force: true }).then((result) => report("timer", result)), interval).unref();
}
