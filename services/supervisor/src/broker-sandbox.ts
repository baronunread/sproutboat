import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RESOURCE_ID, adoptOwnerR2Files, ownerStorageDir, sqliteFileSet, touchFiles } from "./resource-layout";

/**
 * Least-privilege launch of one deployment's bindings broker.
 *
 * The broker used to run beside the edge: same user, same filesystem view, the
 * whole `resources/` directory (every account's data), the edge's own
 * environment and the edge secret. It parses tenant-controlled SQL and frames
 * and calls out to the edge, so it gets the same treatment as the sprout:
 * a bubblewrap sandbox that contains only what this deployment's broker uses.
 *
 * What the broker needs, and nothing more (see `planBrokerSandbox`):
 *   - the bun binary, the repo's node_modules and its own entry file, read only
 *   - the deployment's bindings.json, secrets file and assets, read only
 *   - the deployment's own state directory, read write
 *   - the resource files the app is bound to (and its Durable Object store),
 *     one SQLite file each, read write
 *   - its owner's R2 bodies, parts and quota ledger, read write
 *   - loopback (its sprout, the edge, the egress service). The network
 *     namespace is shared, as for the sprout: the broker listens for the sprout
 *     on loopback, and the edge unit's IPAddressDeny keeps both off the network.
 *   - a handful of environment variables and a per-app edge credential
 */

export type BrokerSandboxMode = "bwrap" | "none";

export function brokerSandboxMode(): BrokerSandboxMode {
  const mode =
    process.env.SPROUTBOAT_BROKER_SANDBOX ??
    process.env.SPROUTBOAT_SPROUT_SANDBOX ??
    (process.platform === "linux" ? "bwrap" : "none");
  if (mode === "bwrap" || mode === "none") return mode;
  throw new Error(`unknown SPROUTBOAT_BROKER_SANDBOX value: ${mode}`);
}

export type BrokerPlanInput = {
  /** The bun executable that runs the broker (`process.execPath`). */
  bun: string;
  /** The broker entry file (broker-main.ts). */
  entry: string;
  /** The node_modules directory the entry resolves `@sproutboat/wire` from (see `nodeModulesOf`). */
  nodeModules?: string | null;
  stateDir: string;
  resourceDir: string;
  bindingsPath: string;
  secretsPath?: string | null;
  assetsDir?: string | null;
  /** Account context from the route snapshot: the owner and all its R2 resource ids. */
  r2?: { ownerId: string; resourceIds: string[] } | null;
  /** Durable Object store file (`<resourceDir>/do_<id>.sqlite`), when the app declares DOs. */
  doDb?: string | null;
};

export type Mount = {
  /** `ro`: read only. `rw`: read write. */
  mode: "ro" | "rw";
  source: string;
  dest: string;
};

/**
 * The node_modules directory the broker resolves its package from (found from the real path of one of the
 * package's files), or null. It is the OUTERMOST one: with Bun's isolated linker (what a workspace install uses)
 * the real path is `<root>/node_modules/.bun/<pkg>/node_modules/<pkg>/...`, and the broker finds the package
 * through the `<root>/node_modules/<pkg>` symlink, so binding the innermost directory (the package's own
 * private store) leaves that symlink, and the broker's import, dangling.
 */
export function nodeModulesOf(file: string): string | null {
  const path = resolve(file);
  const at = path.indexOf("/node_modules/");
  return at >= 0 ? path.slice(0, at + "/node_modules".length) : null;
}

/** Resource ids an app's bindings.json names; ones that are not well-formed ids are dropped. */
export function boundResourceIds(bindingsPath: string): string[] {
  let resources: unknown;
  try {
    resources = JSON.parse(readFileSync(bindingsPath, "utf8")).resources;
  } catch {
    return [];
  }
  if (!(resources instanceof Object)) return [];
  const ids = new Set<string>();
  for (const entry of Object.values(resources)) {
    const id = String(entry?.id);
    if (RESOURCE_ID.test(id)) ids.add(id);
  }
  return [...ids];
}

/** Where the broker's `d1.backup` writes for a resource-backed D1 (`dirname(dirname(db))/backups`). */
export function resourceBackupsDir(resourceDir: string): string {
  return join(dirname(resolve(resourceDir)), "backups");
}

/**
 * Everything the broker may touch, as a pure function of the deployment. Host
 * and sandbox paths are the same, except the owner-scoped R2 files, which are
 * mounted where the broker expects the shared ones.
 */
export function planBrokerSandbox(input: BrokerPlanInput): Mount[] {
  const resourceDir = resolve(input.resourceDir);
  const mounts: Mount[] = [];
  const ro = (source: string, dest = source) => mounts.push({ mode: "ro", source, dest });
  const rw = (source: string, dest = source) => mounts.push({ mode: "rw", source, dest });

  ro(resolve(input.bun));
  if (input.nodeModules) ro(resolve(input.nodeModules));
  ro(resolve(input.entry));
  ro(resolve(input.bindingsPath));
  if (input.secretsPath) ro(resolve(input.secretsPath));
  if (input.assetsDir) {
    ro(resolve(input.assetsDir));
    ro(join(dirname(resolve(input.assetsDir)), "assets.json"));
  }
  rw(resolve(input.stateDir));
  rw(join(resolve(input.stateDir), "d1-backups"), resourceBackupsDir(resourceDir));

  // The resources this app is bound to, and (for the quota sum) its owner's other
  // R2 buckets. Never a directory listing of the shared dir.
  const ids = new Set<string>(boundResourceIds(input.bindingsPath));
  for (const id of input.r2?.resourceIds ?? []) if (RESOURCE_ID.test(id)) ids.add(id);
  for (const id of ids) for (const file of sqliteFileSet(join(resourceDir, `${id}.sqlite`))) rw(file);

  if (input.doDb) {
    const base = resolve(input.doDb).replace(/\.sqlite$/, "");
    for (const file of sqliteFileSet(`${base}.sqlite`)) rw(file);
    rw(`${base}.do-sql`);
  }

  const owner = ownerStorageDir(resourceDir, input.r2?.ownerId);
  rw(join(owner, "r2-blobs"), join(resourceDir, "r2-blobs"));
  rw(join(owner, "r2-parts"), join(resourceDir, "r2-parts"));
  const quota = sqliteFileSet(join(owner, "r2-quota.sqlite"));
  const quotaInside = sqliteFileSet(join(resourceDir, "r2-quota.sqlite"));
  quota.forEach((file, i) => rw(file, quotaInside[i]));
  return mounts;
}

/** Create what the mounts point at, as the edge user, before bwrap runs. Also adopts legacy R2 files. */
export function prepareBrokerHostFiles(input: BrokerPlanInput, mounts: Mount[]): void {
  const resourceDir = resolve(input.resourceDir);
  adoptOwnerR2Files(resourceDir, input.r2?.ownerId, input.r2?.resourceIds ?? []);
  mkdirSync(join(resolve(input.stateDir), "d1-backups"), { recursive: true });
  if (input.doDb) mkdirSync(`${resolve(input.doDb).replace(/\.sqlite$/, "")}.do-sql`, { recursive: true });
  for (const mount of mounts) {
    if (mount.mode === "rw" && /\.sqlite(-wal|-shm)?$/.test(mount.source)) touchFiles([mount.source]);
  }
}

/** The variables a broker may see. Everything else in the edge's environment stays behind. */
const BROKER_ENV_KEYS = [
  "SB_EGRESS_URL",
  "SB_EGRESS_TOKEN",
  "SB_EGRESS_ALLOW",
  "SB_R2_TRANSFER_MAX_BYTES",
  "SB_FETCH_MAX_BYTES",
  "TZ",
] as const;

export type BrokerEnv = Partial<
  Record<"PATH" | "HOME" | "TMPDIR" | "SB_EDGE_SECRET" | "SB_BROKER_TOKEN" | (typeof BROKER_ENV_KEYS)[number], string>
>;

/**
 * The broker's whole environment. `edgeCredential` goes in `SB_EDGE_SECRET`, the
 * name the broker already reads: it is this app's own credential, not the edge's.
 */
export function brokerEnv(
  base: Record<string, string | undefined>,
  edgeCredential: string | null,
  runtime: { PATH: string; HOME: string; TMPDIR: string },
): BrokerEnv {
  const entries: Array<[string, string]> = Object.entries(runtime);
  for (const key of BROKER_ENV_KEYS) {
    const value = base[key];
    if (value !== undefined && value !== "") entries.push([key, value]);
  }
  if (edgeCredential) entries.push(["SB_EDGE_SECRET", edgeCredential]);
  return Object.fromEntries(entries);
}

const DEFAULT_ROBIND = "/usr:/lib:/lib64:/etc/ld.so.cache:/etc/ld.so.conf:/etc/ld.so.conf.d:/etc/alternatives";

/** bwrap argv (up to and including `--`) for the broker. */
export function brokerBwrapArgs(mounts: Mount[], env: BrokerEnv): string[] {
  const uid = process.env.SPROUTBOAT_BROKER_UID || process.env.SPROUTBOAT_SPROUT_UID || "65534";
  const gid = process.env.SPROUTBOAT_BROKER_GID || process.env.SPROUTBOAT_SPROUT_GID || "65534";
  const args = [
    "bwrap",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--clearenv",
    "--new-session",
    "--die-with-parent",
    "--uid",
    uid,
    "--gid",
    gid,
    "--hostname",
    "broker",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--chdir",
    "/tmp",
  ];
  for (const [name, value] of Object.entries(env)) if (value !== undefined) args.push("--setenv", name, value);
  const robind = (process.env.SPROUTBOAT_BROKER_ROBIND ?? DEFAULT_ROBIND).split(":").filter(Boolean);
  for (const path of robind) args.push("--ro-bind-try", path, path);
  for (const mount of mounts) args.push(mount.mode === "ro" ? "--ro-bind" : "--bind", mount.source, mount.dest);
  args.push("--");
  return args;
}

/**
 * `args` without its `--token <value>` pair. The broker reads the token from `SB_BROKER_TOKEN` instead,
 * so it is not in the process's command line, which other local users can read.
 */
export function withoutToken(args: string[]): string[] {
  const at = args.indexOf("--token");
  return at < 0 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
}

/** The options of a `brokerBwrapArgs` result (no leading `bwrap`, no trailing `--`), NUL separated: bwrap's `--args` format. */
export function bwrapArgsFileContent(bwrapArgv: string[]): string {
  return bwrapArgv.slice(1, -1).join("\0") + "\0";
}

/**
 * The command that starts the broker with bubblewrap's options read from `argsFile` instead of the command line,
 * so the `--setenv` values (the egress token, the edge credential, the broker token) never appear in
 * `/proc/<pid>/cmdline`. bash opens the file, deletes it, and execs bwrap with the descriptor.
 * `payload` is what runs inside the sandbox (bun, the entry, its flags).
 */
export function brokerLaunchCommand(argsFile: string, payload: string[], bwrapPath = "bwrap"): string[] {
  return [
    "/bin/bash",
    "-c",
    'exec {fd}<"$0"; rm -f -- "$0"; bwrap=$1; shift; exec "$bwrap" --args "$fd" -- "$@"',
    argsFile,
    bwrapPath,
    ...payload,
  ];
}

/** Write the bwrap options file, readable by this user only. */
export function writeBwrapArgsFile(path: string, bwrapArgv: string[]): void {
  writeFileSync(path, bwrapArgsFileContent(bwrapArgv), { mode: 0o600 });
}
