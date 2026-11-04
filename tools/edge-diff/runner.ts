/** Runs one case against one edge: fixture, edge process, the case's request script, logs. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SIDECAR_WITH_CREDENTIALS,
  Fixture,
  ROOT,
  makeTempDir,
  openWebSocket,
  rawRequest,
  removeTempDir,
  sleep,
  startEdge,
  stopEdge,
  writeFileAtomic,
  type EdgeHandle,
  type EdgeKind,
  type HttpObs,
  type Json,
  type Obs,
  type ReqSpec,
  type WsConn,
} from "./lib";
import { isString } from "./json";

export type RoutesInit = Json[] | string | null;

export interface Case {
  id: string;
  group: string;
  description?: string;
  /** Extra edge env; null removes a default. A function gets the fixture (for paths). */
  env?: Record<string, string | null> | ((fx: Fixture) => Record<string, string | null>);
  timeoutMs?: number;
  /** How to compare the NDJSON request log: in order (default), as a multiset, or not at all. */
  logs?: "ordered" | "sorted" | "off";
  /** Also compare the edge's stdout lines after the listening line. */
  stdout?: boolean;
  /** The edge is expected to refuse to start (exit non-zero without listening). */
  expectStartFailure?: boolean;
  /**
   * The Rust edge deliberately fixes a Bun defect here: Bun's result is printed for reference and the
   * Rust run is checked by `assertRust` (a list of failures) instead of being diffed. Never fails the
   * exit code unless the assertion does.
   */
  intentional?: { reason: string; assertRust: (rust: RunResult, helpers: AssertHelpers) => string[] };
  /** Scoped binding credentials registered at start: credential -> hostnames it may call (see credentials-sync.ts). */
  credentials?: Record<string, string[]>;
  /** Default Host header for requests. */
  host?: string;
  /** Build the fixture; returns the initial routes.json content (null = no file, string = raw text). */
  setup?: (fx: Fixture) => Promise<RoutesInit>;
  run: (ctx: Ctx) => Promise<void>;
}

export interface Ctx {
  readonly fx: Fixture;
  readonly kind: EdgeKind;
  readonly edge: EdgeHandle;
  readonly dir: string;
  readonly host: string;
  readonly routesPath: string;
  readonly logPath: string;
  req(label: string, spec?: ReqSpec): Promise<HttpObs>;
  /** Like req, but not recorded (polling and background traffic). */
  quiet(spec?: ReqSpec): Promise<HttpObs>;
  note(label: string, value: Json): void;
  /**
   * Rewrite routes.json (atomically via rename unless `atomic` is false). The new mtime is always strictly
   * newer than the previous one: a Linux timestamp tick is coarse, and the Bun edge reloads only on a strictly
   * newer mtime, so a rewrite in the same tick would otherwise be invisible to it by luck of timing.
   * (The Rust edge catches same-tick rewrites; see `pinRoutesMtime`.)
   */
  writeRoutes(routes: Json[] | string, atomic?: boolean): void;
  /** Set routes.json's mtime to a whole second just ahead of now and return it (exact, so it can be repeated). */
  pinRoutesMtime(): number;
  /** Rewrite routes.json (in place, or via rename when `atomic`) with its mtime exactly `seconds`: a rewrite in the same tick. */
  writeRoutesAtMtime(routes: Json[] | string, seconds: number, atomic?: boolean): void;
  removeRoutes(): void;
  /** Replace the registered binding credentials (a broker exited, or a new one started) and wait until the edge has them. */
  setCredentials(credentials: Record<string, string[]>): Promise<void>;
  hup(): void;
  sleep(ms: number): Promise<void>;
  waitFor(predicate: () => boolean | Promise<boolean>, deadlineMs?: number, stepMs?: number): Promise<boolean>;
  ws(path: string, opts?: { host?: string; protocols?: string[]; headers?: Record<string, string> }): Promise<WsConn>;
  /** Request log lines written so far. */
  logLines(): string[];
}

export interface RunResult {
  kind: EdgeKind;
  obs: Obs[];
  logs: Json[];
  stdout: string[];
  stderr: string;
  ports: Record<string, number>;
  startedAt: number;
  endedAt: number;
  error?: string;
  startFailure?: { code: number | null; stdout: string[]; stderr: string };
}

/**
 * The Rust edge answers /__sb/pool only for loopback Hosts (intentional fix); the Bun edge answers any
 * host. Pool requests therefore default to "localhost" so both edges can be compared.
 */
function poolHost(spec: ReqSpec): ReqSpec {
  return spec.path?.startsWith("/__sb/pool") && spec.host === undefined ? { ...spec, host: "localhost" } : spec;
}

const BASE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG"];

function edgeEnv(c: Case, fx: Fixture, routesPath: string, logPath: string) {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const inherited = process.env[key];
    if (inherited !== undefined) env[key] = inherited;
  }
  Object.assign(env, {
    PORT: "0",
    SPROUTBOAT_BIND_HOST: "127.0.0.1",
    SPROUTBOAT_ROUTE_SNAPSHOT: routesPath,
    SPROUTBOAT_LOG_PATH: logPath,
    SPROUTBOAT_DEPLOYMENT_DOMAIN: "sproutboat.test",
    SPROUTBOAT_DASHBOARD_URL: "https://dash.sproutboat.test/app/",
    SPROUTBOAT_SPROUT_SANDBOX: "none",
    SPROUTBOAT_UNSAFE_NO_SANDBOX: "1",
    SPROUTBOAT_BROKER_STATE_DIR: join(fx.dir, "brokers"),
    SPROUTBOAT_RESOURCE_DIR: join(fx.dir, "resources"),
  });
  // The harness runs a copy of the Rust binary from a temp dir, where neither the working directory nor
  // the install prefix leads to the checkout, so say where the script is.
  env.SPROUTBOAT_SIDECAR_SCRIPT = join(ROOT, "services/supervisor/src/sidecar.ts");
  if (c.credentials) {
    env.EDGE_DIFF_CREDENTIALS_FILE = join(fx.dir, "credentials.json");
    env.SPROUTBOAT_SIDECAR_SCRIPT = SIDECAR_WITH_CREDENTIALS;
  }
  const extra = c.env instanceof Function ? c.env(fx) : (c.env ?? {});
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Wait until the log stops growing. */
async function settleLogs(path: string): Promise<void> {
  const deadline = Date.now() + 3000;
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const size = existsSync(path) ? statSync(path).size : 0;
    if (size !== last) {
      last = size;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 200) return;
    await sleep(25);
  }
}

export async function runCase(c: Case, kind: EdgeKind, bin: string, timeoutMs: number): Promise<RunResult> {
  const dir = makeTempDir(`${kind}-${c.id.replace(/[^a-z0-9]/gi, "_").slice(0, 24)}`);
  const fx = new Fixture(dir);
  const result: RunResult = {
    kind,
    obs: [],
    logs: [],
    stdout: [],
    stderr: "",
    ports: {},
    startedAt: Date.now(),
    endedAt: 0,
  };
  const routesPath = join(dir, "routes.json");
  const logPath = join(dir, "logs", "requests.ndjson");
  mkdirSync(join(dir, "logs"), { recursive: true });
  let edge: EdgeHandle | null = null;

  const body = async (): Promise<void> => {
    const routes = c.setup
      ? await c.setup(fx)
      : [{ hostname: c.host ?? "app.test", sproutPath: await fx.makeSprout("app") }];
    if (c.credentials)
      writeFileSync(join(dir, "credentials.json"), JSON.stringify({ version: 1, credentials: c.credentials }));
    if (routes !== null) writeFileSync(routesPath, Array.isArray(routes) ? JSON.stringify(routes) : routes);
    const started = await startEdge({
      kind,
      bin,
      env: edgeEnv(c, fx, routesPath, logPath),
      cwd: dir,
      expectFailure: c.expectStartFailure,
    });
    if ("failed" in started) {
      result.startFailure = { code: started.code, stdout: started.stdout, stderr: started.stderr };
      if (!c.expectStartFailure)
        result.error = `edge failed to start (exit ${started.code}): ${started.stderr.slice(-400)}`;
      return;
    }
    if (c.expectStartFailure) {
      result.error = "edge started but was expected to refuse";
      edge = started;
      return;
    }
    edge = started;
    const credentialsFile = join(dir, "credentials.json");
    let credentialsVersion = 1;
    const host = c.host ?? "app.test";
    const ctx: Ctx = {
      fx,
      kind,
      edge: started,
      dir,
      host,
      routesPath,
      logPath,
      req: async (label, spec = {}) => {
        const obs = await rawRequest(started.port, label, host, poolHost(spec));
        result.obs.push(obs);
        return obs;
      },
      quiet: (spec = {}) => rawRequest(started.port, "quiet", host, poolHost(spec)),
      note: (label, value) => void result.obs.push({ kind: "note", label, value }),
      writeRoutes: (routes, atomic = true) => {
        const text = isString(routes) ? routes : JSON.stringify(routes);
        const before = existsSync(routesPath) ? statSync(routesPath).mtimeMs : 0;
        if (atomic) writeFileAtomic(routesPath, text);
        else writeFileSync(routesPath, text);
        if (statSync(routesPath).mtimeMs <= before) {
          const next = new Date(before + 1000);
          utimesSync(routesPath, next, next);
        }
      },
      pinRoutesMtime: () => {
        const seconds = Math.floor(Date.now() / 1000) + 1;
        utimesSync(routesPath, seconds, seconds);
        return seconds;
      },
      writeRoutesAtMtime: (routes, seconds, atomic = false) => {
        const text = isString(routes) ? routes : JSON.stringify(routes);
        const target = atomic ? `${routesPath}.pinned.tmp` : routesPath;
        writeFileSync(target, text);
        utimesSync(target, seconds, seconds);
        if (atomic) renameSync(target, routesPath);
      },
      removeRoutes: () => rmSync(routesPath, { force: true }),
      setCredentials: async (credentials) => {
        credentialsVersion += 1;
        writeFileAtomic(credentialsFile, JSON.stringify({ version: credentialsVersion, credentials }));
        // The Rust edge's sidecar starts lazily; one that is not up yet reads the file when it starts.
        const ack = `${credentialsFile}.${kind === "bun" ? "bun" : "sidecar"}.ack`;
        const seen = () => existsSync(ack) && readFileSync(ack, "utf8") === String(credentialsVersion);
        if (kind === "bun" || existsSync(ack)) {
          if (!(await ctx.waitFor(seen, 3000, 10))) throw new Error("the edge did not pick up the credentials");
        }
      },
      hup: () => process.kill(started.pid, "SIGHUP"),
      sleep,
      waitFor: async (predicate, deadlineMs = 3000, stepMs = 20) => {
        const deadline = Date.now() + deadlineMs;
        while (Date.now() < deadline) {
          if (await predicate()) return true;
          await sleep(stepMs);
        }
        return await predicate();
      },
      ws: (path, opts = {}) => openWebSocket(started.port, path, { host: opts.host ?? host, ...opts }),
      logLines: () => readLines(logPath),
    };
    await c.run(ctx);
    if (c.logs !== "off") await settleLogs(logPath);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      body(),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`case timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    // SAFETY: `edge` is only assigned inside body(), which TypeScript's flow analysis cannot see; it is an EdgeHandle or still null.
    const live = edge as EdgeHandle | null;
    if (live) {
      await stopEdge(live);
      result.stdout = [...live.stdout];
      result.stderr = live.stderr.text;
    }
    if (live) result.ports.edge = live.port;
    result.logs = readLines(logPath).map((line): Json => {
      try {
        const parsed: Json = JSON.parse(line);
        return parsed;
      } catch {
        return { "<unparsable log line>": line };
      }
    });
    result.endedAt = Date.now();
    // Sweep any sprout a dead edge left behind.
    fx.sweep();
    removeTempDir(dir);
  }
  return result;
}

export interface AssertHelpers {
  http(run: RunResult, label: string): import("./lib").HttpObs | undefined;
  note(run: RunResult, label: string): Json | undefined;
  /** Log events as plain objects. */
  events(run: RunResult): Record<string, Json>[];
}
