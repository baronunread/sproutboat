import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateArtifactDirectory } from "./artifact";

// #1 — validateArtifactDirectory now accepts the bindings.json / assets sidecars
// the deploy pipeline carries.
let dir: string;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// A minimal valid x86-64 LE ELF header (enough for the structural checks).
function elf(): Uint8Array {
  const buf = Buffer.alloc(64);
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0); // magic, ELFCLASS64, ELFDATA2LSB
  buf.writeUInt16LE(62, 18); // e_machine = EM_X86_64
  return new Uint8Array(buf);
}

async function seed(over: { bindings?: unknown; assets?: { manifest: unknown; files: Record<string, string> } } = {}) {
  const worker = elf();
  await writeFile(join(dir, "sprout"), worker);
  const manifest = {
    schemaVersion: 2, project: "app", target: "linux-x86_64", runtime: "native-fetch",
    capabilityProfile: "http-sync-v0", porfforVersion: "alpha-4 (a415d19)", esbuildVersion: "0.28.2",
    buildImage: "stamp", sourceHash: "sha256:" + "0".repeat(64), binaryHash: "sha256:" + sha(worker),
    binarySize: worker.length, builtAt: new Date().toISOString(),
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  if (over.bindings !== undefined) await writeFile(join(dir, "bindings.json"), JSON.stringify(over.bindings));
  if (over.assets) {
    await writeFile(join(dir, "assets.json"), JSON.stringify(over.assets.manifest));
    for (const [key, body] of Object.entries(over.assets.files)) {
      await mkdir(join(dir, "assets", key.split("/").slice(0, -1).join("/")), { recursive: true });
      await writeFile(join(dir, "assets", `.${key}`), body);
    }
  }
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "sb-artifact-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("bare manifest + sprout validates", async () => {
  await seed();
  const result = await validateArtifactDirectory(dir);
  expect(result.ok).toBe(true);
});

test("a well-formed bindings.json is accepted", async () => {
  await seed({ bindings: { kv: ["SESSIONS"], secrets: ["API_KEY"], do: [{ binding: "COUNTER", className: "Counter" }], crons: ["0 3 * * *"] } });
  expect((await validateArtifactDirectory(dir)).ok).toBe(true);
});

test("a malformed bindings.json is rejected", async () => {
  await seed({ bindings: { kv: "not-an-array" } });
  const result = await validateArtifactDirectory(dir);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors.join(" ")).toContain("bindings.json.kv");
});

test("an assets tree with matching hashes is accepted", async () => {
  const body = "<!doctype html>hi";
  await seed({ assets: {
    manifest: { notFound: "single-page-application", runSproutFirst: false, files: { "/index.html": { hash: sha(Buffer.from(body)), size: body.length, type: "text/html" } } },
    files: { "/index.html": body },
  } });
  expect((await validateArtifactDirectory(dir)).ok).toBe(true);
});

test("assets.json without the assets/ directory is rejected", async () => {
  await seed();
  await writeFile(join(dir, "assets.json"), JSON.stringify({ notFound: "none", runSproutFirst: false, files: {} }));
  const result = await validateArtifactDirectory(dir);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors.join(" ")).toContain("must be present together");
});

test("an asset whose bytes don't match its recorded hash is rejected", async () => {
  await seed({ assets: {
    manifest: { notFound: "none", runSproutFirst: false, files: { "/app.js": { hash: "0".repeat(64), size: 3, type: "text/javascript" } } },
    files: { "/app.js": "xyz" },
  } });
  const result = await validateArtifactDirectory(dir);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors.join(" ")).toContain("does not match its recorded hash");
});

test("an unknown extra entry is still rejected", async () => {
  await seed();
  await writeFile(join(dir, "secrets.json"), "{}"); // secrets are injected by the control plane, never uploaded
  const result = await validateArtifactDirectory(dir);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors.join(" ")).toContain("unexpected entries");
});
