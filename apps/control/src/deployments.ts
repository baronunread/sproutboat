import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { validateArtifactDirectory } from "../../../packages/artifact/src/validate";
import { actorFor, type Actor } from "./identity";

export type Route = { hostname: string; workerPath: string };

const artifactRoot = resolve(process.env.SPROUTBOAT_ARTIFACTS_DIR || "/var/lib/sproutboat/artifacts");
const routesPath = resolve(process.env.SPROUTBOAT_ROUTE_SNAPSHOT || "/var/lib/sproutboat/routes.json");
const deploymentsPath = resolve(process.env.SPROUTBOAT_DEPLOYMENTS_PATH || "/var/lib/sproutboat/deployments.json");
const logPath = resolve(process.env.SPROUTBOAT_LOG_PATH || "/var/lib/sproutboat/logs/requests.ndjson");

export type Deployment = { id: string; project: string; ownerId: string; username: string; hostname: string; artifact: string; workerPath: string; deployedAt: string; active: boolean };
export type ProjectSummary = { name: string; hostname: string; activeDeploymentId: string; deployedAt: string };
export type DashboardOverview = {
  metrics: { activeProjects: number; deployments: number; requestsLast24Hours: number; successRate: number | null };
  projects: ProjectSummary[];
  deployments: Array<Pick<Deployment, "id" | "project" | "hostname" | "artifact" | "deployedAt" | "active">>;
};

export function deploymentDomain(): string {
  const domain = (process.env.SPROUTBOAT_DEPLOYMENT_DOMAIN || "sproutboat.com").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) throw new Error("SPROUTBOAT_DEPLOYMENT_DOMAIN must be a lowercase multi-label hostname");
  return domain;
}

export function deploymentHostname(project: string, username: string): string {
  return `${project}.${username}.${deploymentDomain()}`;
}

export function isDeploymentHostname(hostname: string): boolean {
  const suffix = `.${deploymentDomain()}`;
  if (!hostname.endsWith(suffix)) return false;
  return /^[a-z0-9-]+\.[a-z0-9-]+$/.test(hostname.slice(0, -suffix.length));
}

async function authorized(request: Request): Promise<Actor | Response> {
  try {
    const actor = await actorFor(request);
    return actor || Response.json({ error: "sign in and reserve a username before using this endpoint" }, { status: 401 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "authentication is unavailable" }, { status: 503 });
  }
}

async function readRoutes(): Promise<Route[]> {
  try { return JSON.parse(await readFile(routesPath, "utf8")) as Route[]; }
  catch { return []; }
}

async function activateRoute(route: Route): Promise<void> {
  const routes = (await readRoutes()).filter((item) => item.hostname !== route.hostname);
  routes.push(route);
  await mkdir(resolve(routesPath, ".."), { recursive: true });
  const temporary = `${routesPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(routes, null, 2)}\n`, { mode: 0o640 });
  await rename(temporary, routesPath);
}

async function removeRoute(hostname: string): Promise<void> {
  const routes = (await readRoutes()).filter((route) => route.hostname !== hostname);
  await mkdir(resolve(routesPath, ".."), { recursive: true });
  const temporary = `${routesPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(routes, null, 2)}\n`, { mode: 0o640 });
  await rename(temporary, routesPath);
}

async function readDeployments(): Promise<Deployment[]> {
  try { return JSON.parse(await readFile(deploymentsPath, "utf8")) as Deployment[]; }
  catch { return []; }
}

async function writeDeployments(deployments: Deployment[]): Promise<void> {
  await mkdir(resolve(deploymentsPath, ".."), { recursive: true });
  const temporary = `${deploymentsPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(deployments, null, 2)}\n`, { mode: 0o640 });
  await rename(temporary, deploymentsPath);
}

export async function listDeployments(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  return Response.json((await readDeployments()).filter((deployment) => deployment.project === project && deployment.ownerId === actor.id));
}

export async function listProjects(request: Request): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const active = (await readDeployments()).filter((deployment) => deployment.ownerId === actor.id && deployment.active);
  const projects: ProjectSummary[] = active.map((deployment) => ({
    name: deployment.project,
    hostname: deployment.hostname,
    activeDeploymentId: deployment.id,
    deployedAt: deployment.deployedAt,
  }));
  return Response.json(projects.sort((left, right) => left.name.localeCompare(right.name)));
}

export async function dashboardOverview(request: Request): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;

  const deployments = (await readDeployments()).filter((deployment) => deployment.ownerId === actor.id);
  const active = deployments.filter((deployment) => deployment.active);
  const projects = active.map((deployment) => ({
    name: deployment.project,
    hostname: deployment.hostname,
    activeDeploymentId: deployment.id,
    deployedAt: deployment.deployedAt,
  })).sort((left, right) => left.name.localeCompare(right.name));
  const hostnames = new Set(active.map((deployment) => deployment.hostname));
  const since = Date.now() - 24 * 60 * 60 * 1000;
  let requestsLast24Hours = 0;
  let successfulRequests = 0;
  try {
    for (const line of (await readFile(logPath, "utf8")).trim().split("\n")) {
      const event = JSON.parse(line) as { at?: string; hostname?: string; status?: number };
      if (!event.hostname || !hostnames.has(event.hostname) || !event.at || new Date(event.at).getTime() < since) continue;
      requestsLast24Hours += 1;
      if (typeof event.status === "number" && event.status >= 200 && event.status < 400) successfulRequests += 1;
    }
  } catch { /* No request log exists until the edge receives traffic. */ }

  const overview: DashboardOverview = {
    metrics: {
      activeProjects: projects.length,
      deployments: deployments.length,
      requestsLast24Hours,
      successRate: requestsLast24Hours ? Math.round((successfulRequests / requestsLast24Hours) * 1000) / 10 : null,
    },
    projects,
    deployments: deployments
      .sort((left, right) => right.deployedAt.localeCompare(left.deployedAt))
      .slice(0, 20)
      .map(({ id, project, hostname, artifact, deployedAt, active }) => ({ id, project, hostname, artifact, deployedAt, active })),
  };
  return Response.json(overview);
}

export async function activateDeployment(request: Request, project: string, id: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const deployments = await readDeployments();
  const deployment = deployments.find((item) => item.project === project && item.ownerId === actor.id && item.id === id);
  if (!deployment) return Response.json({ error: "deployment not found" }, { status: 404 });
  for (const item of deployments) if (item.project === project && item.ownerId === actor.id) item.active = item.id === id;
  await activateRoute({ hostname: deployment.hostname, workerPath: deployment.workerPath });
  await writeDeployments(deployments);
  return Response.json({ id, project, active: true, url: `https://${deployment.hostname}` });
}

export async function projectLogs(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const hostname = deploymentHostname(project, actor.username);
  try {
    const lines = (await readFile(logPath, "utf8")).trimEnd().split("\n").filter((line) => line.includes(`"hostname":"${hostname}"`)).slice(-100);
    return new Response(`${lines.join("\n")}\n`, { headers: { "content-type": "application/x-ndjson" } });
  } catch {
    return new Response("", { headers: { "content-type": "application/x-ndjson" } });
  }
}

export async function deleteProject(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const deployments = await readDeployments();
  const removed = deployments.filter((deployment) => deployment.project === project && deployment.ownerId === actor.id);
  if (!removed.length) return Response.json({ error: "project not found" }, { status: 404 });
  await removeRoute(removed[0].hostname);
  await writeDeployments(deployments.filter((deployment) => deployment.project !== project || deployment.ownerId !== actor.id));
  return new Response(null, { status: 204 });
}

export async function deployArtifact(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(project)) return Response.json({ error: "invalid project name" }, { status: 400 });
  let form: FormData;
  try { form = await request.formData(); }
  catch { return Response.json({ error: "expected multipart artifact upload" }, { status: 400 }); }
  const manifest = form.get("manifest");
  const worker = form.get("worker");
  if (!(manifest instanceof File) || !(worker instanceof File)) return Response.json({ error: "upload must include manifest and worker files" }, { status: 400 });
  if (manifest.size > 64 * 1024 || worker.size > 16 * 1024 * 1024) return Response.json({ error: "artifact exceeds upload limit" }, { status: 413 });

  const temporary = resolve(artifactRoot, `.upload-${randomUUID()}`);
  await mkdir(temporary, { recursive: true, mode: 0o750 });
  try {
    await Promise.all([
      writeFile(resolve(temporary, "manifest.json"), new Uint8Array(await manifest.arrayBuffer()), { mode: 0o640 }),
      writeFile(resolve(temporary, "worker"), new Uint8Array(await worker.arrayBuffer()), { mode: 0o555 }),
    ]);
    await chmod(resolve(temporary, "worker"), 0o555);
    const validation = await validateArtifactDirectory(temporary);
    if (!validation.ok) return Response.json({ error: "invalid artifact", details: validation.errors }, { status: 400 });
    if (validation.value.manifest.project !== project) return Response.json({ error: "manifest project does not match request path" }, { status: 400 });
    const digest = validation.value.manifest.binaryHash.slice("sha256:".length);
    const destination = resolve(artifactRoot, digest);
    try { await rename(temporary, destination); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")) throw error;
      await rm(temporary, { recursive: true, force: true });
    }
    const hostname = deploymentHostname(project, actor.username);
    const deployment: Deployment = { id: randomUUID(), project, ownerId: actor.id, username: actor.username, hostname, artifact: digest, workerPath: resolve(destination, "worker"), deployedAt: new Date().toISOString(), active: true };
    const deployments = await readDeployments();
    for (const item of deployments) if (item.project === project && item.ownerId === actor.id) item.active = false;
    deployments.push(deployment);
    await activateRoute({ hostname, workerPath: deployment.workerPath });
    await writeDeployments(deployments);
    return Response.json({ id: deployment.id, hostname, url: `https://${hostname}`, artifact: digest, activated: true }, { status: 201 });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    return Response.json({ error: error instanceof Error ? error.message : "deployment failed" }, { status: 500 });
  }
}
