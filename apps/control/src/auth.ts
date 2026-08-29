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
  const socialGithub = !useEmulator && githubSignInConfigured() ? { github: { clientId: clientId!, clientSecret: clientSecret! } } : {};
  return betterAuth({
    appName: "Sproutboat",
    database: new Database(process.env.SPROUTBOAT_DATABASE_PATH || "/var/lib/sproutboat/sproutboat.sqlite"),
    secret,
    baseURL,
    trustedOrigins: [dashboardUrl],
    // The single admin signs in with the bootstrap token as a credential
    // password (account seeded by ensureAdminSeeded). Self-service registration
    // is blocked at the HTTP layer in main.ts — the /sign-up route is refused.
    emailAndPassword: { enabled: true },
    socialProviders: socialGithub,
    plugins: emulatorPlugin ? [apiKeyPlugin, adminPlugin, emulatorPlugin] : [apiKeyPlugin, adminPlugin],
    advanced: {
      // The __Secure- prefix that `true` forces is rejected by browsers over a
      // local dev cert, which breaks the OAuth state cookie. Opt out for local
      // dev only; production leaves this unset and stays secure.
      useSecureCookies: process.env.SPROUTBOAT_INSECURE_COOKIES === "1" ? false : true,
      crossSubDomainCookies: { enabled: false },
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
  const { reserveUsername } = await import("./identity");
  if (/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(username)) {
    try { reserveUsername(userId, username, { allowReserved: true }); } catch { /* already reserved */ }
  }
  seeded = true;
}
