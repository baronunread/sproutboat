import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The safe-update scripts run here unprivileged: sb-snapshot and sb-rollback against a
// temp prefix (SB_ROLLBACK_ROOT), sb-health against Bun.serve stubs, systemctl stubbed.
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-safe-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(cmd: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}

async function put(path: string, content: string, mode?: number) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  if (mode) await chmod(path, mode);
}

describe("sb-health", () => {
  type Stub = { control: Response; edge: Response; egress: Response; caddy: Response };
  const servers: ReturnType<typeof Bun.serve>[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
  });

  function stubs(answers: Stub) {
    const hosts: (string | null)[] = [];
    const serve = (handler: (req: Request) => Response) => {
      const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
      servers.push(s);
      return `http://127.0.0.1:${s.port}`;
    };
    const urls = {
      SB_HEALTH_CONTROL_URL: serve((req) =>
        new URL(req.url).pathname === "/internal/health"
          ? answers.control.clone()
          : new Response("no", { status: 404 }),
      ),
      SB_HEALTH_EDGE_URL: serve((req) => {
        hosts.push(req.headers.get("host"));
        return new URL(req.url).pathname === "/__sb/pool" ? answers.edge.clone() : new Response("no", { status: 404 });
      }),
      SB_HEALTH_EGRESS_URL: serve(() => answers.egress.clone()),
      SB_HEALTH_CADDY_URL: serve(() => answers.caddy.clone()),
    };
    return { urls, hosts };
  }

  const healthy = (): Stub => ({
    control: Response.json({ ok: true, service: "control" }),
    edge: Response.json({ idle: 0 }),
    egress: new Response("unauthorized", { status: 401 }),
    caddy: new Response(null, { status: 308 }),
  });

  const health = (urls: Record<string, string>, extra: string[] = [], env: Record<string, string> = {}) =>
    run(["bash", "infra/sb-health", ...extra], {
      ...urls,
      SB_SYSTEMCTL: "true",
      SB_HEALTH_TIMEOUT: "2",
      SB_HEALTH_INTERVAL: "0.2",
      ...env,
    });

  test("passes against 200 / 200 / 401 / 308", async () => {
    const { urls, hosts } = stubs(healthy());
    const r = await health(urls);
    expect(r.code).toBe(0);
    for (const name of ["units", "control", "edge", "egress", "caddy"]) expect(r.out).toContain(name);
    expect(r.out).not.toContain("✗");
    expect(hosts[0]).toBe("127.0.0.1");
  });

  test("--json reports every check", async () => {
    const { urls } = stubs(healthy());
    const r = await health(urls, ["--json"]);
    expect(r.code).toBe(0);
    // SAFETY: sb-health --json prints exactly this shape; the assertions below check it.
    const parsed = JSON.parse(r.out) as { ok: boolean; checks: { name: string; ok: boolean }[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.map((c) => c.name)).toEqual(["units", "control", "edge", "egress", "caddy"]);
  });

  test("fails when the edge answers 500, and says which check", async () => {
    const answers = healthy();
    answers.edge = new Response("boom", { status: 500 });
    const { urls } = stubs(answers);
    const r = await health(urls, [], { SB_HEALTH_TIMEOUT: "1" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/✗ edge .*500/);
    expect(r.out).toMatch(/✓ control/);
  });

  test("fails when control does not say ok:true", async () => {
    const answers = healthy();
    answers.control = Response.json({ ok: false });
    const { urls } = stubs(answers);
    expect((await health(urls, [], { SB_HEALTH_TIMEOUT: "1" })).code).toBe(1);
  });

  test("fails when nothing listens, and when a unit is inactive", async () => {
    const dead = { SB_HEALTH_CONTROL_URL: "http://127.0.0.1:1", SB_HEALTH_EDGE_URL: "http://127.0.0.1:1" };
    const { urls } = stubs(healthy());
    expect((await health({ ...urls, ...dead }, [], { SB_HEALTH_TIMEOUT: "1" })).code).toBe(1);
    const failing = join(dir, "systemctl");
    await put(failing, '#!/usr/bin/env bash\n[ "$3" = caddy ] && exit 3\nexit 0\n', 0o755);
    const r = await health(urls, [], { SB_SYSTEMCTL: failing, SB_HEALTH_TIMEOUT: "1" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/✗ units .*caddy/);
  });

  test("waits for a service that comes up late", async () => {
    const answers = healthy();
    const { urls } = stubs(answers);
    const late = join(dir, "up");
    // The control stub is healthy; the units check passes only once the flag file exists.
    await put(join(dir, "systemctl"), `#!/usr/bin/env bash\n[ -e ${late} ]\n`, 0o755);
    setTimeout(() => void writeFile(late, ""), 700);
    const r = await health(urls, [], { SB_SYSTEMCTL: join(dir, "systemctl"), SB_HEALTH_TIMEOUT: "5" });
    expect(r.code).toBe(0);
  });
});

const hostEnv = (root: string, prev: string, bin: string) => ({
  SB_ROLLBACK_ROOT: root,
  SB_ROLLBACK_PREV: prev,
  SB_SYSTEMCTL: join(root, "systemctl"),
  SB_HEALTH_BIN: bin,
});

describe("sb-snapshot and sb-rollback", () => {
  let prev: string;
  let env: ReturnType<typeof hostEnv>;
  let log: string;

  beforeEach(async () => {
    prev = join(dir, "prev");
    log = join(dir, "systemctl.log");
    await put(join(dir, "systemctl"), `#!/usr/bin/env bash\necho "$*" >> ${log}\n`, 0o755);
    await put(join(dir, "healthy"), "#!/usr/bin/env bash\necho health-ok\n", 0o755);
    await put(join(dir, "unhealthy"), "#!/usr/bin/env bash\necho health-bad\nexit 1\n", 0o755);
    env = hostEnv(dir, prev, join(dir, "healthy"));
    // The "old" release.
    await put(join(dir, "opt/sproutboat/install.sh"), "old installer\n", 0o755);
    await put(join(dir, "opt/sproutboat/package.json"), '{ "name": "x", "version": "0.13.1" }\n');
    await put(join(dir, "opt/sproutboat/apps/control/main.ts"), "old main\n");
    await put(join(dir, "opt/sproutboat/bun/bin/bun"), "old bun\n", 0o755);
    await put(join(dir, "opt/sproutboat/node_modules/dep/index.js"), "dep\n");
    await put(join(dir, "etc/sproutboat/control.env"), "TOKEN=old\n", 0o600);
    await put(
      join(dir, "etc/sproutboat/update.env"),
      "SPROUTBOAT_UPDATE_REPO=r\nSPROUTBOAT_UPDATE_REF=\nSPROUTBOAT_UPDATE_COMMIT=abc123\n",
      0o600,
    );
    await put(join(dir, "etc/caddy/Caddyfile"), "old caddyfile\n");
    await put(join(dir, "etc/systemd/system/sproutboat-edge.service"), "old unit\n");
    await put(join(dir, "etc/systemd/system/caddy.service.d/sproutboat.conf"), "old caddy dropin\n");
    await put(join(dir, "usr/local/bin/sbctl"), "old sbctl\n", 0o755);
    await put(join(dir, "usr/local/bin/caddy-sproutboat"), "old caddy\n", 0o755);
    await put(join(dir, "usr/local/lib/sproutboat/update"), "old update\n", 0o755);
    await put(join(dir, "usr/local/lib/sproutboat/engine"), "old engine\n", 0o755);
    await put(join(dir, "usr/local/lib/sproutboat/bin/sproutboat-edge"), "old edge bin\n", 0o755);
  });

  const snapshot = (extra: string[] = [], more: Record<string, string> = {}) =>
    run(["bash", "infra/sb-snapshot", ...extra], { ...env, ...more });
  const rollback = (more: Record<string, string> = {}) => run(["bash", "infra/sb-rollback"], { ...env, ...more });
  const read = (path: string) => readFile(join(dir, path), "utf8");
  const exists = (path: string) =>
    stat(join(dir, path)).then(
      () => true,
      () => false,
    );

  /** What a half-finished update of the host looks like. */
  async function breakHost() {
    await put(join(dir, "opt/sproutboat/install.sh"), "new installer\n", 0o755);
    await put(join(dir, "opt/sproutboat/apps/control/main.ts"), "new main\n");
    await put(join(dir, "opt/sproutboat/apps/control/added.ts"), "added by the new release\n");
    await rm(join(dir, "opt/sproutboat/node_modules"), { recursive: true });
    await put(join(dir, "opt/sproutboat/bun/bin/bun"), "new bun\n", 0o755);
    await put(join(dir, "etc/sproutboat/control.env"), "TOKEN=new\n", 0o600);
    await put(join(dir, "etc/sproutboat/engine.env"), "SB_EDGE=rust\n");
    await put(join(dir, "etc/caddy/Caddyfile"), "new caddyfile\n");
    await put(join(dir, "etc/systemd/system/sproutboat-edge.service"), "new unit\n");
    await put(join(dir, "etc/systemd/system/caddy.service.d/sproutboat.conf"), "new caddy dropin\n");
    await put(join(dir, "etc/systemd/system/sproutboat-edge.service.d/10-engine.conf"), "[Service]\n");
    await put(join(dir, "usr/local/bin/sbctl"), "new sbctl\n", 0o755);
    await put(join(dir, "usr/local/bin/caddy-sproutboat"), "new caddy\n", 0o755);
    await put(join(dir, "usr/local/lib/sproutboat/update"), "new update\n", 0o755);
    await put(join(dir, "usr/local/lib/sproutboat/bin/sproutboat-edge"), "new edge bin\n", 0o755);
    await put(join(dir, "usr/local/lib/sproutboat/bin/sproutboat-egress"), "new egress bin\n", 0o755);
    await put(join(dir, "usr/local/lib/sproutboat/rollback"), "new rollback\n", 0o755);
    await put(join(dir, "usr/local/lib/sproutboat/health"), "new health\n", 0o755);
  }

  test("the snapshot records the release and copies the tree, config and helpers", async () => {
    const r = await snapshot();
    expect(r.code).toBe(0);
    const release = await readFile(join(prev, "RELEASE"), "utf8");
    expect(release).toContain("version=0.13.1");
    expect(release).toContain("commit=abc123");
    expect(release).toMatch(/^date=\d{4}-/m);
    expect(await readFile(join(prev, "tree/node_modules/dep/index.js"), "utf8")).toBe("dep\n");
    expect(await readFile(join(prev, "tree/bun/bin/bun"), "utf8")).toBe("old bun\n");
    expect(await readFile(join(prev, "etc/sproutboat/control.env"), "utf8")).toBe("TOKEN=old\n");
    expect(await readFile(join(prev, "etc/systemd/system/caddy.service.d/sproutboat.conf"), "utf8")).toBe(
      "old caddy dropin\n",
    );
    expect(await readFile(join(prev, "usr/local/lib/sproutboat/bin/sproutboat-edge"), "utf8")).toBe("old edge bin\n");
    expect(await readFile(join(prev, "usr/local/bin/caddy-sproutboat"), "utf8")).toBe("old caddy\n");
  });

  test("a second snapshot replaces the first and drops what is gone", async () => {
    await snapshot();
    await rm(join(dir, "opt/sproutboat/apps/control/main.ts"));
    await rm(join(dir, "usr/local/lib/sproutboat/bin"), { recursive: true });
    expect((await snapshot()).code).toBe(0);
    expect(await Bun.file(join(prev, "tree/apps/control/main.ts")).exists()).toBe(false);
    expect(await Bun.file(join(prev, "usr/local/lib/sproutboat/bin/sproutboat-edge")).exists()).toBe(false);
  });

  test("the snapshot refuses when the disk cannot hold it, and changes nothing", async () => {
    const r = await snapshot([], { SB_SNAPSHOT_SLACK_MIB: "999999999" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("not enough disk");
    expect(await Bun.file(join(prev, "RELEASE")).exists()).toBe(false);
    expect((await snapshot(["--check"])).code).toBe(0);
  });

  test("rollback restores the tree, config, units, helpers and engines of a broken update", async () => {
    await snapshot();
    await breakHost();
    const r = await rollback();
    expect(r.code).toBe(0);
    expect(r.out).toContain("rolled back to version=0.13.1 commit=abc123");
    expect(await read("opt/sproutboat/install.sh")).toBe("old installer\n");
    expect(await read("opt/sproutboat/apps/control/main.ts")).toBe("old main\n");
    expect(await exists("opt/sproutboat/apps/control/added.ts")).toBe(false);
    expect(await read("opt/sproutboat/node_modules/dep/index.js")).toBe("dep\n");
    expect(await read("opt/sproutboat/bun/bin/bun")).toBe("old bun\n");
    expect(await read("etc/sproutboat/control.env")).toBe("TOKEN=old\n");
    expect((await stat(join(dir, "etc/sproutboat/control.env"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "etc/sproutboat/update.env"))).mode & 0o777).toBe(0o600);
    expect(await read("etc/caddy/Caddyfile")).toBe("old caddyfile\n");
    expect(await read("etc/systemd/system/sproutboat-edge.service")).toBe("old unit\n");
    expect(await read("etc/systemd/system/caddy.service.d/sproutboat.conf")).toBe("old caddy dropin\n");
    expect(await exists("etc/systemd/system/sproutboat-edge.service.d/10-engine.conf")).toBe(false);
    expect(await read("usr/local/bin/sbctl")).toBe("old sbctl\n");
    expect(await read("usr/local/bin/caddy-sproutboat")).toBe("old caddy\n");
    expect(await read("usr/local/lib/sproutboat/update")).toBe("old update\n");
    expect(await read("usr/local/lib/sproutboat/bin/sproutboat-edge")).toBe("old edge bin\n");
    expect(await exists("usr/local/lib/sproutboat/bin/sproutboat-egress")).toBe(false);
    // The helpers that ran the rollback stay, so `sbctl rollback` and `sbctl health` still work.
    expect(await read("usr/local/lib/sproutboat/rollback")).toBe("new rollback\n");
    expect(await read("usr/local/lib/sproutboat/health")).toBe("new health\n");
  });

  test("rollback restarts the services in order and restarts Caddy when its binary changed", async () => {
    await snapshot();
    await breakHost();
    expect((await rollback()).code).toBe(0);
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    expect(calls).toEqual([
      "daemon-reload",
      "restart sproutboat-control sproutboat-egress sproutboat-edge",
      "restart caddy",
    ]);
    await rm(log);
    expect((await rollback()).code).toBe(0);
    expect((await readFile(log, "utf8")).trim().split("\n").at(-1)).toBe("reload-or-restart caddy");
    // A Caddyfile whose admin endpoint differs from the restored one: `caddy reload`
    // would dial an address the running instance does not serve, so restart.
    await rm(log);
    await put(join(dir, "etc/caddy/Caddyfile"), '{\n\tadmin "unix//run/caddy-admin.sock|0600"\n}\n');
    expect((await rollback()).code).toBe(0);
    expect((await readFile(log, "utf8")).trim().split("\n").at(-1)).toBe("restart caddy");
  });

  test("rollback exits non-zero and points at the backup when the host stays unhealthy", async () => {
    await snapshot();
    await breakHost();
    const r = await rollback({ SB_HEALTH_BIN: join(dir, "unhealthy") });
    expect(r.code).toBe(1);
    expect(r.out).toContain("health-bad");
    expect(r.err).toContain("sbctl restore <archive> --force");
    // The files are back regardless.
    expect(await read("opt/sproutboat/install.sh")).toBe("old installer\n");
  });

  test("rollback refuses without a complete snapshot and touches nothing", async () => {
    await breakHost();
    const none = await rollback();
    expect(none.code).toBe(1);
    expect(none.err).toContain("no usable snapshot");
    await snapshot();
    await rm(join(prev, "RELEASE"));
    expect((await rollback()).code).toBe(1);
    expect(await read("opt/sproutboat/install.sh")).toBe("new installer\n");
    expect(await exists("systemctl.log")).toBe(false);
  });
});

describe("sb-rollback mirror() with the real host prefix (empty SB_ROLLBACK_ROOT)", () => {
  test("a drop-in dir missing from the snapshot is removed without aborting", async () => {
    // Regression: `rm -rf "${PFX:?}/$rel"` aborted the whole rollback on a real host, where
    // PFX is empty, right after restoring the tree (units, daemon-reload and restart never ran).
    const prev = join(dir, "prev");
    await mkdir(prev, { recursive: true });
    const rel = join(dir, "etc/systemd/system/sproutboat-control.service.d").replace(/^\//, "");
    await put(join("/", rel, "10-engine.conf"), "[Service]\n");
    const script = [
      "set -euo pipefail",
      'PFX=""',
      `PREV=${JSON.stringify(prev)}`,
      await Bun.$`sed -n '/^mirror() {/,/^}/p' infra/sb-rollback`.text(),
      `mirror ${JSON.stringify(rel)}`,
      "echo mirror-ok",
    ].join("\n");
    const r = await run(["bash", "-c", script]);
    expect(r.err).toBe("");
    expect(r.out.trim()).toBe("mirror-ok");
    expect(
      await stat(join("/", rel)).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const text = await readFile("infra/sb-rollback", "utf8");
    expect(text).not.toContain("${PFX:?}");
    expect(await readFile("infra/sb-snapshot", "utf8")).not.toContain("${PFX:?}");
  });
});

describe("sbctl changelog_range", () => {
  const changelog = [
    "# Changelog",
    "",
    "intro",
    "",
    "## [Unreleased]",
    "- next",
    "",
    "## [0.14.0] - 2026-11-10",
    "- new",
    "",
    "## [0.13.1] - 2026-11-02",
    "- fix",
    "",
    "## [0.13.0] - 2026-11-02",
    "- feature",
    "",
  ].join("\n");
  const range = async (version: string) => {
    const file = join(dir, "CHANGELOG.md");
    await writeFile(file, changelog);
    const r = await run([
      "bash",
      "-c",
      `eval "$(sed -n '/^changelog_range()/,/^}/p' infra/sbctl)"; changelog_range '${file}' '${version}'`,
    ]);
    return r.out;
  };

  test("prints every section above the installed version", async () => {
    const out = await range("0.13.1");
    expect(out).toContain("## [Unreleased]");
    expect(out).toContain("## [0.14.0] - 2026-11-10");
    expect(out).not.toContain("0.13.1");
    expect(out).not.toContain("intro");
    expect(await range("0.14.0")).not.toContain("0.14.0");
  });

  test("prints everything when the installed version has no heading", async () => {
    const out = await range("9.9.9");
    expect(out).toContain("## [0.13.0] - 2026-11-02");
  });
});

describe("install.sh rollback trap", () => {
  /** Runs the real rollback_armed with a stub staged sb-rollback; `body` is the failing update. */
  async function update(body: string, env: Record<string, string> = {}, stub?: string) {
    await put(join(dir, "src/infra/sb-rollback"), stub ?? `echo "rollback health=$SB_HEALTH_BIN" >> '${dir}/calls'\n`);
    const script = [
      "set -euo pipefail",
      `eval "$(sed -n '/^rollback_armed()/,/^}/p' install.sh)"`,
      'say() { echo "say: $*"; }; warn() { echo "warn: $*" >&2; }',
      `C_ERR=; C_0=; SRC='${dir}/src'; PRE_UPDATE_BACKUP=/b/sproutboat-1.tar.gz.enc`,
      "trap 'rollback_armed $?' EXIT",
      body,
    ].join("\n");
    const r = await run(["bash", "-c", script], env);
    const calls = await readFile(join(dir, "calls"), "utf8").catch(() => "");
    return { ...r, calls };
  }

  test("a failing step runs the staged rollback and exits with the same non-zero code", async () => {
    const r = await update("false || exit 3");
    expect(r.code).toBe(3);
    expect(r.calls).toBe(`rollback health=${dir}/src/infra/sb-health\n`);
    expect(r.err).toContain("sbctl restore /b/sproutboat-1.tar.gz.enc --force");
  });

  test("set -e failures and die-style exit 1 roll back too", async () => {
    expect((await update("false")).code).toBe(1);
    expect((await update("exit 1")).calls).toContain("rollback");
  });

  test("a rollback that itself fails still exits with the update's code", async () => {
    const r = await update("exit 4", {}, "exit 1\n");
    expect(r.code).toBe(4);
  });

  test("SB_NO_ROLLBACK=1 keeps the failed update and still exits non-zero", async () => {
    const r = await update("exit 5", { SB_NO_ROLLBACK: "1" });
    expect(r.code).toBe(5);
    expect(r.calls).toBe("");
    expect(r.err).toContain("leaving the failed update in place");
  });

  test("a disarmed trap or a clean exit runs no rollback", async () => {
    expect((await update("trap - EXIT; exit 0")).calls).toBe("");
    const clean = await update("exit 0");
    expect(clean.code).toBe(0);
    expect(clean.calls).toBe("");
  });
});
