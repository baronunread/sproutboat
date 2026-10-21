// Run a command against local @sproutboat/{wire,runtime,toolchain} checkouts.
//   bun tools/with-local-packages.ts <path-to-sproutboat-packages> [--only wire,runtime,toolchain] -- <command...>
//
// Each requested package's node_modules/@sproutboat/<pkg> is moved aside and
// replaced by a symlink to <path>/packages/<pkg>, the command runs with inherited
// stdio, and the original entries are put back afterwards: on success, on
// failure, and on SIGINT/SIGTERM/SIGHUP. A run killed outright (SIGKILL) leaves
// the backups in place; the next run restores them before doing anything else.
//
// It refuses to run in the main checkout while that has uncommitted changes:
// use a worktree (`git worktree add ../sb-try origin/main`) for experiments.
import { existsSync, lstatSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { constants } from "node:os";
import { join, resolve } from "node:path";

const known = ["wire", "runtime", "toolchain"];
const root = resolve(import.meta.dir, "..");
const scope = join(root, "node_modules/@sproutboat");
const backupSuffix = ".with-local-packages-backup";
const usage =
  "usage: bun tools/with-local-packages.ts <path-to-sproutboat-packages> [--only wire,runtime,toolchain] -- <command...>";

function fail(message: string): never {
  console.error(`with-local-packages: ${message}`);
  process.exit(2);
}

function git(...args: string[]): string {
  const run = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) fail(`git ${args.join(" ")} failed: ${run.stderr.toString().trim()}`);
  return run.stdout.toString().trim();
}

/** The main checkout is where the user keeps work in progress; a linked worktree is fair game. */
function refuseDirtyMainCheckout(): void {
  const gitDir = resolve(root, git("rev-parse", "--git-dir"));
  const commonDir = resolve(root, git("rev-parse", "--git-common-dir"));
  if (gitDir !== commonDir) return;
  const changes = git("status", "--porcelain");
  if (!changes) return;
  fail(
    [
      `${root} is the main checkout and has uncommitted changes:`,
      changes
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
      "Linking packages here could get mixed up with that work. Run it from a worktree instead:",
      `  git -C ${root} worktree add /tmp/sb-try origin/main && cd /tmp/sb-try && bun install`,
    ].join("\n"),
  );
}

/** Put back whatever a previous run left moved aside (it was killed before it could). */
function restoreLeftovers(): void {
  if (!existsSync(scope)) return;
  for (const entry of readdirSync(scope)) {
    if (!entry.endsWith(backupSuffix)) continue;
    const pkg = entry.slice(0, -backupSuffix.length);
    const target = join(scope, pkg);
    if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(target);
    if (existsSync(target)) fail(`both ${target} and its backup exist; remove one by hand`);
    renameSync(join(scope, entry), target);
    console.error(`with-local-packages: restored ${target} left over from an interrupted run`);
  }
}

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
if (dash === -1 || dash === argv.length - 1) fail(usage);
const options = argv.slice(0, dash);
const command = argv.slice(dash + 1);
const onlyAt = options.indexOf("--only");
const only = onlyAt === -1 ? null : options[onlyAt + 1];
if (onlyAt !== -1) options.splice(onlyAt, 2);
if (options.length !== 1 || only === undefined) fail(usage);
const packagesRoot = resolve(options[0]);
if (!existsSync(join(packagesRoot, "packages"))) fail(`${packagesRoot} has no packages/ directory`);
if (!existsSync(join(packagesRoot, "node_modules")))
  fail(`${packagesRoot} has no node_modules: run bun install there first`);

const requested = only === null ? known : only.split(",").map((name) => name.trim());
for (const name of requested)
  if (!known.includes(name)) fail(`unknown package "${name}"; pick from ${known.join(",")}`);
const linked = requested.filter((name) => existsSync(join(packagesRoot, "packages", name, "package.json")));
const missing = requested.filter((name) => !linked.includes(name));
if (only !== null && missing.length) fail(`not in ${packagesRoot}/packages: ${missing.join(", ")}`);
if (!linked.length) fail(`none of ${known.join(", ")} found in ${packagesRoot}/packages`);

refuseDirtyMainCheckout();
restoreLeftovers();

const swapped: string[] = [];
let restored = false;
function restore(): void {
  if (restored) return;
  restored = true;
  for (const name of swapped.reverse()) {
    const target = join(scope, name);
    if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(target);
    if (existsSync(target + backupSuffix)) renameSync(target + backupSuffix, target);
  }
  if (swapped.length) console.error(`with-local-packages: restored node_modules/@sproutboat/{${swapped.join(",")}}`);
}

let child: Bun.Subprocess | null = null;
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
for (const signal of signals) {
  process.on(signal, () => {
    // An interactive Ctrl-C already reached the child through the process
    // group; forwarding covers a signal sent to this process alone. The child
    // exiting lets the normal path below restore and exit with its status.
    if (child) child.kill(signal);
    else {
      restore();
      process.exit(130);
    }
  });
}

let code = 1;
try {
  for (const name of linked) {
    const target = join(scope, name);
    if (existsSync(target)) renameSync(target, target + backupSuffix);
    swapped.push(name);
    symlinkSync(join(packagesRoot, "packages", name), target, "dir");
  }
  console.error(
    `with-local-packages: node_modules/@sproutboat/{${linked.join(",")}} -> ${packagesRoot}/packages/; running: ${command.join(" ")}`,
  );
  child = Bun.spawn(command, { cwd: process.cwd(), stdio: ["inherit", "inherit", "inherit"] });
  await child.exited;
  code = child.exitCode ?? 128 + (child.signalCode ? constants.signals[child.signalCode] : 0);
} catch (error) {
  console.error(`with-local-packages: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  restore();
}
process.exit(code);
