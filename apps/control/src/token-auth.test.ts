import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// API keys authenticate as "token" actors, never as browser sessions. Runs in
// its own process because auth.ts caches the Better Auth instance.
const root = join(import.meta.dir, "..", "..", "..");

const script = `
import { getMigrations } from "better-auth/db/migration";
import { getAuth, ensureAdminSeeded } from "./apps/control/src/auth";
import { adminCreateUser, banUser } from "./apps/control/src/admin";
import { actorFor, listCredentials } from "./apps/control/src/identity";
import { approveCliAuthorization, createCliAuthorization, listCliCredentials } from "./apps/control/src/cli-authorization";
import { authDatabase } from "./apps/control/src/auth";

await (await getMigrations(getAuth().options)).runMigrations();
await ensureAdminSeeded();
const signed = await getAuth().api.signInEmail({ body: { email: "admin@example.test", password: process.env.SPROUTBOAT_BOOTSTRAP_TOKEN }, returnHeaders: true });
const cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0];
const asAdmin = (path, init = {}) => new Request("http://control.test" + path, { ...init, headers: { cookie, "content-type": "application/json", ...init.headers } });
const withKey = (key, init = {}) => new Request("http://control.test/x", { ...init, headers: { "x-api-key": key, ...init.headers } });

const make = async (email, username) => (await (await adminCreateUser(asAdmin("/api/admin/users", { method: "POST", body: JSON.stringify({ email, username, password: "a-long-password-1" }) }))).json()).id;
const bob = await make("bob@example.test", "bob");
const carol = await make("carol@example.test", "carol");
const adminId = (await (await getAuth().$context).internalAdapter.findUserByEmail("admin@example.test")).user.id;
const keyFor = async (userId) => (await getAuth().api.createApiKey({ body: { userId, name: "k" } })).key;
const [bobKey, carolKey, adminKey] = [await keyFor(bob), await keyFor(carol), await keyFor(adminId)];

const session = await actorFor(asAdmin("/x"));
const bobActor = await actorFor(withKey(bobKey));
const bearer = await actorFor(new Request("http://control.test/x", { headers: { authorization: "Bearer " + bobKey } }));
const adminActor = await actorFor(withKey(adminKey));
const bogus = await actorFor(withKey("sproutboat_nope"));

const approvalAuth = await (await createCliAuthorization()).json();
const approveWithToken = await approveCliAuthorization(withKey(bobKey, { method: "POST" }), approvalAuth.userCode);
const listWithToken = await listCliCredentials(withKey(bobKey));

// a key whose owner is banned directly in the database is refused
authDatabase().run("UPDATE user SET banned = 1 WHERE id = ?", [carol]);
const carolBanned = await actorFor(withKey(carolKey));

const bobKeysBefore = listCredentials(bob).length;
const banned = await banUser(asAdmin("/x", { method: "POST", body: "{}" }), bob);
const bobKeysAfter = listCredentials(bob).length;
const bobAfterBan = await actorFor(withKey(bobKey));
const adminKeysAfter = listCredentials(adminId).length;

console.log(JSON.stringify({
  session: session?.authentication, bob: bobActor?.authentication, bearer: bearer?.authentication,
  admin: [adminActor?.authentication, adminActor?.isAdmin], bogus: bogus ?? null,
  approveWithToken: approveWithToken.status, listWithToken: listWithToken.status,
  carolBanned: carolBanned ?? null,
  bobKeysBefore, banned: banned.status, bobKeysAfter, bobAfterBan: bobAfterBan ?? null, adminKeysAfter,
}));
`;

test("API keys yield token actors; banned owners are refused; ban revokes keys; session-only routes refuse tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sb-token-auth-"));
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
    if (code !== 0) console.error(err);
    expect(code).toBe(0);
    const result = JSON.parse(out.trim().split("\n").at(-1) ?? "");
    expect(result.session).toBe("session");
    expect(result.bob).toBe("token");
    expect(result.bearer).toBe("token");
    expect(result.admin).toEqual(["token", true]);
    expect(result.bogus).toBeNull();
    expect(result.approveWithToken).toBe(401);
    expect(result.listWithToken).toBe(403);
    expect(result.carolBanned).toBeNull();
    expect(result.bobKeysBefore).toBe(1);
    expect(result.banned).toBe(200);
    expect(result.bobKeysAfter).toBe(0);
    expect(result.bobAfterBan).toBeNull();
    expect(result.adminKeysAfter).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
