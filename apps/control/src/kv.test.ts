import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let id: string;
let kv: typeof import("./kv");
let store: typeof import("./store");
const request = (path: string, init?: RequestInit) =>
  new Request(`http://control.test${path}`, { ...init, headers: { "x-api-key": "test-token", ...init?.headers } });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-kv-api-"));
  process.env.SPROUTBOAT_DATABASE_PATH = join(dir, "control.sqlite");
  process.env.SPROUTBOAT_RESOURCE_DIR = join(dir, "resources");
  process.env.SPROUTBOAT_BOOTSTRAP_TOKEN = "test-token";
  process.env.SPROUTBOAT_BOOTSTRAP_USERNAME = "tester";
  store = await import("./store");
  kv = await import("./kv");
  id = store.createResource("bootstrap:tester", "kv", "registrations").id;
});

afterAll(async () => {
  store.closeStore();
  await rm(dir, { recursive: true, force: true });
});

test("single-key operations are owner-scoped", async () => {
  const key = encodeURIComponent("email:person@example.com");
  expect(
    (
      await kv.kvKey(
        request(`/api/kv/${id}/keys/${key}`, { method: "PUT", body: JSON.stringify({ value: "joined" }) }),
        id,
        "email:person@example.com",
      )
    ).status,
  ).toBe(200);
  const found = await kv.kvKey(request(`/api/kv/${id}/keys/${key}`), id, "email:person@example.com");
  expect(await found.json()).toEqual({ key: "email:person@example.com", value: "joined" });

  process.env.SPROUTBOAT_BOOTSTRAP_USERNAME = "stranger";
  expect((await kv.kvKey(request(`/api/kv/${id}/keys/${key}`), id, "email:person@example.com")).status).toBe(404);
  process.env.SPROUTBOAT_BOOTSTRAP_USERNAME = "tester";
});

test("listing paginates in key order and filters by prefix", async () => {
  for (const [key, value] of [
    ["registration:a", "a"],
    ["registration:b", "b"],
    ["other", "c"],
  ])
    await kv.kvKey(request("/", { method: "PUT", body: JSON.stringify({ value }) }), id, key);
  const first = await kv.listKvKeys(request(`/api/kv/${id}/keys?prefix=registration%3A&limit=1`), id);
  expect(await first.json()).toEqual({ keys: ["registration:a"], cursor: "registration:a" });
  const second = await kv.listKvKeys(
    request(`/api/kv/${id}/keys?prefix=registration%3A&limit=1&cursor=registration%3Aa`),
    id,
  );
  expect(await second.json()).toEqual({ keys: ["registration:b"], cursor: null });
});

test("bulk get and delete return bounded result contracts", async () => {
  const got = await kv.kvBulk(
    request("/", { method: "POST", body: JSON.stringify(["registration:a", "missing"]) }),
    id,
    "get",
  );
  expect(await got.json()).toEqual([
    { key: "registration:a", value: "a" },
    { key: "missing", value: null },
  ]);
  const deleted = await kv.kvBulk(
    request("/", { method: "POST", body: JSON.stringify(["registration:a", "missing"]) }),
    id,
    "delete",
  );
  expect(await deleted.json()).toEqual({ deleted: 1, failures: [] });
});

test("oversized existing values are refused and audit records omit contents", async () => {
  const database = new Database(join(dir, "resources", `${id}.sqlite`));
  database
    .query("INSERT OR REPLACE INTO kv (ns, key, value) VALUES (?, ?, ?)")
    .run(id, "private-key", "x".repeat(9 * 1024 * 1024));
  database.close();
  const info = spyOn(console, "info").mockImplementation(() => undefined);
  const response = await kv.kvKey(request("/"), id, "private-key");
  expect(response.status).toBe(413);
  const event = info.mock.calls.at(-1)?.[0] ?? "";
  expect(event).toContain('"operation":"get"');
  expect(event).not.toContain("private-key");
  expect(event).not.toContain("xxxxxxxx");
  info.mockRestore();
});
