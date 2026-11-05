import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@sproutboat/config";
import { validateHttpSyncSource } from "@sproutboat/runtime";
import { validateManifest } from "@sproutboat/artifact";
import { validateArtifactDirectory } from "../apps/control/src/artifact";
import { artifactDigest, deploymentHostname } from "../apps/control/src/deployments";
import { profileForUser, reserveUsername, validUsername } from "../apps/control/src/identity";
import { createCliAuthorization, exchangeCliAuthorization } from "../apps/control/src/cli-authorization";
import { readVarsFromEnv, wrapNativeFetchHandler } from "../tools/compile";

describe("Phase A contracts", () => {
  beforeAll(async () => {
    // Point the control DB at a writable temp file — the default
    // /var/lib/sproutboat path does not exist on a clean CI runner.
    process.env.SPROUTBOAT_DATABASE_PATH = join(await mkdtemp(join(tmpdir(), "sb-contracts-")), "sproutboat.sqlite");
  });

  test("accepts the documented sproutboat.jsonc shape", () => {
    expect(
      parseConfig(
        `{ // comment\n "name": "hello", "main": "src/index.js", "compatibility_date": "2026-08-26", "vars": { "GREETING": "hello" }, }`,
      ).ok,
    ).toBe(true);
  });

  test("rejects unsupported configuration fields and secret-like vars", () => {
    const result = parseConfig(
      `{"name":"Hello","main":"../index.js","compatibility_date":"today","bogus":{},"vars":{"token":3}}`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(expect.arrayContaining(["unsupported config field: bogus"]));
  });

  test("accepts an assets block and rejects a malformed one", () => {
    const ok = parseConfig(
      `{"name":"hello","main":"src/index.js","compatibility_date":"2026-08-26","assets":{"directory":"public","binding":"ASSETS","not_found_handling":"single-page-application","run_sprout_first":["/api/*"]}}`,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok)
      expect(ok.value.assets).toEqual({
        directory: "public",
        binding: "ASSETS",
        not_found_handling: "single-page-application",
        run_sprout_first: ["/api/*"],
      });
    expect(
      parseConfig(
        `{"name":"hello","main":"src/index.js","compatibility_date":"2026-08-26","assets":{"binding":"ASSETS"}}`,
      ).ok,
    ).toBe(false);
    expect(
      parseConfig(
        `{"name":"hello","main":"src/index.js","compatibility_date":"2026-08-26","assets":{"directory":"public","not_found_handling":"spa"}}`,
      ).ok,
    ).toBe(false);
  });

  test("accepts a complete artifact-v2 manifest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(
      validateManifest({
        schemaVersion: 2,
        project: "hello",
        target: "linux-x86_64",
        runtime: "native-fetch",
        capabilityProfile: "http-sync-v0",
        porfforVersion: "alpha-3",
        esbuildVersion: "0.28.2",
        buildImage: "sha256:image",
        sourceHash: digest,
        binaryHash: digest,
        binarySize: 42,
        builtAt: "2026-08-26T00:00:00.000Z",
      }).ok,
    ).toBe(true);
  });

  test("accepts the frozen capability handlers and rejects unsupported source", async () => {
    const accepted = await Bun.file("tests/porffor/capabilities/01-hello.js").text();
    const rejected = await Bun.file("tests/porffor/rejected/02-node-api.js").text();
    expect(validateHttpSyncSource(accepted).ok).toBe(true);
    expect(validateHttpSyncSource(rejected).ok).toBe(false);
    // #174 — fetch() needs no config: a bare upstream call is accepted.
    expect(
      validateHttpSyncSource(`export default { async fetch() { return fetch("https://example.com"); } };`).ok,
    ).toBe(true);
  });

  test("allows console — native-fetch logs go to the sprout's stderr, not a protocol stream", () => {
    expect(
      validateHttpSyncSource(`export default { fetch() { console.log("hello"); return new Response("ok"); } }`).ok,
    ).toBe(true);
  });

  test("bakes sproutboat.jsonc vars into the handler as a module-scoped env binding (#8)", () => {
    const handler = `export default { fetch(request) { return new Response(env.GREETING); } };`;
    const wrapped = wrapNativeFetchHandler(handler, "// prelude", { GREETING: "hej", COUNT: "3" });
    expect(wrapped).toContain(`const env = {"GREETING":"hej","COUNT":"3"};`);
    expect(wrapped.indexOf("const env =")).toBeLessThan(wrapped.indexOf("export default"));
    // no vars -> empty object, still valid (compat harness path)
    expect(wrapNativeFetchHandler(handler, "// prelude")).toContain(`const env = {};`);
  });

  test("readVarsFromEnv parses SPROUTBOAT_VARS_JSON and rejects non-string / bad names", () => {
    process.env.SPROUTBOAT_VARS_JSON = `{"API_BASE":"https://x.test","N":"1"}`;
    expect(readVarsFromEnv()).toEqual({ API_BASE: "https://x.test", N: "1" });
    process.env.SPROUTBOAT_VARS_JSON = `{"lower":"x"}`;
    expect(() => readVarsFromEnv()).toThrow(/UPPER_SNAKE/);
    process.env.SPROUTBOAT_VARS_JSON = `{"OK":3}`;
    expect(() => readVarsFromEnv()).toThrow(/must map/);
    delete process.env.SPROUTBOAT_VARS_JSON;
    expect(readVarsFromEnv()).toEqual({});
  });

  test("rejects an artifact directory that is missing its sprout", async () => {
    const path = await mkdtemp(join(tmpdir(), "sproutboat-invalid-artifact-"));
    await Bun.write(`${path}/manifest.json`, "{}");
    const result = await validateArtifactDirectory(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(expect.arrayContaining(["sprout is missing or unreadable"]));
  });

  test("#80 — artifact digest covers the sidecars, not just the sprout hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sb-digest-"));
    const binaryHash = `sha256:${"a".repeat(64)}`;

    const bare = await artifactDigest(dir, binaryHash);
    expect(bare).toMatch(/^[a-f0-9]{64}$/);
    expect(bare).not.toBe(binaryHash.slice("sha256:".length)); // not the raw sprout hash

    await Bun.write(join(dir, "assets.json"), `{"files":{"/a":{"hash":"x","size":1}}}`);
    const withAssets = await artifactDigest(dir, binaryHash);
    expect(withAssets).not.toBe(bare);

    await Bun.write(join(dir, "assets.json"), `{"files":{"/a":{"hash":"CHANGED","size":1}}}`);
    const changedAssets = await artifactDigest(dir, binaryHash);
    expect(changedAssets).not.toBe(withAssets); // a changed asset tree = a new artifact

    await Bun.write(join(dir, "bindings.json"), `{"kv":["X"]}`);
    expect(await artifactDigest(dir, binaryHash)).not.toBe(changedAssets);
  });

  test("uses a reserved user namespace in nested deployment hostnames", async () => {
    process.env.SPROUTBOAT_DATABASE_PATH = join(
      await mkdtemp(join(tmpdir(), "sproutboat-profiles-")),
      "sproutboat.sqlite",
    );
    expect(validUsername("example-user")).toBe(true);
    expect(validUsername("dashboard")).toBe(false);
    expect(reserveUsername("user-a", "example-user")).toEqual(
      expect.objectContaining({ userId: "user-a", username: "example-user" }),
    );
    expect(profileForUser("user-a")).toEqual(expect.objectContaining({ username: "example-user" }));
    expect(deploymentHostname("hello", "example-user")).toBe("hello.example-user.sproutboat.com");
    expect(() => reserveUsername("user-b", "example-user")).toThrow("username is already taken");
  });

  test("creates a short-lived CLI request that cannot be exchanged before approval", async () => {
    const created = await createCliAuthorization();
    // SAFETY: a 201 response from createCliAuthorization carries this documented contract.
    const body = (await created.json()) as { deviceCode: string; userCode: string; verificationUri: string };
    expect(created.status).toBe(201);
    expect(body.deviceCode.length).toBeGreaterThan(32);
    expect(body.userCode).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/);
    expect(body.verificationUri).toContain(body.userCode);
    expect((await exchangeCliAuthorization(body.deviceCode)).status).toBe(428);
  });

  test("upgrades make existing binding databases writable by control and edge", async () => {
    const install = await Bun.file("install.sh").text();
    const controlUnit = await Bun.file("infra/systemd/sproutboat-control.service").text();
    const edgeUnit = await Bun.file("infra/systemd/sproutboat-edge.service").text();

    expect(install).toContain('install -d -m 2770 -o sproutboat-edge   -g sproutboat "$STATE/brokers"');
    expect(install).toContain('install -d -m 2770 -o sproutboat-edge   -g sproutboat "$STATE/resources"');
    expect(install).toContain("for _d in brokers resources; do");
    expect(install).toContain('chgrp -R sproutboat "$STATE/$_d"');
    expect(install).toContain('chmod -R g+rwX "$STATE/$_d"');
    expect(controlUnit).toContain("UMask=0007");
    expect(edgeUnit).toContain("UMask=0007");
    expect(install).toContain('install -d -m 2770 -o sproutboat-control -g sproutboat "$STATE/activation"');
    expect(controlUnit).toContain("SPROUTBOAT_ACTIVATION_DIR=/var/lib/sproutboat/activation");
    expect(edgeUnit).toContain("SPROUTBOAT_ACTIVATION_DIR=/var/lib/sproutboat/activation");
  });

  test("#252: brokers reach the network only through the token-gated egress unit", async () => {
    const install = await Bun.file("install.sh").text();
    const sbctl = await Bun.file("infra/sbctl").text();
    const edgeUnit = await Bun.file("infra/systemd/sproutboat-edge.service").text();
    const egressUnit = await Bun.file("infra/systemd/sproutboat-egress.service").text();
    const sandbox = await Bun.file("infra/sandbox/sprout-sandbox.sh").text();

    // The Bun fallback (sb-engine) runs a script the pinned @sproutboat/wire actually ships,
    // on the same port as the Rust unit and the one the edge points its brokers at.
    const engine = await Bun.file("infra/sb-engine").text();
    const exec = /node_modules\/@sproutboat\/wire\/src\/egress\.ts --host 127\.0\.0\.1 --port (\d+)/.exec(engine);
    expect(exec).not.toBeNull();
    expect(await Bun.file("node_modules/@sproutboat/wire/src/egress.ts").exists()).toBe(true);
    expect(egressUnit).toContain(`--host 127.0.0.1 --port ${exec![1]}`);
    expect(edgeUnit).toContain(`Environment=SB_EGRESS_URL=http://127.0.0.1:${exec![1]}`);
    expect(edgeUnit).toContain("EnvironmentFile=-/etc/sproutboat/egress.env");
    expect(egressUnit).toContain("EnvironmentFile=/etc/sproutboat/egress.env");
    // Control sends webhooks through the same service, with the same token file.
    const controlUnit = await Bun.file("infra/systemd/sproutboat-control.service").text();
    expect(controlUnit).toContain(`Environment=SB_EGRESS_URL=http://127.0.0.1:${exec![1]}`);
    expect(controlUnit).toContain("EnvironmentFile=-/etc/sproutboat/egress.env");
    // The edge's own deny stays: sprouts must not gain a route.
    expect(edgeUnit).toContain("IPAddressDeny=any");

    expect(install).toContain("for u in sproutboat-control sproutboat-edge sproutboat-egress; do");
    expect(install).toContain("systemctl restart sproutboat-control sproutboat-egress sproutboat-edge");
    expect(install).toContain('EGRESS_TOKEN=$(val_env "$ETC/egress.env" SB_EGRESS_TOKEN)');
    expect(install).toContain('chmod 0600 "$ETC/egress.env"');
    expect(sbctl).toContain("sproutboat-egress");
    // Sprouts share loopback with the service; only the token keeps them off
    // it, so the sandbox must never forward it.
    expect(sandbox).toContain("--clearenv");
    expect(sandbox).not.toContain("SB_EGRESS");
  });

  test("the base units run the Rust engines from outside the rsync tree", async () => {
    const edge = await Bun.file("infra/systemd/sproutboat-edge.service").text();
    const egress = await Bun.file("infra/systemd/sproutboat-egress.service").text();
    expect(edge).toMatch(/^ExecStart=\/usr\/local\/lib\/sproutboat\/bin\/sproutboat-edge$/m);
    expect(edge).toContain("Environment=SPROUTBOAT_BUN=/opt/sproutboat/bun/bin/bun");
    expect(edge).toContain("ExecReload=/bin/kill -HUP $MAINPID");
    expect(egress).toMatch(
      /^ExecStart=\/usr\/local\/lib\/sproutboat\/bin\/sproutboat-egress --host 127\.0\.0\.1 --port 8070$/m,
    );
    expect(egress).toContain("MemoryMax=128M");
    expect(egress).toContain("MemoryHigh=112M");
    expect(egress).toContain("EnvironmentFile=/etc/sproutboat/egress.env");
    // The egress port in the edge's SB_EGRESS_URL is the one the unit binds.
    expect(edge).toContain("Environment=SB_EGRESS_URL=http://127.0.0.1:8070");
    // The old opt-in drop-in is gone.
    expect(existsSync("infra/systemd/sproutboat-egress.service.d")).toBe(false);
  });

  test("sb-engine writes the Bun fallback drop-ins and removes them for rust", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-engine-"));
    const run = (...args: string[]) => {
      const r = Bun.spawnSync(["bash", "infra/sb-engine", ...args], {
        env: { ...process.env, SB_ENGINE_ROOT: root, SB_ENGINE_NO_RELOAD: "1" },
      });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    const edgeDropIn = join(root, "etc/systemd/system/sproutboat-edge.service.d/10-engine.conf");
    const egressDropIn = join(root, "etc/systemd/system/sproutboat-egress.service.d/10-engine.conf");
    try {
      // No engine.env: rust, so nothing is written.
      expect(run("apply").code).toBe(0);
      expect(existsSync(edgeDropIn)).toBe(false);
      expect(run("status").out).toContain("edge    rust");

      // Setting rust needs the binaries.
      expect(run("set", "both", "rust").code).not.toBe(0);

      expect(run("set", "both", "bun").code).toBe(0);
      expect(readFileSync(join(root, "etc/sproutboat/engine.env"), "utf8")).toBe("SB_EDGE=bun\nSB_EGRESS=bun\n");
      expect(readFileSync(edgeDropIn, "utf8").split("\n").filter(Boolean)).toEqual([
        "[Service]",
        "ExecStart=",
        "ExecStart=/opt/sproutboat/bun/bin/bun services/edge/src/main.ts",
      ]);
      expect(readFileSync(egressDropIn, "utf8").split("\n").filter(Boolean)).toEqual([
        "[Service]",
        "ExecStart=",
        "ExecStart=/opt/sproutboat/bun/bin/bun node_modules/@sproutboat/wire/src/egress.ts --host 127.0.0.1 --port 8070",
        "MemoryMax=512M",
        "MemoryHigh=448M",
      ]);

      // Back to rust once the binaries exist; the drop-ins go away.
      const bin = join(root, "usr/local/lib/sproutboat/bin");
      mkdirSync(bin, { recursive: true });
      for (const n of ["sproutboat-edge", "sproutboat-egress"])
        writeFileSync(join(bin, n), "#!/bin/sh\n", { mode: 0o755 });
      expect(run("set", "edge", "rust").code).toBe(0);
      expect(existsSync(edgeDropIn)).toBe(false);
      expect(existsSync(egressDropIn)).toBe(true);
      expect(run("status").out).toContain("egress  bun");
      expect(run("set", "both", "rust").code).toBe(0);
      expect(existsSync(egressDropIn)).toBe(false);
      expect(run("set", "edge", "nope").code).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("install.sh fetches checksummed Rust engines outside the rsync tree and falls back to Bun", async () => {
    const install = await Bun.file("install.sh").text();
    const sbctl = await Bun.file("infra/sbctl").text();
    expect(install).toContain("ENGINE_DIR=/usr/local/lib/sproutboat/bin");
    expect(install).toContain("install_engines()");
    expect(install).toContain("SB_ENGINE_DIR");
    expect(install).toContain("SB_ENGINE_BASE_URL");
    expect(install).toContain("releases/download");
    expect(install).toContain("SHA256SUMS");
    expect(install).toContain('install -m 0755 -o root -g root "$tmp/$(engine_asset "$n")" "$ENGINE_DIR/$n.new"');
    expect(install).toContain("--exclude /bin");
    expect(install).toContain('install -m 0755 "$ROOT/infra/sb-engine" /usr/local/lib/sproutboat/engine');
    expect(install).toContain('if [ "$ENGINE_STATUS" = none ]; then ENGINE_EDGE=bun; ENGINE_EGRESS=bun; fi');
    expect(install).toContain("engines_healthy 20");
    expect(install).toContain("/usr/local/lib/sproutboat/engine set both bun");
    expect(install).toContain("systemctl restart sproutboat-control sproutboat-egress sproutboat-edge");
    // The engine drop-ins are applied before systemd re-reads the units.
    expect(install.indexOf("/usr/local/lib/sproutboat/engine apply")).toBeLessThan(
      install.lastIndexOf("systemctl daemon-reload"),
    );
    expect(sbctl).toContain('exec "$ENGINE" status');
    expect(sbctl).toContain('"$ENGINE" set both "$1"');
  });

  test("install.sh verifies engine binaries against SHA256SUMS", async () => {
    const install = await Bun.file("install.sh").text();
    const from = install.indexOf("ENGINE_DIR=/usr/local");
    const to = install.indexOf('say "Installing the Rust engines');
    const dir = mkdtempSync(join(tmpdir(), "sb-engines-"));
    try {
      writeFileSync(join(dir, "funcs.sh"), install.slice(from, to));
      writeFileSync(join(dir, "sproutboat-edge-linux-x64"), "edge");
      writeFileSync(join(dir, "sproutboat-egress-linux-x64"), "egress");
      const sums = ["sproutboat-edge-linux-x64", "sproutboat-egress-linux-x64"].map((f) => {
        const h = new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, f))).digest("hex");
        return `${h}  ${f}\n`;
      });
      writeFileSync(join(dir, "SHA256SUMS"), sums.join(""));
      const check = () => Bun.spawnSync(["bash", "-c", `source "${dir}/funcs.sh"; verify_engines "${dir}"`]).exitCode;
      expect(check()).toBe(0);
      writeFileSync(join(dir, "sproutboat-edge-linux-x64"), "tampered");
      expect(check()).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the release workflow publishes the engines with checksums", async () => {
    const wf = await Bun.file(".github/workflows/release.yml").text();
    expect(wf).toContain('tags: ["v*"]');
    expect(wf).toContain("contents: write");
    expect(wf).toContain("x86_64-unknown-linux-musl");
    expect(wf).toContain("cargo build --locked --release");
    expect(wf).toContain("sproutboat-edge-linux-x64");
    expect(wf).toContain("sproutboat-egress-linux-x64");
    expect(wf).toContain("sha256sum");
    expect(wf).toContain("gh release upload");
    expect(wf).toContain("--clobber");
    expect(wf).toContain("workflow_dispatch");
  });

  test("backups v2: key, config snapshot and the restore order are wired", async () => {
    const install = await Bun.file("install.sh").text();
    const sbctl = await Bun.file("infra/sbctl").text();
    const unit = await Bun.file("infra/systemd/sproutboat-backup.service").text();

    // The unit stages root-only config outside its sandbox (`+`), as root, before it runs.
    expect(unit).toContain("ExecStartPre=+/usr/local/lib/sproutboat/backup-stage");
    expect(unit).toContain("User=sproutboat-control");
    expect(unit).toContain("ProtectSystem=strict");

    expect(install).toContain('install -m 0755 "$ROOT/infra/sb-backup-stage" /usr/local/lib/sproutboat/backup-stage');
    expect(install).toContain("BACKUP_KEY_FILE=$ETC/backup.key");
    expect(install).toContain('randhex > "$BACKUP_KEY_FILE"');
    expect(install).toContain('chown root:sproutboat "$BACKUP_KEY_FILE"; chmod 0640 "$BACKUP_KEY_FILE"');
    expect(install).toContain('echo "SPROUTBOAT_BACKUP_KEY_FILE=$BACKUP_KEY_FILE"');
    expect(install).toContain("/usr/local/lib/sproutboat/backup-stage ||");
    expect(install).toContain("rm -f /usr/local/lib/sproutboat/backup-stage");
    expect(install).toContain("without it every backup is unreadable");
    expect(install).toContain("systemctl restart sproutboat-control sproutboat-egress sproutboat-edge");

    for (const cmd of ["backup)", "now)", "list)", "verify)", "restore)"]) expect(sbctl).toContain(cmd);
    for (const flag of ["--no-config", "--key", "--allow-newer", "--force", "--full"]) expect(sbctl).toContain(flag);
    // Order: restore state, apply config, reseed the password, reload Caddy, start services.
    const order = [
      "backups_cli restore",
      'apply_restored_config "$cfg/config"',
      "auth-admin.ts reset-password",
      "systemctl reload-or-restart caddy",
      "systemctl start sproutboat-control sproutboat-edge sproutboat-backup.timer",
    ].map((needle) => sbctl.indexOf(needle));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(sbctl).toContain('chmod 0600 "$ETC/$rel"');
    // Caddy drop-ins stay readable for a non-root caddy user.
    expect(sbctl).toContain('caddy.d/*) install -d -m 0755 -o root -g root "$ETC/$(dirname "$rel")"');
    expect(sbctl).toContain('caddy.d/*|README.caddy) chown root:root "$ETC/$rel"; chmod 0644 "$ETC/$rel"');
    expect(sbctl).toContain('"$STAGER" --print-caddy-dir');
    expect(sbctl).toContain("SPROUTBOAT_API_URL=%s://control.%s");
  });

  test("updates stage a new installer outside the active release", async () => {
    const install = await Bun.file("install.sh").text();
    const updater = await Bun.file("infra/sb-update").text();
    const sbctl = await Bun.file("infra/sbctl").text();

    expect(install).toContain('install -m 0755 "$ROOT/infra/sb-update" /usr/local/lib/sproutboat/update');
    expect(install).toContain("SPROUTBOAT_UPDATE_COMMIT=");
    expect(install).toContain("UPDATE_COMMIT=${UPDATE_COMMIT:-unknown}");
    expect(updater).toContain('stage=$(mktemp -d "$UPDATES/stage.XXXXXXXX")');
    expect(updater).toContain("flock -n 9");
    expect(updater).toContain("checkout -q --detach FETCH_HEAD");
    expect(updater).toContain('find "$stage" -mindepth 1 -type d -exec chmod 0755 {} +');
    expect(updater).toContain("SB_PULL=0 SB_SKIP_DNS_CHECK=1 SB_UPDATE=1");
    expect(sbctl).toContain('exec "$UPDATER" "$@"');
    expect(install).toContain('install -d -m 0755 -o root -g root "$ROOT"');
    expect(install).toContain("--chmod=Du=rwx,Dgo=rx,Fu=rwX,Fgo=rX");
  });

  test("Caddy drop-ins: import line, guarded README, validate before replace", async () => {
    const install = await Bun.file("install.sh").text();
    const ref = await Bun.file("infra/caddy/Caddyfile").text();
    const example = await Bun.file("infra/caddy/caddy.d/www-redirect.caddy.example").text();

    expect(install).toContain("import /etc/sproutboat/caddy.d/*.caddy");
    expect(ref).toContain("import /etc/sproutboat/caddy.d/*.caddy");
    expect(install).toContain("install -d -m 0755 /etc/sproutboat/caddy.d");
    expect(install).toContain(
      "[ -f /etc/sproutboat/caddy.d/README.caddy ] || cat > /etc/sproutboat/caddy.d/README.caddy",
    );
    expect(install).toContain("validate --config /etc/caddy/Caddyfile.new --adapter caddyfile");
    expect(install).toContain("mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile");
    // validation happens before the live file is replaced and before the reload
    expect(install.indexOf("validate --config /etc/caddy/Caddyfile.new")).toBeLessThan(
      install.indexOf("mv /etc/caddy/Caddyfile.new"),
    );
    expect(install.indexOf("mv /etc/caddy/Caddyfile.new")).toBeLessThan(
      install.indexOf("systemctl reload-or-restart caddy"),
    );
    expect(install).toContain("systemctl restart sproutboat-control sproutboat-egress sproutboat-edge");

    // the example is a complete site block, tab indented
    expect(example).toMatch(/^www\.example\.com \{\n\tredir https:\/\/example\.com\{uri\} permanent\n\}\n$/m);
  });

  test("Caddy drop-ins: reference Caddyfile plus the example validates", async () => {
    const caddy = Bun.which("caddy");
    if (!caddy) return; // caddy is not installed on every dev machine; CI-less check
    const dir = await mkdtemp(join(tmpdir(), "sb-caddy-"));
    const drop = join(dir, "caddy.d");
    await Bun.$`mkdir -p ${drop}`;
    const example = await Bun.file("infra/caddy/caddy.d/www-redirect.caddy.example").text();
    await Bun.write(join(drop, "www.caddy"), example);
    const ref = (await Bun.file("infra/caddy/Caddyfile").text()).replace(
      "/etc/sproutboat/caddy.d/*.caddy",
      `${drop}/*.caddy`,
    );
    await Bun.write(join(dir, "Caddyfile"), ref);
    const res = await Bun.$`${caddy} validate --config ${join(dir, "Caddyfile")} --adapter caddyfile`
      .env({ ...process.env, ACME_EMAIL: "ops@example.com" })
      .quiet()
      .nothrow();
    expect(res.exitCode).toBe(0);
  });

  test("Bun and Caddy are pinned, verified and upgraded in place", async () => {
    const install = await Bun.file("install.sh").text();
    expect(install).toMatch(/^BUN_VERSION="\d+\.\d+\.\d+"$/m);
    expect(install).toMatch(/^BUN_SHA256_X64="[0-9a-f]{64}"$/m);
    expect(install).toMatch(/^BUN_SHA256_X64_BASELINE="[0-9a-f]{64}"$/m);
    expect(install).toMatch(/^CADDY_VERSION="\d+\.\d+\.\d+"$/m);
    expect(install).toMatch(/^CADDY_SHA512_AMD64="[0-9a-f]{128}"$/m);
    expect(install).toContain("fetch_verified() {");
    expect(install).toContain("curl -fsSL --retry 3");
    expect(install).toContain('[ "$BUN_HAVE" != "$BUN_VERSION" ]');
    expect(install).toContain('"v$CADDY_VERSION"*) ;;');
    expect(install).toContain("grep -qw avx2 /proc/cpuinfo");
    expect(install).toContain("sha512");
    expect(install).toContain('if [ "$CADDY_REPLACED" = 1 ]; then systemctl restart caddy;');
    expect(install).toContain("systemctl restart sproutboat-control sproutboat-egress sproutboat-edge");
    expect(install).toContain("not checksum-verified");
    expect(
      install
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("#"))
        .join("\n"),
    ).not.toMatch(/curl[^\n]*\|\s*(sudo )?bash/);
    expect(install).not.toContain("bun.sh/install");
    for (const wf of ["ci.yml", "style-doctor.yml"]) {
      const text = await Bun.file(`.github/workflows/${wf}`).text();
      const v = /^BUN_VERSION="([^"]+)"/m.exec(install)![1];
      expect(text).toMatch(new RegExp(`bun-version: "?${v.replaceAll(".", "\\.")}"?$`, "m"));
    }
  });
});

describe("memory caps", () => {
  const bash = (script: string, env: Record<string, string> = {}) =>
    Bun.spawnSync(["bash", "-c", script], { env: { PATH: process.env.PATH ?? "", ...env } });
  const fn = (name: string) => `eval "$(sed -n '/^${name}()/,/^}/p' install.sh)"`;

  test("units carry the budgeted caps and keep retrying", async () => {
    const read = (u: string) => Bun.file(`infra/systemd/${u}.service`).text();
    const [control, edge, egress, backup] = await Promise.all(
      ["control", "edge", "egress", "backup"].map((u) => read(`sproutboat-${u}`)),
    );
    expect(control).toContain("MemoryMax=384M\nMemoryHigh=320M");
    // Rust is the default engine; the sb-engine Bun drop-in restores the old cap.
    expect(egress).toContain("MemoryMax=128M\nMemoryHigh=112M");
    expect(await Bun.file("infra/sb-engine").text()).toContain("'MemoryMax=512M' 'MemoryHigh=448M'");
    expect(edge).toContain("MemoryMax=1536M\nMemoryHigh=1280M");
    expect(edge).toContain("MemorySwapMax=0");
    expect(edge).toContain("CPUQuota=200%");
    expect(edge).toContain("TasksMax=2048");
    expect(backup).toContain("MemoryMax=512M");
    expect(backup).toContain("Nice=10");
    expect(backup).toContain("IOSchedulingClass=idle");
    for (const unit of [control, edge, egress]) {
      expect(unit).toMatch(/^\[Unit\][^[]*^StartLimitIntervalSec=0$/m);
      expect(unit).toContain("Restart=always\nRestartSec=2");
    }
  });

  test("the installer writes the edge and caddy caps and runs the heavy steps capped", async () => {
    const install = await Bun.file("install.sh").text();
    expect(install).toContain("/etc/systemd/system/sproutboat-edge.service.d/10-sproutboat-memory.conf");
    expect(install).toContain("MemoryMax=${EDGE_MAX_MIB}M");
    expect(install).toContain("MemoryHigh=${EDGE_HIGH_MIB}M");
    expect(install).toContain("MemoryMax=256M\nMemoryHigh=224M\nEOF");
    expect(install.indexOf("10-sproutboat-memory.conf")).toBeLessThan(install.indexOf("  # --- start (control first"));
    expect(install).toContain('capped "$BUN" install --frozen-lockfile --silent');
    expect(install).toContain('capped "$BUN" run --silent web:build');
    expect(install).toContain('capped "$BUN" x --bun auth@1.7.1 migrate');
    expect(install).toContain("systemd-run --quiet --scope --collect -p MemoryMax=");
    expect(install).toContain("SB_BUILD_MEMORY_MAX");
    expect(install).toContain("SB_SKIP_MEMCHECK");
    expect(install.indexOf("\ncheck_build_memory\n")).toBeLessThan(install.indexOf("rsync -a --delete"));
    const sbctl = await Bun.file("infra/sbctl").text();
    expect(sbctl).toContain("memory) memory_report ;;");
    expect(sbctl).toContain("sbctl memory");
  });

  test("edge_budget_mib is half of RAM, in 64 MiB steps, at least 512", () => {
    for (const [kb, mib] of [
      [3983360, "1920"],
      [1048576, "512"],
      [16777216, "8192"],
    ] as const) {
      const r = bash(`${fn("edge_budget_mib")}; edge_budget_mib ${kb}`);
      expect(r.stdout.toString().trim()).toBe(mib);
    }
  });

  test("SB_EDGE_MEMORY_MAX overrides the computed cap and is validated", () => {
    const script = `die() { echo "$*" >&2; exit 1; }; ${fn("edge_budget_mib")}; ${fn("edge_memory_max_mib")}; edge_memory_max_mib`;
    expect(bash(script, { SB_EDGE_MEMORY_MAX: "3000" }).stdout.toString().trim()).toBe("3000");
    expect(bash(script, { SB_EDGE_MEMORY_MAX: "lots" }).exitCode).toBe(1);
  });

  test("capped runs plainly without systemd; check_build_memory refuses when short", () => {
    const plain = bash(`${fn("capped")}; capped echo hi`, { SB_SKIP_SERVICES: "1" });
    expect(plain.stdout.toString().trim()).toBe("hi");
    const check = (avail: number, env: Record<string, string>) =>
      bash(
        `die() { echo "$*" >&2; exit 1; }; mem_available_mib() { echo ${avail}; }; BUILD_MEMORY_MAX=1200M; ${fn("check_build_memory")}; check_build_memory`,
        env,
      );
    const low = check(900, { SB_UPDATE: "1" });
    expect(low.exitCode).toBe(1);
    expect(low.stderr.toString()).toContain("900 MiB");
    expect(check(900, { SB_UPDATE: "1", SB_SKIP_MEMCHECK: "1" }).exitCode).toBe(0);
    expect(check(900, {}).exitCode).toBe(0);
    expect(check(2000, { SB_UPDATE: "1" }).exitCode).toBe(0);
  });
});

describe("safe update", () => {
  const at = (text: string, needle: string) => {
    const i = text.indexOf(needle);
    expect(i, `missing: ${needle}`).toBeGreaterThanOrEqual(0);
    return i;
  };

  test("the installer installs the health and rollback scripts and removes them on uninstall", async () => {
    const install = await Bun.file("install.sh").text();
    expect(install).toContain('install -m 0755 "$ROOT/infra/sb-health" /usr/local/lib/sproutboat/health');
    expect(install).toContain('install -m 0755 "$ROOT/infra/sb-rollback" /usr/local/lib/sproutboat/rollback');
    expect(install).toContain("/usr/local/lib/sproutboat/health /usr/local/lib/sproutboat/rollback");
    expect(install).toContain("rm -rf /opt/sproutboat-prev");
  });

  test("order: memory check, disk check, backup, snapshot, trap, then the tree is synced", async () => {
    const install = await Bun.file("install.sh").text();
    const memory = at(install, "\ncheck_build_memory\n");
    const disk = at(install, 'bash "$SRC/infra/sb-snapshot" --check');
    const backup = at(install, "\n  pre_update_backup\n");
    const snapshot = at(install, 'bash "$SRC/infra/sb-snapshot" || die');
    const trap = at(install, "trap 'rollback_armed $?' EXIT");
    const sync = at(install, "rsync -a --delete --chmod=");
    expect(memory).toBeLessThan(disk);
    expect(disk).toBeLessThan(backup);
    expect(backup).toBeLessThan(snapshot);
    expect(snapshot).toBeLessThan(trap);
    expect(trap).toBeLessThan(sync);
  });

  test("the backup is verified with the staged tree, and can be skipped", async () => {
    const install = await Bun.file("install.sh").text();
    expect(install).toContain("systemctl start sproutboat-backup.service");
    expect(install).toContain('"$SRC/apps/control/src/backups.ts" verify "$archive"');
    expect(install).toContain("SB_SKIP_BACKUP");
    expect(install).toContain("fallback for data");
  });

  test("a failure after the snapshot rolls back with the staged scripts; SB_NO_ROLLBACK disables it", async () => {
    const install = await Bun.file("install.sh").text();
    expect(install).toContain('SB_HEALTH_BIN="$SRC/infra/sb-health" bash "$SRC/infra/sb-rollback"');
    expect(install).toContain("SB_NO_ROLLBACK");
    // Any non-zero exit (set -e, die, a signal) lands in the trap, which exits non-zero itself.
    expect(install).toContain('exit "$rc"');
    expect(install).toContain("trap 'exit 143' TERM");
    // The rollback is disarmed only after update.env is written, right before the summary.
    const disarm = at(install, "trap - EXIT HUP INT TERM");
    expect(disarm).toBeGreaterThan(at(install, 'chown root:root "$ETC/update.env"'));
    expect(disarm).toBeLessThan(at(install, "printf '\\n%s▸ Sproutboat is up%s\\n'"));
  });

  test("the health gate runs after the restart and fails the update; fresh installs fail on a dead unit", async () => {
    const install = await Bun.file("install.sh").text();
    expect(install).toContain("systemctl restart sproutboat-control sproutboat-egress sproutboat-edge");
    expect(install).toContain('bash "$SRC/infra/sb-health"');
    expect(install).toContain("SB_HEALTH_TIMEOUT:-45");
    expect(at(install, "health_gate || die")).toBeGreaterThan(
      at(install, "systemctl restart sproutboat-control sproutboat-egress sproutboat-edge"),
    );
    expect(install).toContain('die "$u is not active after the install');
  });

  test("sbctl gains update --check, health and rollback", async () => {
    const sbctl = await Bun.file("infra/sbctl").text();
    expect(sbctl).toContain('if [ "${1:-}" = --check ]; then update_check; exit 0; fi');
    expect(sbctl).toContain("raw.githubusercontent.com");
    expect(sbctl).toContain("  health)");
    expect(sbctl).toContain("  rollback)");
    expect(sbctl).toContain("sbctl rollback [--yes]");
    expect(sbctl).toContain("sbctl health [--json]");
  });

  test("the snapshot covers the helper scripts, engine binaries and engine drop-ins", async () => {
    const snap = await Bun.file("infra/sb-snapshot").text();
    expect(snap).toContain("  usr/local/lib/sproutboat\n"); // update, engine, backup-stage, bin/
    expect(snap).toContain("  etc/systemd/system/sproutboat-edge.service.d");
    expect(snap).toContain("  etc/systemd/system/sproutboat-egress.service.d");
    expect(snap).toContain("  etc/sproutboat\n"); // engine.env
    expect(snap).toContain("  etc/logrotate.d/sproutboat");
    expect(snap).toContain("  etc/systemd/journald.conf.d/sproutboat.conf");
    // The update never runs the engine probe: the gate is the only post-restart check.
    const install = await Bun.file("install.sh").text();
    expect(install).toContain('if [ "${SB_UPDATE:-0}" != 1 ] && { [ "$ENGINE_EDGE" = rust ]');
  });

  test("the scripts pass bash -n", () => {
    for (const f of [
      "install.sh",
      "infra/sbctl",
      "infra/sb-health",
      "infra/sb-rollback",
      "infra/sb-snapshot",
      "infra/sb-envsplit",
    ]) {
      expect(Bun.spawnSync(["bash", "-n", f]).exitCode, f).toBe(0);
    }
  });
});

describe("install mode", () => {
  test("install.sh writes install.env and backfills it, so sbctl update keeps the mode", async () => {
    const install = await Bun.file("install.sh").text();
    expect(install).toContain("INSTALL_ENV=$ETC/install.env");
    expect(install).toContain('} > "$INSTALL_ENV"');
    expect(install).toContain('chown root:root "$INSTALL_ENV"; chmod 0644 "$INSTALL_ENV"');
    expect(install).toContain('val_env "$INSTALL_ENV" "$_k"');
    for (const key of [
      "SB_MODE",
      "SB_PROXY",
      "SB_FIREWALL",
      "SB_SSH_PORT",
      "SB_SCHEME",
      "SB_BIND_HOST",
      "SB_BIND_ALLOW",
      "SB_ACME_STAGING",
    ]) {
      expect(install).toContain(`echo "${key}=$${key}"`);
    }
    // Written after the snapshot of a safe update, so the snapshot keeps the old values.
    expect(install.indexOf('"$SRC/infra/sb-snapshot" ||')).toBeLessThan(install.indexOf('} > "$INSTALL_ENV"'));
    // The Cloudflare token is read back from caddy.env.
    expect(install).toContain('val_env "$ETC/caddy.env" CLOUDFLARE_API_TOKEN');
    expect(install).toContain("--homelab) SB_MODE=homelab");
    expect(install).toContain("--public) SB_MODE=public");
  });

  test("an external proxy skips every Caddy step; homelab never touches ufw or ipify", async () => {
    const install = await Bun.file("install.sh").text();
    expect(install).toContain('if [ "$SB_PROXY" = external ]; then\n  say "Caddy: skipped');
    expect(install).toContain('[ "$SB_PROXY" != caddy ] || units+=(caddy)');
    expect(install).toContain('if [ "$SB_PROXY" = caddy ]; then\n{\n  echo "# Generated by install.sh');
    expect(install).toContain('  echo "ACME_EMAIL=$SB_ACME_EMAIL"');
    expect(install).toContain('if [ "$SB_PROXY" = caddy ]; then\nsay "Generating /etc/caddy/Caddyfile');
    expect(install).toContain('[ "$SB_MODE" = homelab ] || PUBLIC_IP=$(curl -fsS4 -m 5 https://api.ipify.org');
    expect(install).toContain('elif [ "$SB_FIREWALL" != ufw ]; then');
    expect(install).toContain('for p in "$SB_SSH_PORT" 80 443; do ufw allow');
    expect(install).toContain('[ "$SB_FIREWALL" != ufw ] || apt-get install -y -qq ufw');
    expect(install).toContain('echo "SPROUTBOAT_DASHBOARD_DIR=$ROOT/apps/web/dist/client"');
    expect(install).toContain("Host header unchanged");
    // /etc/caddy may be the operator's own on an external install.
    expect(install).toContain("= external ] || rm -rf /etc/caddy");
  });

  test("control and the edge still bind loopback by default; the drop-in is generated", async () => {
    const [control, edge, install] = await Promise.all([
      Bun.file("infra/systemd/sproutboat-control.service").text(),
      Bun.file("infra/systemd/sproutboat-edge.service").text(),
      Bun.file("install.sh").text(),
    ]);
    expect(control).toContain("Environment=SPROUTBOAT_BIND_HOST=127.0.0.1");
    expect(edge).toContain("Environment=SPROUTBOAT_BIND_HOST=127.0.0.1");
    expect(edge).toContain("IPAddressDeny=any\nIPAddressAllow=localhost");
    expect(install).toContain("20-sproutboat-bind.conf");
    expect(install).toContain('rm -f "$bind_d/20-sproutboat-bind.conf"');
  });

  test("sbctl has mode and leaves caddy out when the proxy is external", async () => {
    const sbctl = await Bun.file("infra/sbctl").text();
    expect(sbctl).toContain("  mode)");
    expect(sbctl).toContain('[ "$PROXY" = external ] || SERVICES+=(caddy)');
    expect(sbctl).toContain("this install has no Caddy (SB_PROXY=external)");
    expect(await Bun.file("infra/sb-health").text()).toContain('[ "$PROXY" = external ] || UNITS+=(caddy)');
    expect(await Bun.file("infra/sb-rollback").text()).toContain("= external ]");
  });

  test("the control server wires the dashboard module", async () => {
    const main = await Bun.file("apps/control/src/main.ts").text();
    expect(main).toContain("SPROUTBOAT_DASHBOARD_DIR");
    expect(main).toContain("serveDashboard(request, dashboardDir)");
  });
});

describe("control and supervisor agree on the per-deployment runtime name", () => {
  const supervisorModule = join(import.meta.dir, "..", "services", "supervisor", "src", "runtime-name.ts");
  const ownerDir = "0123456789abcdef0123456789abcdef";
  const digest = "f".repeat(64);
  const sproutPath = `/var/lib/sproutboat/artifacts/${ownerDir}/${digest}/sprout`;

  test("control derives <ownerDir>-<digest> from the sprout path", async () => {
    const { runtimeName } = await import("../apps/control/src/logs");
    expect(runtimeName(sproutPath)).toBe(`${ownerDir}-${digest}`);
  });

  test("control's artifact owner directory matches the supervisor's resource layout", async () => {
    const { artifactOwnerDir } = await import("../apps/control/src/store");
    const { ownerDirName } = await import("../services/supervisor/src/resource-layout");
    expect(artifactOwnerDir("bootstrap:alice")).toBe(ownerDirName("bootstrap:alice"));
  });

  test.skipIf(!existsSync(supervisorModule))("the supervisor's runtimeName gives the same name", async () => {
    const control = await import("../apps/control/src/logs");
    // SAFETY: the module under test exports `runtimeName(sproutPath: string): string`.
    const supervisor = (await import(supervisorModule)) as { runtimeName: (path: string) => string };
    for (const path of [sproutPath, "/tmp/x/artifacts/ab/cd/sprout", "/a/b/sprout"]) {
      expect(supervisor.runtimeName(path)).toBe(control.runtimeName(path));
    }
  });
});
