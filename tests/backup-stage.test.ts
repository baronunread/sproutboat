import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// infra/sb-backup-stage resolves Caddy's data dir and snapshots config for the
// backup user. Run it unprivileged against a temp tree with a fake systemctl.
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-stage-"));
  await mkdir(join(dir, "etc"), { recursive: true });
  await mkdir(join(dir, "state"), { recursive: true });
  await writeFile(join(dir, "etc", "control.env"), "SPROUTBOAT_BOOTSTRAP_TOKEN=abc\n", { mode: 0o600 });
  await writeFile(join(dir, "etc", "backup.key"), "k".repeat(64) + "\n", { mode: 0o400 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A systemctl that answers `show -p <prop> --value caddy` from the given values. */
async function fakeSystemctl(values: Record<string, string>): Promise<string> {
  const path = join(dir, "systemctl");
  const cases = Object.entries(values)
    .map(([prop, value]) => `    ${prop}) printf '%s\\n' '${value}' ;;`)
    .join("\n");
  await writeFile(path, `#!/usr/bin/env bash\ncase "$3" in\n${cases}\n    *) ;;\nesac\n`);
  await chmod(path, 0o755);
  return path;
}

async function stage(args: string[], systemctl: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn(["bash", "infra/sb-backup-stage", ...args], {
    env: {
      ...process.env,
      SB_ETC: join(dir, "etc"),
      SB_STATE: join(dir, "state"),
      SB_SYSTEMCTL: systemctl,
      SB_STAGE_NONROOT: "1",
      SB_CADDY_CANDIDATES: join(dir, "nowhere"),
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

test("--print-caddy-dir: XDG_DATA_HOME from the unit wins, then the unit user's home, then candidates", async () => {
  const xdg = join(dir, "xdg", "caddy");
  const fixed = join(dir, "fixed", "caddy");
  await mkdir(join(xdg, "certificates"), { recursive: true });
  await mkdir(join(fixed, "certificates"), { recursive: true });
  const withXdg = await fakeSystemctl({ Environment: `FOO=1 XDG_DATA_HOME=${join(dir, "xdg")}`, User: "" });
  expect((await stage(["--print-caddy-dir"], withXdg, { SB_CADDY_CANDIDATES: fixed })).out).toBe(xdg);

  // No XDG: the unit's user home (root here resolves via ~root), then the fixed candidates.
  const plain = await fakeSystemctl({ Environment: "", User: "" });
  expect((await stage(["--print-caddy-dir"], plain, { SB_CADDY_CANDIDATES: `${join(dir, "x")}:${fixed}` })).out).toBe(
    fixed,
  );
});

test("--print-caddy-dir: a candidate holding only instance.uuid is found, ordering is kept", async () => {
  const fresh = join(dir, "fresh", "caddy");
  const later = join(dir, "later", "caddy");
  await mkdir(fresh, { recursive: true });
  await mkdir(join(later, "certificates"), { recursive: true });
  await writeFile(join(fresh, "instance.uuid"), "u");
  const sc = await fakeSystemctl({ Environment: "", User: "" });
  expect((await stage(["--print-caddy-dir"], sc, { SB_CADDY_CANDIDATES: `${fresh}:${later}` })).out).toBe(fresh);
  expect((await stage(["--print-caddy-dir"], sc, { SB_CADDY_CANDIDATES: `${later}:${fresh}` })).out).toBe(later);
});

test("--print-caddy-dir: with no certificates anywhere it prints the unit's own default", async () => {
  const xdg = join(dir, "xdg");
  const sc = await fakeSystemctl({ Environment: `XDG_DATA_HOME=${xdg}`, User: "" });
  const result = await stage(["--print-caddy-dir"], sc);
  expect(result).toMatchObject({ code: 0, out: join(xdg, "caddy") });
});

test("stage: snapshots /etc/sproutboat and Caddy data (no locks), --delete keeps it in step, idempotent", async () => {
  const caddy = join(dir, "caddy-data");
  await mkdir(join(caddy, "certificates", "acme"), { recursive: true });
  await mkdir(join(caddy, "locks"), { recursive: true });
  await writeFile(join(caddy, "certificates", "acme", "site.crt"), "CERT");
  await writeFile(join(caddy, "locks", "issue.lock"), "L");
  const sc = await fakeSystemctl({ Environment: "", User: "" });
  const env = { SB_CADDY_CANDIDATES: caddy };
  const snap = join(dir, "state", "config-snapshot");

  for (let i = 0; i < 2; i++) expect(await stage([], sc, env)).toEqual({ code: 0, out: "", err: "" });
  expect(await readFile(join(snap, "etc", "sproutboat", "control.env"), "utf8")).toBe(
    "SPROUTBOAT_BOOTSTRAP_TOKEN=abc\n",
  );
  expect((await readFile(join(snap, "etc", "sproutboat", "backup.key"), "utf8")).length).toBe(65);
  // Secret files are never widened by the copy.
  for (const [name, mode] of [
    ["control.env", 0o600],
    ["backup.key", 0o400],
  ] as const)
    expect((await stat(join(snap, "etc", "sproutboat", name))).mode & 0o777).toBe(mode);
  expect(await readFile(join(snap, "caddy", "certificates", "acme", "site.crt"), "utf8")).toBe("CERT");
  expect(await Bun.file(join(snap, "caddy", "locks", "issue.lock")).exists()).toBe(false);

  await rm(join(dir, "etc", "backup.key"));
  await stage([], sc, env);
  expect(await Bun.file(join(snap, "etc", "sproutboat", "backup.key")).exists()).toBe(false);
});

test("stage: rejects an unprivileged run unless a test opts in", async () => {
  const sc = await fakeSystemctl({});
  const child = Bun.spawn(["bash", "infra/sb-backup-stage"], {
    env: {
      ...process.env,
      SB_ETC: join(dir, "etc"),
      SB_STATE: join(dir, "state"),
      SB_SYSTEMCTL: sc,
      SB_STAGE_NONROOT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain("run as root");
});
