import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { genericOAuth } from "better-auth/plugins";

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
        const profile = await response.json() as { id?: string | number; login?: string; name?: string; email?: string; avatar_url?: string };
        if (profile.id === undefined || !profile.email) return null;
        return { id: profile.id, name: profile.name || profile.login || "GitHub developer", email: profile.email, image: profile.avatar_url, emailVerified: true };
      },
    }] }) : undefined;
  return betterAuth({
    appName: "Sproutboat",
    database: new Database(process.env.SPROUTBOAT_DATABASE_PATH || "/var/lib/sproutboat/sproutboat.sqlite"),
    secret,
    baseURL,
    trustedOrigins: [dashboardUrl],
    socialProviders: githubEmulatorUrl ? {} : { github: { clientId: githubClientId, clientSecret: githubClientSecret } },
    plugins: emulatorPlugin ? [apiKeyPlugin, emulatorPlugin] : [apiKeyPlugin],
    advanced: {
      useSecureCookies: true,
      crossSubDomainCookies: { enabled: false },
    },
  });
}

let configuredAuth: ReturnType<typeof createAuth> | undefined;

export function getAuth() {
  if (!configuredAuth) configuredAuth = createAuth();
  return configuredAuth;
}
