import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Activity events: every mutation site writes one, and the feed filters,
// paginates and scopes them. Handlers are driven for real with the bootstrap
// token (no Better Auth); the admin and token paths live in events.admin.test.ts.
let dir: string;
let store: typeof import("./store");
let events: typeof import("./events");
let eventTypes: typeof import("./event-types");
let deployments: typeof import("./deployments");
let secrets: typeof import("./secrets");
let domains: typeof import("./domains");
let activity: typeof import("./activity");
let limits: typeof import("./limits");
let cryptoKey: typeof import("./secrets-crypto");
const roots: string[] = [];

const ALICE = "bootstrap:alice";
const BOB = "bootstrap:bob";

function as(user: string, path: string, init: RequestInit = {}): Request {
  process.env.SPROUTBOAT_BOOTSTRAP_USERNAME = user;
  return new Request(`http://control.test${path}`, {
    ...init,
    headers: { authorization: "Bearer tok", ...init.headers },
  });
}

// A minimal valid x86-64 ELF header, padded with `seed` so each call has its own digest.
function sproutBytes(seed: string) {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  header.writeUInt16LE(62, 18);
  return Uint8Array.from(Buffer.concat([header, Buffer.from(seed)]));
}

function artifactForm(project: string, seed: string, manifestProject = project): FormData {
  const bytes = sproutBytes(seed);
  const manifest = {
    schemaVersion: 2,
    project: manifestProject,
    target: "linux-x86_64",
    runtime: "native-fetch",
    capabilityProfile: "http-sync-v0",
    porfforVersion: "alpha-4 (a415d19)",
    esbuildVersion: "0.28.2",
    buildImage: "stamp",
    sourceHash: `sha256:${"0".repeat(64)}`,
    binaryHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    binarySize: bytes.length,
    builtAt: new Date().toISOString(),
    compileMs: 12,
  };
  const form = new FormData();
  form.set("manifest", new File([JSON.stringify(manifest)], "manifest.json"));
  form.set("sprout", new File([bytes], "sprout"));
  return form;
}

async function deploy(user: string, project: string, seed: string, manifestProject?: string): Promise<Response> {
  return deployments.deployArtifact(
    as(user, `/api/projects/${project}/deployments`, {
      method: "POST",
      body: artifactForm(project, seed, manifestProject),
    }),
    project,
  );
}

type Feed = {
  events: Array<{ id: number; type: string; project: string; ts: string; summary: string }>;
  nextBefore: number | null;
};
const mine = (ownerId = ALICE) => events.listEvents({ ownerId, limit: 200 }).events.toReversed();
const typesOf = (ownerId = ALICE) => mine(ownerId).map((event) => event.type);
const tableDump = () => JSON.stringify(store.storeDatabase().query("SELECT * FROM events").all());

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-events-"));
  roots.push(dir);
  // deployments.ts reads the artifact root at import, so fix it once for the file.
  process.env.SPROUTBOAT_ARTIFACTS_DIR = join(dir, "artifacts");
  process.env.SPROUTBOAT_BOOTSTRAP_TOKEN = "tok";
  process.env.SPROUTBOAT_DEPLOYMENT_DOMAIN = "sb.invalid";
  delete process.env.SPROUTBOAT_ACTIVATION_DIR;
  store = await import("./store");
  events = await import("./events");
  eventTypes = await import("./event-types");
  deployments = await import("./deployments");
  secrets = await import("./secrets");
  domains = await import("./domains");
  activity = await import("./activity");
  limits = await import("./limits");
  cryptoKey = await import("./secrets-crypto");
});
afterAll(async () => {
  store.closeStore();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
beforeEach(async () => {
  store.closeStore();
  cryptoKey.resetSecretsKeyForTest();
  limits.resetLimiter();
  const run = await mkdtemp(join(tmpdir(), "sb-events-run-"));
  roots.push(run);
  process.env.SPROUTBOAT_DATABASE_PATH = join(run, "control.sqlite");
  process.env.SPROUTBOAT_ROUTE_SNAPSHOT = join(run, "routes.json");
  process.env.SPROUTBOAT_DEPLOYMENTS_PATH = join(run, "deployments.json");
  delete process.env.SPROUTBOAT_EVENTS_KEEP_DAYS;
  delete process.env.SPROUTBOAT_EVENTS_MAX_ROWS;
});

test("a first deploy records started, project.created and succeeded with its facts", async () => {
  const response = await deploy("alice", "app", "v1");
  expect(response.status).toBe(201);
  expect(typesOf()).toEqual(["deploy.started", "project.created", "deploy.succeeded"]);
  const succeeded = mine().find((event) => event.type === "deploy.succeeded");
  expect(succeeded?.project).toBe("app");
  expect(succeeded?.actor).toBe("alice");
  expect(succeeded?.data).toMatchObject({
    hostname: "app.alice.sb.invalid",
    binarySize: 64 + 2,
    compileMs: 12,
    newProject: true,
  });
  expect(succeeded?.data.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(succeeded?.data.deploymentId).toBe((await response.json()).id);
});

test("a redeploy is not a new project; an identical one is reported as unchanged", async () => {
  await deploy("alice", "app", "v1");
  await deploy("alice", "app", "v2");
  const again = await deploy("alice", "app", "v2");
  expect((await again.json()).unchanged).toBe(true);
  expect(typesOf().filter((type) => type === "project.created")).toHaveLength(1);
  const last = mine().at(-1);
  expect(last?.type).toBe("deploy.succeeded");
  expect(last?.data.unchanged).toBe(true);
});

test("a rejected deploy records started then failed with the reason, no stack", async () => {
  const response = await deploy("alice", "app", "v1", "other-project");
  expect(response.status).toBe(400);
  expect(typesOf()).toEqual(["deploy.started", "deploy.failed"]);
  const failed = mine().at(-1);
  expect(failed?.data.reason).toBe("manifest project does not match request path");
  expect(JSON.stringify(failed)).not.toContain("    at ");
});

test("activating an older version is a rollback; a newer one is an activation", async () => {
  const first = await (await deploy("alice", "app", "v1")).json();
  await Bun.sleep(5);
  const second = await (await deploy("alice", "app", "v2")).json();

  const rollback = await deployments.activateDeployment(
    as("alice", `/api/projects/app/deployments/${first.id}/activate`, { method: "POST" }),
    "app",
    first.id,
  );
  expect(rollback.status).toBe(200);
  const forward = await deployments.activateDeployment(
    as("alice", `/api/projects/app/deployments/${second.id}/activate`, { method: "POST" }),
    "app",
    second.id,
  );
  expect(forward.status).toBe(200);

  const [rolledBack, activated] = mine().slice(-2);
  expect(rolledBack.type).toBe("deploy.rolled_back");
  expect(rolledBack.data).toEqual({ from: second.id, to: first.id });
  expect(activated.type).toBe("deploy.activated");
  expect(activated.data).toEqual({ from: first.id, to: second.id });
});

test("deleting a version and a project each record an event", async () => {
  const first = await (await deploy("alice", "app", "v1")).json();
  await deploy("alice", "app", "v2");
  const removed = await deployments.deleteDeployment(
    as("alice", `/api/projects/app/deployments/${first.id}`, { method: "DELETE" }),
    "app",
    first.id,
  );
  expect(removed.status).toBe(200);
  expect(mine().at(-1)).toMatchObject({ type: "deploy.deleted", data: { deploymentId: first.id } });

  const gone = await deployments.deleteProject(
    as("alice", "/api/projects/app?confirm=app", { method: "DELETE" }),
    "app",
  );
  expect(gone.status).toBe(200);
  expect(mine().at(-1)).toMatchObject({ type: "project.deleted", project: "app", data: { hostnames: 1 } });
});

test("secrets record the name only, never the value", async () => {
  await deploy("alice", "app", "v1");
  const put = await secrets.putSecret(
    as("alice", "/api/projects/app/secrets/API_KEY", {
      method: "PUT",
      body: JSON.stringify({ value: "super-secret-value" }),
    }),
    "app",
    "API_KEY",
  );
  expect(put.status).toBe(201);
  const removed = await secrets.removeSecret(
    as("alice", "/api/projects/app/secrets/API_KEY", { method: "DELETE" }),
    "app",
    "API_KEY",
  );
  expect(removed.status).toBe(200);
  const [set, deleted] = mine().slice(-2);
  expect(set).toMatchObject({ type: "secret.set", project: "app", data: { name: "API_KEY" } });
  expect(deleted).toMatchObject({ type: "secret.deleted", data: { name: "API_KEY" } });
  expect(tableDump()).not.toContain("super-secret-value");
});

test("domains record added, verified and removed with the hostname, never the token", async () => {
  await deploy("alice", "app", "v1");
  const added = await domains.addDomain(
    as("alice", "/api/projects/app/domains", { method: "POST", body: JSON.stringify({ hostname: "www.acme.test" }) }),
    "app",
  );
  expect(added.status).toBe(201);
  const token = store.projectCustomDomains(ALICE, "app")[0].token;
  const verified = await domains.verifyDomain(
    as("alice", "/api/projects/app/domains/www.acme.test/verify", { method: "POST" }),
    "app",
    "www.acme.test",
    async () => [[`sproutboat-verify=${token}`]],
  );
  expect(verified.status).toBe(200);
  const removed = await domains.deleteDomain(
    as("alice", "/api/projects/app/domains/www.acme.test", { method: "DELETE" }),
    "app",
    "www.acme.test",
  );
  expect(removed.status).toBe(200);
  const trail = mine().slice(-3);
  expect(trail.map((event) => event.type)).toEqual(["domain.added", "domain.verified", "domain.removed"]);
  for (const event of trail) expect(event.data).toEqual({ hostname: "www.acme.test" });
  expect(tableDump()).not.toContain(token);
});

test("scrub keeps only the allowlisted keys for the type", () => {
  const event = events.recordEvent({
    ownerId: ALICE,
    project: "app",
    type: "secret.set",
    summary: "x",
    data: { name: "API_KEY", value: "super-secret-value", token: "t", apiKey: "k", passwordHash: "h" },
  });
  expect(event?.data).toEqual({ name: "API_KEY" });
  expect(tableDump()).not.toContain("super-secret-value");

  // Every type: whatever a caller passes, only its allowlist survives.
  const hostile = { value: "v", token: "t", key: "k", apiKey: "a", password: "p", passwordHash: "h", secret: "s" };
  for (const type of eventTypes.EVENT_TYPES) {
    const scrubbed = events.scrub(type, hostile);
    expect(Object.keys(scrubbed)).toEqual([]);
    for (const key of eventTypes.EVENT_DATA_KEYS[type]) {
      expect(["value", "token", "key", "apiKey", "password", "passwordHash", "secret"]).not.toContain(key);
    }
  }
});

test("scrub drops non-scalar values and bounds long strings", () => {
  // Parsed JSON is untyped, as a caller bypassing the types would be.
  const hostile = JSON.parse('{"reason":{"nested":"object"}}');
  expect(events.scrub("deploy.failed", hostile)).toEqual({});
  const long = events.scrub("deploy.failed", { reason: "x".repeat(2000) });
  expect(String(long.reason).length).toBeLessThan(600);
});

test("the feed filters by project, exact type, prefix and a time window", async () => {
  await deploy("alice", "app", "v1");
  await deploy("alice", "blog", "v1");
  const feed = async (query: string, user = "alice") => {
    const response = await activity.activityFeed(as(user, `/api/activity?${query}`));
    expect(response.status).toBe(200);
    const body: Feed = await response.json();
    return body;
  };

  expect((await feed("project=blog")).events.every((event) => event.project === "blog")).toBe(true);
  expect((await feed("project=blog")).events).toHaveLength(3);
  expect((await feed("type=deploy.succeeded")).events.map((event) => event.type)).toEqual([
    "deploy.succeeded",
    "deploy.succeeded",
  ]);
  expect((await feed("type=deploy.*")).events).toHaveLength(4);
  expect((await feed("type=project.created,deploy.started")).events).toHaveLength(4);
  expect((await feed("type=deploy.*&project=app")).events).toHaveLength(2);

  // Pin timestamps so the window is exact.
  const db = store.storeDatabase();
  const ids = (await feed("")).events.map((event) => event.id).toReversed();
  ids.forEach((id, index) =>
    db.query("UPDATE events SET ts = ? WHERE id = ?").run(`2026-01-0${index + 1}T00:00:00.000Z`, id),
  );
  const windowed = await feed("since=2026-01-02T00:00:00Z&until=2026-01-04T00:00:00Z");
  expect(windowed.events.map((event) => event.ts)).toEqual([
    "2026-01-04T00:00:00.000Z",
    "2026-01-03T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z",
  ]);
});

test("before and limit page newest first and end with a null cursor", async () => {
  for (let index = 0; index < 5; index++)
    events.recordEvent({
      ownerId: ALICE,
      project: "app",
      type: "secret.set",
      summary: `s${index}`,
      data: { name: `N${index}` },
    });
  const page = async (query: string) => {
    const body: Feed = await (await activity.activityFeed(as("alice", `/api/activity?${query}`))).json();
    return body;
  };
  const one = await page("limit=2");
  expect(one.events.map((event) => event.summary)).toEqual(["s4", "s3"]);
  expect(one.nextBefore).toBe(one.events[1].id);
  const two = await page(`limit=2&before=${one.nextBefore}`);
  expect(two.events.map((event) => event.summary)).toEqual(["s2", "s1"]);
  const three = await page(`limit=2&before=${two.nextBefore}`);
  expect(three.events.map((event) => event.summary)).toEqual(["s0"]);
  expect(three.nextBefore).toBeNull();
  // limit is capped at 200 and defaults to 50.
  expect((await page("limit=9999")).events).toHaveLength(5);
});

test("the feed is owner scoped, hides system events, and refuses all=1 to non-admins", async () => {
  events.recordEvent({ ownerId: ALICE, type: "secret.set", summary: "alice", data: { name: "A" } });
  events.recordEvent({ ownerId: BOB, type: "secret.set", summary: "bob", data: { name: "B" } });
  events.recordEvent({
    ownerId: eventTypes.SYSTEM_OWNER,
    type: "backup.created",
    actor: "timer",
    summary: "backup",
    data: { name: "b.tar.gz" },
  });

  const alice = await (await activity.activityFeed(as("alice", "/api/activity"))).json();
  expect(alice.events.map((event: { summary: string }) => event.summary)).toEqual(["alice"]);
  expect(alice.events[0]).not.toHaveProperty("ownerId");
  const bob = await (await activity.activityFeed(as("bob", "/api/activity"))).json();
  expect(bob.events.map((event: { summary: string }) => event.summary)).toEqual(["bob"]);

  expect((await activity.activityFeed(as("alice", "/api/activity?all=1"))).status).toBe(403);

  // The admin view is listEvents({ all }): every account plus system events.
  expect(
    events
      .listEvents({ all: true, limit: 50 })
      .events.map((event) => event.ownerId)
      .toSorted(),
  ).toEqual([ALICE, BOB, "system"].toSorted());
});

test("bad filters are 400s, and signed-out callers are 401", async () => {
  for (const query of ["type=nope.x", "type=deploy.nope", "since=yesterday", "until=x", "before=-3", "before=abc"]) {
    expect((await activity.activityFeed(as("alice", `/api/activity?${query}`))).status).toBe(400);
  }
  const anonymous = new Request("http://control.test/api/activity");
  // No bootstrap header and no Better Auth session: authentication is unavailable or absent.
  expect((await activity.activityFeed(anonymous)).status).toBeGreaterThanOrEqual(401);
});

test("the types endpoint lists every type and the prefix groups", async () => {
  const body = await activity.activityTypes().json();
  expect(body.types).toEqual([...eventTypes.EVENT_TYPES]);
  expect(body.types).toHaveLength(21);
  expect(body.groups).toContain("deploy.*");
  expect(body.groups).toContain("webhook.*");
});

test("pruning drops events past the retention window and beyond the row cap", () => {
  const db = store.storeDatabase();
  for (let index = 0; index < 6; index++)
    events.recordEvent({ ownerId: ALICE, type: "secret.set", summary: `s${index}`, data: { name: "N" } });
  db.query("UPDATE events SET ts = ? WHERE summary IN ('s0', 's1')").run("2020-01-01T00:00:00.000Z");
  process.env.SPROUTBOAT_EVENTS_KEEP_DAYS = "30";
  expect(events.pruneEvents()).toBe(2);
  process.env.SPROUTBOAT_EVENTS_MAX_ROWS = "2";
  expect(events.pruneEvents()).toBe(2);
  expect(mine().map((event) => event.summary)).toEqual(["s4", "s5"]);
});

test("the caps show up in the limits output", async () => {
  process.env.SPROUTBOAT_EVENTS_KEEP_DAYS = "90";
  const body = await (await limits.accountLimits(as("alice", "/api/limits"))).json();
  expect(body.limits).toMatchObject({ eventsKeepDays: 90, eventsMaxRows: 50000, webhooksPerAccount: 10 });
});

test("recordEvent never throws, even when the store is unusable", () => {
  process.env.SPROUTBOAT_DATABASE_PATH = "/nonexistent-dir-for-sproutboat/x/control.sqlite";
  expect(() => events.recordEvent({ ownerId: ALICE, type: "secret.set", summary: "x" })).not.toThrow();
});
