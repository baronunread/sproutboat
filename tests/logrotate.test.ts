import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
const installer = read("install.sh");
const rotate = read("infra/logrotate/sproutboat");
const journald = read("infra/journald/sproutboat.conf");

describe("log rotation config", () => {
  test("logrotate names the logs, su identity and copytruncate", () => {
    expect(rotate).toContain("/var/lib/sproutboat/logs/requests.ndjson");
    expect(rotate).toContain("/var/lib/sproutboat/logs/control.ndjson");
    expect(rotate).toContain("/var/lib/sproutboat/logs/sprouts/*.log");
    expect(rotate.match(/^\s+su sproutboat-edge sproutboat$/gm)?.length).toBe(2);
    expect(rotate.match(/^\s+copytruncate$/gm)?.length).toBeGreaterThanOrEqual(2);
    expect(rotate).toContain("size 64M");
    expect(rotate).toContain("size 16M");
    expect(rotate).not.toMatch(/^\s*(daily|weekly|create)\b/m);
    expect(rotate).not.toContain("—");
  });

  test("journald cap", () => {
    expect(journald).toContain("[Journal]");
    expect(journald).toContain("SystemMaxUse=256M");
    expect(journald).toContain("SystemMaxFileSize=32M");
    expect(journald).toContain("MaxRetentionSec=1month");
  });

  test("install.sh installs, enables and uninstalls them", () => {
    expect(installer).toMatch(/apt-get install -y -qq [^\n]*\blogrotate\b/);
    expect(installer).toMatch(/dnf install -y -q [^\n]*\blogrotate\b/);
    expect(installer).toContain('install -m 0644 "$ROOT/infra/logrotate/sproutboat" /etc/logrotate.d/sproutboat');
    expect(installer).toContain(
      'install -m 0644 "$ROOT/infra/journald/sproutboat.conf" /etc/systemd/journald.conf.d/sproutboat.conf',
    );
    expect(installer).toContain("systemctl enable --now logrotate.timer 2>/dev/null || true");
    expect(installer).toContain("systemctl restart systemd-journald");
    expect(installer).toContain("cmp -s");
    expect(installer).toContain("/etc/logrotate.d/sproutboat /etc/systemd/journald.conf.d/sproutboat.conf");
    // journald restart is inside the SB_SKIP_SERVICES else branch
    expect(installer.indexOf("systemctl restart systemd-journald")).toBeGreaterThan(
      installer.indexOf('if [ "$SKIP_SERVICES" = 1 ]; then\n  say "Services'),
    );
    expect(installer).toContain("systemctl restart sproutboat-control sproutboat-egress sproutboat-edge");
  });

  const logrotate = Bun.which("logrotate");
  test.skipIf(!logrotate)("logrotate -d accepts the config", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-lr-"));
    try {
      const logs = join(dir, "logs");
      mkdirSync(join(logs, "sprouts"), { recursive: true });
      for (const f of ["requests.ndjson", "control.ndjson", "sprouts/a.log"]) writeFileSync(join(logs, f), "x\n");
      // Real identities and temp paths, so the dry run checks syntax and directives.
      const user = Bun.spawnSync(["id", "-un"]).stdout.toString().trim();
      const group = Bun.spawnSync(["id", "-gn"]).stdout.toString().trim();
      const conf = join(dir, "sproutboat");
      writeFileSync(
        conf,
        rotate
          .replaceAll("su sproutboat-edge sproutboat", `su ${user} ${group}`)
          .replaceAll("/var/lib/sproutboat/logs", logs),
      );
      chmodSync(conf, 0o644);
      const r = Bun.spawnSync([logrotate!, "-d", "-s", join(dir, "state"), conf]);
      const out = r.stdout.toString() + r.stderr.toString();
      expect(out).not.toMatch(/error:/);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
