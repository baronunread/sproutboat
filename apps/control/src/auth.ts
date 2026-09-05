import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { admin, genericOAuth } from "better-auth/plugins";

type GithubProfile = { id: string | number; login?: string; name?: string; email: string; avatar_url?: string };
type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

function isString(value: JsonValue | undefined): value is string {
  return value !== undefined && value === String(value);
}

function isFiniteNumber(value: JsonValue | undefined): value is number {
  return Number.isFinite(value);
}

function parseGithubProfile(value: JsonValue): GithubProfile | null {
  if (!(value instanceof Object) || Array.isArray(value)) return null;
  const profile = value;
  const id = isString(profile.id) ? profile.id : isFiniteNumber(profile.id) ? profile.id : undefined;
  if (id === undefined || !isString(profile.email)) return null;
  return {
    id,
    email: profile.email,
    login: isString(profile.login) ? profile.login : undefined,
    name: isString(profile.name) ? profile.name : undefined,
    avatar_url: isString(profile.avatar_url) ? profile.avatar_url : undefined,
  };
}

const githubClientId = () => process.env.GITHUB_CLIENT_ID;
const githubClientSecret = () => process.env.GITHUB_CLIENT_SECRET;

/**
 * GitHub sign-in is optional. When it is not configured the dashboard is still
 * reachable — the admin signs in with the bootstrap token
 * (`SPROUTBOAT_BOOTSTRAP_TOKEN`) against the seeded credential account.
 */
export function githubSignInConfigured(): boolean {
  return Boolean(githubClientId() && githubClientSecret());
}

export function authDatabase(): Database {
  const database = new Database(process.env.SPROUTBOAT_DATABASE_PATH || "/var/lib/sproutboat/sproutboat.sqlite");
  // Same file as store.ts, which runs it in WAL. Without a busy_timeout this
  // connection fails SQLITE_BUSY the instant a session read/write races a WAL
  // checkpoint or another connection's write — which logs the user straight
  // back out. Match store.ts / identity.ts so it waits instead.
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  return database;
}

function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = process.env.BETTER_AUTH_URL;
  const clientId = githubClientId();
  const clientSecret = githubClientSecret();
  const githubEmulatorUrl = process.env.GITHUB_EMULATOR_URL?.replace(/\/$/, "");
  const dashboardUrl = process.env.SPROUTBOAT_DASHBOARD_URL || "https://dashboard.sproutboat.com";
  if (!secret || secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be set to at least 32 high-entropy characters");
  if (!baseURL) throw new Error("BETTER_AUTH_URL must be set to the public dashboard URL");
  const apiKeyPlugin = apiKey({
    defaultPrefix: "sproutboat_",
    apiKeyHeaders: "x-api-key",
    enableSessionForAPIKeys: true,
    rateLimit: { enabled: true, maxRequests: 120, timeWindow: 60_000 },
  });
  const useEmulator = Boolean(githubEmulatorUrl && clientId && clientSecret);
  const emulatorPlugin = useEmulator ? genericOAuth({ config: [{
      providerId: "github",
      name: "GitHub",
      clientId: clientId!,
      clientSecret: clientSecret!,
      authorizationUrl: `${githubEmulatorUrl}/login/oauth/authorize`,
      tokenUrl: `${githubEmulatorUrl}/login/oauth/access_token`,
      userInfoUrl: `${githubEmulatorUrl}/user`,
      accountIssuer: githubEmulatorUrl,
      scopes: ["user:email"],
      getUserInfo: async (tokens) => {
        const response = await fetch(`${githubEmulatorUrl}/user`, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
        if (!response.ok) return null;
        const profile = parseGithubProfile(await response.json());
        if (!profile) return null;
        return { id: profile.id, name: profile.name || profile.login || "GitHub developer", email: profile.email, image: profile.avatar_url, emailVerified: true };
      },
    }] }) : undefined;
  const adminPlugin = admin({ adminRoles: ["admin"], defaultRole: "user" });
  // GitHub sign-in never *creates* an account here — `disableSignUp` means the
  // OAuth callback only logs in someone who already has an account with that
  // email (the admin, or a user the admin provisioned), linking the GitHub
  // identity to it. No self-service signup, whether by email or by OAuth.
  const socialGithub = !useEmulator && githubSignInConfigured()
    ? { github: { clientId: clientId!, clientSecret: clientSecret!, disableSignUp: true } }
    : {};
  return betterAuth({
    appName: "Sproutboat",
    database: authDatabase(),
    secret,
    baseURL,
    trustedOrigins: [dashboardUrl],
    // Accounts are created by the admin (email + password), never self-service:
    // /api/auth/sign-up is refused in main.ts. `emailAndPassword` stays enabled
    // for the sign-in side. GitHub OAuth links to an existing account (above).
    emailAndPassword: { enabled: true },
    account: { accountLinking: { enabled: true, trustedProviders: ["github"] } },
    // #25 — throttle /api/auth/* (login, CLI token exchange) against credential
    // stuffing. Per-IP fixed window.
    rateLimit: {
      enabled: true,
      window: Number(process.env.SPROUTBOAT_AUTH_RATE_WINDOW_SEC) || 60,
      max: Number(process.env.SPROUTBOAT_AUTH_RATE_MAX) || 30,
    },
    socialProviders: socialGithub,
    plugins: emulatorPlugin ? [apiKeyPlugin, adminPlugin, emulatorPlugin] : [apiKeyPlugin, adminPlugin],
    advanced: {
      // The __Secure- prefix that `true` forces is rejected by browsers over a
      // local dev cert, which breaks the OAuth state cookie. Opt out for local
      // dev only; production leaves this unset and stays secure.
      useSecureCookies: process.env.SPROUTBOAT_INSECURE_COOKIES === "1" ? false : true,
      crossSubDomainCookies: { enabled: false },
      // Caddy is the only public listener and sets X-Forwarded-For, so the
      // auth rate limiter can bucket per real client IP.
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
    },
  });
}

let configuredAuth: ReturnType<typeof createAuth> | undefined;

export function getAuth() {
  if (!configuredAuth) configuredAuth = createAuth();
  return configuredAuth;
}

/** First admin email from SPROUTBOAT_ADMIN_EMAILS (the credential login id). */
export function adminEmail(): string | undefined {
  return (process.env.SPROUTBOAT_ADMIN_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean)[0];
}

let seeded = false;

/**
 * Idempotently create the single admin credential account so the dashboard has
 * someone to log in as without GitHub OAuth. The password is
 * SPROUTBOAT_BOOTSTRAP_TOKEN; the login id is the first SPROUTBOAT_ADMIN_EMAILS
 * entry; the namespace is SPROUTBOAT_BOOTSTRAP_USERNAME. No-op if any of those
 * are unset or the account already exists.
 */
export async function ensureAdminSeeded(): Promise<void> {
  if (seeded) return;
  const token = process.env.SPROUTBOAT_BOOTSTRAP_TOKEN;
  const username = process.env.SPROUTBOAT_BOOTSTRAP_USERNAME;
  const email = adminEmail();
  if (!token || !username || !email) return;

  const ctx = await getAuth().$context;
  const existing = await ctx.internalAdapter.findUserByEmail(email);
  let userId = existing?.user?.id;
  if (!userId) {
    // Create the credential account through the normal sign-up path so the
    // password is hashed and linked exactly as a real login expects. The HTTP
    // /sign-up route is refused in main.ts; this server-side call is not.
    try {
      const result = await getAuth().api.signUpEmail({ body: { email, password: token, name: username } });
      userId = result.user.id;
    } catch (error) {
      // Race or a partial previous run: fall back to whatever now exists.
      userId = (await ctx.internalAdapter.findUserByEmail(email))?.user?.id;
      if (!userId) throw error;
    }
  }
  // Role: identity.actorFor promotes an SPROUTBOAT_ADMIN_EMAILS user to "admin"
  // on first authenticated request, so nothing to set here. Reserve the
  // namespace now so the dashboard doesn't send the admin through setup.
  // allowReserved: the admin may hold a name like "admin" that other users can't.
  // reserveUsername enforces the slug shape itself; a bad or taken name lands in
  // the same catch, so a second copy of the rule here would only be one to drift.
  const { reserveUsername } = await import("./identity");
  try { reserveUsername(userId, username, { allowReserved: true }); } catch { /* invalid or already reserved */ }
  seeded = true;
}
