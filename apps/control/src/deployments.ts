import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { validateArtifactDirectory } from "./artifact";
import { actorFor, purgeUser, type Actor } from "./identity";
import { guardDeploy, guardNewProject, LIMITS } from "./limits";
import { aggregateLogs, readLogHistory, readLogTailText, readSproutLogText, routeTraffic, tailLogs } from "./logs";
import {
  activateDeployment as storeActivate,
  activeProjects,
  collectArtifacts,
  deleteDeployment as storeDeleteDeployment,
  deleteOwner,
  deleteProject as storeDeleteProject,
  type Deployment,
  ownerDeployments,
  ownerProjectCount,
  type ProjectSummary,
  projectDeployment,
  projectDeployments,
  pruneProjectDeployments,
  recordDeployment,
  syncRoutes,
} from "./store";

export type { Deployment, ProjectSummary } from "./store";

const artifactRoot = resolve(process.env.SPROUTBOAT_ARTIFACTS_DIR || "/var/lib/sproutboat/artifacts");

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

/**
 * #55: the Porffor pin the currently-active version of this project was built
 * with, or null if there is no active version or its manifest is unreadable.
 * Deployed artifacts are frozen at their build-time Porffor — a redeploy is the
 * only way to move — so a deploy that changes this value is worth flagging: the
 * alpha compiler's output can differ between pins (see the CLI's COMPAT.md).
 */
async function activePorfforVersion(ownerId: string, project: string): Promise<string | null> {
  const active = projectDeployments(ownerId, project).find((deployment) => deployment.active);
  if (!active) return null;
  const validation = await validateArtifactDirectory(resolve(artifactRoot, active.artifact));
  return validation.ok ? validation.value.manifest.porfforVersion : null;
}

async function authorized(request: Request): Promise<Actor | Response> {
  try {
    const actor = await actorFor(request);
    return actor || Response.json({ error: "sign in and reserve a username before using this endpoint" }, { status: 401 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "authentication is unavailable" }, { status: 503 });
  }
}

export async function listDeployments(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  return Response.json(projectDeployments(actor.id, project));
}

export async function listProjects(request: Request): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  return Response.json(activeProjects(actor.id));
}

export async function dashboardOverview(request: Request): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;

  const deployments = ownerDeployments(actor.id);
  const projects = activeProjects(actor.id);
  const hostnames = new Set(projects.map((project) => project.hostname));
  const { requests, successes } = await routeTraffic(hostnames);

  const overview: DashboardOverview = {
    metrics: {
      activeProjects: projects.length,
      deployments: deployments.length,
      requestsLast24Hours: requests,
      successRate: requests ? Math.round((successes / requests) * 1000) / 10 : null,
    },
    projects,
    deployments: deployments
      .slice(0, 20)
      .map(({ id, project, hostname, artifact, deployedAt, active }) => ({ id, project, hostname, artifact, deployedAt, active })),
  };
  return Response.json(overview);
}

/**
 * #4: the full immutable record for one version — deployment fields plus the
 * validated manifest/toolchain fields read from the artifact directory. A
 * missing or unreadable artifact returns the record with `manifest: null` and
 * `manifestError` rather than a 500.
 */
export async function deploymentDetail(request: Request, project: string, id: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const found = projectDeployment(actor.id, project, id);
  if (!found) return Response.json({ error: "deployment not found" }, { status: 404 });
  const validation = await validateArtifactDirectory(resolve(artifactRoot, found.artifact));
  return Response.json({
    id: found.id, project: found.project, hostname: found.hostname, artifact: found.artifact,
    sproutPath: found.sproutPath, deployedAt: found.deployedAt, active: found.active,
    manifest: validation.ok ? validation.value.manifest : null,
    manifestError: validation.ok ? null : validation.errors.join("; "),
  });
}

/**
 * #4: delete one inactive version and GC its artifact if nothing else references
 * the digest. The active version is rejected with 409.
 */
export async function deleteDeployment(request: Request, project: string, id: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const result = storeDeleteDeployment(actor.id, project, id);
  if (!result) return Response.json({ error: "deployment not found" }, { status: 404 });
  if (result.active) return Response.json({ error: "cannot delete the active version — roll back or replace it first" }, { status: 409 });
  const cleanup = await collectArtifacts(result.orphanedArtifacts);
  return Response.json(
    { deleted: id, artifactsRemoved: cleanup.removed, artifactCleanupFailed: cleanup.failed },
    { status: cleanup.failed.length ? 207 : 200 },
  );
}

export async function activateDeployment(request: Request, project: string, id: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const deployment = storeActivate(actor.id, project, id);
  if (!deployment) return Response.json({ error: "deployment not found" }, { status: 404 });
  await syncRoutes();
  return Response.json({ id, project, active: true, url: `https://${deployment.hostname}` });
}

/** CLI `tail`: chronological last 100 records as NDJSON (bounded tail read). */
export async function projectLogs(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const hostname = deploymentHostname(project, actor.username);
  const body = await readLogTailText(hostname, 100);
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

/** #3: bounded, filterable history page for the dashboard Observability view. */
export async function projectLogHistory(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const params = new URL(request.url).searchParams;
  const hostname = deploymentHostname(project, actor.username);
  const page = await readLogHistory(hostname, {
    before: params.get("before") || undefined,
    limit: Number(params.get("limit")) || undefined,
    statusClass: params.get("status") || undefined,
    q: params.get("q") || undefined,
  });
  return Response.json(page);
}

/** #3: Server-Sent Events live tail; the reader stops when the client disconnects. */
export async function projectLogTail(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const hostname = deploymentHostname(project, actor.username);
  return tailLogs(hostname, request.signal);
}

/** stdout/stderr of the active deployment's running sprout + broker (plain text). */
export async function projectSproutLog(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const active = projectDeployments(actor.id, project).find((deployment) => deployment.active);
  if (!active) return Response.json({ error: "no active deployment" }, { status: 404 });
  const text = await readSproutLogText(basename(dirname(active.sproutPath)));
  return new Response(text || "(no sprout output — the deployment has not started, or its handler logs nothing)\n",
    { headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** #10: coarse, bounded traffic aggregation for the project's charts. */
export async function projectMetrics(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const range = new URL(request.url).searchParams.get("range") ?? "24h";
  const hostname = deploymentHostname(project, actor.username);
  return Response.json(await aggregateLogs(hostname, range));
}

/**
 * #1: delete a project and every version, drop its route, and GC any artifact
 * no other deployment still references. Requires the exact project name back in
 * `?confirm=`. Reports partial cleanup rather than claiming success.
 */
export async function deleteProject(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const confirm = new URL(request.url).searchParams.get("confirm");
  if (confirm !== project) return Response.json({ error: "add ?confirm=<project name> to delete a project" }, { status: 400 });

  const result = storeDeleteProject(actor.id, project);
  if (result.removed === 0) return Response.json({ error: "project not found" }, { status: 404 });
  await syncRoutes();
  const cleanup = await collectArtifacts(result.orphanedArtifacts);
  const body = { deleted: project, versionsRemoved: result.removed, routeRemoved: result.hostnames, artifactsRemoved: cleanup.removed, artifactCleanupFailed: cleanup.failed };
  return Response.json(body, { status: cleanup.failed.length ? 207 : 200 });
}

export async function deployArtifact(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(project)) return Response.json({ error: "invalid project name" }, { status: 400 });
  const rateLimited = await guardDeploy(actor.id, request);
  if (rateLimited) return rateLimited;
  if (projectDeployments(actor.id, project).length === 0) {
    const capped = await guardNewProject(actor.id, request, ownerProjectCount(actor.id));
    if (capped) return capped;
  }
  let form: FormData;
  try { form = await request.formData(); }
  catch { return Response.json({ error: "expected multipart artifact upload" }, { status: 400 }); }
  const manifest = form.get("manifest");
  const sprout = form.get("sprout");
  if (!(manifest instanceof File) || !(sprout instanceof File)) return Response.json({ error: "upload must include manifest and sprout files" }, { status: 400 });
  if (manifest.size > 64 * 1024 || sprout.size > 16 * 1024 * 1024) return Response.json({ error: "artifact exceeds upload limit" }, { status: 413 });
  // #1 — optional sidecars: bindings.json (drives the per-deployment broker) and
  // the static-asset tree (assets.json + one `asset` part per file, keyed by its
  // posix path). validateArtifactDirectory re-checks their shape and hashes.
  const bindings = form.get("bindings");
  const assetsManifest = form.get("assets_manifest");
  const assetFiles = form.getAll("asset").filter((part): part is File => part instanceof File);
  if (bindings instanceof File && bindings.size > 64 * 1024) return Response.json({ error: "bindings.json exceeds 64 KiB" }, { status: 413 });
  if (assetFiles.length > 4096) return Response.json({ error: "too many asset files" }, { status: 413 });
  if (assetFiles.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) return Response.json({ error: "assets exceed the 64 MiB limit" }, { status: 413 });

  const temporary = resolve(artifactRoot, `.upload-${randomUUID()}`);
  await mkdir(temporary, { recursive: true, mode: 0o750 });
  try {
    await Promise.all([
      writeFile(resolve(temporary, "manifest.json"), new Uint8Array(await manifest.arrayBuffer()), { mode: 0o640 }),
      writeFile(resolve(temporary, "sprout"), new Uint8Array(await sprout.arrayBuffer()), { mode: 0o555 }),
    ]);
    await chmod(resolve(temporary, "sprout"), 0o555);
    if (bindings instanceof File) {
      await writeFile(resolve(temporary, "bindings.json"), new Uint8Array(await bindings.arrayBuffer()), { mode: 0o640 });
    }
    if (assetsManifest instanceof File) {
      await writeFile(resolve(temporary, "assets.json"), new Uint8Array(await assetsManifest.arrayBuffer()), { mode: 0o640 });
      for (const file of assetFiles) {
        const key = file.name.startsWith("/") ? file.name : `/${file.name}`;
        if (key.includes("..") || key.includes("\0")) return Response.json({ error: `invalid asset path: ${file.name}` }, { status: 400 });
        const target = resolve(temporary, "assets", `.${key}`);
        if (!target.startsWith(resolve(temporary, "assets") + "/")) return Response.json({ error: `asset path escapes the tree: ${file.name}` }, { status: 400 });
        await mkdir(dirname(target), { recursive: true, mode: 0o750 });
        await writeFile(target, new Uint8Array(await file.arrayBuffer()), { mode: 0o640 });
      }
    }
    const validation = await validateArtifactDirectory(temporary);
    if (!validation.ok) return Response.json({ error: "invalid artifact", details: validation.errors }, { status: 400 });
    if (validation.value.manifest.project !== project) return Response.json({ error: "manifest project does not match request path" }, { status: 400 });
    // #55: capture the outgoing version's Porffor pin before it is replaced.
    const previousPorffor = await activePorfforVersion(actor.id, project);
    const digest = validation.value.manifest.binaryHash.slice("sha256:".length);
    const destination = resolve(artifactRoot, digest);
    try { await rename(temporary, destination); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")) throw error;
      await rm(temporary, { recursive: true, force: true });
    }
    const hostname = deploymentHostname(project, actor.username);
    const deployment = recordDeployment({
      id: randomUUID(), project, ownerId: actor.id, username: actor.username,
      hostname, artifact: digest, sproutPath: resolve(destination, "sprout"), deployedAt: new Date().toISOString(),
    });
    await syncRoutes();
    // #25 — keep the retained-versions cap; GC any artifact it orphans.
    const orphaned = pruneProjectDeployments(actor.id, project, LIMITS.versionsPerProject());
    if (orphaned.length > 0) await collectArtifacts(orphaned);
    const incomingPorffor = validation.value.manifest.porfforVersion;
    const porfforDrift = previousPorffor && previousPorffor !== incomingPorffor
      ? { from: previousPorffor, to: incomingPorffor }
      : undefined;
    return Response.json({ id: deployment.id, hostname, url: `https://${hostname}`, artifact: digest, activated: true, porfforDrift }, { status: 201 });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    return Response.json({ error: error instanceof Error ? error.message : "deployment failed" }, { status: 500 });
  }
}

/**
 * #16: delete the caller's account and everything they own. Deployment
 * hostnames stop serving (routes synced) before any identity row is removed, and
 * every step is an idempotent delete, so re-running after a partial failure is
 * safe.
 */
export async function deleteAccount(request: Request): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  if (actor.authentication !== "session") return Response.json({ error: "account deletion requires an interactive session" }, { status: 403 });

  const result = deleteOwner(actor.id);
  await syncRoutes();
  const cleanup = await collectArtifacts(result.orphanedArtifacts);
  const identity = purgeUser(actor.id);

  const response = Response.json({
    deleted: true,
    versionsRemoved: result.removed,
    routesRemoved: result.hostnames,
    artifactsRemoved: cleanup.removed,
    artifactCleanupFailed: cleanup.failed,
    identityRemoved: identity,
  }, { status: cleanup.failed.length ? 207 : 200 });
  response.headers.append("set-cookie", "better-auth.session_token=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  return response;
}
