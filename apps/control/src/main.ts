import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { adminEmail, ensureAdminSeeded, getAuth, githubSignInConfigured } from "./auth";
import { activateDeployment, dashboardOverview, deleteAccount, deleteDeployment, deleteProject, deploymentDetail, deployArtifact, isDeploymentHostname, listDeployments, listProjects, projectLogHistory, projectLogs, projectLogTail, projectMetrics } from "./deployments";
import { actorFor, profileForUser, reserveUsername, sessionUser } from "./identity";
import { clientIp, rateHit } from "./limits";
import { approveCliAuthorization, createCliAuthorization, exchangeCliAuthorization, listCliCredentials, revokeAllCliCredentials, revokeCliCredential } from "./cli-authorization";
import { adminBackups, adminCreateBackup, adminDeleteBackup, adminDownloadBackup, adminOverview, adminUserDetail, adminUsers, banUser, revokeUserSessions, unbanUser } from "./admin";

type Route = { hostname: string; workerPath: string };
const routesPath = resolve(process.env.SPROUTBOAT_ROUTE_SNAPSHOT || "/var/lib/sproutboat/routes.json");
const port = Number(process.env.PORT || 8787);
// Loopback only: Caddy is the sole public listener and reverse-proxies here.
const hostname = process.env.SPROUTBOAT_BIND_HOST || "127.0.0.1";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

function isString(value: JsonValue | undefined): value is string {
  return value !== undefined && value === String(value);
}

type DeviceCodeBody = JsonObject;
type UsernameBody = JsonObject;

function parseDeviceCodeBody(value: JsonValue): string | undefined {
  if (!(value instanceof Object) || Array.isArray(value)) return undefined;
  const body: DeviceCodeBody = value;
  return isString(body.deviceCode) ? body.deviceCode : undefined;
}

function parseUsernameBody(value: JsonValue): string | undefined {
  if (!(value instanceof Object) || Array.isArray(value)) return undefined;
  const body: UsernameBody = value;
  return isString(body.username) ? body.username : undefined;
}

async function activeHostnames(): Promise<Set<string>> {
  try {
    // SAFETY: routes.json is written by the control deployment flow with the Route[] contract.
    const routes = JSON.parse(await readFile(routesPath, "utf8")) as Route[];
    return new Set(routes.map((route) => route.hostname));
  } catch {
    return new Set();
  }
}

const server = Bun.serve({
  port,
  hostname,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/auth/")) {
      // Single-admin box: no self-service registration. The one admin account is
      // seeded by ensureAdminSeeded(); sign-in still works.
      if (url.pathname.startsWith("/api/auth/sign-up")) {
        return Response.json({ error: "registration is disabled" }, { status: 403 });
      }
      try {
        return await getAuth().handler!(request);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "authentication is unavailable" }, { status: 503 });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/config") {
      return Response.json({ githubSignIn: githubSignInConfigured(), adminEmail: adminEmail() ?? null });
    }
    if (request.method === "POST" && url.pathname === "/api/cli/authorizations") {
      const wait = rateHit(`cli-auth:${clientIp(request)}`, 20);
      if (wait > 0) return Response.json({ error: "too many login attempts; wait a moment" }, { status: 429, headers: { "retry-after": String(wait) } });
      return createCliAuthorization();
    }
    if (request.method === "POST" && url.pathname === "/api/cli/authorizations/token") {
      const body = await request.json().catch(() => null);
      return exchangeCliAuthorization(parseDeviceCodeBody(body));
    }
    const cliApproval = /^\/api\/cli\/authorizations\/([A-F0-9]{4}-[A-F0-9]{4})\/approve$/.exec(url.pathname);
    if (request.method === "POST" && cliApproval) return approveCliAuthorization(request, cliApproval[1]);
    if (request.method === "GET" && url.pathname === "/api/account") {
      try {
        const account = await sessionUser(request);
        if (!account) return Response.json({ error: "sign in required" }, { status: 401 });
        const actor = await actorFor(request);
        return Response.json({
          id: account.id,
          profile: profileForUser(account.id) || null,
          isAdmin: actor?.isAdmin === true,
          user: { name: account.name, email: account.email, image: account.image },
        });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "authentication is unavailable" }, { status: 503 });
      }
    }
    if (request.method === "DELETE" && url.pathname === "/api/account") {
      try {
        return await deleteAccount(request);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "account deletion failed" }, { status: 500 });
      }
    }
    if (url.pathname === "/api/account/credentials" || url.pathname.startsWith("/api/account/credentials/")) {
      try {
        if (request.method === "GET" && url.pathname === "/api/account/credentials") return await listCliCredentials(request);
        if (request.method === "DELETE" && url.pathname === "/api/account/credentials") return await revokeAllCliCredentials(request);
        const credential = /^\/api\/account\/credentials\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
        if (request.method === "DELETE" && credential) return await revokeCliCredential(request, credential[1]);
        return new Response("not found", { status: 404 });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "credential request failed" }, { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/account/namespace") {
      try {
        const account = await sessionUser(request);
        if (!account) return Response.json({ error: "sign in required" }, { status: 401 });
        const body = await request.json();
        const username = parseUsernameBody(body);
        if (!username) return Response.json({ error: "username is required" }, { status: 400 });
        return Response.json({ profile: reserveUsername(account.id, username) }, { status: 201 });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "could not reserve username" }, { status: 409 });
      }
    }
    if (url.pathname.startsWith("/api/admin/")) {
      try {
        if (request.method === "GET" && url.pathname === "/api/admin/overview") return await adminOverview(request);
        if (request.method === "GET" && url.pathname === "/api/admin/users") return await adminUsers(request);
        const userDetail = /^\/api\/admin\/users\/([^/]+)$/.exec(url.pathname);
        if (request.method === "GET" && userDetail) return await adminUserDetail(request, userDetail[1]);
        const ban = /^\/api\/admin\/users\/([^/]+)\/ban$/.exec(url.pathname);
        if (request.method === "POST" && ban) return await banUser(request, ban[1]);
        const unban = /^\/api\/admin\/users\/([^/]+)\/unban$/.exec(url.pathname);
        if (request.method === "POST" && unban) return await unbanUser(request, unban[1]);
        const revoke = /^\/api\/admin\/users\/([^/]+)\/sessions\/revoke$/.exec(url.pathname);
        if (request.method === "POST" && revoke) return await revokeUserSessions(request, revoke[1]);
        if (url.pathname === "/api/admin/backups") {
          if (request.method === "GET") return await adminBackups(request);
          if (request.method === "POST") return await adminCreateBackup(request);
        }
        const backup = /^\/api\/admin\/backups\/([^/]+)$/.exec(url.pathname);
        if (request.method === "GET" && backup) return await adminDownloadBackup(request, backup[1]);
        if (request.method === "DELETE" && backup) return await adminDeleteBackup(request, backup[1]);
        return new Response("not found", { status: 404 });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "admin request failed" }, { status: 500 });
      }
    }
    const deployment = /^\/api\/projects\/([a-z0-9-]+)\/deployments$/.exec(url.pathname);
    if (request.method === "GET" && url.pathname === "/api/projects") return listProjects(request);
    if (request.method === "GET" && url.pathname === "/api/overview") return dashboardOverview(request);
    if (request.method === "POST" && deployment) return deployArtifact(request, deployment[1]);
    if (request.method === "GET" && deployment) return listDeployments(request, deployment[1]);
    const project = /^\/api\/projects\/([a-z0-9-]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && project) return deleteProject(request, project[1]);
    const activation = /^\/api\/projects\/([a-z0-9-]+)\/deployments\/([a-z0-9-]+)\/activate$/.exec(url.pathname);
    if (request.method === "POST" && activation) return activateDeployment(request, activation[1], activation[2]);
    const deploymentRecord = /^\/api\/projects\/([a-z0-9-]+)\/deployments\/([a-z0-9-]+)$/.exec(url.pathname);
    if (request.method === "GET" && deploymentRecord) return deploymentDetail(request, deploymentRecord[1], deploymentRecord[2]);
    if (request.method === "DELETE" && deploymentRecord) return deleteDeployment(request, deploymentRecord[1], deploymentRecord[2]);
    const metrics = /^\/api\/projects\/([a-z0-9-]+)\/metrics$/.exec(url.pathname);
    if (request.method === "GET" && metrics) return projectMetrics(request, metrics[1]);
    const logsHistory = /^\/api\/projects\/([a-z0-9-]+)\/logs$/.exec(url.pathname);
    if (request.method === "GET" && logsHistory) return projectLogHistory(request, logsHistory[1]);
    const logsTail = /^\/api\/projects\/([a-z0-9-]+)\/logs\/tail$/.exec(url.pathname);
    if (request.method === "GET" && logsTail) return projectLogTail(request, logsTail[1]);
    const logsRecent = /^\/api\/projects\/([a-z0-9-]+)\/logs\/recent$/.exec(url.pathname);
    if (request.method === "GET" && logsRecent) return projectLogs(request, logsRecent[1]);
    if (url.pathname === "/internal/health") return Response.json({ ok: true, service: "control" });
    if (url.pathname === "/internal/tls/allow") {
      const domain = url.searchParams.get("domain")?.toLowerCase() || "";
      const allowed = isDeploymentHostname(domain) && (await activeHostnames()).has(domain);
      return new Response(allowed ? "allowed" : "unknown deployment", { status: allowed ? 200 : 403 });
    }
    if (url.pathname === "/") {
      return new Response("Sproutboat is an experimental platform. The control API is not public yet.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`Sproutboat control listening on http://${hostname}:${server.port}`);

// Seed the single admin credential account so the dashboard is usable without
// GitHub OAuth. Safe to run every boot; no-op once the account exists.
ensureAdminSeeded().catch((error) => console.error(`admin seed skipped: ${error instanceof Error ? error.message : String(error)}`));
