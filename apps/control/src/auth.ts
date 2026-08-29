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

function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = process.env.BETTER_AUTH_URL;
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
  const githubEmulatorUrl = process.env.GITHUB_EMULATOR_URL?.replace(/\/$/, "");
  const dashboardUrl = process.env.SPROUTBOAT_DASHBOARD_URL || "https://dashboard.sproutboat.com";
  if (!secret || secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be set to at least 32 high-entropy characters");
  if (!baseURL) throw new Error("BETTER_AUTH_URL must be set to the public dashboard.sproutboat.com URL");
  if (!githubClientId || !githubClientSecret) throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required for GitHub sign-in");
  const apiKeyPlugin = apiKey({
    defaultPrefix: "sproutboat_",
    apiKeyHeaders: "x-api-key",
    enableSessionForAPIKeys: true,
    rateLimit: { enabled: true, maxRequests: 120, timeWindow: 60_000 },
  });
  const emulatorPlugin = githubEmulatorUrl ? genericOAuth({ config: [{
      providerId: "github",
      name: "GitHub",
      clientId: githubClientId,
      clientSecret: githubClientSecret,
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
  return betterAuth({
    appName: "Sproutboat",
    database: new Database(process.env.SPROUTBOAT_DATABASE_PATH || "/var/lib/sproutboat/sproutboat.sqlite"),
    secret,
    baseURL,
    trustedOrigins: [dashboardUrl],
    socialProviders: githubEmulatorUrl ? {} : { github: { clientId: githubClientId, clientSecret: githubClientSecret } },
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
