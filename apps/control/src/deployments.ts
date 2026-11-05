import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { stageCandidate } from "./activation";
import { listedAssetKeys, validateArtifactDirectory, type ResourceBindingRef } from "./artifact";
import { recordEvent } from "./events";
import { actorFor, purgeUser, type Actor } from "./identity";
import { guardDeploy, guardNewProject, LIMITS } from "./limits";
import {
  aggregateLogs,
  readLogHistory,
  readLogTailText,
  readSproutLogText,
  routeTraffic,
  runtimeName,
  sproutLogFile,
  tailLogs,
} from "./logs";
import { parseTailFilters, tailEvents } from "./tail";
import {
  activateDeployment as storeActivate,
  activeProjects,
  artifactDir,
  candidateRoute,
  collectArtifacts,
  deleteDeployment as storeDeleteDeployment,
  deleteOwner,
  deleteProject as storeDeleteProject,
  type Deployment,
  deploymentResources,
  ownerDeployments,
  ownerDomainCounts,
  ownerProjectCount,
  type ProjectSummary,
  projectDeployment,
  projectDeployments,
  projectHosts,
  pruneProjectDeployments,
  recordDeployment,
  resourceById,
  syncRoutes,
  withArtifactLock,
} from "./store";

export type { Deployment, ProjectSummary } from "./store";

// Read lazily, like store.ts, so a test can point it at a temp dir after import.
const artifactRoot = () => resolve(process.env.SPROUTBOAT_ARTIFACTS_DIR || "/var/lib/sproutboat/artifacts");

/** #78 — what one row of the Sprouts list needs, beyond the route itself. */
export type ProjectRow = ProjectSummary & {
  versions: number;
  domains: number;
  requests24h: number;
  errors24h: number;
  latencyP50: number | null;
};

export type DashboardOverview = {
  metrics: {
    activeProjects: number;
    deployments: number;
    requestsLast24Hours: number;
    successRate: number | null;
    /** #76 — 24 buckets over the last 24h across every route this account owns. */
    trend: Array<{ start: string; count: number; errors: number }>;
  };
  projects: ProjectRow[];
  deployments: Array<Pick<Deployment, "id" | "project" | "hostname" | "artifact" | "deployedAt" | "active">>;
};

export function deploymentDomain(): string {
  const domain = (process.env.SPROUTBOAT_DEPLOYMENT_DOMAIN || "sproutboat.com").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain))
    throw new Error("SPROUTBOAT_DEPLOYMENT_DOMAIN must be a lowercase multi-label hostname");
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
  const validation = await validateArtifactDirectory(artifactDir(ownerId, active.artifact));
  return validation.ok ? validation.value.manifest.porfforVersion : null;
}

async function authorized(request: Request): Promise<Actor | Response> {
  try {
    const actor = await actorFor(request);
    return (
      actor || Response.json({ error: "sign in and reserve a username before using this endpoint" }, { status: 401 })
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "authentication is unavailable" },
      { status: 503 },
    );
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
  const projectHostnames = new Map(projects.map((project) => [project.name, logHostnames(actor, project.name)]));
  const hostnames = new Set([...projectHostnames.values()].flatMap((set) => [...set]));
  const { requests, successes, buckets, byHostname } = await routeTraffic(hostnames);

  // #78 — the Sprouts list is one row per project, so each carries its own
  // version count, attached domains and traffic rather than a second fetch each.
  const versionCounts = new Map<string, number>();
  for (const deployment of deployments) {
    versionCounts.set(deployment.project, (versionCounts.get(deployment.project) ?? 0) + 1);
  }
  const domainCounts = ownerDomainCounts(actor.id);
  const rows: ProjectRow[] = projects.map((project) => {
    // Custom domains count toward their project; the median comes from its busiest host.
    const seen = [...(projectHostnames.get(project.name) ?? [])].flatMap((host) => byHostname[host] ?? []);
    const busiest = seen.reduce<(typeof seen)[number] | undefined>(
      (best, entry) => (!best || entry.requests > best.requests ? entry : best),
      undefined,
    );
    return {
      ...project,
      versions: versionCounts.get(project.name) ?? 0,
      domains: domainCounts.get(project.name) ?? 0,
      requests24h: seen.reduce((sum, entry) => sum + entry.requests, 0),
      errors24h: seen.reduce((sum, entry) => sum + entry.errors, 0),
      latencyP50: busiest?.latencyP50 ?? null,
    };
  });

  const recent = deployments.slice(0, 20);
  const overview: DashboardOverview = {
    metrics: {
      activeProjects: projects.length,
      deployments: deployments.length,
      requestsLast24Hours: requests,
      successRate: requests ? Math.round((successes / requests) * 1000) / 10 : null,
      trend: buckets,
    },
    projects: rows,
    deployments: recent.map(({ id, project, hostname, artifact, deployedAt, active }) => ({
      id,
      project,
      hostname,
      artifact,
      deployedAt,
      active,
    })),
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
  const validation = await validateArtifactDirectory(artifactDir(actor.id, found.artifact));
  return Response.json({
    id: found.id,
    project: found.project,
    hostname: found.hostname,
    artifact: found.artifact,
    sproutPath: found.sproutPath,
    deployedAt: found.deployedAt,
    active: found.active,
    // #76 — the dashboard's version + bindings views: who shipped it, what the
    // artifact declares, and which owned resources it was recorded against.
    deployedBy: found.username,
    bindings: validation.ok ? validation.value.bindings : null,
    resources: deploymentResources(actor.id, found.id),
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
  if (result.active)
    return Response.json(
      { error: "cannot delete the active version — roll back or replace it first" },
      { status: 409 },
    );
  recordEvent({
    ownerId: actor.id,
    project,
    type: "deploy.deleted",
    actor: actor.username,
    summary: `Deleted version ${id.slice(0, 8)} of ${project}`,
    data: { deploymentId: id },
  });
  const cleanup = await collectArtifacts(result.orphanedArtifacts);
  return Response.json(
    { deleted: id, artifactsRemoved: cleanup.removed, artifactCleanupFailed: cleanup.failed },
    { status: cleanup.failed.length ? 207 : 200 },
  );
}

export async function activateDeployment(request: Request, project: string, id: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const target = projectDeployment(actor.id, project, id);
  if (!target) return Response.json({ error: "deployment not found" }, { status: 404 });
  // #141: a rollback target must start too; otherwise the current version stays.
  try {
    await stageCandidate(await candidateRoute(target));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "activation failed" }, { status: 409 });
  }
  const previous = projectDeployments(actor.id, project).find((version) => version.active);
  const deployment = storeActivate(actor.id, project, id);
  if (!deployment) return Response.json({ error: "deployment not found" }, { status: 404 });
  await syncRoutes();
  const rolledBack = previous !== undefined && previous.id !== id && target.deployedAt < previous.deployedAt;
  recordEvent({
    ownerId: actor.id,
    project,
    type: rolledBack ? "deploy.rolled_back" : "deploy.activated",
    actor: actor.username,
    summary: `${rolledBack ? "Rolled back" : "Activated"} ${project} to version ${id.slice(0, 8)}`,
    data: { from: previous?.id ?? null, to: id },
  });
  return Response.json({ id, project, active: true, url: `https://${deployment.hostname}` });
}

/**
 * Every hostname the edge routes to this project: its generated hostname plus
 * each verified custom domain. The request log is keyed by the host a request
 * arrived on, so the log and tail readers filter on this whole set. Scoped by
 * owner and project, so another project's hostnames never appear.
 */
function logHostnames(actor: Actor, project: string): Set<string> {
  return new Set([deploymentHostname(project, actor.username), ...projectHosts(actor.id, project)]);
}

/** CLI `tail`: chronological last 100 records as NDJSON (bounded tail read). */
export async function projectLogs(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const hostname = logHostnames(actor, project);
  const body = await readLogTailText(hostname, 100);
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

/** #3: bounded, filterable history page for the dashboard Observability view. */
export async function projectLogHistory(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const params = new URL(request.url).searchParams;
  const hostname = logHostnames(actor, project);
  const page = await readLogHistory(hostname, {
    before: params.get("before") || undefined,
    limit: Number(params.get("limit")) || undefined,
    statusClass: params.get("status") || undefined,
    q: params.get("q") || undefined,
    method: params.get("method") || undefined,
    minDurationMs: Number(params.get("minDuration")) || undefined,
    coldStart: params.get("coldStart") === "true" ? true : undefined,
  });
  return Response.json(page);
}

/** #3: Server-Sent Events live tail; the reader stops when the client disconnects. */
export async function projectLogTail(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const hostname = logHostnames(actor, project);
  return tailLogs(hostname, request.signal);
}

/**
 * Per-app live tail (SSE): request events from the edge log merged with the
 * sprout's console output and uncaught exceptions, in Workers tail shape, with
 * server-side filters. See tail.ts for the bounds and the request-correlation
 * limitation. Auth and ownership are the same as the other log routes.
 */
export async function projectTail(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const parsed = parseTailFilters(new URL(request.url).searchParams);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  const { filters } = parsed;
  const hostname = logHostnames(actor, project);
  // Deploys can happen while a tail is open; re-resolve the active sprout each poll.
  const sproutLog = () => {
    const active = projectDeployments(actor.id, project).find((deployment) => deployment.active);
    return active ? sproutLogFile(runtimeName(active.sproutPath)) : null;
  };
  return tailEvents({ hostname, scriptName: project, sproutLog, filters, signal: request.signal });
}

/** stdout/stderr of the active deployment's running sprout + broker (plain text). */
export async function projectSproutLog(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const active = projectDeployments(actor.id, project).find((deployment) => deployment.active);
  if (!active) return Response.json({ error: "no active deployment" }, { status: 404 });
  const text = await readSproutLogText(runtimeName(active.sproutPath));
  return new Response(text || "(no sprout output — the deployment has not started, or its handler logs nothing)\n", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** #10: coarse, bounded traffic aggregation for the project's charts. */
export async function projectMetrics(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const range = new URL(request.url).searchParams.get("range") ?? "24h";
  const hostname = logHostnames(actor, project);
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
  if (confirm !== project)
    return Response.json({ error: "add ?confirm=<project name> to delete a project" }, { status: 400 });

  const result = storeDeleteProject(actor.id, project);
  if (result.removed === 0) return Response.json({ error: "project not found" }, { status: 404 });
  await syncRoutes();
  recordEvent({
    ownerId: actor.id,
    project,
    type: "project.deleted",
    actor: actor.username,
    summary: `Deleted project ${project}`,
    data: { hostnames: result.hostnames.length },
  });
  const cleanup = await collectArtifacts(result.orphanedArtifacts);
  const body = {
    deleted: project,
    versionsRemoved: result.removed,
    routeRemoved: result.hostnames,
    artifactsRemoved: cleanup.removed,
    artifactCleanupFailed: cleanup.failed,
  };
  return Response.json(body, { status: cleanup.failed.length ? 207 : 200 });
}

/**
 * #74 — confirm every `{ binding, id }` the artifact declares names a storage
 * resource `ownerId` holds, of the declared kind. Returns the deduped id list
 * to record, or a 400 Response naming the first bad reference.
 */
function resolveResourceBindings(refs: ResourceBindingRef[], ownerId: string): string[] | Response {
  const ids: string[] = [];
  for (const ref of refs) {
    const resource = resourceById(ownerId, ref.id);
    if (!resource) {
      // #79 — each kind is its own CLI command now; name the one they need.
      const command = ref.kind === "queue" ? "queues" : ref.kind;
      return Response.json(
        {
          error: `binding ${ref.binding}: no resource ${ref.id} — create it with \`sproutboat ${command} create <name>\``,
        },
        { status: 400 },
      );
    }
    if (resource.kind !== ref.kind) {
      return Response.json(
        { error: `binding ${ref.binding}: ${ref.id} is a ${resource.kind}, not a ${ref.kind}` },
        { status: 400 },
      );
    }
    ids.push(ref.id);
  }
  return [...new Set(ids)];
}

/**
 * #80 — an artifact's identity is its sprout binary plus the sidecars that ride
 * with it (the manifest, so a metadata change is a new version too). `assets.json` already carries a hash per asset file, so hashing it
 * covers the whole tree. Without this, a changed asset tree on an unchanged
 * handler produced the same digest, hit EEXIST on rename, and the new assets
 * were discarded.
 */
export async function artifactDigest(dir: string, binaryHash: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(binaryHash);
  const sidecars = await Promise.all(
    ["manifest.json", "bindings.json", "assets.json"].map(async (name) => ({
      name,
      body: await readFile(resolve(dir, name)).catch(() => null), // absent for this project
    })),
  );
  for (const { name, body } of sidecars) {
    hash.update(`\n${name}\n`);
    if (body) hash.update(body);
  }
  return hash.digest("hex");
}

export async function deployArtifact(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(project))
    return Response.json({ error: "invalid project name" }, { status: 400 });
  const rateLimited = await guardDeploy(actor.id, request);
  if (rateLimited) return rateLimited;
  const newProject = projectDeployments(actor.id, project).length === 0;
  if (newProject) {
    const capped = await guardNewProject(actor.id, request, ownerProjectCount(actor.id));
    if (capped) return capped;
  }
  recordEvent({
    ownerId: actor.id,
    project,
    type: "deploy.started",
    actor: actor.username,
    summary: `Deploy of ${project} started`,
    data: { project },
  });
  const failed = (reason: string) =>
    recordEvent({
      ownerId: actor.id,
      project,
      type: "deploy.failed",
      actor: actor.username,
      summary: `Deploy of ${project} failed`,
      data: { reason },
    });
  try {
    const response = await runDeploy(request, project, actor, newProject);
    if (response.status >= 400) {
      // SAFETY: every error response from runDeploy is { error, details? } JSON.
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as { error?: string; details?: string[] } | null;
      const detail = Array.isArray(body?.details) ? `: ${body.details.join("; ")}` : "";
      failed(`${body?.error ?? `HTTP ${response.status}`}${detail}`);
    }
    return response;
  } catch (error) {
    failed(error instanceof Error ? error.message : "deployment failed");
    throw error;
  }
}

async function runDeploy(request: Request, project: string, actor: Actor, newProject: boolean): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "expected multipart artifact upload" }, { status: 400 });
  }
  const manifest = form.get("manifest");
  const sprout = form.get("sprout");
  if (!(manifest instanceof File) || !(sprout instanceof File))
    return Response.json({ error: "upload must include manifest and sprout files" }, { status: 400 });
  if (manifest.size > 64 * 1024 || sprout.size > 16 * 1024 * 1024)
    return Response.json({ error: "artifact exceeds upload limit" }, { status: 413 });
  // #1 — optional sidecars: bindings.json (drives the per-deployment broker) and
  // the static-asset tree (assets.json + one `asset` part per file, keyed by its
  // posix path). validateArtifactDirectory re-checks their shape and hashes.
  const bindings = form.get("bindings");
  const assetsManifest = form.get("assets_manifest");
  const assetFiles = form.getAll("asset").filter((part): part is File => part instanceof File);
  if (bindings instanceof File && bindings.size > 64 * 1024)
    return Response.json({ error: "bindings.json exceeds 64 KiB" }, { status: 413 });
  if (assetFiles.length > 4096) return Response.json({ error: "too many asset files" }, { status: 413 });
  if (assetFiles.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024)
    return Response.json({ error: "assets exceed the 64 MiB limit" }, { status: 413 });

  if (assetsManifest instanceof File && assetsManifest.size > 2 * 1024 * 1024)
    return Response.json({ error: "assets.json exceeds 2 MiB" }, { status: 413 });
  // Every uploaded asset must be listed in assets.json: the listing is what validation hashes, so a part
  // outside it would ride along unchecked. Parse the listing before anything is written.
  let listedAssets = new Set<string>();
  if (assetsManifest instanceof File) {
    const keys = listedAssetKeys(await assetsManifest.text());
    if (!keys)
      return Response.json({ error: "assets_manifest must be a JSON object with a files map" }, { status: 400 });
    listedAssets = new Set(keys);
  }
  const assetKey = (file: File) => (file.name.startsWith("/") ? file.name : `/${file.name}`);
  for (const file of assetFiles) {
    if (!listedAssets.has(assetKey(file)))
      return Response.json({ error: `asset ${file.name} is not listed in assets.json` }, { status: 400 });
  }

  const temporary = resolve(artifactRoot(), `.upload-${randomUUID()}`);
  await mkdir(temporary, { recursive: true, mode: 0o750 });
  try {
    await Promise.all([
      writeFile(resolve(temporary, "manifest.json"), new Uint8Array(await manifest.arrayBuffer()), { mode: 0o640 }),
      writeFile(resolve(temporary, "sprout"), new Uint8Array(await sprout.arrayBuffer()), { mode: 0o555 }),
    ]);
    await chmod(resolve(temporary, "sprout"), 0o555);
    if (bindings instanceof File) {
      await writeFile(resolve(temporary, "bindings.json"), new Uint8Array(await bindings.arrayBuffer()), {
        mode: 0o640,
      });
    }
    if (assetsManifest instanceof File) {
      await writeFile(resolve(temporary, "assets.json"), new Uint8Array(await assetsManifest.arrayBuffer()), {
        mode: 0o640,
      });
      for (const file of assetFiles) {
        const key = assetKey(file);
        if (key.includes("..") || key.includes("\0"))
          return Response.json({ error: `invalid asset path: ${file.name}` }, { status: 400 });
        const target = resolve(temporary, "assets", `.${key}`);
        if (!target.startsWith(resolve(temporary, "assets") + "/"))
          return Response.json({ error: `asset path escapes the tree: ${file.name}` }, { status: 400 });
        await mkdir(dirname(target), { recursive: true, mode: 0o750 });
        await writeFile(target, new Uint8Array(await file.arrayBuffer()), { mode: 0o640 });
      }
    }
    const validation = await validateArtifactDirectory(temporary);
    if (!validation.ok)
      return Response.json({ error: "invalid artifact", details: validation.errors }, { status: 400 });
    if (validation.value.manifest.project !== project)
      return Response.json({ error: "manifest project does not match request path" }, { status: 400 });
    const digest = await artifactDigest(temporary, validation.value.manifest.binaryHash);

    // Nothing changed — same sprout, same sidecars — and it is already live.
    // Drop the upload and report the no-op instead of stacking a duplicate version.
    const unchanged = projectDeployments(actor.id, project).find(
      (deployment) => deployment.active && deployment.artifact === digest,
    );
    if (unchanged) {
      recordEvent({
        ownerId: actor.id,
        project,
        type: "deploy.succeeded",
        actor: actor.username,
        summary: `Deploy of ${project} unchanged: the active version already matches`,
        data: { deploymentId: unchanged.id, digest, hostname: unchanged.hostname, unchanged: true },
      });
      return Response.json(
        {
          id: unchanged.id,
          hostname: unchanged.hostname,
          url: `https://${unchanged.hostname}`,
          artifact: digest,
          activated: false,
          unchanged: true,
        },
        { status: 200 },
      );
    }

    // #74 — every `{ binding, id }` the artifact declares must name a storage
    // resource this account owns, of the matching kind. Reject the deploy
    // before anything is placed, rather than silently spin up an empty store.
    const resolvedResources = resolveResourceBindings(validation.value.resourceBindings, actor.id);
    if (resolvedResources instanceof Response) return resolvedResources;

    // #55: capture the outgoing version's Porffor pin before it is replaced.
    const previousPorffor = await activePorfforVersion(actor.id, project);
    const hostname = deploymentHostname(project, actor.username);
    const destination = artifactDir(actor.id, digest);
    const sproutPath = resolve(destination, "sprout");

    // Placement, staging and the database row happen under the artifact lock, so a collection of the same
    // digest (another project's version going away) cannot remove the directory in between.
    const outcome = await withArtifactLock(async (): Promise<{ response: Response } | { id: string }> => {
      let placed = false;
      try {
        await mkdir(dirname(destination), { recursive: true, mode: 0o750 });
        try {
          await rename(temporary, destination);
          placed = true;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")
          )
            throw error;
          // This account already holds this digest on disk (another of its projects, or a
          // race). Its contents match the digest by construction, so reuse it.
        }
        // #141: start it on the edge first. Nothing is recorded or routed unless it
        // listens, so the previous version keeps serving and there is no
        // half-activated row to recover after a crash.
        try {
          await stageCandidate(await candidateRoute({ hostname, sproutPath, ownerId: actor.id, project }));
        } catch (error) {
          if (placed) await rm(destination, { recursive: true, force: true });
          return {
            response: Response.json(
              { error: error instanceof Error ? error.message : "activation failed", activated: false },
              { status: 409 },
            ),
          };
        }
        const recorded = recordDeployment({
          id: randomUUID(),
          project,
          ownerId: actor.id,
          username: actor.username,
          hostname,
          artifact: digest,
          sproutPath,
          deployedAt: new Date().toISOString(),
          binarySize: validation.value.manifest.binarySize,
          compileMs: validation.value.manifest.compileMs ?? null,
          resourceIds: resolvedResources,
        });
        return { id: recorded.id };
      } catch (error) {
        if (placed) await rm(destination, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    });
    if ("response" in outcome) return outcome.response;
    const deployment = outcome;
    await syncRoutes();
    // #25 — keep the retained-versions cap; GC any artifact it orphans.
    const orphaned = pruneProjectDeployments(actor.id, project, LIMITS.versionsPerProject());
    if (orphaned.length > 0) await collectArtifacts(orphaned);
    if (newProject)
      recordEvent({
        ownerId: actor.id,
        project,
        type: "project.created",
        actor: actor.username,
        summary: `Created project ${project}`,
        data: { hostname },
      });
    recordEvent({
      ownerId: actor.id,
      project,
      type: "deploy.succeeded",
      actor: actor.username,
      summary: `Deployed ${project} to ${hostname}`,
      data: {
        deploymentId: deployment.id,
        digest,
        hostname,
        binarySize: validation.value.manifest.binarySize,
        compileMs: validation.value.manifest.compileMs ?? null,
        newProject,
      },
    });
    const incomingPorffor = validation.value.manifest.porfforVersion;
    const porfforDrift =
      previousPorffor && previousPorffor !== incomingPorffor
        ? { from: previousPorffor, to: incomingPorffor }
        : undefined;
    return Response.json(
      { id: deployment.id, hostname, url: `https://${hostname}`, artifact: digest, activated: true, porfforDrift },
      { status: 201 },
    );
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "deployment failed" }, { status: 500 });
  } finally {
    // Every path out (early 400s included) clears the staging dir; after a successful rename it is already gone.
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
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
  if (actor.authentication !== "session")
    return Response.json({ error: "account deletion requires an interactive session" }, { status: 403 });

  const result = deleteOwner(actor.id);
  await syncRoutes();
  const cleanup = await collectArtifacts(result.orphanedArtifacts);
  const identity = purgeUser(actor.id);

  const response = Response.json(
    {
      deleted: true,
      versionsRemoved: result.removed,
      routesRemoved: result.hostnames,
      artifactsRemoved: cleanup.removed,
      artifactCleanupFailed: cleanup.failed,
      identityRemoved: identity,
    },
    { status: cleanup.failed.length ? 207 : 200 },
  );
  response.headers.append(
    "set-cookie",
    "better-auth.session_token=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
  );
  return response;
}
