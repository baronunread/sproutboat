import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_TOKEN, startFakeAdapter } from "./sproutd-fake.test-util";

// Control's sproutd paths through its real HTTP handlers (bootstrap-token auth), against a fake adapter.
const TOKEN = "bootstrap-token";
const OWNER = "bootstrap:alice";
let dir: string;
let adapter: ReturnType<typeof startFakeAdapter>;
let store: typeof import("./store");
let deployments: typeof import("./deployments");
let secrets: typeof import("./secrets");
let sproutd: typeof import("./sproutd");
let secretsCrypto: typeof import("./secrets-crypto");
const roots: string[] = [];

const elf = (tag: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array([0x7f, 0x45, 0x4c, 0x46, ...new TextEncoder().encode(tag)]);
const vid = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const request = (path: string, init: RequestInit = {}) =>
  new Request(`http://control${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...Object.fromEntries(new Headers(init.headers)) },
  });
const moduleForm = (bytes: Uint8Array<ArrayBuffer>) => {
  const form = new FormData();
  form.set("module", new File([bytes], "app.so"));
  return form;
};
type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };
const putRuntime = (project: string, body: Json) =>
  deployments.putProjectRuntime(
    request(`/api/projects/${project}/runtime`, { method: "PUT", body: JSON.stringify(body) }),
    project,
  );
const deploy = (project: string, bytes: Uint8Array<ArrayBuffer>) =>
  deployments.deployArtifact(
    request(`/api/projects/${project}/deployments`, { method: "POST", body: moduleForm(bytes) }),
    project,
  );
type RouteJson = { hostname: string; backend?: { kind: string; url: string }; secretsPath?: string };
const routes = async (): Promise<RouteJson[]> => JSON.parse(await readFile(join(dir, "routes.json"), "utf8"));

beforeAll(async () => {
  store = await import("./store");
  secretsCrypto = await import("./secrets-crypto");
  deployments = await import("./deployments");
  secrets = await import("./secrets");
  sproutd = await import("./sproutd");
});
afterAll(async () => {
  store.closeStore();
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});
beforeEach(async () => {
  store.closeStore();
  secretsCrypto.resetSecretsKeyForTest();
  dir = await mkdtemp(join(tmpdir(), "sb-sproutd-"));
  roots.push(dir);
  adapter = startFakeAdapter();
  Object.assign(process.env, {
    SPROUTBOAT_DATABASE_PATH: join(dir, "control.sqlite"),
    SPROUTBOAT_ROUTE_SNAPSHOT: join(dir, "routes.json"),
    SPROUTBOAT_ARTIFACTS_DIR: join(dir, "artifacts"),
    SPROUTBOAT_DEPLOYMENTS_PATH: join(dir, "deployments.json"),
    SPROUTBOAT_BOOTSTRAP_TOKEN: TOKEN,
    SPROUTBOAT_BOOTSTRAP_USERNAME: "alice",
    SPROUTBOAT_DEPLOYMENT_DOMAIN: "sb.test",
    SPROUTBOAT_SPROUTD_ADAPTER_SOCKET: adapter.socket,
    SPROUTBOAT_SPROUTD_ADAPTER_TOKEN: FAKE_TOKEN,
    SPROUTBOAT_SPROUTD_URL: "http://127.0.0.1:8600",
    SPROUTBOAT_SPROUTD_OWNERS: "alice",
    SPROUTBOAT_DEPLOY_RATE_PER_MIN: "10000",
    SPROUTBOAT_DEPLOY_RATE_PER_IP_PER_MIN: "10000",
  });
  delete process.env.SPROUTBOAT_SECRETS_KEY;
  delete process.env.SPROUTBOAT_ACTIVATION_DIR;
});
afterEach(() => adapter.stop());

test("the runtime defaults to the supervisor, and sproutd needs a configured box and an allowed owner", async () => {
  const before = await (await deployments.getProjectRuntime(request("/api/projects/blog/runtime"), "blog")).json();
  expect(before).toMatchObject({ runtime: "supervisor", sproutdAvailable: true, sproutdAllowed: true });
  process.env.SPROUTBOAT_SPROUTD_OWNERS = "someone-else";
  expect((await putRuntime("blog", { runtime: "sproutd" })).status).toBe(403);
  process.env.SPROUTBOAT_SPROUTD_OWNERS = "alice";
  delete process.env.SPROUTBOAT_SPROUTD_URL;
  expect((await putRuntime("blog", { runtime: "sproutd" })).status).toBe(409);
  process.env.SPROUTBOAT_SPROUTD_URL = "http://127.0.0.1:8600";
  expect((await putRuntime("blog", { runtime: "nope" })).status).toBe(400);
  expect((await putRuntime("blog", { runtime: "sproutd", limits: { memoryMb: 1 } })).status).toBe(400);
  expect((await putRuntime("blog", { runtime: "sproutd", limits: { cpuQuota: 50 } })).status).toBe(400);
  const ok = await putRuntime("blog", { runtime: "sproutd", limits: { memoryMb: 64 } });
  expect(await ok.json()).toMatchObject({
    runtime: "sproutd",
    limits: { memoryMb: 64 },
    effectiveLimits: { memoryMb: 64, wallMs: 30000 },
  });
});

test("a project that has deployments cannot change runtime", async () => {
  store.recordDeployment({
    id: "d1",
    ownerId: OWNER,
    project: "old",
    username: "alice",
    hostname: "old.alice.sb.test",
    artifact: "a".repeat(64),
    sproutPath: join(dir, "x"),
    deployedAt: new Date().toISOString(),
  });
  expect((await putRuntime("old", { runtime: "sproutd" })).status).toBe(409);
});

test("a supervisor project's routes and deployment rows are exactly what they were", async () => {
  store.recordDeployment({
    id: "d1",
    ownerId: OWNER,
    project: "plain",
    username: "alice",
    hostname: "plain.alice.sb.test",
    artifact: "b".repeat(64),
    sproutPath: join(dir, "artifacts", "b", "sprout"),
    deployedAt: new Date().toISOString(),
  });
  await store.syncRoutes();
  const [route] = await routes();
  expect(Object.keys(route).sort()).toEqual(["doStoreId", "hostname", "ownerId", "r2ResourceIds", "sproutPath"]);
  const [row] = store.projectDeployments(OWNER, "plain");
  expect(Object.keys(row).sort()).toEqual([
    "active",
    "artifact",
    "binarySize",
    "compileMs",
    "deployedAt",
    "hostname",
    "id",
    "ownerId",
    "project",
    "sproutPath",
    "username",
  ]);
});

test("deploy uploads module, secrets and limits, records the version sproutd reports, and routes to the backend", async () => {
  await putRuntime("blog", { runtime: "sproutd", limits: { memoryMb: 96 } });
  store.setSecret(OWNER, "blog", "GREETING", "hello");
  const bytes = elf("v1");
  const res = await deploy("blog", bytes);
  expect(res.status).toBe(201);
  const body: { id: string; vid: string; hostname: string; activated: boolean } = await res.json();
  expect(body).toMatchObject({ vid: vid(bytes), hostname: "blog.alice.sb.test", activated: true });
  const app = adapter.apps.get(adapter.idOf(OWNER, "blog"))!;
  expect(app.versions.map((v) => v.id)).toEqual([vid(bytes)]);
  expect(app.versions[0].secrets).not.toBeNull();
  expect(app.limits.memoryMb).toBe(96);
  expect(app.limits.wallMs).toBe(30000);
  // The edge is told where to forward, and is not told to start anything.
  const [route] = await routes();
  expect(route).toMatchObject({
    hostname: "blog.alice.sb.test",
    backend: { kind: "sproutd", url: "http://127.0.0.1:8600" },
  });
  expect(route.secretsPath).toBeUndefined();
  expect(await readdir(join(dir, "secrets")).catch(() => [])).toEqual([]); // no plaintext secrets.json for the supervisor to read
  // Control keeps its own copy of the module and the deployment names the version.
  const [row] = store.projectDeployments(OWNER, "blog");
  expect(row).toMatchObject({ vid: vid(bytes), active: true });
  expect(Buffer.from(await readFile(row.sproutPath)).equals(Buffer.from(bytes))).toBe(true);
  // The same bytes again are a no-op, like the supervisor path.
  const again = await deploy("blog", bytes);
  expect(await again.json()).toMatchObject({ unchanged: true, activated: false });
  expect(store.projectDeployments(OWNER, "blog").length).toBe(1);
});

test("a module sproutd refuses leaves the previous version active and records nothing", async () => {
  await putRuntime("blog", { runtime: "sproutd" });
  await deploy("blog", elf("v1"));
  adapter.failNextDeploy(409, "rejected; previous worker retained");
  const bad = await deploy("blog", elf("v2"));
  expect(bad.status).toBe(409);
  expect(await bad.json()).toMatchObject({ activated: false, error: "rejected; previous worker retained" });
  const rows = store.projectDeployments(OWNER, "blog");
  expect(rows.length).toBe(1);
  expect(rows[0].vid).toBe(vid(elf("v1")));
  expect((await readdir(join(dir, "artifacts"))).filter((n) => !n.startsWith("."))).toEqual([rows[0].artifact]);
});

test("not an ELF module, no module, and a supervisor upload to a sproutd project are refused", async () => {
  await putRuntime("blog", { runtime: "sproutd" });
  expect((await deploy("blog", new TextEncoder().encode("#!/bin/sh\n"))).status).toBe(400);
  const manifestOnly = new FormData();
  manifestOnly.set("manifest", new File(["{}"], "manifest.json"));
  manifestOnly.set("sprout", new File(["x"], "sprout"));
  const res = await deployments.deployArtifact(
    request("/api/projects/blog/deployments", { method: "POST", body: manifestOnly }),
    "blog",
  );
  expect(res.status).toBe(400);
  const refused: { error: string } = await res.json();
  expect(refused.error).toContain("runs on sproutd");
  expect(adapter.apps.size).toBe(0);
});

test("rollback uses sproutd's own verb, and redeploys control's copy when sproutd no longer stores the version", async () => {
  await putRuntime("blog", { runtime: "sproutd" });
  const v1 = elf("v1"),
    v2 = elf("v2");
  const first: { id: string } = await (await deploy("blog", v1)).json();
  await deploy("blog", v2);
  const activate = (id: string) =>
    deployments.activateDeployment(
      request(`/api/projects/blog/deployments/${id}/activate`, { method: "POST" }),
      "blog",
      id,
    );
  const back = await activate(first.id);
  expect(back.status).toBe(200);
  expect(await back.json()).toMatchObject({ active: true, vid: vid(v1) });
  expect(adapter.apps.get(adapter.idOf(OWNER, "blog"))!.versions.find((v) => v.active)!.id).toBe(vid(v1));
  expect(store.projectDeployments(OWNER, "blog").find((d) => d.active)!.id).toBe(first.id);
  // Roll forward, then let sproutd forget v1 (versions-keep) and roll back again: control's copy is used.
  const second = store.projectDeployments(OWNER, "blog").find((d) => d.vid === vid(v2))!;
  await activate(second.id);
  adapter.prune(OWNER, "blog", vid(v1));
  adapter.calls.length = 0;
  const viaCopy = await activate(first.id);
  expect(viaCopy.status).toBe(200);
  expect(adapter.calls.some((c) => c.startsWith("POST /v1/projects/blog/deploy"))).toBe(true);
  expect(adapter.apps.get(adapter.idOf(OWNER, "blog"))!.versions.find((v) => v.active)!.id).toBe(vid(v1));
});

test("rollback restores the module with the project's current secrets, not the old ones", async () => {
  await putRuntime("blog", { runtime: "sproutd" });
  store.setSecret(OWNER, "blog", "TOKEN", "one");
  const v1 = elf("v1");
  const first: { id: string } = await (await deploy("blog", v1)).json();
  await deploy("blog", elf("v2"));
  store.setSecret(OWNER, "blog", "TOKEN", "two");
  const res = await deployments.activateDeployment(
    request(`/api/projects/blog/deployments/${first.id}/activate`, { method: "POST" }),
    "blog",
    first.id,
  );
  expect(res.status).toBe(200);
  const app = adapter.apps.get(adapter.idOf(OWNER, "blog"))!;
  const secretsTwo = createHash("sha256")
    .update(JSON.stringify({ TOKEN: "two" }))
    .digest("hex")
    .slice(0, 16);
  expect(app.versions.find((v) => v.active)).toMatchObject({ id: vid(v1), secrets: secretsTwo });
});

test("secrets that sproutd cannot carry are refused when set, with the reason; line breaks are accepted", async () => {
  await putRuntime("blog", { runtime: "sproutd" });
  await deploy("blog", elf("v1"));
  const put = (name: string, value: string) =>
    secrets.putSecret(
      request(`/api/projects/blog/secrets/${name}`, { method: "PUT", body: JSON.stringify({ value }) }),
      "blog",
      name,
    );
  // Line breaks are carried by sproutd's escaped secrets format; a NUL and the reserved names are not.
  expect((await put("MULTI", "a\nb\\c\r\nd")).status).toBe(201);
  const nul = await put("NUL", "a\0b");
  expect(nul.status).toBe(400);
  const reason: { error: string } = await nul.json();
  expect(reason.error).toContain("NUL");
  expect((await put("SB_TOKEN", "x")).status).toBe(400);
  const ok = await put("PLAIN", "x");
  expect(ok.status).toBe(201);
  expect(await ok.json()).toMatchObject({ appliesOn: "the running version, within seconds" });
  // And a supervisor project still accepts a multi-line value, as before.
  store.recordDeployment({
    id: "s1",
    ownerId: OWNER,
    project: "plain",
    username: "alice",
    hostname: "plain.alice.sb.test",
    artifact: "c".repeat(64),
    sproutPath: join(dir, "x"),
    deployedAt: new Date().toISOString(),
  });
  const supervisor = await secrets.putSecret(
    request("/api/projects/plain/secrets/MULTI", { method: "PUT", body: JSON.stringify({ value: "a\nb" }) }),
    "plain",
    "MULTI",
  );
  expect(supervisor.status).toBe(201);
  expect(await supervisor.json()).toMatchObject({ appliesOn: "next deploy or sprout restart" });
});

test("reconcile rebuilds a sproutd that lost the app, and pushes hosts, limits and changed secrets", async () => {
  await putRuntime("blog", { runtime: "sproutd", limits: { memoryMb: 64 } });
  const v1 = elf("v1");
  await deploy("blog", v1);
  const id = adapter.idOf(OWNER, "blog");
  const first = await sproutd.reconcileSproutd({ force: true });
  expect(first.errors).toEqual([]);
  expect(adapter.apps.get(id)!.hosts).toEqual(["blog.alice.sb.test"]);
  // sproutd restarts with an empty STATE.
  adapter.apps.clear();
  const rebuilt = await sproutd.reconcileSproutd({ force: true });
  expect(rebuilt.actions.map((a) => a.action)).toContain("deployed (sproutd had no such app)");
  expect(adapter.apps.get(id)!.versions.find((v) => v.active)!.id).toBe(vid(v1));
  expect(adapter.apps.get(id)!.hosts).toEqual(["blog.alice.sb.test"]);
  expect(adapter.apps.get(id)!.limits.memoryMb).toBe(64);
  // A verified custom domain is pushed on the next pass; a changed secret is applied.
  store.addCustomDomain({ hostname: "www.example.org", ownerId: OWNER, project: "blog", token: "t" });
  store.markCustomDomainVerified(OWNER, "blog", "www.example.org");
  store.setSecret(OWNER, "blog", "TOKEN", "rotated");
  const changed = await sproutd.reconcileSproutd();
  expect(changed.actions.map((a) => a.action).join(" ")).toContain("applied changed secrets");
  expect(adapter.apps.get(id)!.hosts).toEqual(["blog.alice.sb.test", "www.example.org"]);
  // Nothing changed: the next sync-driven pass does no adapter writes.
  adapter.calls.length = 0;
  expect((await sproutd.reconcileSproutd()).actions).toEqual([]);
  expect(adapter.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
});

test("reconcile reports sproutd apps no project maps to, and reports an unreachable adapter per project", async () => {
  await putRuntime("blog", { runtime: "sproutd" });
  await deploy("blog", elf("v1"));
  adapter.apps.set("stray_000000000000", {
    id: "stray_000000000000",
    owner: "x",
    project: "stray",
    versions: [],
    limits: {},
    hosts: [],
  });
  expect((await sproutd.reconcileSproutd({ force: true })).orphans).toEqual(["stray_000000000000"]);
  process.env.SPROUTBOAT_SPROUTD_ADAPTER_SOCKET = join(dir, "missing.sock");
  const down = await sproutd.reconcileSproutd({ force: true });
  expect(down.errors.length).toBe(1);
  expect(down.errors[0].project).toBe("blog");
});

test("deleting a sproutd project removes the app and its route", async () => {
  await putRuntime("blog", { runtime: "sproutd" });
  await deploy("blog", elf("v1"));
  const res = await deployments.deleteProject(request("/api/projects/blog?confirm=blog", { method: "DELETE" }), "blog");
  expect(res.status).toBe(200);
  expect(adapter.apps.size).toBe(0);
  expect(await routes()).toEqual([]);
});

test("a sproutd project's route is dropped when sproutd is no longer configured, rather than pointing nowhere", async () => {
  await putRuntime("blog", { runtime: "sproutd" });
  await deploy("blog", elf("v1"));
  delete process.env.SPROUTBOAT_SPROUTD_URL;
  await store.syncRoutes();
  expect(await routes()).toEqual([]);
});
