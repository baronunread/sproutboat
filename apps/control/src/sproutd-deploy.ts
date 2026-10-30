/**
 * Deploy, rollback and runtime selection for projects on sproutd (design 05, phase 1).
 *
 * Phase 1 deploys a hand-built module: an `app.so` compiled for the generation sproutd runs
 * (`bun build/compile-app.ts` in the sproutd repo). Building it from a project, and the
 * generation scheme around it, are phase 2. What is real here is everything after the bytes
 * arrive: control stores its own copy, hands module, secrets and limits to the adapter,
 * records the deployment against the version sproutd reports, and routes the hostname.
 */
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import type { Actor } from "./identity";
import { guardNewProject, LIMITS } from "./limits";
import {
  activateDeployment as storeActivate,
  collectArtifacts,
  type Deployment,
  ownerProjectCount,
  projectDeployments,
  projectExists,
  projectHosts,
  projectRuntime,
  projectSecrets,
  pruneProjectDeployments,
  recordDeployment,
  setProjectLimits,
  setProjectRuntime,
  syncRoutes,
} from "./store";
import {
  AdapterError,
  effectiveLimits,
  isElf,
  moduleVid,
  parseLimits,
  reconcileSproutd,
  sproutdClient,
  sproutdEnabled,
  sproutdOwnerAllowed,
  storeModule,
} from "./sproutd";

const MAX_MODULE_BYTES = 32 * 1024 * 1024; // a real module is ~0.4 MiB

function adapterFailure(error: Error, activated: boolean): Response {
  if (error instanceof AdapterError) {
    const status = error.status === 422 ? 400 : error.status === 503 ? 503 : 409;
    // The adapter's list of secrets it cannot carry reaches the caller as it came.
    return Response.json({ error: error.message, problems: error.body.problems, activated }, { status });
  }
  return Response.json({ error: `sproutd is unavailable: ${error.message}`, activated }, { status: 503 });
}

/** Project runtime for the API: the stored choice plus what this box can do. */
export function describeRuntime(actor: Actor, project: string) {
  const { runtime, limits } = projectRuntime(actor.id, project);
  return {
    project,
    runtime,
    limits,
    effectiveLimits: runtime === "sproutd" ? effectiveLimits(limits) : undefined,
    sproutdAvailable: sproutdEnabled(),
    sproutdAllowed: sproutdEnabled() && sproutdOwnerAllowed(actor.username),
  };
}

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };
const isObject = (value: Json | undefined): value is { readonly [key: string]: Json } =>
  value !== null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function);

/** PUT /api/projects/:project/runtime  { runtime, limits? } */
export async function setRuntime(actor: Actor, request: Request, project: string): Promise<Response> {
  const body: Json = await request.json().catch(() => null);
  const requested = isObject(body) ? body.runtime : undefined;
  if (requested !== "supervisor" && requested !== "sproutd")
    return Response.json({ error: 'runtime must be "supervisor" or "sproutd"' }, { status: 400 });
  const limitsInput = isObject(body) ? body.limits : undefined;
  const parsed = parseLimits(limitsInput);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  const limits = parsed.limits;
  const current = projectRuntime(actor.id, project);
  const deployments = projectDeployments(actor.id, project);
  if (requested === "sproutd") {
    if (!sproutdEnabled()) return Response.json({ error: "this host has no sproutd configured" }, { status: 409 });
    if (!sproutdOwnerAllowed(actor.username))
      return Response.json({ error: "this account is not allowed to run projects on sproutd" }, { status: 403 });
  }
  if (current.runtime === requested) {
    // Same runtime: only sproutd limits can change, and they apply to the running app.
    if (requested === "sproutd") {
      if (limitsInput !== undefined) setProjectLimits(actor.id, project, limits);
      await reconcileSproutd({ force: true });
    }
    return Response.json(describeRuntime(actor, project));
  }
  if (deployments.length > 0)
    return Response.json(
      {
        error:
          "a project's runtime can only be chosen before its first deployment; moving a live project is a later phase",
      },
      { status: 409 },
    );
  if (!projectExists(actor.id, project)) {
    const capped = await guardNewProject(actor.id, request, ownerProjectCount(actor.id));
    if (capped) return capped;
  }
  setProjectRuntime(actor, project, requested, limits);
  return Response.json(describeRuntime(actor, project), { status: 200 });
}

/** POST /api/projects/:project/deployments for a sproutd project: multipart with a `module` file. */
export async function deploySproutd(
  actor: Actor,
  project: string,
  hostname: string,
  form: FormData,
): Promise<Response> {
  const client = sproutdClient();
  if (!client) return Response.json({ error: "this host has no sproutd configured" }, { status: 409 });
  if (!sproutdOwnerAllowed(actor.username))
    return Response.json({ error: "this account is not allowed to run projects on sproutd" }, { status: 403 });
  const file = form.get("module");
  if (!(file instanceof File))
    return Response.json(
      {
        error:
          "this project runs on sproutd: upload an app.so as the `module` field (building one from a project is a later phase)",
      },
      { status: 400 },
    );
  if (file.size > MAX_MODULE_BYTES) return Response.json({ error: "module exceeds upload limit" }, { status: 413 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isElf(bytes)) return Response.json({ error: "module is not an ELF shared object" }, { status: 400 });
  const secrets = projectSecrets(actor.id, project);
  const limits = effectiveLimits(projectRuntime(actor.id, project).limits);
  const vid = moduleVid(bytes);

  const stored = await storeModule(bytes);
  const unchanged = projectDeployments(actor.id, project).find((d) => d.active && d.artifact === stored.digest);
  if (unchanged) {
    return Response.json(
      {
        id: unchanged.id,
        hostname: unchanged.hostname,
        url: `https://${unchanged.hostname}`,
        artifact: stored.digest,
        vid,
        activated: false,
        unchanged: true,
      },
      { status: 200 },
    );
  }
  // sproutd loads it first (blue/green: if it does not load, the old version keeps serving).
  // Nothing is recorded or routed unless it does, as with the supervisor's staged candidate.
  try {
    const result = await client.deploy(actor.id, project, bytes, vid, secrets, limits);
    if (result.vid !== vid) throw new Error(`sproutd serves ${result.vid}, expected ${vid}`);
    // Map the hostnames before the route goes live, or the edge would forward to a sproutd that answers 404 for a moment.
    await client.setHosts(actor.id, project, [...new Set([hostname, ...projectHosts(actor.id, project)])].sort());
  } catch (error) {
    if (stored.placed) await rm(stored.path.replace(/\/app\.so$/, ""), { recursive: true, force: true });
    return adapterFailure(error instanceof Error ? error : new Error(String(error)), false);
  }
  const deployment = recordDeployment({
    id: randomUUID(),
    project,
    ownerId: actor.id,
    username: actor.username,
    hostname,
    artifact: stored.digest,
    sproutPath: stored.path,
    deployedAt: new Date().toISOString(),
    binarySize: bytes.byteLength,
    vid,
  });
  await syncRoutes();
  const orphaned = pruneProjectDeployments(actor.id, project, LIMITS.versionsPerProject());
  if (orphaned.length > 0) await collectArtifacts(orphaned);
  return Response.json(
    { id: deployment.id, hostname, url: `https://${hostname}`, artifact: stored.digest, vid, activated: true },
    { status: 201 },
  );
}

/**
 * Activate (roll back to) a recorded deployment. sproutd's own `rollback` is used when it still
 * stores the version with the project's current secrets; otherwise the module is redeployed from
 * control's copy, so a version sproutd pruned is never a dead end.
 */
export async function activateSproutd(actor: Actor, project: string, target: Deployment): Promise<Response> {
  const client = sproutdClient();
  if (!client) return Response.json({ error: "this host has no sproutd configured" }, { status: 409 });
  if (!target.vid) return Response.json({ error: "deployment has no sproutd version" }, { status: 409 });
  const secrets = projectSecrets(actor.id, project);
  const limits = effectiveLimits(projectRuntime(actor.id, project).limits);
  let via: string;
  try {
    try {
      via = (await client.rollback(actor.id, project, target.vid, secrets)).via;
    } catch (error) {
      if (!(error instanceof AdapterError && (error.unknownVersion || error.body.reason === "unknown-app")))
        throw error;
      const bytes = new Uint8Array(await readFile(target.sproutPath));
      await client.deploy(actor.id, project, bytes, target.vid, secrets, limits);
      via = "control's copy";
    }
  } catch (error) {
    return adapterFailure(error instanceof Error ? error : new Error(String(error)), false);
  }
  const deployment = storeActivate(actor.id, project, target.id);
  if (!deployment) return Response.json({ error: "deployment not found" }, { status: 404 });
  await syncRoutes();
  return Response.json({
    id: target.id,
    project,
    active: true,
    url: `https://${deployment.hostname}`,
    vid: target.vid,
    via,
  });
}
