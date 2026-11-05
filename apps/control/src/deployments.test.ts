import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Artifact placement: per-owner directories, logs that stay with their owner, and a deploy that
// leaves nothing behind when it is refused.
let dir: string;
let store: typeof import("./store");
let deployments: typeof import("./deployments");
let logs: typeof import("./logs");
let limits: typeof import("./limits");
const roots: string[] = [];

const as = (user: string, method: string, body?: BodyInit): Request => {
  process.env.SPROUTBOAT_BOOTSTRAP_USERNAME = user;
  return new Request("http://control.test/x", { method, headers: { authorization: "Bearer tok" }, body });
};

function sproutBytes(seed: string) {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  header.writeUInt16LE(62, 18);
  return Uint8Array.from(Buffer.concat([header, Buffer.from(seed)]));
}

type Parts = { bindings?: object; assets?: Record<string, string>; listed?: string[] };
function form(project: string, seed: string, parts: Parts = {}): FormData {
  const bytes = sproutBytes(seed);
  const manifest = {
    schemaVersion: 2,
    project,
    target: "linux-x86_64",
    runtime: "native-fetch",
    capabilityProfile: "http-sync-v0",
    porfforVersion: "alpha-4 (a415d19)",
    esbuildVersion: "0.28.2",
    buildImage: "stamp",
    sourceHash: `sha256:${"0".repeat(64)}`,
    binaryHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    binarySize: bytes.length,
    builtAt: "2026-11-01T00:00:00.000Z",
  };
  const data = new FormData();
  data.set("manifest", new File([JSON.stringify(manifest)], "manifest.json"));
  data.set("sprout", new File([bytes], "sprout"));
  if (parts.bindings) data.set("bindings", new File([JSON.stringify(parts.bindings)], "bindings.json"));
  if (parts.assets) {
    const files: Record<string, { hash: string; size: number; type: string }> = {};
    for (const [key, body] of Object.entries(parts.assets)) {
      if (parts.listed && !parts.listed.includes(key)) continue;
      files[key] = { hash: createHash("sha256").update(body).digest("hex"), size: body.length, type: "text/plain" };
    }
    data.set(
      "assets_manifest",
      new File([JSON.stringify({ notFound: "none", runSproutFirst: false, files })], "assets.json"),
    );
    for (const [key, body] of Object.entries(parts.assets)) data.append("asset", new File([body], key));
  }
  return data;
}

const deploy = (user: string, project: string, seed: string, parts?: Parts) =>
  deployments.deployArtifact(as(user, "POST", form(project, seed, parts)), project);

const leftovers = async () =>
  (await readdir(join(dir, "artifacts")).catch(() => [])).filter((n) => n.startsWith(".upload-"));

beforeAll(async () => {
  process.env.SPROUTBOAT_BOOTSTRAP_TOKEN = "tok";
  process.env.SPROUTBOAT_DEPLOYMENT_DOMAIN = "sb.invalid";
  delete process.env.SPROUTBOAT_ACTIVATION_DIR;
  store = await import("./store");
  deployments = await import("./deployments");
  logs = await import("./logs");
  limits = await import("./limits");
});
afterAll(async () => {
  store.closeStore();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
beforeEach(async () => {
  store.closeStore();
  limits.resetLimiter();
  dir = await mkdtemp(join(tmpdir(), "sb-deployments-"));
  roots.push(dir);
  Object.assign(process.env, {
    SPROUTBOAT_DATABASE_PATH: join(dir, "control.sqlite"),
    SPROUTBOAT_ROUTE_SNAPSHOT: join(dir, "routes.json"),
    SPROUTBOAT_ARTIFACTS_DIR: join(dir, "artifacts"),
    SPROUTBOAT_DEPLOYMENTS_PATH: join(dir, "deployments.json"),
    SPROUTBOAT_LOG_PATH: join(dir, "logs", "requests.ndjson"),
  });
});

test("two owners uploading identical bytes get separate directories and separate sprout logs", async () => {
  const first = await deploy("alice", "app", "same");
  const second = await deploy("bob", "app", "same");
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const a = store.projectDeployments("bootstrap:alice", "app")[0];
  const b = store.projectDeployments("bootstrap:bob", "app")[0];
  expect(a?.artifact).toBe(b?.artifact); // same bytes, same digest
  expect(a?.sproutPath).not.toBe(b?.sproutPath);
  expect(a?.sproutPath).toBe(
    join(dir, "artifacts", store.artifactOwnerDir("bootstrap:alice"), a?.artifact ?? "", "sprout"),
  );
  expect((await stat(a?.sproutPath ?? "")).isFile()).toBe(true);
  expect((await stat(b?.sproutPath ?? "")).isFile()).toBe(true);

  // The supervisor writes one log per runtime name; each owner reads only their own.
  await mkdir(join(dir, "logs", "sprouts"), { recursive: true });
  await writeFile(logs.sproutLogFile(logs.runtimeName(a?.sproutPath ?? "")), "alice secret output\n");
  await writeFile(logs.sproutLogFile(logs.runtimeName(b?.sproutPath ?? "")), "bob output\n");
  const mine = await deployments.projectSproutLog(as("alice", "GET"), "app");
  const theirs = await deployments.projectSproutLog(as("bob", "GET"), "app");
  expect(await mine.text()).toBe("alice secret output\n");
  expect(await theirs.text()).toBe("bob output\n");
  expect(await logs.readSproutLogText(logs.runtimeName(b?.sproutPath ?? ""))).not.toContain("alice");
});

test("removing one owner's copy leaves the other's artifact in place", async () => {
  await deploy("alice", "app", "same");
  await deploy("bob", "app", "same");
  const b = store.projectDeployments("bootstrap:bob", "app")[0];
  const url = new Request("http://control.test/x?confirm=app", {
    method: "DELETE",
    headers: { authorization: "Bearer tok" },
  });
  process.env.SPROUTBOAT_BOOTSTRAP_USERNAME = "alice";
  expect((await deployments.deleteProject(url, "app")).status).toBe(200);
  expect((await stat(b?.sproutPath ?? "")).isFile()).toBe(true);
});

test("a refused deploy leaves no staging directory and no placed artifact", async () => {
  // A listed asset that is missing from the upload is refused by validation.
  const missing = form("app", "v1", { assets: { "/a.txt": "one" } });
  missing.delete("asset");
  expect((await deployments.deployArtifact(as("alice", "POST", missing), "app")).status).toBe(400);
  expect(await leftovers()).toEqual([]);

  // A manifest for another project.
  const wrongProject = await deployments.deployArtifact(as("alice", "POST", form("other", "v1")), "app");
  expect(wrongProject.status).toBe(400);
  expect(await leftovers()).toEqual([]);

  // A binding to a resource the account does not hold is refused before anything is placed.
  const binding = await deploy("alice", "app", "v2", {
    bindings: { kv: ["K"], resources: { K: { kind: "kv", id: "kv_missing" } } },
  });
  expect(binding.status).toBe(400);
  expect(await leftovers()).toEqual([]);
  const owned = join(dir, "artifacts", store.artifactOwnerDir("bootstrap:alice"));
  expect(await readdir(owned).catch(() => [])).toEqual([]);
});

test("an asset the manifest does not list is refused before any asset is written", async () => {
  // /b.txt is uploaded but left out of the listing.
  const parts = form("app", "v1", { assets: { "/a.txt": "one", "/b.txt": "two" }, listed: ["/a.txt"] });
  const response = await deployments.deployArtifact(as("alice", "POST", parts), "app");
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("/b.txt");
  expect(await leftovers()).toEqual([]);
  expect(store.projectDeployments("bootstrap:alice", "app")).toEqual([]);
});

test("the startup sweep removes stale upload directories", async () => {
  const root = join(dir, "artifacts");
  await mkdir(join(root, ".upload-stale"), { recursive: true });
  await mkdir(join(root, ".upload-fresh"), { recursive: true });
  const old = Date.now() / 1000 - 2 * 3600;
  await utimes(join(root, ".upload-stale"), old, old);
  await store.sweepBrokerState(); // what main.ts calls at startup
  expect(await leftovers()).toEqual([".upload-fresh"]);
});

test("a deploy the edge cannot start removes the directory it placed", async () => {
  const spool = join(dir, "activation");
  await mkdir(spool, { recursive: true });
  process.env.SPROUTBOAT_ACTIVATION_DIR = spool;
  process.env.SPROUTBOAT_ACTIVATION_TIMEOUT_MS = "150";
  try {
    const response = await deploy("alice", "app", "v1");
    expect(response.status).toBe(409);
  } finally {
    delete process.env.SPROUTBOAT_ACTIVATION_DIR;
    delete process.env.SPROUTBOAT_ACTIVATION_TIMEOUT_MS;
  }
  expect(await leftovers()).toEqual([]);
  const owned = join(dir, "artifacts", store.artifactOwnerDir("bootstrap:alice"));
  expect(await readdir(owned)).toEqual([]);
  expect(store.projectDeployments("bootstrap:alice", "app")).toEqual([]);
});
