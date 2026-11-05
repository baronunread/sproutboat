import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Webhooks: registration API, the delivery queue, signing, the retry schedule
// and the egress-only transport. The SSRF tests run the real Bun egress service
// (the one the systemd install can fall back to) against a loopback receiver.
let dir: string;
let store: typeof import("./store");
let events: typeof import("./events");
let hooks: typeof import("./webhooks");
let activity: typeof import("./activity");
let secrets: typeof import("./secrets");
let limits: typeof import("./limits");
let cryptoKey: typeof import("./secrets-crypto");
let deployments: typeof import("./deployments");
const roots: string[] = [];
const children: Array<{ kill: () => void }> = [];

const ALICE = "bootstrap:alice";
const BOB = "bootstrap:bob";
const EGRESS_TOKEN = "egress-test-token";
const egressScript = join(import.meta.dir, "../../../node_modules/@sproutboat/wire/src/egress.ts");

function as(user: string, path: string, init: RequestInit = {}): Request {
  process.env.SPROUTBOAT_BOOTSTRAP_USERNAME = user;
  return new Request(`http://control.test${path}`, {
    ...init,
    headers: { authorization: "Bearer tok", ...init.headers },
  });
}
type HookBody = { url?: string; types?: string[] | string; format?: string; secret?: string; enabled?: boolean };
const post = (user: string, path: string, body: HookBody) =>
  as(user, path, { method: "POST", body: JSON.stringify(body) });

type Call = { url: string; headers: Headers; body: string; signal: AbortSignal | null | undefined };
function recorder(respond: () => Response | Promise<Response> = () => new Response("ok")) {
  const calls: Call[] = [];
  const fetchImpl: import("./webhooks").FetchLike = async (input, init) => {
    calls.push({ url: input, headers: new Headers(init.headers), body: String(init.body), signal: init.signal });
    return respond();
  };
  return { calls, fetchImpl };
}

function record(type: "secret.set" | "deploy.succeeded" | "deploy.failed" = "secret.set", ownerId = ALICE) {
  const event = events.recordEvent({
    ownerId,
    project: "app",
    type,
    actor: "alice",
    summary: `a ${type} happened`,
    data:
      type === "secret.set"
        ? { name: "API_KEY" }
        : type === "deploy.failed"
          ? { reason: "boom" }
          : { hostname: "app.alice.test", binarySize: 10 },
  });
  if (!event) throw new Error("event was not recorded");
  return event;
}
const hook = (over: Partial<Parameters<typeof hooks.createWebhook>[0]> = {}) =>
  hooks.createWebhook({
    ownerId: ALICE,
    url: "https://receiver.example/hook",
    types: [],
    format: "json",
    secret: "whsec-test",
    ...over,
  });
const only = (webhookId: string) => hooks.listDeliveries(webhookId, 50);

async function startEgress(env: Record<string, string>): Promise<string> {
  const child = Bun.spawn(["bun", egressScript, "--port", "0"], {
    env: { ...process.env, SB_EGRESS_TOKEN: EGRESS_TOKEN, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const reader = child.stdout.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`egress exited early: ${text}`);
    text += new TextDecoder().decode(value);
    const found = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(text);
    if (found) return found[1];
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-webhooks-"));
  roots.push(dir);
  process.env.SPROUTBOAT_ARTIFACTS_DIR = join(dir, "artifacts");
  process.env.SPROUTBOAT_BOOTSTRAP_TOKEN = "tok";
  process.env.SPROUTBOAT_DEPLOYMENT_DOMAIN = "sb.invalid";
  delete process.env.SPROUTBOAT_ACTIVATION_DIR;
  store = await import("./store");
  events = await import("./events");
  hooks = await import("./webhooks");
  activity = await import("./activity");
  secrets = await import("./secrets");
  limits = await import("./limits");
  cryptoKey = await import("./secrets-crypto");
  deployments = await import("./deployments");
});
afterAll(async () => {
  for (const child of children) child.kill();
  delete process.env.SB_EGRESS_URL;
  delete process.env.SB_EGRESS_TOKEN;
  store.closeStore();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
beforeEach(async () => {
  store.closeStore();
  cryptoKey.resetSecretsKeyForTest();
  limits.resetLimiter();
  const run = await mkdtemp(join(tmpdir(), "sb-webhooks-run-"));
  roots.push(run);
  process.env.SPROUTBOAT_DATABASE_PATH = join(run, "control.sqlite");
  process.env.SPROUTBOAT_ROUTE_SNAPSHOT = join(run, "routes.json");
  process.env.SPROUTBOAT_DEPLOYMENTS_PATH = join(run, "deployments.json");
  process.env.SB_EGRESS_URL = "http://egress.test:8070";
  process.env.SB_EGRESS_TOKEN = EGRESS_TOKEN;
  delete process.env.SB_EGRESS_ALLOW;
  delete process.env.SPROUTBOAT_MAX_WEBHOOKS_PER_ACCOUNT;
});

// --- registration API ---------------------------------------------------------

test("create returns 201 with a one-time secret; later reads never include it", async () => {
  const created = await activity.webhookCreate(
    post("alice", "/api/webhooks", {
      url: "https://receiver.example/hook",
      types: ["deploy.*", "secret.set"],
      format: "discord",
    }),
  );
  expect(created.status).toBe(201);
  const body = await created.json();
  expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
  expect(body).toMatchObject({
    url: "https://receiver.example/hook",
    types: ["deploy.*", "secret.set"],
    format: "discord",
    enabled: true,
  });
  expect(body.id).toMatch(/^wh_[0-9a-f]{24}$/);
  expect(body).not.toHaveProperty("ownerId");

  const listed = await (await activity.webhooksList(as("alice", "/api/webhooks"))).json();
  expect(listed.webhooks).toHaveLength(1);
  expect(JSON.stringify(listed)).not.toContain(body.secret);
  expect(listed.webhooks[0]).not.toHaveProperty("secret");
  // Encrypted at rest.
  const stored = JSON.stringify(store.storeDatabase().query("SELECT * FROM webhooks").all());
  expect(stored).not.toContain(body.secret);

  const given = await (
    await activity.webhookCreate(
      post("alice", "/api/webhooks", { url: "https://b.example/", types: [], format: "json", secret: "my-own-secret" }),
    )
  ).json();
  expect(given.secret).toBe("my-own-secret");
});

test("URL validation: scheme, credentials, port 25, and literal private addresses", async () => {
  const make = async (url: string, user = "alice") =>
    activity.webhookCreate(post(user, "/api/webhooks", { url, types: [], format: "json" }));
  expect((await make("ftp://example.com/x")).status).toBe(400);
  expect((await make("not a url")).status).toBe(400);
  expect((await make("https://user:pw@example.com/x")).status).toBe(400);
  expect((await make("https://example.com:25/x")).status).toBe(400);
  for (const url of [
    "http://127.0.0.1:9/x",
    "http://localhost:9/x",
    "http://[::1]:9/x",
    "http://10.0.0.5/x",
    "http://169.254.169.254/latest",
    "http://2130706433/",
  ]) {
    const response = await make(url);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("private or reserved address");
  }
  // An operator allowance opens the literal address, as it does at the egress service.
  process.env.SB_EGRESS_ALLOW = "127.0.0.1";
  expect((await make("http://127.0.0.1:9/x")).status).toBe(201);
  // Names are not resolved here: the egress service refuses those at send time.
  expect((await make("https://hooks.example.com/x")).status).toBe(201);
});

test("bad bodies are 400s: types, format, secret", async () => {
  const bad = async (body: HookBody) =>
    (await activity.webhookCreate(post("alice", "/api/webhooks", { url: "https://a.example/", ...body }))).status;
  expect(await bad({ types: "deploy.*", format: "json" })).toBe(400);
  expect(await bad({ types: ["nope.*"], format: "json" })).toBe(400);
  expect(await bad({ types: ["deploy.started,deploy.failed"], format: "json" })).toBe(400);
  expect(await bad({ types: [], format: "slack" })).toBe(400);
  expect(await bad({ types: [], format: "json", secret: "" })).toBe(400);
  expect(await bad({ types: [], format: "json" })).toBe(201);
});

test("the per-account cap is a 429 and is per account", async () => {
  process.env.SPROUTBOAT_MAX_WEBHOOKS_PER_ACCOUNT = "2";
  const make = (user: string) =>
    activity.webhookCreate(post(user, "/api/webhooks", { url: "https://a.example/", types: [], format: "json" }));
  expect((await make("alice")).status).toBe(201);
  expect((await make("alice")).status).toBe(201);
  const capped = await make("alice");
  expect(capped.status).toBe(429);
  expect((await capped.json()).error).toContain("at most 2 webhooks");
  expect((await make("bob")).status).toBe(201);
});

test("patch, delete, test and the delivery log are owner scoped", async () => {
  const created = await (
    await activity.webhookCreate(
      post("alice", "/api/webhooks", { url: "https://a.example/", types: [], format: "json" }),
    )
  ).json();
  const id = created.id;

  const patched = await activity.webhookUpdate(
    as("alice", `/api/webhooks/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ types: ["deploy.failed"], format: "discord", enabled: false, url: "https://b.example/x" }),
    }),
    id,
  );
  expect(await patched.json()).toMatchObject({
    types: ["deploy.failed"],
    format: "discord",
    enabled: false,
    url: "https://b.example/x",
  });
  expect(
    (
      await activity.webhookUpdate(
        as("alice", `/api/webhooks/${id}`, { method: "PATCH", body: JSON.stringify({ url: "ftp://x" }) }),
        id,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await activity.webhookUpdate(
        as("alice", `/api/webhooks/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: "yes" }) }),
        id,
      )
    ).status,
  ).toBe(400);

  // Bob cannot see or touch it.
  expect(
    (await activity.webhookUpdate(as("bob", `/api/webhooks/${id}`, { method: "PATCH", body: "{}" }), id)).status,
  ).toBe(404);
  expect((await activity.webhookDelete(as("bob", `/api/webhooks/${id}`, { method: "DELETE" }), id)).status).toBe(404);
  expect((await activity.webhookTest(as("bob", `/api/webhooks/${id}/test`, { method: "POST" }), id)).status).toBe(404);
  expect((await activity.webhookDeliveries(as("bob", `/api/webhooks/${id}/deliveries`), id)).status).toBe(404);
  expect((await (await activity.webhooksList(as("bob", "/api/webhooks"))).json()).webhooks).toEqual([]);

  const tested = await activity.webhookTest(as("alice", `/api/webhooks/${id}/test`, { method: "POST" }), id);
  expect(tested.status).toBe(202);
  const log = await (
    await activity.webhookDeliveries(as("alice", `/api/webhooks/${id}/deliveries?limit=10`), id)
  ).json();
  expect(log.deliveries).toHaveLength(1);
  expect(log.deliveries[0]).toMatchObject({ eventType: "webhook.test", state: "pending", attempt: 0 });

  expect((await activity.webhookDelete(as("alice", `/api/webhooks/${id}`, { method: "DELETE" }), id)).status).toBe(200);
  expect(hooks.listDeliveries(id, 10)).toEqual([]);
  expect((await activity.webhookDelete(as("alice", `/api/webhooks/${id}`, { method: "DELETE" }), id)).status).toBe(404);
});

// --- enqueueing ---------------------------------------------------------------

test("an event is queued for each enabled, matching webhook of its account only", () => {
  const all = hook();
  const exact = hook({ types: ["secret.set"] });
  const prefix = hook({ types: ["deploy.*"] });
  const other = hook({ types: ["deploy.failed", "secret.set"] });
  const off = hook();
  hooks.updateWebhook(ALICE, off.id, { enabled: false });
  const bobs = hook({ ownerId: BOB });

  record("secret.set");
  expect(only(all.id)).toHaveLength(1);
  expect(only(exact.id)).toHaveLength(1);
  expect(only(prefix.id)).toHaveLength(0);
  expect(only(other.id)).toHaveLength(1);
  expect(only(off.id)).toHaveLength(0);
  expect(only(bobs.id)).toHaveLength(0);

  record("deploy.failed");
  expect(only(prefix.id)).toHaveLength(1);
  expect(only(exact.id)).toHaveLength(1);
});

test("system events go to nobody, and webhook.test goes to its own webhook only", () => {
  const a = hook();
  const b = hook();
  events.recordEvent({ ownerId: "system", type: "backup.created", actor: "timer", summary: "b", data: { name: "x" } });
  expect(only(a.id)).toHaveLength(0);
  events.recordEvent({
    ownerId: ALICE,
    type: "webhook.test",
    summary: "t",
    data: { webhookId: a.id },
    webhookId: a.id,
  });
  expect(only(a.id)).toHaveLength(1);
  expect(only(b.id)).toHaveLength(0);
  // Without a target it is dropped rather than broadcast.
  events.recordEvent({ ownerId: ALICE, type: "webhook.test", summary: "t" });
  expect(only(a.id)).toHaveLength(1);
});

test("only the newest 200 deliveries per webhook are kept", () => {
  const a = hook();
  for (let index = 0; index < 205; index++) record();
  expect(
    store.storeDatabase().query("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = ?").get(a.id),
  ).toEqual({ n: 200 });
  expect(hooks.listDeliveries(a.id, 500)).toHaveLength(200);
});

// --- sending ------------------------------------------------------------------

test("a delivery goes through the egress service, signed over the exact body", async () => {
  const a = hook();
  const event = record("deploy.succeeded");
  const { calls, fetchImpl } = recorder();
  const now = new Date(Date.now() + 1000);
  expect(await hooks.deliverDue({ now, fetchImpl })).toBe(1);

  expect(calls).toHaveLength(1);
  const [call] = calls;
  expect(call.url).toBe("http://egress.test:8070/");
  expect(call.headers.get("x-sb-egress-url")).toBe("https://receiver.example/hook");
  expect(call.headers.get("x-sb-egress-token")).toBe(EGRESS_TOKEN);
  expect(call.headers.get("content-type")).toBe("application/json");
  expect(call.headers.get("user-agent")).toMatch(/^sproutboat-webhooks\/\d+\.\d+\.\d+/);
  expect(call.headers.get("x-sproutboat-event")).toBe("deploy.succeeded");
  const delivery = only(a.id)[0];
  expect(call.headers.get("x-sproutboat-delivery")).toBe(delivery.id);
  expect(call.signal).toBeDefined();

  const signature = call.headers.get("x-sproutboat-signature") ?? "";
  const parsed = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signature);
  expect(parsed).not.toBeNull();
  expect(Number(parsed?.[1])).toBe(Math.floor(now.getTime() / 1000));
  const expected = createHmac("sha256", "whsec-test").update(`${parsed?.[1]}.${call.body}`).digest("hex");
  expect(parsed?.[2]).toBe(expected);
  // A tampered body no longer verifies.
  const tampered = createHmac("sha256", "whsec-test").update(`${parsed?.[1]}.${call.body}x`).digest("hex");
  expect(parsed?.[2]).not.toBe(tampered);
  // And so does the wrong secret.
  expect(hooks.signatureHeader("other", Number(parsed?.[1]), call.body)).not.toBe(signature);

  expect(JSON.parse(call.body)).toEqual({
    id: event.id,
    type: "deploy.succeeded",
    ts: event.ts,
    account: "alice",
    project: "app",
    actor: "alice",
    summary: "a deploy.succeeded happened",
    data: { hostname: "app.alice.test", binarySize: 10 },
  });
  expect(delivery).toMatchObject({ state: "delivered", attempt: 1, httpStatus: 200, error: null });
  expect(delivery.deliveredAt).toBe(now.toISOString());
});

test("retries at +30s, +2m, +10m, +1h and then ends failed", async () => {
  const a = hook();
  record();
  const { calls, fetchImpl } = recorder(() => new Response("nope", { status: 500 }));
  let clock = new Date(Date.now() + 1000);
  const at = (ms: number) => new Date(clock.getTime() + ms);

  expect(await hooks.deliverDue({ now: clock, fetchImpl })).toBe(1);
  let delivery = only(a.id)[0];
  expect(delivery).toMatchObject({ state: "pending", attempt: 1, httpStatus: 500, error: "receiver responded 500" });
  expect(delivery.nextAttemptAt).toBe(at(30_000).toISOString());

  // Not due yet one second early; nothing is attempted.
  expect(await hooks.deliverDue({ now: at(29_000), fetchImpl })).toBe(0);

  const gaps = [120_000, 600_000, 3_600_000];
  clock = at(30_000);
  for (const [index, gap] of gaps.entries()) {
    expect(await hooks.deliverDue({ now: clock, fetchImpl })).toBe(1);
    delivery = only(a.id)[0];
    expect(delivery.attempt).toBe(index + 2);
    expect(delivery.state).toBe("pending");
    expect(delivery.nextAttemptAt).toBe(at(gap).toISOString());
    clock = at(gap);
  }
  expect(await hooks.deliverDue({ now: clock, fetchImpl })).toBe(1);
  delivery = only(a.id)[0];
  expect(delivery).toMatchObject({ state: "failed", attempt: 5, nextAttemptAt: null, httpStatus: 500 });
  expect(calls).toHaveLength(5);
  // Terminal: nothing more, however long we wait.
  expect(await hooks.deliverDue({ now: new Date(clock.getTime() + 86_400_000), fetchImpl })).toBe(0);
});

test("a network error retries; a later 2xx delivers", async () => {
  const a = hook();
  record();
  let fail = true;
  const { fetchImpl } = recorder(() => {
    if (fail) throw new Error("connect ECONNREFUSED");
    return new Response(null, { status: 204 });
  });
  const start = new Date(Date.now() + 1000);
  await hooks.deliverDue({ now: start, fetchImpl });
  expect(only(a.id)[0]).toMatchObject({
    state: "pending",
    attempt: 1,
    httpStatus: null,
    error: "connect ECONNREFUSED",
  });
  fail = false;
  await hooks.deliverDue({ now: new Date(start.getTime() + 30_000), fetchImpl });
  expect(only(a.id)[0]).toMatchObject({ state: "delivered", attempt: 2, httpStatus: 204 });
});

test("an egress refusal is recorded as refused with its message and never retried", async () => {
  const a = hook();
  record();
  const message =
    "fetch() refused: receiver.example resolves to 10.0.0.9, a private or reserved address (10.0.0.0/8). An operator can allow it with SB_EGRESS_ALLOW=10.0.0.9";
  const { calls, fetchImpl } = recorder(() =>
    Response.json({ error: message }, { status: 502, headers: { "x-sb-egress-error": "1" } }),
  );
  const start = new Date(Date.now() + 1000);
  await hooks.deliverDue({ now: start, fetchImpl });
  expect(only(a.id)[0]).toMatchObject({
    state: "refused",
    attempt: 1,
    httpStatus: 502,
    error: message,
    nextAttemptAt: null,
  });
  expect(await hooks.deliverDue({ now: new Date(start.getTime() + 86_400_000), fetchImpl })).toBe(0);
  expect(calls).toHaveLength(1);
});

test("with no egress configured a delivery fails closed and never calls fetch", async () => {
  const a = hook();
  record();
  delete process.env.SB_EGRESS_URL;
  const { calls, fetchImpl } = recorder();
  const start = new Date(Date.now() + 1000);
  await hooks.deliverDue({ now: start, fetchImpl });
  expect(only(a.id)[0]).toMatchObject({ state: "pending", attempt: 1, error: "egress not configured" });
  process.env.SB_EGRESS_URL = "http://egress.test:8070";
  delete process.env.SB_EGRESS_TOKEN;
  await hooks.deliverDue({ now: new Date(start.getTime() + 30_000), fetchImpl });
  expect(only(a.id)[0]).toMatchObject({ attempt: 2, error: "egress not configured" });
  expect(calls).toHaveLength(0);
});

test("a disabled webhook is not delivered to, but its test events are", async () => {
  const a = hook();
  record();
  hooks.updateWebhook(ALICE, a.id, { enabled: false });
  const { calls, fetchImpl } = recorder();
  const start = new Date(Date.now() + 1000);
  await hooks.deliverDue({ now: start, fetchImpl });
  expect(only(a.id)[0]).toMatchObject({ state: "failed", error: "webhook disabled" });
  expect(calls).toHaveLength(0);

  const tested = await activity.webhookTest(as("alice", `/api/webhooks/${a.id}/test`, { method: "POST" }), a.id);
  expect(tested.status).toBe(202);
  await hooks.deliverDue({ now: new Date(start.getTime() + 1000), fetchImpl });
  expect(calls).toHaveLength(1);
  expect(calls[0].headers.get("x-sproutboat-event")).toBe("webhook.test");
});

test("discord format: embed with colour, fields and footer, and still signed", async () => {
  const a = hook({ format: "discord" });
  record("deploy.succeeded");
  record("deploy.failed");
  record("secret.set");
  events.recordEvent({ ownerId: ALICE, type: "member.disabled", summary: "off", data: { userId: "u1" } });
  const { calls, fetchImpl } = recorder();
  await hooks.deliverDue({ now: new Date(Date.now() + 1000), fetchImpl });
  expect(only(a.id).every((delivery) => delivery.state === "delivered")).toBe(true);

  const embeds = calls.map((call) => JSON.parse(call.body).embeds[0]);
  const byTitle = Object.fromEntries(embeds.map((embed) => [embed.description.split(" ")[0], embed]));
  expect(byTitle["deploy.succeeded"]).toMatchObject({
    title: "a deploy.succeeded happened",
    color: 0x2ecc71,
    fields: [
      { name: "hostname", value: "app.alice.test", inline: true },
      { name: "binarySize", value: "10", inline: true },
    ],
    footer: { text: "Sproutboat · app" },
  });
  expect(byTitle["deploy.succeeded"].description).toBe("deploy.succeeded by alice");
  expect(Number.isNaN(Date.parse(byTitle["deploy.succeeded"].timestamp))).toBe(false);
  expect(byTitle["deploy.failed"].color).toBe(0xe74c3c);
  expect(byTitle["secret.set"].color).toBe(0x95a5a6);
  expect(byTitle["member.disabled"].color).toBe(0xf59e0b);
  expect(byTitle["member.disabled"].footer.text).toBe("Sproutboat · alice");
  for (const call of calls) {
    expect(call.headers.get("x-sproutboat-signature")).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const [, t, sig] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(call.headers.get("x-sproutboat-signature") ?? "") ?? [];
    expect(sig).toBe(createHmac("sha256", "whsec-test").update(`${t}.${call.body}`).digest("hex"));
  }
});

test("rolled_back and other amber/green colours follow the type suffix", async () => {
  const formats = await import("./webhook-formats");
  expect(formats.discordColor("deploy.rolled_back")).toBe(0xf59e0b);
  expect(formats.discordColor("domain.verified")).toBe(0x2ecc71);
  expect(formats.discordColor("project.created")).toBe(0x2ecc71);
  expect(formats.discordColor("backup.failed")).toBe(0xe74c3c);
  expect(formats.discordColor("deploy.started")).toBe(0x95a5a6);
});

test("a secret value never reaches the events table or any webhook body", async () => {
  hook({ types: [] });
  hook({ format: "discord" });
  const form = new FormData();
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  header.writeUInt16LE(62, 18);
  const bytes = new Uint8Array(header);
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  form.set(
    "manifest",
    new File(
      [
        JSON.stringify({
          schemaVersion: 2,
          project: "app",
          target: "linux-x86_64",
          runtime: "native-fetch",
          capabilityProfile: "http-sync-v0",
          porfforVersion: "alpha-4 (a415d19)",
          esbuildVersion: "0.28.2",
          buildImage: "stamp",
          sourceHash: `sha256:${"0".repeat(64)}`,
          binaryHash: `sha256:${digest}`,
          binarySize: bytes.length,
          builtAt: new Date().toISOString(),
        }),
      ],
      "manifest.json",
    ),
  );
  form.set("sprout", new File([bytes], "sprout"));
  expect(
    (
      await deployments.deployArtifact(
        as("alice", "/api/projects/app/deployments", { method: "POST", body: form }),
        "app",
      )
    ).status,
  ).toBe(201);
  const put = await secrets.putSecret(
    as("alice", "/api/projects/app/secrets/DB_PASSWORD", {
      method: "PUT",
      body: JSON.stringify({ value: "super-secret-value" }),
    }),
    "app",
    "DB_PASSWORD",
  );
  expect(put.status).toBe(201);

  expect(JSON.stringify(store.storeDatabase().query("SELECT * FROM events").all())).not.toContain("super-secret-value");
  const { calls, fetchImpl } = recorder();
  await hooks.deliverDue({ now: new Date(Date.now() + 1000), fetchImpl, limit: 100 });
  expect(calls.length).toBeGreaterThanOrEqual(8); // 4 events x 2 webhooks
  expect(calls.some((call) => call.body.includes("DB_PASSWORD"))).toBe(true);
  for (const call of calls) expect(call.body).not.toContain("super-secret-value");
});

// --- the real egress service ----------------------------------------------------

test("a webhook aimed at a loopback receiver is refused by the egress service; an allowance opens it", async () => {
  const seen: Array<{ headers: Headers; body: string }> = [];
  const receiver = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      seen.push({ headers: request.headers, body: await request.text() });
      return new Response("got it");
    },
  });
  try {
    const target = `http://127.0.0.1:${receiver.port}/hook`;
    // Bypass the creation-time literal check on purpose: the egress service is the enforcement.
    const a = hook({ url: target, secret: "loopback-secret" });
    record();

    process.env.SB_EGRESS_URL = await startEgress({ SB_EGRESS_ALLOW: "" });
    const start = new Date(Date.now() + 1000);
    expect(await hooks.deliverDue({ now: start })).toBe(1);
    const refused = only(a.id)[0];
    expect(refused.state).toBe("refused");
    expect(refused.error).toContain("127.0.0.1 resolves to 127.0.0.1, a private or reserved address");
    expect(refused.error).toContain("SB_EGRESS_ALLOW=127.0.0.1");
    expect(seen).toHaveLength(0);
    expect(await hooks.deliverDue({ now: new Date(start.getTime() + 86_400_000) })).toBe(0);
    expect(seen).toHaveLength(0);

    // Same webhook, an egress that the operator has opened to loopback.
    process.env.SB_EGRESS_URL = await startEgress({ SB_EGRESS_ALLOW: "127.0.0.1" });
    record();
    expect(await hooks.deliverDue({ now: new Date(Date.now() + 1000) })).toBe(1);
    expect(seen).toHaveLength(1);
    const delivered = only(a.id).find((delivery) => delivery.state === "delivered");
    expect(delivered).toMatchObject({ httpStatus: 200, attempt: 1 });

    const [request] = seen;
    expect(request.headers.get("x-sproutboat-event")).toBe("secret.set");
    expect(request.headers.get("x-sproutboat-delivery")).toBe(delivered?.id ?? "");
    const parsed = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(request.headers.get("x-sproutboat-signature") ?? "");
    expect(parsed).not.toBeNull();
    expect(parsed?.[2]).toBe(
      createHmac("sha256", "loopback-secret").update(`${parsed?.[1]}.${request.body}`).digest("hex"),
    );
    expect(JSON.parse(request.body)).toMatchObject({
      type: "secret.set",
      account: "alice",
      project: "app",
      data: { name: "API_KEY" },
    });
  } finally {
    receiver.stop(true);
  }
}, 30_000);
