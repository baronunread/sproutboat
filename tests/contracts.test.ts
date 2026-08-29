import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../packages/config/src/config";
import { validateHttpSyncSource } from "../packages/config/src/source";
import { validateManifest } from "../packages/artifact/src/manifest";
import { validateArtifactDirectory } from "../packages/artifact/src/validate";
import { deploymentHostname } from "../apps/control/src/deployments";
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
    expect(parseConfig(`{ // comment\n "name": "hello", "main": "src/index.js", "compatibility_date": "2026-08-26", "vars": { "GREETING": "hello" }, }`).ok).toBe(true);
  });

  test("rejects unsupported configuration fields and secret-like vars", () => {
    const result = parseConfig(`{"name":"Hello","main":"../index.js","compatibility_date":"today","secrets":{},"vars":{"token":3}}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(expect.arrayContaining(["unsupported config field: secrets"]));
  });

  test("accepts a complete artifact-v2 manifest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(validateManifest({ schemaVersion: 2, project: "hello", target: "linux-x86_64", runtime: "native-fetch", capabilityProfile: "http-sync-v0", porfforVersion: "alpha-3", esbuildVersion: "0.28.2", buildImage: "sha256:image", sourceHash: digest, binaryHash: digest, binarySize: 42, builtAt: "2026-08-26T00:00:00.000Z" }).ok).toBe(true);
  });

  test("accepts the frozen capability handlers and rejects unsupported source", async () => {
    const accepted = await Bun.file("tests/porffor/capabilities/01-hello.js").text();
    const rejected = await Bun.file("tests/porffor/rejected/03-outbound-fetch.js").text();
    expect(validateHttpSyncSource(accepted).ok).toBe(true);
    expect(validateHttpSyncSource(rejected)).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        "outbound networking is not supported",
      ]),
    });
  });

  test("allows console — native-fetch logs go to the worker's stderr, not a protocol stream", () => {
    expect(validateHttpSyncSource(`export default { fetch() { console.log("hello"); return new Response("ok"); } }`).ok).toBe(true);
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

  test("rejects an artifact directory that is missing its worker", async () => {
    const path = await mkdtemp(join(tmpdir(), "sproutboat-invalid-artifact-"));
    await Bun.write(`${path}/manifest.json`, "{}");
    const result = await validateArtifactDirectory(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(expect.arrayContaining(["worker is missing or unreadable"]));
  });

  test("uses a reserved user namespace in nested deployment hostnames", async () => {
    process.env.SPROUTBOAT_DATABASE_PATH = join(await mkdtemp(join(tmpdir(), "sproutboat-profiles-")), "sproutboat.sqlite");
    expect(validUsername("andrea")).toBe(true);
    expect(validUsername("dashboard")).toBe(false);
    expect(reserveUsername("user-a", "andrea")).toEqual(expect.objectContaining({ userId: "user-a", username: "andrea" }));
    expect(profileForUser("user-a")).toEqual(expect.objectContaining({ username: "andrea" }));
    expect(deploymentHostname("hello", "andrea")).toBe("hello.andrea.sproutboat.com");
    expect(() => reserveUsername("user-b", "andrea")).toThrow("username is already taken");
  });

  test("creates a short-lived CLI request that cannot be exchanged before approval", async () => {
    const created = await createCliAuthorization();
    // SAFETY: a 201 response from createCliAuthorization carries this documented contract.
    const body = await created.json() as { deviceCode: string; userCode: string; verificationUri: string };
    expect(created.status).toBe(201);
    expect(body.deviceCode.length).toBeGreaterThan(32);
    expect(body.userCode).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/);
    expect(body.verificationUri).toContain(body.userCode);
    expect((await exchangeCliAuthorization(body.deviceCode)).status).toBe(428);
  });
});
