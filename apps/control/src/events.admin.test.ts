import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Members and CLI tokens need a real Better Auth session, which caches per
// process, so (like auth-admin.test.ts) the flow runs in its own process: sign
// in as the seeded admin, create and disable a member, issue and revoke CLI
// tokens, then read the feed back as the admin and as a plain account.
const root = join(import.meta.dir, "..", "..", "..");

const script = `
import { getMigrations } from "better-auth/db/migration";
import { getAuth, ensureAdminSeeded } from "./apps/control/src/auth";
import { adminCreateUser, banUser, unbanUser } from "./apps/control/src/admin";
import { activityFeed } from "./apps/control/src/activity";
import { approveCliAuthorization, createCliAuthorization, exchangeCliAuthorization, listCliCredentials, revokeAllCliCredentials, revokeCliCredential } from "./apps/control/src/cli-authorization";
import { storeDatabase } from "./apps/control/src/store";

await (await getMigrations(getAuth().options)).runMigrations();
await ensureAdminSeeded();
const signed = await getAuth().api.signInEmail({ body: { email: "admin@example.test", password: process.env.SPROUTBOAT_BOOTSTRAP_TOKEN }, returnHeaders: true });
const cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0];
const call = (path, init = {}) => new Request("http://control.test" + path, { ...init, headers: { cookie, "content-type": "application/json", ...init.headers } });

const created = await adminCreateUser(call("/api/admin/users", { method: "POST", body: JSON.stringify({ email: "bob@example.test", username: "bob", password: "bobs-password-123" }) }));
const bob = await created.json();
const banned = await banUser(call("/x", { method: "POST", body: "{}" }), bob.id);
const unbanned = await unbanUser(call("/x", { method: "POST" }), bob.id);

const auth = await createCliAuthorization();
const { deviceCode, userCode } = await auth.json();
const approved = await approveCliAuthorization(call("/x", { method: "POST" }), userCode);
const exchanged = await exchangeCliAuthorization(deviceCode);
const token = (await exchanged.json()).token;
const credentials = (await (await listCliCredentials(call("/x"))).json()).credentials;
const revoked = await revokeCliCredential(call("/x", { method: "DELETE" }), credentials[0].id);
const revokedAll = await revokeAllCliCredentials(call("/x", { method: "DELETE" }));

const feed = await (await activityFeed(call("/api/activity"))).json();
const all = await (await activityFeed(call("/api/activity?all=1"))).json();
console.log(JSON.stringify({
  statuses: [created.status, banned.status, unbanned.status, approved.status, exchanged.status, revoked.status, revokedAll.status],
  token, bobId: bob.id,
  feed: feed.events.map((e) => ({ type: e.type, actor: e.actor, data: e.data, ownerId: e.ownerId })),
  allCount: all.events.length,
  allHasOwner: all.events.every((e) => typeof e.ownerId === "string"),
  dump: JSON.stringify(storeDatabase().query("SELECT * FROM events").all()),
}));
`;

test("member and token events are recorded with the acting admin as owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sb-events-admin-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: root,
      env: {
        ...process.env,
        SPROUTBOAT_DATABASE_PATH: join(dir, "sproutboat.sqlite"),
        SPROUTBOAT_ROUTE_SNAPSHOT: join(dir, "routes.json"),
        BETTER_AUTH_SECRET: "x".repeat(40),
        BETTER_AUTH_URL: "https://dashboard.example.test",
        SPROUTBOAT_INSECURE_COOKIES: "1",
        SPROUTBOAT_ADMIN_EMAILS: "admin@example.test",
        SPROUTBOAT_BOOTSTRAP_USERNAME: "boss",
        SPROUTBOAT_BOOTSTRAP_TOKEN: "bootstrap-token-0123456789",
        SPROUTBOAT_AUTH_RATE_MAX: "1000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(err).not.toContain("error");
    expect(code).toBe(0);
    const result = JSON.parse(out.trim().split("\n").at(-1) ?? "");
    expect(result.statuses).toEqual([201, 200, 200, 200, 200, 200, 200]);

    const trail = result.feed.toReversed();
    expect(trail.map((event: { type: string }) => event.type)).toEqual([
      "member.created",
      "member.disabled",
      "member.enabled",
      "token.created",
      "token.revoked",
    ]);
    expect(trail.every((event: { actor: string }) => event.actor === "boss")).toBe(true);
    expect(trail[0].data).toEqual({ userId: result.bobId, username: "bob", email: "bob@example.test" });
    expect(trail[1].data).toEqual({ userId: result.bobId });
    expect(trail[3].data).toMatchObject({ name: "Sproutboat CLI" });
    expect(trail[3].data.keyId).toBeTruthy();
    expect(trail[4].data.keyId).toBe(trail[3].data.keyId);

    // Revoking all when none are left records nothing; the key itself, the
    // password and any hash never land in the table.
    expect(result.dump).not.toContain(result.token);
    expect(result.dump).not.toContain("bobs-password-123");
    expect(result.dump).not.toContain("bootstrap-token-0123456789");
    expect(result.allCount).toBe(5);
    expect(result.allHasOwner).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
