import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { listenerOwner } from "./listener-owner";
import { sproutCommand } from "./sandbox";
import {
  brokerBwrapArgs,
  brokerLaunchCommand,
  brokerEnv,
  brokerSandboxMode,
  nodeModulesOf,
  planBrokerSandbox,
  prepareBrokerHostFiles,
  withoutToken,
  writeBwrapArgsFile,
  type BrokerEnv,
  type BrokerPlanInput,
} from "./broker-sandbox";

const positiveEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

/**
 * Where the sprout writes the wall-clock ms at which its bundled JS began
 * running (#41). Diffed against the spawn time, it splits cold-start into
 * "process + runtime bootstrap" (spawn -> JS starts) and "module eval + bind"
 * (JS starts -> listening). Both the spawn env (`SB_STARTUP_FILE`) and the
 * reader derive the same path.
 */
export const startupFilePath = (sproutPath: string, port: number): string =>
  resolve(dirname(sproutPath), `.startup-${port}`);

function readBootMs(file: string, spawnedAt: number, startupMs: number): number {
  try {
    const jsStartedAt = Number(readFileSync(file, "utf8").trim());
    if (!Number.isFinite(jsStartedAt)) return 0;
    const boot = Math.round(jsStartedAt - spawnedAt);
    // same host, same CLOCK_REALTIME — clamp only to absorb rounding slop
    return boot < 0 ? 0 : boot > startupMs ? startupMs : boot;
  } catch {
    return 0;
  }
}

/**
 * One long-lived native-fetch HTTP server per deployment.
 *
 * Porffor compiles `export default { fetch }` into a uWebSockets server
 * binary. The supervisor assigns it a loopback port ($PORT — honoured by the
 * render.js patch in @sproutboat/toolchain), starts it, waits for it to listen,
 * and restarts it if it exits. The edge reverse-proxies each request to
 * `endpoint()`.
 *
 * No stdin/stdout framing, no per-request process, no recycle: Porffor has
 * working memory management (verified flat RSS over 500k requests).
 */

export type SproutChild = {
  readonly exited: Promise<number>;
  kill(signal?: number): void;
  /** #141: let a broker started with `--dispatch-disabled` run its timers. */
  enableDispatch?(): void;
  /** The token this sprout trusts from the edge (SB_EDGE_TOKEN): see `isEdgeSecret`. */
  readonly edgeToken?: string;
  /** The spawned sprout process (the launcher, for a sandboxed one). Used to check who owns the listening socket. */
  readonly pid?: number;
  /** The bindings broker process, when the sprout has one. */
  readonly brokerPid?: number;
};

/** Something other than the process we spawned is listening on the sprout's port. */
export class ForeignListenerError extends Error {
  constructor(readonly port: number) {
    super(`sprout port ${port} is held by a process the supervisor did not start`);
    this.name = "ForeignListenerError";
  }
}

/**
 * Service-binding calls go from a sprout through its broker to this edge, which routes
 * them to the callee like any request. Each broker gets its own credential (in the
 * `SB_EDGE_SECRET` variable it already reads) and sends it with every call. The
 * credential is random per broker, is good only for the hostnames in that broker's own
 * `services` map, and dies with the broker. The edge checks it with `verifyBindingCall`
 * and vouches for the call to the callee with the callee's own SB_EDGE_TOKEN. A client
 * can forge none of this, and a broker that leaks or is taken over can impersonate the
 * edge to nobody but the services its app was already allowed to call.
 *
 * Stored by hash, so a lookup compares nothing secret.
 */
const bindingCredentials = new Map<string, ReadonlySet<string>>();
const credentialKey = (credential: string): string => createHash("sha256").update(credential).digest("hex");
const hostOnly = (host: string): string => host.split(":")[0]!.toLowerCase();

/**
 * Make `credential` valid for `hosts` until the returned function is called. The broker
 * spawn path uses it; the edge-diff harness uses it to give both edges known credentials.
 */
export function registerBindingCredential(credential: string, hosts: Iterable<string>): () => void {
  const key = credentialKey(credential);
  bindingCredentials.set(key, new Set([...hosts].map(hostOnly)));
  return () => void bindingCredentials.delete(key);
}

/** Whether `credential` is a live broker credential allowed to call `host`. */
export function verifyBindingCall(credential: string | null, host: string): boolean {
  if (!credential) return false;
  return bindingCredentials.get(credentialKey(credential))?.has(hostOnly(host)) ?? false;
}
/** Account context the broker needs to enforce shared R2 storage limits. */
export type R2Runtime = {
  ownerId: string;
  resourceIds: string[];
  /**
   * #207 — stable per-project id (`do_<24hex>`) naming the Durable Object
   * store, so object state outlives a redeploy instead of living in the
   * per-deployment broker db.
   */
  doStoreId?: string;
};
/** `secretsPath` (#2) points at the project's decrypted `secrets.json`, written
 *  outside the content-addressed artifact dir; null when the project has none. */
export type SproutFactory = (
  sproutPath: string,
  port: number,
  secretsPath?: string | null,
  /** #48 — binding -> target hostname, resolved by control and carried on the
   *  route snapshot. Positional like `secretsPath` on purpose: #120 replaces
   *  this whole argv path with one `register` frame, so an options-object
   *  refactor here is work that gets thrown away. */
  services?: Record<string, string> | null,
  r2?: R2Runtime | null,
  /** #141: a staged candidate listens, but its broker must not fire cron,
   *  queue or alarm work until its route is active. */
  dispatchDisabled?: boolean,
) => SproutChild;

/**
 * What `endpoint()` resolved to. `coldStart` is true when this call had to spawn
 * the sprout process; `startupMs` is the spawn→listening wait for that cold
 * start (0 on a warm hit). The edge records both per request so the dashboard
 * can chart cold-start rate and startup-time percentiles.
 */
export type Endpoint = {
  url: string;
  transferUrl?: string;
  coldStart: boolean;
  startupMs: number;
  bootMs: number;
  /** What the edge sends a vouched service-binding call to this sprout with. */
  edgeToken?: string;
};

/**
 * A route whose broker must keep its paired sprout available without an HTTP
 * request. Cron, queue and Durable Object alarm dispatch all originate in the
 * broker, then POST back to that sprout.
 */
export type TimedSprout = {
  sproutPath: string;
  secretsPath?: string | null;
  services?: Record<string, string> | null;
  r2?: R2Runtime | null;
};

export type SproutPoolOptions = {
  readonly spawn?: SproutFactory;
  readonly readyTimeoutMs?: number;
  readonly idleMs?: number;
  readonly now?: () => number;
  readonly portRange?: readonly [number, number];
};

const defaultReadyTimeoutMs = 10_000;
const defaultIdleMs = 600_000;
const defaultPortRange: readonly [number, number] = [40_000, 49_999];

/** A process embeds its secret file and service-routing snapshot at spawn, so
 * those values are part of its identity. Sharing just by artifact path could
 * send one hostname's calls through another hostname's runtime context. */
function runtimeKey(
  sproutPath: string,
  secretsPath?: string | null,
  services?: Record<string, string> | null,
  r2?: R2Runtime | null,
): string {
  const servicePairs = services ? Object.entries(services).sort(([a], [b]) => a.localeCompare(b)) : [];
  const r2Key = r2 ? `${r2.ownerId}\0${r2.resourceIds.slice().sort().join(",")}\0${r2.doStoreId ?? ""}` : "";
  return `${resolve(sproutPath)}\0${secretsPath ?? ""}\0${JSON.stringify(servicePairs)}\0${r2Key}`;
}

// The broker runs as a subprocess (not an import). `broker-main.ts` starts
// @sproutboat/wire's broker and adds a stdin control channel, because a signal
// cannot reach a broker inside its sandbox. `brokerModules` is the node_modules
// directory it resolves the package from; the sandbox mounts it read only.
const brokerEntry = resolve(import.meta.dir, "broker-main.ts");
const brokerModules = nodeModulesOf(fileURLToPath(import.meta.resolve("@sproutboat/wire/broker")));

/**
 * Whether the OS will let a sprout bind this port right now. Bun throws from
 * `Bun.listen` when the port is taken, which is the check; the listener is
 * stopped immediately either way.
 *
 * A sprout listens on the wildcard address (uWS, like Bun.serve, binds every
 * address by default), so the probe has to bind the wildcard too. Probing only
 * 127.0.0.1 missed a socket holding the port on any other local address: an
 * outbound connection from the NIC address or an IPv6 client, including one
 * left in TIME_WAIT for a minute after it closed. The default range (and the
 * tests') sits inside Linux's ephemeral range (32768-60999), so on a busy box
 * such sockets turn up there regularly, and the sprout then died on "Failed to
 * start server. Is port N in use?". 127.0.0.1 is still probed: it is the
 * address the edge dials, and macOS lets a wildcard bind share a port with a
 * loopback listener.
 */
function portBindable(port: number): boolean {
  for (const hostname of ["0.0.0.0", "127.0.0.1"]) {
    try {
      const probe = Bun.listen({ hostname, port, socket: { data() {} } });
      probe.stop(true);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * The broker's argv, as a pure function so it can be asserted on.
 *
 * `--sprout-url` is the whole reason this is exported: the broker only starts
 * its cron scheduler and queue consumer when it is told where its sprout is, so
 * dropping or renaming this flag silently costs every deployed project its
 * scheduled and queued work while requests keep serving normally. That rename
 * has already happened once — `--worker-url` -> `--sprout-url` — and that time
 * it was loud, because the broker's parseArgs threw and nothing started. The
 * quiet direction is the dangerous one.
 */
export function brokerArgs(opts: {
  entry: string;
  brokerPort: number;
  transferPort?: number;
  token: string;
  stateDir: string;
  resourceDir: string;
  bindingsPath: string;
  sproutPort: number;
  r2?: R2Runtime | null;
  r2QuotaBytes?: number;
  r2MinFreeBytes?: number;
  secretsPath?: string | null;
  assetsDir?: string | null;
  services?: Record<string, string> | null;
  edgeUrl?: string | null;
  doDb?: string | null;
  dispatchDisabled?: boolean;
}): string[] {
  const args = [
    // `process.execPath`, not "bun": sproutboat-edge.service runs with a
    // hardened PATH that doesn't include the pinned /opt/sproutboat/bun, so a
    // bare "bun" is ENOENT and every sprout with bindings fails to launch.
    // `--smol`: the broker is near-idle and one per deployment — trade GC CPU
    // (idle here) for a smaller JSC heap.
    process.execPath,
    "--smol",
    opts.entry,
    "--port",
    String(opts.brokerPort),
    "--token",
    opts.token,
    "--db",
    resolve(opts.stateDir, "state.sqlite"),
    "--data-dir",
    resolve(opts.stateDir, "d1"),
    "--resource-dir",
    opts.resourceDir,
    "--bindings",
    opts.bindingsPath,
    "--sprout-url",
    `http://127.0.0.1:${opts.sproutPort}/`,
  ];
  if (opts.transferPort) args.push("--transfer-port", String(opts.transferPort));
  if (opts.r2) {
    args.push("--owner-id", opts.r2.ownerId, "--r2-resource-ids", opts.r2.resourceIds.join(","));
    if (opts.r2QuotaBytes) args.push("--r2-quota-bytes", String(opts.r2QuotaBytes));
    if (opts.r2MinFreeBytes) args.push("--r2-min-free-bytes", String(opts.r2MinFreeBytes));
  }
  if (opts.secretsPath) args.push("--secrets", opts.secretsPath);
  // #48 — service bindings only work when the broker knows both where to send a
  // call (the node's edge, on loopback) and which hostname each binding means.
  // Passing one without the other is a misconfiguration, not a partial feature.
  if (opts.services && Object.keys(opts.services).length > 0 && opts.edgeUrl) {
    args.push("--services", JSON.stringify(opts.services), "--edge-url", opts.edgeUrl);
  }
  // Static assets published beside the artifact back `env.<ASSETS>.fetch()`.
  if (opts.assetsDir) args.push("--assets-dir", opts.assetsDir);
  // #207 — Durable Object state in a per-project file that survives redeploys.
  if (opts.doDb) args.push("--do-db", opts.doDb);
  if (opts.dispatchDisabled) args.push("--dispatch-disabled");
  return args;
}

/**
 * Bindings broker sidecar. Spawned only when the artifact ships a `bindings.json`
 * (KV / D1 / R2 / queues / secrets / cron / Durable Objects). The worker reaches
 * it on `SB_BROKER_PORT`; the broker delivers cron + queue triggers back to the
 * worker on `SB_SPROUT_URL`.
 *
 * ponytail: broker port is `workerPort + 10000` — deterministic, within the
 * ephemeral range, no second allocator. Give the broker its own port pool if two
 * live sprouts ever land exactly 10000 apart.
 */
/** Whether an artifact's bindings.json declares any Durable Object classes. */
function declaresDurableObjects(bindingsPath: string): boolean {
  try {
    // SAFETY: generated by the build; only `do` is read, and checked as an array.
    const bindings = JSON.parse(readFileSync(bindingsPath, "utf8")) as { do?: unknown };
    return Array.isArray(bindings.do) && bindings.do.length > 0;
  } catch {
    return false;
  }
}

/**
 * Open a sprout log for a child to write to. Mode "w" truncates first, then the
 * fd is opened with "a" so it is O_APPEND: after logrotate `copytruncate` the
 * child writes at the new end instead of its old offset (no sparse NUL holes).
 */
export function openLogFd(path: string, mode: "w" | "a"): number {
  if (mode === "w") closeSync(openSync(path, "w"));
  return openSync(path, "a");
}

/** What a sprout gets beside the edge's own environment. */
type SproutEnv = { SB_EDGE_TOKEN: string; SB_BROKER_PORT?: string; SB_BROKER_TOKEN?: string };

function spawnWithBroker(
  sproutPath: string,
  port: number,
  secretsPath?: string | null,
  services?: Record<string, string> | null,
  r2?: R2Runtime | null,
  dispatchDisabled?: boolean,
): SproutChild {
  const workerDir = dirname(sproutPath);
  const bindingsPath = resolve(workerDir, "bindings.json");
  let broker: Bun.Subprocess<"pipe", number | "ignore", number | "ignore"> | null = null;
  let brokerCredential: string | null = null;
  let revokeCredential: (() => void) | null = null;
  let brokerArgsFile: string | null = null;
  const removeArgsFile = () => {
    if (brokerArgsFile) rmSync(brokerArgsFile, { force: true });
  };
  const edgeToken = randomBytes(24).toString("hex");
  const sproutEnv: SproutEnv = { SB_EDGE_TOKEN: edgeToken };

  // Tee sprout + broker stdout/stderr to one plain-text file per deployment,
  // truncated on each fresh spawn so it always shows the current instance
  // (handler console.log, crashes, "broker rc -N"). Control reads it for
  // `sproutboat tail --sprout`. `"ignore"` when there's no log dir (dev/tests)
  // or the open fails.
  const sproutLogPath = process.env.SPROUTBOAT_LOG_PATH
    ? resolve(dirname(process.env.SPROUTBOAT_LOG_PATH), "sprouts", `${basename(workerDir)}.log`)
    : null;
  const openLog = (mode: "w" | "a"): number | "ignore" => {
    if (!sproutLogPath) return "ignore";
    try {
      mkdirSync(dirname(sproutLogPath), { recursive: true });
      return openLogFd(sproutLogPath, mode);
    } catch {
      return "ignore";
    }
  };
  const withLog = (fd: number | "ignore") => ({ stdout: fd, stderr: fd }) as const;
  const closeLog = (fd: number | "ignore") => {
    if (fd !== "ignore") closeSync(fd);
  };

  if (existsSync(bindingsPath)) {
    const brokerPort = port + 10_000;
    const transferPort = port - 10_000;
    if (transferPort <= 0) throw new RangeError("sprout port must be above 10000 for direct transfers");
    const token = randomBytes(24).toString("hex");
    // The artifact dir is read-only to the edge (0750 sproutboat-control), so
    // broker state can't live in `workerDir/.broker`. Put it beside the request
    // log, whose dir the edge owns; fall back to the artifact dir for dev/tests
    // where it is writable. Nothing creates the tree, so mkdir it here.
    const stateBase =
      process.env.SPROUTBOAT_BROKER_STATE_DIR ||
      (process.env.SPROUTBOAT_LOG_PATH ? resolve(dirname(process.env.SPROUTBOAT_LOG_PATH), "brokers") : workerDir);
    const stateDir = resolve(stateBase, basename(workerDir));
    mkdirSync(resolve(stateDir, "d1"), { recursive: true });
    // #74 — account-level KV/R2/queue/D1 resources live in one shared dir keyed
    // by their globally-unique `<kind>_<24hex>` id (not per-deployment, not
    // per-owner): the control plane already refuses a deploy that references an
    // id the caller doesn't own, and the id is unguessable. This is what lets a
    // resource's data outlive a redeploy and be shared between projects.
    const resourceDir =
      process.env.SPROUTBOAT_RESOURCE_DIR ||
      (process.env.SPROUTBOAT_LOG_PATH
        ? resolve(dirname(process.env.SPROUTBOAT_LOG_PATH), "resources")
        : resolve(stateBase, "..", "resources"));
    mkdirSync(resourceDir, { recursive: true });
    const assetsDir = existsSync(resolve(workerDir, "assets.json")) ? resolve(workerDir, "assets") : null;
    const doDb =
      r2?.doStoreId && declaresDurableObjects(bindingsPath) ? resolve(resourceDir, `${r2.doStoreId}.sqlite`) : null;
    const args = brokerArgs({
      entry: brokerEntry,
      brokerPort,
      transferPort,
      token,
      stateDir,
      resourceDir,
      bindingsPath,
      sproutPort: port,
      r2,
      r2QuotaBytes: r2 ? positiveEnv("SPROUTBOAT_R2_QUOTA_BYTES", 10 * 1024 * 1024 * 1024) : undefined,
      r2MinFreeBytes: r2 ? positiveEnv("SPROUTBOAT_R2_MIN_FREE_BYTES", 5 * 1024 * 1024 * 1024) : undefined,
      // #2 — secrets come from a per-project file the control plane writes
      // outside the shared artifact dir; the path rides in on the route snapshot.
      secretsPath: secretsPath && existsSync(secretsPath) ? secretsPath : null,
      assetsDir,
      services,
      // The edge is the process spawning us, so it tells us its own address.
      edgeUrl: process.env.SPROUTBOAT_EDGE_URL || null,
      doDb,
      dispatchDisabled,
    });
    // The broker's own edge credential, only when it can call services at all.
    if (services && Object.keys(services).length > 0 && process.env.SPROUTBOAT_EDGE_URL) {
      brokerCredential = randomBytes(24).toString("hex");
      revokeCredential = registerBindingCredential(brokerCredential, Object.values(services));
    }
    const mode = brokerSandboxMode();
    // The token goes to the broker in its environment (it reads SB_BROKER_TOKEN), not on its command line.
    const payload = withoutToken(args);
    let command = payload;
    let env: BrokerEnv;
    if (mode === "bwrap") {
      const plan: BrokerPlanInput = {
        bun: process.execPath,
        entry: brokerEntry,
        nodeModules: brokerModules,
        stateDir,
        resourceDir,
        bindingsPath,
        secretsPath: secretsPath && existsSync(secretsPath) ? secretsPath : null,
        assetsDir,
        r2,
        doDb,
      };
      const mounts = planBrokerSandbox(plan);
      prepareBrokerHostFiles(plan, mounts);
      env = brokerEnv(process.env, brokerCredential, { PATH: "/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp" });
      env.SB_BROKER_TOKEN = token;
      // bwrap reads its options from a 0600 file, so no secret is in argv. bash deletes the file once it has it open.
      brokerArgsFile = resolve(stateDir, `bwrap-${randomBytes(6).toString("hex")}.args`);
      writeBwrapArgsFile(brokerArgsFile, brokerBwrapArgs(mounts, env));
      command = brokerLaunchCommand(brokerArgsFile, payload, Bun.which("bwrap") ?? "bwrap");
      // The sandbox's own environment carries the token; the process that launches it needs none.
      env = { PATH: "/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp" };
    } else {
      if (process.platform === "linux" && process.env.SPROUTBOAT_UNSAFE_NO_SANDBOX !== "1") {
        throw new Error(
          "refusing to run a bindings broker unsandboxed on Linux; set SPROUTBOAT_BROKER_SANDBOX=bwrap (or SPROUTBOAT_UNSAFE_NO_SANDBOX=1 for a trusted local test)",
        );
      }
      env = brokerEnv(process.env, brokerCredential, {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
      });
      env.SB_BROKER_TOKEN = token;
    }
    const brokerFd = openLog("w");
    try {
      broker = Bun.spawn(command, { ...withLog(brokerFd), stdin: "pipe", env });
    } catch (cause) {
      revokeCredential?.();
      removeArgsFile();
      throw cause;
    } finally {
      closeLog(brokerFd);
    }
    sproutEnv.SB_BROKER_PORT = String(brokerPort);
    sproutEnv.SB_BROKER_TOKEN = token;
  }

  const startupFile = startupFilePath(sproutPath, port);
  try {
    rmSync(startupFile, { force: true });
  } catch {
    /* fresh spawn */
  }

  let sprout: Bun.Subprocess | null = null;
  let sproutPid: number | undefined;
  let stopped = false;
  const capturedBroker = broker;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    sprout?.kill(9);
    capturedBroker?.kill(9);
    revokeCredential?.();
    removeArgsFile();
  };

  // The broker is a Bun process; a freshly compiled native sprout is ready in
  // ~1ms and would fire its first env.KV / env.ASSETS call into a broker that
  // isn't listening yet ("broker rc -2" -> uncaught -> sprout dies -> lifecycle
  // bind kills the broker -> respawn -> same race forever). Gate the sprout on
  // the broker's port. No broker (no bindings) -> start immediately.
  const exited = (async () => {
    if (capturedBroker) {
      const [up, transferUp] = await Promise.all([awaitPort(port + 10_000, 5_000), awaitPort(port - 10_000, 5_000)]);
      removeArgsFile();
      if (stopped) return 0;
      // Broker never listened — don't start a sprout that will only crash on its
      // first binding call. Resolve as a failed exit; the pool retries next hit.
      if (!up || !transferUp) {
        capturedBroker.kill(9);
        return 1;
      }
      // A connect succeeds for any listener. The ports must be ours: held by the broker we started.
      if (
        listenerOwner(port + 10_000, capturedBroker.pid) === "foreign" ||
        listenerOwner(port - 10_000, capturedBroker.pid) === "foreign"
      ) {
        console.error("broker ports are held by a process the supervisor did not start; retrying on other ports");
        capturedBroker.kill(9);
        revokeCredential?.();
        return 1;
      }
    }
    const sproutFd = openLog(capturedBroker ? "a" : "w");
    try {
      sprout = Bun.spawn(sproutCommand(sproutPath), {
        ...withLog(sproutFd),
        env: { ...process.env, PORT: String(port), SB_STARTUP_FILE: startupFile, ...sproutEnv },
      });
    } catch (cause) {
      // The artifact is not executable on this box — a truncated upload, a
      // foreign architecture, a seeded placeholder. `Bun.spawn` throws
      // synchronously (ENOEXEC), and an uncaught throw here would take the
      // whole edge down with it: one bad artifact, every tenant offline.
      // Fail this deployment only; the pool retries on the next request.
      console.error(`sprout ${sproutPath} could not be executed:`, cause instanceof Error ? cause.message : cause);
      capturedBroker?.kill(9);
      closeLog(sproutFd);
      return 1;
    }
    closeLog(sproutFd);
    sproutPid = sprout.pid;
    // #4 — bind the two lifecycles: a sprout with bindings is useless without
    // its broker, so either exiting tears down the other and the pool respawns
    // the pair on the next request.
    void sprout.exited.then(stop);
    if (capturedBroker) void capturedBroker.exited.then(stop);
    return sprout.exited;
  })();

  return {
    exited,
    kill: stop,
    // The broker reads `enable` on stdin (broker-main.ts); sending it twice is harmless.
    enableDispatch: () => {
      try {
        capturedBroker?.stdin.write("enable\n");
        void capturedBroker?.stdin.flush();
      } catch {
        // The broker already exited; the pair is being torn down.
      }
    },
    edgeToken,
    get pid() {
      return sproutPid;
    },
    brokerPid: capturedBroker?.pid,
  };
}

/** The real spawn behind the default pool. Exported so the unexecutable-artifact
 *  path can be covered — it used to throw and take the whole edge down. */
export function spawnSprout(
  sproutPath: string,
  port: number,
  secretsPath?: string | null,
  services?: Record<string, string> | null,
  r2?: R2Runtime | null,
  dispatchDisabled?: boolean,
): SproutChild {
  return spawnWithBroker(sproutPath, port, secretsPath, services, r2, dispatchDisabled);
}

async function listens(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      done(true);
    });
    socket.on("error", () => done(false));
  });
}

/** Poll a loopback port until something accepts, or the deadline passes. */
async function awaitPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let wait = 2;
  while (Date.now() < deadline) {
    if (await listens(port)) return true;
    await Bun.sleep(wait);
    if (wait < 25) wait = Math.min(25, wait * 2);
  }
  return false;
}

class SproutServer {
  readonly port: number;
  readonly url: string;
  #child: SproutChild;
  #closed = false;
  #ready: Promise<void>;
  lastUsedAt: number;
  /** Spawn→listening wait in ms, set once the process accepts a connection. */
  startupMs = 0;
  /** Spawn->JS-start slice of startupMs: process create + ld.so + runtime init (#41). */
  bootMs = 0;

  get edgeToken(): string | undefined {
    return this.#child.edgeToken;
  }

  constructor(
    readonly sproutPath: string,
    port: number,
    spawn: SproutFactory,
    readyTimeoutMs: number,
    now: () => number,
    private readonly onExit: (server: SproutServer) => void,
    secretsPath?: string | null,
    services?: Record<string, string> | null,
    r2?: R2Runtime | null,
    dispatchDisabled?: boolean,
  ) {
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.lastUsedAt = now();
    const spawnedAt = Date.now();
    this.#child = spawn(sproutPath, port, secretsPath, services, r2, dispatchDisabled);
    this.#ready = this.#awaitListening(readyTimeoutMs).then(() => {
      this.startupMs = Date.now() - spawnedAt;
      this.bootMs = readBootMs(startupFilePath(sproutPath, port), spawnedAt, this.startupMs);
    });
    void this.#child.exited.then(() => {
      if (!this.#closed) {
        this.#closed = true;
        this.onExit(this);
      }
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  enableDispatch(): void {
    this.#child.enableDispatch?.();
  }

  async ready(): Promise<void> {
    return this.#ready;
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    // SIGKILL: the bwrap launcher does not forward SIGTERM to the payload;
    // killing bwrap hard triggers --die-with-parent teardown of the namespace.
    this.#child.kill(9);
  }

  async #awaitListening(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // Fast poll early (most sprouts listen within a few ms), then back off so a
    // slow start doesn't spin. #39: replace polling entirely with an inherited
    // listening fd once Porffor supports it.
    let wait = 1;
    while (Date.now() < deadline) {
      if (this.#closed) throw new Error("sprout exited before it began listening");
      if (await listens(this.port)) {
        const pid = this.#child.pid;
        const owner = pid === undefined ? "unsupported" : listenerOwner(this.port, pid);
        if (owner === "foreign") {
          this.dispose();
          console.error(
            `sprout port ${this.port} is held by a process the supervisor did not start; retrying on another port`,
          );
          throw new ForeignListenerError(this.port);
        }
        if (owner !== "none") return;
      }
      await Bun.sleep(wait);
      if (wait < 20) wait = Math.min(20, wait * 2);
    }
    this.dispose();
    throw new Error(`sprout did not listen on :${this.port} within ${timeoutMs}ms`);
  }
}

/** Deployment-keyed pool of native-fetch server processes. */
/** #30 — process-wide runtime-lifecycle gauges for the admin dashboard. */
export type PoolStats = {
  live: number;
  spawns: number;
  restarts: number;
  readyFailures: number;
  idleEvictions: number;
  portsInUse: number;
  portPoolSize: number;
  /** Active route generations retained for cron, queue or alarm dispatch. */
  timedConfigured: number;
  /** Retained generations whose sprout is currently listening. */
  timedLive: number;
  /** Failed timed wakes. Retried with capped exponential backoff. */
  timedWakeFailures: number;
  /** Spawns whose port turned out to be held by a process we did not start. */
  foreignListeners: number;
};

export class SproutPool {
  readonly #servers = new Map<string, SproutServer>();
  readonly #usedPorts = new Set<number>();
  readonly #spawn: SproutFactory;
  readonly #readyTimeoutMs: number;
  readonly #idleMs: number;
  readonly #now: () => number;
  readonly #portRange: readonly [number, number];
  readonly #seenKeys = new Set<string>();
  /** Active generations with broker-driven work. These are deliberately a
   * small subset of routes: ordinary HTTP sprouts remain eligible for idle
   * eviction. */
  readonly #timed = new Map<string, TimedSprout>();
  readonly #timedWakeups = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #timedWakeAttempts = new Map<string, number>();
  #timedReconcile: Promise<void> = Promise.resolve();
  #spawns = 0;
  #restarts = 0;
  #readyFailures = 0;
  #idleEvictions = 0;
  #timedWakeFailures = 0;
  #foreignListeners = 0;

  constructor({
    spawn = spawnSprout,
    readyTimeoutMs = defaultReadyTimeoutMs,
    idleMs = defaultIdleMs,
    now = Date.now,
    portRange = defaultPortRange,
  }: SproutPoolOptions = {}) {
    this.#spawn = spawn;
    this.#readyTimeoutMs = readyTimeoutMs;
    this.#idleMs = idleMs;
    this.#now = now;
    this.#portRange = portRange;
  }

  /**
   * A port this pool has not handed out *and* that nothing else on the box is
   * holding. Checking only #usedPorts made the pool the sole authority on a
   * range it does not own: another process — a second supervisor, a test
   * server, anything with an ephemeral bind — could already have it, and the
   * sprout then died on "Failed to start server. Is port N in use?" with no
   * retry. Binding it briefly is the only way to ask the OS.
   *
   * The bind is a probe, not a reservation: the port is released before the
   * sprout claims it, so a racing process can still win. That window is
   * microseconds against a range of thousands, where before the collision
   * window was the whole life of the other listener.
   */
  #freePort(sproutPath: string): number {
    const [lo, hi] = this.#portRange;
    const withBroker = existsSync(resolve(dirname(sproutPath), "bindings.json"));
    // Walk the range once from a random start: every port is tried at most
    // once, so a range that is genuinely full fails after one pass instead of
    // probing the same few ports thousands of times.
    const size = hi - lo + 1;
    const start = Math.floor(Math.random() * size);
    for (let i = 0; i < size; i++) {
      const port = lo + ((start + i) % size);
      if (this.#usedPorts.has(port)) continue;
      if (
        portBindable(port) &&
        (!withBroker ||
          (port > 10_000 && port + 10_000 <= 65_535 && portBindable(port + 10_000) && portBindable(port - 10_000)))
      )
        return port;
    }
    throw new Error("no free sprout port available");
  }

  /** Base URL of the deployment's server, starting and awaiting it if needed. */
  /** `dispatchDisabled` (#141) only applies when this call spawns the process:
   *  the edge stages a candidate with it, and #reconcileTimed lifts it once the
   *  candidate's route is active. */
  async endpoint(
    sproutPath: string,
    secretsPath?: string | null,
    services?: Record<string, string> | null,
    r2?: R2Runtime | null,
    dispatchDisabled = false,
  ): Promise<Endpoint> {
    // A port another process already held is not retried on, so a second attempt gets a freshly probed one.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#endpointOnce(sproutPath, secretsPath, services, r2, dispatchDisabled);
      } catch (error) {
        if (!(error instanceof ForeignListenerError)) throw error;
        this.#foreignListeners += 1;
        if (attempt >= 2) throw error;
      }
    }
  }

  async #endpointOnce(
    sproutPath: string,
    secretsPath: string | null | undefined,
    services: Record<string, string> | null | undefined,
    r2: R2Runtime | null | undefined,
    dispatchDisabled: boolean,
  ): Promise<Endpoint> {
    const key = runtimeKey(sproutPath, secretsPath, services, r2);
    let server = this.#servers.get(key);
    let coldStart = false;
    if (!server || server.closed) {
      coldStart = true;
      if (this.#seenKeys.has(key)) this.#restarts += 1; // this route ran before: crash/evict replacement
      this.#seenKeys.add(key);
      const port = this.#freePort(sproutPath);
      this.#usedPorts.add(port);
      this.#spawns += 1;
      server = new SproutServer(
        resolve(sproutPath),
        port,
        this.#spawn,
        this.#readyTimeoutMs,
        this.#now,
        (dead) => {
          if (this.#servers.get(key) === dead) this.#servers.delete(key);
          this.#usedPorts.delete(dead.port);
          // A broker-driven route has no incoming HTTP request to bring a
          // crashed pair back. Retry it with a bounded backoff while it remains
          // the active route generation. This is lifecycle recovery only: it
          // does not make queue delivery crash-safe beyond the broker's own
          // existing acknowledgement policy.
          if (this.#timed.has(key)) this.#scheduleTimedWake(key);
        },
        secretsPath,
        services,
        r2,
        dispatchDisabled,
      );
      this.#servers.set(key, server);
    }
    server.lastUsedAt = this.#now();
    try {
      await server.ready();
    } catch (error) {
      this.#readyFailures += 1;
      server.dispose();
      this.#servers.delete(key);
      this.#usedPorts.delete(server.port);
      throw error;
    }
    return {
      url: server.url,
      transferUrl: existsSync(resolve(dirname(server.sproutPath), "bindings.json"))
        ? `http://127.0.0.1:${server.port - 10_000}`
        : undefined,
      coldStart,
      startupMs: coldStart ? server.startupMs : 0,
      bootMs: coldStart ? server.bootMs : 0,
      edgeToken: server.edgeToken,
    };
  }

  /** Keep an in-flight direct transfer from being reaped as HTTP-idle. */
  touch(
    sproutPath: string,
    secretsPath?: string | null,
    services?: Record<string, string> | null,
    r2?: R2Runtime | null,
  ): void {
    const server = this.#servers.get(runtimeKey(sproutPath, secretsPath, services, r2));
    if (server && !server.closed) server.lastUsedAt = this.#now();
  }

  dispose(sproutPath: string): void {
    const path = resolve(sproutPath);
    // `dispose(path)` is intentionally broad: route removal must stop every
    // runtime context that was spawned for this artifact, including aliases on
    // custom domains with different secrets or service snapshots.
    for (const [key, server] of Array.from(this.#servers.entries())) {
      if (server.sproutPath !== path) continue;
      this.#timed.delete(key);
      this.#cancelTimedWake(key);
      server.dispose();
      this.#servers.delete(key);
      this.#usedPorts.delete(server.port);
    }
    for (const [key, timed] of Array.from(this.#timed.entries())) {
      if (resolve(timed.sproutPath) !== path) continue;
      this.#timed.delete(key);
      this.#cancelTimedWake(key);
    }
  }

  disposeAll(): void {
    for (const key of this.#timedWakeups.keys()) this.#cancelTimedWake(key);
    this.#timed.clear();
    for (const server of Array.from(this.#servers.values())) server.dispose();
    this.#servers.clear();
    this.#usedPorts.clear();
  }

  /**
   * Stop any sprout idle past the window — routed or not. A hot deployment
   * keeps `lastUsedAt` fresh and is never touched; a deployment with a route
   * but no traffic for `idleMs` is reaped and cold-starts (~1ms + broker wait)
   * on its next request. Deployments whose route was removed are disposed
   * eagerly by the edge on snapshot swap; this is the traffic-based reaper.
   *
   * Previously every routed deployment was pinned resident, so a node with N
   * deployments held N sprouts (+ N brokers) forever regardless of traffic.
   */
  evictIdle(now = this.#now()): number {
    let evicted = 0;
    for (const [key, server] of Array.from(this.#servers.entries())) {
      if (this.#timed.has(key)) continue;
      if (now - server.lastUsedAt >= this.#idleMs) {
        server.dispose();
        this.#servers.delete(key);
        this.#usedPorts.delete(server.port);
        evicted++;
      }
    }
    this.#idleEvictions += evicted;
    return evicted;
  }

  /**
   * Reconcile the active route snapshot's timer-driven deployments. This is
   * called at edge boot and on each route swap, so a cron/queue/alarm starts
   * even if nobody has ever made an HTTP request. Wakes are capped at two at a
   * time: a large route file cannot stampede the node's compiler/runtime just
   * because the edge restarted.
   */
  reconcileTimed(sprouts: readonly TimedSprout[]): Promise<void> {
    // Route mtime polling and SIGHUP can overlap. Serialize the whole
    // reconciliation so the two-worker start budget is node-wide, not merely
    // per notification.
    const run = this.#timedReconcile.then(() => this.#reconcileTimed(sprouts));
    this.#timedReconcile = run.catch(() => {});
    return run;
  }

  async #reconcileTimed(sprouts: readonly TimedSprout[]): Promise<void> {
    const next = new Map<string, TimedSprout>();
    for (const sprout of sprouts)
      next.set(runtimeKey(sprout.sproutPath, sprout.secretsPath, sprout.services, sprout.r2), sprout);

    for (const key of Array.from(this.#timed.keys())) {
      if (next.has(key)) continue;
      this.#timed.delete(key);
      this.#cancelTimedWake(key);
      const server = this.#servers.get(key);
      server?.dispose();
      this.#servers.delete(key);
      if (server) this.#usedPorts.delete(server.port);
    }
    for (const [key, sprout] of next) this.#timed.set(key, sprout);
    // #141: a candidate staged with dispatch disabled becomes active here, the
    // first time its route is in the snapshot. Enabling is idempotent, so every
    // active timed runtime gets the signal rather than tracking which were held.
    for (const key of next.keys()) this.#servers.get(key)?.enableDispatch();

    const pending = Array.from(next.keys());
    const wakeNext = async (): Promise<void> => {
      const key = pending.pop();
      if (!key) return;
      await this.#wakeTimed(key);
      return wakeNext();
    };
    const workers = Array.from({ length: Math.min(2, pending.length) }, wakeNext);
    await Promise.all(workers);
  }

  #cancelTimedWake(key: string): void {
    this.#clearTimedWakeTimer(key);
    this.#timedWakeAttempts.delete(key);
  }

  #clearTimedWakeTimer(key: string): void {
    const timer = this.#timedWakeups.get(key);
    if (timer) clearTimeout(timer);
    this.#timedWakeups.delete(key);
  }

  async #wakeTimed(key: string): Promise<void> {
    const timed = this.#timed.get(key);
    if (!timed) return;
    this.#clearTimedWakeTimer(key);
    try {
      await this.endpoint(timed.sproutPath, timed.secretsPath, timed.services, timed.r2);
      this.#timedWakeAttempts.delete(key);
    } catch (error) {
      this.#timedWakeFailures += 1;
      console.error(
        `timed sprout ${timed.sproutPath} did not start:`,
        error instanceof Error ? error.message : String(error),
      );
      if (this.#timed.has(key)) this.#scheduleTimedWake(key);
    }
  }

  #scheduleTimedWake(key: string): void {
    if (this.#timedWakeups.has(key) || !this.#timed.has(key)) return;
    const attempt = (this.#timedWakeAttempts.get(key) ?? 0) + 1;
    this.#timedWakeAttempts.set(key, attempt);
    const delay = Math.min(30_000, 250 * 2 ** Math.min(attempt - 1, 7));
    const timer = setTimeout(() => {
      this.#timedWakeups.delete(key);
      void this.#wakeTimed(key);
    }, delay);
    this.#timedWakeups.set(key, timer);
  }

  stats(): PoolStats {
    const [lo, hi] = this.#portRange;
    let timedLive = 0;
    for (const key of this.#timed.keys()) if (this.#servers.has(key)) timedLive++;
    return {
      live: this.#servers.size,
      spawns: this.#spawns,
      restarts: this.#restarts,
      readyFailures: this.#readyFailures,
      idleEvictions: this.#idleEvictions,
      portsInUse: this.#usedPorts.size,
      portPoolSize: hi - lo + 1,
      timedConfigured: this.#timed.size,
      timedLive,
      timedWakeFailures: this.#timedWakeFailures,
      foreignListeners: this.#foreignListeners,
    };
  }
}

/** Process-wide worker pool the edge proxies through. */
export const pool = new SproutPool();
