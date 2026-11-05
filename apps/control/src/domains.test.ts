import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as domains from "./domains";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #2 — custom-domain store layer + its effect on the route snapshot.
let dir: string;
let store: typeof import("./store");
const now = () => new Date().toISOString();

async function routeHosts(): Promise<Record<string, string>> {
  const list: Array<{ hostname: string; sproutPath: string }> = JSON.parse(
    await readFile(join(dir, "routes.json"), "utf8"),
  );
  return Object.fromEntries(list.map((route) => [route.hostname, route.sproutPath]));
}
async function deploy(project: string, digest: string, id: string, ownerId = "user-1"): Promise<string> {
  const artifactDir = join(dir, "artifacts", store.artifactOwnerDir(ownerId), digest);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "sprout"), "binary");
  const sproutPath = join(artifactDir, "sprout");
  store.recordDeployment({
    id,
    ownerId,
    project,
    username: ownerId === "user-1" ? "alice" : ownerId,
    hostname: `${project}.${ownerId === "user-1" ? "alice" : ownerId.replace(/\W/g, "")}.test`,
    artifact: digest,
    sproutPath,
    deployedAt: now(),
  });
  await store.syncRoutes();
  return sproutPath;
}

let roots: string[] = [];
beforeAll(async () => {
  store = await import("./store");
});
afterAll(async () => {
  store.closeStore();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
beforeEach(async () => {
  store.closeStore(); // drop the previous test's connection so a fresh DB path is picked up
  dir = await mkdtemp(join(tmpdir(), "sb-domains-"));
  roots.push(dir);
  process.env.SPROUTBOAT_DATABASE_PATH = join(dir, "control.sqlite");
  process.env.SPROUTBOAT_ROUTE_SNAPSHOT = join(dir, "routes.json");
  process.env.SPROUTBOAT_ARTIFACTS_DIR = join(dir, "artifacts");
  process.env.SPROUTBOAT_DEPLOYMENTS_PATH = join(dir, "deployments.json");
});

test("add is unverified and stays out of the route snapshot until verified", async () => {
  const worker = await deploy("app", "a".repeat(64), "d1");
  const added = store.addCustomDomain({ hostname: "www.acme.test", ownerId: "user-1", project: "app", token: "tok1" });
  expect(added?.verifiedAt).toBeNull();
  await store.syncRoutes();
  expect(await routeHosts()).not.toHaveProperty("www.acme.test");

  expect(store.markCustomDomainVerified("user-1", "app", "www.acme.test")).toBe(true);
  await store.syncRoutes();
  expect((await routeHosts())["www.acme.test"]).toBe(worker);
});

test("hostname is globally unique", async () => {
  await deploy("app", "a".repeat(64), "d1");
  await deploy("blog", "b".repeat(64), "d2");
  expect(
    store.addCustomDomain({ hostname: "dup.acme.test", ownerId: "user-1", project: "app", token: "t" }),
  ).toBeTruthy();
  expect(
    store.addCustomDomain({ hostname: "dup.acme.test", ownerId: "user-1", project: "blog", token: "t" }),
  ).toBeUndefined();
});

test("a verified hostname stays with its owner", async () => {
  await deploy("app", "a".repeat(64), "d1");
  await deploy("web", "b".repeat(64), "d2", "user-2");
  store.addCustomDomain({ hostname: "mine.acme.test", ownerId: "user-1", project: "app", token: "t1" });
  expect(store.markCustomDomainVerified("user-1", "app", "mine.acme.test")).toBe(true);
  expect(
    store.addCustomDomain({ hostname: "mine.acme.test", ownerId: "user-2", project: "web", token: "t2" }),
  ).toBeUndefined();
  expect(store.customDomainByHostname("mine.acme.test")?.ownerId).toBe("user-1");
});

test("an unverified claim lapses after 24 hours and the next claimant replaces it", async () => {
  await deploy("app", "a".repeat(64), "d1");
  await deploy("web", "b".repeat(64), "d2", "user-2");
  store.addCustomDomain({ hostname: "squat.acme.test", ownerId: "user-1", project: "app", token: "t1" });
  const database = store.storeDatabase();
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

  database.run("UPDATE custom_domains SET created_at = ?", [hoursAgo(23)]);
  expect(store.customDomainByHostname("squat.acme.test")?.ownerId).toBe("user-1");

  database.run("UPDATE custom_domains SET created_at = ?", [hoursAgo(25)]);
  expect(store.customDomainByHostname("squat.acme.test")).toBeUndefined();
  const taken = store.addCustomDomain({ hostname: "squat.acme.test", ownerId: "user-2", project: "web", token: "t2" });
  expect(taken?.ownerId).toBe("user-2");
  expect(store.projectCustomDomains("user-1", "app")).toEqual([]);
  expect(store.projectCustomDomains("user-2", "web").map((d) => d.hostname)).toEqual(["squat.acme.test"]);
});

test("TXT proof by a later owner supersedes another owner's unverified claim", async () => {
  process.env.SPROUTBOAT_BOOTSTRAP_TOKEN = "tok";
  process.env.SPROUTBOAT_DEPLOYMENT_DOMAIN = "sb.invalid";
  await deploy("app", "a".repeat(64), "d1", "bootstrap:alice");
  await deploy("web", "b".repeat(64), "d2", "bootstrap:bob");
  const as = (user: string, method: string, body?: { hostname: string }) => {
    process.env.SPROUTBOAT_BOOTSTRAP_USERNAME = user;
    return new Request("http://control.test/x", {
      method,
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  };
  // alice claims first and never verifies; bob claims inside the 24 hours and proves the record.
  expect((await domains.addDomain(as("alice", "POST", { hostname: "shop.acme.test" }), "app")).status).toBe(201);
  const bob = await domains.addDomain(as("bob", "POST", { hostname: "shop.acme.test" }), "web");
  expect(bob.status).toBe(201);
  const { verification } = await bob.json();
  const wrong = await domains.verifyDomain(as("bob", "POST"), "web", "shop.acme.test", async () => [["nope"]]);
  expect(wrong.status).toBe(400);
  const ok = await domains.verifyDomain(as("bob", "POST"), "web", "shop.acme.test", async () => [[verification.value]]);
  expect(ok.status).toBe(200);
  expect(store.customDomainByHostname("shop.acme.test")).toMatchObject({ ownerId: "bootstrap:bob" });
  expect(store.projectCustomDomains("bootstrap:alice", "app")).toEqual([]);
  // The verified owner now blocks a new claim.
  expect((await domains.addDomain(as("alice", "POST", { hostname: "shop.acme.test" }), "app")).status).toBe(409);
});

test("a verified domain follows whatever version is active", async () => {
  await deploy("app", "a".repeat(64), "d1");
  store.addCustomDomain({ hostname: "acme.test", ownerId: "user-1", project: "app", token: "t" });
  store.markCustomDomainVerified("user-1", "app", "acme.test");
  await store.syncRoutes();

  const worker2 = await deploy("app", "c".repeat(64), "d2"); // new active version
  expect((await routeHosts())["acme.test"]).toBe(worker2);
});

test("delete drops it from the snapshot; deleting the project cascades", async () => {
  await deploy("app", "a".repeat(64), "d1");
  store.addCustomDomain({ hostname: "one.acme.test", ownerId: "user-1", project: "app", token: "t" });
  store.markCustomDomainVerified("user-1", "app", "one.acme.test");
  store.addCustomDomain({ hostname: "two.acme.test", ownerId: "user-1", project: "app", token: "t" });
  store.markCustomDomainVerified("user-1", "app", "two.acme.test");
  await store.syncRoutes();
  expect(Object.keys(await routeHosts())).toContain("one.acme.test");

  expect(store.deleteCustomDomain("user-1", "app", "one.acme.test")).toBe(true);
  await store.syncRoutes();
  expect(Object.keys(await routeHosts())).not.toContain("one.acme.test");

  store.deleteProject("user-1", "app");
  await store.syncRoutes();
  expect(store.projectCustomDomains("user-1", "app")).toHaveLength(0);
  expect(store.customDomainByHostname("two.acme.test")).toBeUndefined();
});

test("a banned owner's custom domain leaves the snapshot", async () => {
  await deploy("app", "a".repeat(64), "d1");
  store.addCustomDomain({ hostname: "banned.acme.test", ownerId: "user-1", project: "app", token: "t" });
  store.markCustomDomainVerified("user-1", "app", "banned.acme.test");
  await store.syncRoutes();
  expect(Object.keys(await routeHosts())).toContain("banned.acme.test");

  store.banOwner("user-1");
  await store.syncRoutes();
  expect(await routeHosts()).toEqual({});
});

test("isPlatformManagedHost: apex + www attachable, generated subdomains not", () => {
  const base = "sproutboat.com";
  expect(domains.isPlatformManagedHost("sproutboat.com", base)).toBe(false); // apex
  expect(domains.isPlatformManagedHost("www.sproutboat.com", base)).toBe(false); // www
  expect(domains.isPlatformManagedHost("hello.alice.sproutboat.com", base)).toBe(true);
  expect(domains.isPlatformManagedHost("api.sproutboat.com", base)).toBe(true);
  expect(domains.isPlatformManagedHost("example.com", base)).toBe(false); // external
  expect(domains.isPlatformManagedHost("notsproutboat.com", base)).toBe(false); // suffix but not subdomain
});
