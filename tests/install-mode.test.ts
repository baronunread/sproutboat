import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The install mode (docs/homelab.md): functions eval'd out of install.sh, and
// infra/sb-health run against fake servers with a fake systemctl.

const fns = ["valid_ip", "valid_cidr", "resolve_mode_defaults", "bind_dropins", "url_host"];
const load = fns.map((n) => `eval "$(sed -n '/^${n}()/,/^}/p' install.sh)"`).join("\n");
const prelude = `die() { echo "$*" >&2; exit 1; }\n${load}\n`;

function bash(script: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", "-c", prelude + script], { env: { PATH: process.env.PATH ?? "", ...env } });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

/** The resolved settings as a key to value map (or the failure). */
function resolve(env: Record<string, string> = {}) {
  const r = bash("resolve_mode_defaults", env);
  const map: Record<string, string> = {};
  if (r.code === 0) {
    const shown = bash(
      'eval "$(resolve_mode_defaults)"; for k in SB_MODE SB_PROXY SB_FIREWALL SB_SSH_PORT SB_SCHEME SB_BIND_HOST SB_BIND_ALLOW SB_ACME_STAGING; do printf "%s=%s\\n" "$k" "${!k}"; done',
      env,
    );
    for (const line of shown.out.split("\n")) map[line.slice(0, line.indexOf("="))] = line.slice(line.indexOf("=") + 1);
  }
  return { ...r, map };
}

const DEFAULT_ALLOW = "10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 fc00::/7 fe80::/10";

describe("mode defaults", () => {
  test("no settings at all is the unchanged public install", () => {
    const { code, map } = resolve();
    expect(code).toBe(0);
    expect(map).toEqual({
      SB_MODE: "public",
      SB_PROXY: "caddy",
      SB_FIREWALL: "ufw",
      SB_SSH_PORT: "22",
      SB_SCHEME: "https",
      SB_BIND_HOST: "127.0.0.1",
      SB_BIND_ALLOW: DEFAULT_ALLOW,
      SB_ACME_STAGING: "0",
    });
  });

  test("homelab defaults to an external proxy and no firewall takeover", () => {
    const { map } = resolve({ SB_MODE: "homelab" });
    expect(map.SB_PROXY).toBe("external");
    expect(map.SB_FIREWALL).toBe("off");
    expect(map.SB_SCHEME).toBe("https");
    expect(map.SB_BIND_HOST).toBe("127.0.0.1");
  });

  test("explicit settings win over the mode, in both modes", () => {
    expect(
      resolve({ SB_MODE: "homelab", SB_PROXY: "caddy", SB_FIREWALL: "ufw", SB_SSH_PORT: "2222" }).map,
    ).toMatchObject({
      SB_PROXY: "caddy",
      SB_FIREWALL: "ufw",
      SB_SSH_PORT: "2222",
    });
    // no forced firewall takeover in public mode either
    expect(resolve({ SB_FIREWALL: "off" }).map).toMatchObject({
      SB_MODE: "public",
      SB_PROXY: "caddy",
      SB_FIREWALL: "off",
    });
  });

  test("http is only accepted with an external proxy", () => {
    expect(resolve({ SB_SCHEME: "http" }).code).toBe(1);
    expect(resolve({ SB_MODE: "homelab", SB_PROXY: "caddy", SB_SCHEME: "http" }).err).toContain("SB_PROXY=external");
    expect(resolve({ SB_MODE: "homelab", SB_SCHEME: "http" }).map.SB_SCHEME).toBe("http");
    expect(resolve({ SB_PROXY: "external", SB_SCHEME: "http" }).map.SB_SCHEME).toBe("http");
  });

  test("a non-loopback bind is only accepted in homelab mode", () => {
    const pub = resolve({ SB_BIND_HOST: "0.0.0.0" });
    expect(pub.code).toBe(1);
    expect(pub.err).toContain("homelab");
    expect(resolve({ SB_BIND_HOST: "127.0.0.2" }).code).toBe(0);
    expect(resolve({ SB_MODE: "homelab", SB_BIND_HOST: "192.168.1.10" }).map.SB_BIND_HOST).toBe("192.168.1.10");
    expect(resolve({ SB_MODE: "homelab", SB_BIND_HOST: "::" }).code).toBe(0);
  });

  test("bad values die", () => {
    expect(resolve({ SB_MODE: "cloud" }).code).toBe(1);
    expect(resolve({ SB_PROXY: "nginx" }).code).toBe(1);
    expect(resolve({ SB_FIREWALL: "iptables" }).code).toBe(1);
    expect(resolve({ SB_SSH_PORT: "99999" }).code).toBe(1);
    expect(resolve({ SB_SSH_PORT: "ssh" }).code).toBe(1);
    expect(resolve({ SB_MODE: "homelab", SB_BIND_HOST: "my-host" }).code).toBe(1);
    expect(resolve({ SB_MODE: "homelab", SB_BIND_HOST: "300.1.1.1" }).code).toBe(1);
    expect(resolve({ SB_ACME_STAGING: "yes" }).code).toBe(1);
  });

  test("SB_BIND_ALLOW is validated as CIDRs", () => {
    const ok = resolve({ SB_MODE: "homelab", SB_BIND_HOST: "0.0.0.0", SB_BIND_ALLOW: "192.168.1.0/24 fd00::/8" });
    expect(ok.map.SB_BIND_ALLOW).toBe("192.168.1.0/24 fd00::/8");
    for (const bad of ["192.168.1.0", "192.168.1.0/33", "nonsense/8", "10.0.0.0/8 bogus", "fd00::/129", "10.0.0/8"]) {
      const r = resolve({ SB_MODE: "homelab", SB_BIND_HOST: "0.0.0.0", SB_BIND_ALLOW: bad });
      expect(r.code, bad).toBe(1);
      expect(r.err, bad).toContain("SB_BIND_ALLOW");
    }
  });
});

describe("bind drop-ins", () => {
  test("a loopback bind writes nothing, so the units keep their own 127.0.0.1", () => {
    expect(bash('bind_dropins control 127.0.0.1 "10.0.0.0/8"').out).toBe("");
    expect(bash('bind_dropins edge 127.0.0.1 "10.0.0.0/8"').out).toBe("");
  });

  test("control only gets the bind address", () => {
    const { out } = bash('bind_dropins control 192.168.1.10 "10.0.0.0/8"');
    expect(out).toContain("[Service]\nEnvironment=SPROUTBOAT_BIND_HOST=192.168.1.10");
    expect(out).not.toContain("IPAddressAllow");
  });

  test("the edge also allows every SB_BIND_ALLOW range, one line each, with a warning", () => {
    const { out } = bash('bind_dropins edge 0.0.0.0 "$A"', { A: DEFAULT_ALLOW });
    expect(out).toContain("Environment=SPROUTBOAT_BIND_HOST=0.0.0.0");
    for (const cidr of DEFAULT_ALLOW.split(" ")) expect(out).toContain(`\nIPAddressAllow=${cidr}`);
    expect(out.match(/^IPAddressAllow=/gm)?.length).toBe(7);
    expect(out).toContain("every sprout");
    expect(out).not.toContain("\u2014");
  });

  test("url_host picks an address this box can reach", () => {
    expect(bash("url_host 0.0.0.0").out).toBe("127.0.0.1");
    expect(bash("url_host ::").out).toBe("[::1]");
    expect(bash("url_host 192.168.1.10").out).toBe("192.168.1.10");
    expect(bash("url_host fd00::5").out).toBe("[fd00::5]");
  });
});

describe("sb-health in each proxy mode", () => {
  let dir: string;
  const servers: ReturnType<typeof Bun.serve>[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sb-health-"));
    await mkdir(join(dir, "etc"));
  });
  afterEach(async () => {
    for (const s of servers.splice(0)) s.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  const serve = (fetch: (r: Request) => Response) => {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
    servers.push(s);
    return `http://127.0.0.1:${s.port}`;
  };

  async function health(installEnv: string | null, extra: Record<string, string> = {}, args: string[] = []) {
    if (installEnv !== null) await writeFile(join(dir, "etc", "install.env"), installEnv);
    const systemctl = join(dir, "systemctl");
    // Records what it was asked about; every unit is active.
    await writeFile(systemctl, `#!/usr/bin/env bash\necho "$@" >> "${dir}/asked"\nexit 0\n`);
    await chmod(systemctl, 0o755);
    const control = serve(() => Response.json({ ok: true, service: "control" }));
    const edge = serve((r) => new Response("pool", { status: r.url.endsWith("/__sb/pool") ? 200 : 404 }));
    const egress = serve(() => new Response("no", { status: 401 }));
    const child = Bun.spawn(["bash", "infra/sb-health", "--timeout", "2", ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        SB_ETC: join(dir, "etc"),
        SB_SYSTEMCTL: systemctl,
        SB_HEALTH_CONTROL_URL: control,
        SB_HEALTH_EDGE_URL: edge,
        SB_HEALTH_EGRESS_URL: egress,
        SB_HEALTH_CADDY_URL: "http://127.0.0.1:1",
        SB_HEALTH_INTERVAL: "1",
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    const asked = (await Bun.file(join(dir, "asked")).text()).split("\n").filter(Boolean);
    return { code, out, asked };
  }

  test("external: no caddy unit, no :80 check, exit 0", async () => {
    const r = await health("SB_MODE=homelab\nSB_PROXY=external\n", {}, ["--json"]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out);
    expect(json.ok).toBe(true);
    expect(json.checks.map((c: { name: string }) => c.name)).toEqual(["units", "control", "edge", "egress"]);
    expect(r.asked.some((l) => l.includes("caddy"))).toBe(false);
    expect(json.checks[0].detail).toBe("all 3 units are active");
  });

  test("caddy: the caddy unit and the :80 check are there (and fail when nothing listens)", async () => {
    const r = await health("SB_MODE=public\nSB_PROXY=caddy\n", {}, ["--json"]);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.out);
    expect(json.checks.map((c: { name: string }) => c.name)).toEqual(["units", "control", "edge", "egress", "caddy"]);
    expect(json.checks.find((c: { name: string }) => c.name === "caddy").ok).toBe(false);
    expect(r.asked.some((l) => l.includes("caddy"))).toBe(true);
  });

  test("caddy answering :80 is healthy", async () => {
    const caddy = serve(() => new Response(null, { status: 308 }));
    const r = await health("SB_PROXY=caddy\n", { SB_HEALTH_CADDY_URL: caddy });
    expect(r.code).toBe(0);
  });

  test("no install.env is a public install: caddy is checked", async () => {
    const r = await health(null, {}, ["--json"]);
    expect(JSON.parse(r.out).checks.map((c: { name: string }) => c.name)).toContain("caddy");
  });

  test("a specific bind address becomes the default control and edge URL", async () => {
    // A curl that records the URLs it is asked for and fails.
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "curl"), `#!/usr/bin/env bash\necho "$@" >> "${dir}/curled"\nexit 7\n`);
    await chmod(join(bin, "curl"), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, SB_HEALTH_CONTROL_URL: "", SB_HEALTH_EDGE_URL: "" };
    await health("SB_MODE=homelab\nSB_PROXY=external\nSB_BIND_HOST=192.168.1.10\n", env, ["--json", "--timeout", "0"]);
    const curled = await Bun.file(join(dir, "curled")).text();
    expect(curled).toContain("http://192.168.1.10:8787/internal/health");
    expect(curled).toContain("http://192.168.1.10:8080/__sb/pool");
    await rm(join(dir, "curled"));
    // A wildcard bind is probed on loopback.
    await health("SB_PROXY=external\nSB_BIND_HOST=0.0.0.0\n", env, ["--json", "--timeout", "0"]);
    expect(await Bun.file(join(dir, "curled")).text()).toContain("http://127.0.0.1:8787/internal/health");
  });
});
