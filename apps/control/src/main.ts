import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAuth } from "./auth";
import { activateDeployment, deleteProject, deployArtifact, isDeploymentHostname, listDeployments, listProjects, projectLogs } from "./deployments";
import { actorFor, profileForUser, reserveUsername, signedInUserId } from "./identity";
import { approveCliAuthorization, createCliAuthorization, exchangeCliAuthorization } from "./cli-authorization";

type Route = { hostname: string; workerPath: string };
const routesPath = resolve(process.env.PORFFER_ROUTE_SNAPSHOT || "/var/lib/porffer/routes.json");
const port = Number(process.env.PORT || 8787);

async function activeHostnames(): Promise<Set<string>> {
  try {
    const routes = JSON.parse(await readFile(routesPath, "utf8")) as Route[];
    return new Set(routes.map((route) => route.hostname));
  } catch {
    return new Set();
  }
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/auth/")) {
      try {
        return await getAuth().handler!(request);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "authentication is unavailable" }, { status: 503 });
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/cli/authorizations") return createCliAuthorization();
    if (request.method === "POST" && url.pathname === "/v1/cli/authorizations/token") {
      const body = await request.json().catch(() => ({})) as { deviceCode?: unknown };
      return exchangeCliAuthorization(body.deviceCode);
    }
    const cliApproval = /^\/v1\/cli\/authorizations\/([A-F0-9]{4}-[A-F0-9]{4})\/approve$/.exec(url.pathname);
    if (request.method === "POST" && cliApproval) return approveCliAuthorization(request, cliApproval[1]);
    if (url.pathname === "/v1/me") {
      try {
        const userId = await signedInUserId(request);
        if (!userId) return Response.json({ error: "sign in required" }, { status: 401 });
        const actor = await actorFor(request);
        return Response.json({ userId, profile: profileForUser(userId) || null, isOperator: actor?.isOperator === true });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "authentication is unavailable" }, { status: 503 });
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/me/namespace") {
      try {
        const userId = await signedInUserId(request);
        if (!userId) return Response.json({ error: "sign in required" }, { status: 401 });
        const body = await request.json() as { username?: unknown };
        if (typeof body.username !== "string") return Response.json({ error: "username is required" }, { status: 400 });
        return Response.json({ profile: reserveUsername(userId, body.username) }, { status: 201 });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "could not reserve username" }, { status: 409 });
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/operator/overview") {
      const actor = await actorFor(request);
      if (!actor?.isOperator) return Response.json({ error: "operator access required" }, { status: 403 });
      return Response.json({ ok: true });
    }
    const deployment = /^\/v1\/projects\/([a-z0-9-]+)\/deployments$/.exec(url.pathname);
    if (request.method === "GET" && url.pathname === "/v1/projects") return listProjects(request);
    if (request.method === "POST" && deployment) return deployArtifact(request, deployment[1]);
    if (request.method === "GET" && deployment) return listDeployments(request, deployment[1]);
    const project = /^\/v1\/projects\/([a-z0-9-]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && project) return deleteProject(request, project[1]);
    const activation = /^\/v1\/projects\/([a-z0-9-]+)\/deployments\/([a-z0-9-]+)\/activate$/.exec(url.pathname);
    if (request.method === "POST" && activation) return activateDeployment(request, activation[1], activation[2]);
    const logs = /^\/v1\/projects\/([a-z0-9-]+)\/logs\/stream$/.exec(url.pathname);
    if (request.method === "GET" && logs) return projectLogs(request, logs[1]);
    if (url.pathname === "/internal/health") return Response.json({ ok: true, service: "control" });
    if (url.pathname === "/internal/tls/allow") {
      const domain = url.searchParams.get("domain")?.toLowerCase() || "";
      const allowed = isDeploymentHostname(domain) && (await activeHostnames()).has(domain);
      return new Response(allowed ? "allowed" : "unknown deployment", { status: allowed ? 200 : 403 });
    }
    if (url.pathname === "/") {
      return new Response("Porffer is an experimental platform. The control API is not public yet.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`Porffer control listening on http://127.0.0.1:${server.port}`);
