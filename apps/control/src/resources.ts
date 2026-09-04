/**
 * #74 — account-level storage resources: KV namespaces, D1 databases, R2
 * buckets and queues as first-class owned objects with a stable `<kind>_<id>`
 * handle, created and deleted independently of any deploy. (Analytics Engine
 * datasets aren't here — they aren't provisioned, they appear on first write.)
 *
 * This chunk is the registry + CRUD only. A later chunk resolves `{ binding,
 * id }` entries in `sproutboat.jsonc` against it at deploy time, keys the
 * broker's backing store by `id` instead of the artifact digest (so data
 * survives a redeploy and can be shared between projects), and echoes the
 * resolved handle in the deploy report.
 */
import { actorFor, type Actor } from "./identity";
import { LIMITS } from "./limits";
import {
  createResource,
  deleteResource,
  ownerResourceProjects,
  ownerResources,
  renameResource,
  resourceById,
  resourceCount,
  resourceReferencingProjects,
  RESOURCE_KINDS,
  type ResourceKind,
} from "./store";

type JsonInput = string | number | boolean | null | undefined | JsonInput[] | { readonly [key: string]: JsonInput };
const asText = (value: JsonInput): string =>
  Object(value) !== value && value === String(value) ? String(value).trim() : "";

// 2–63 char lowercase slug, same shape wrangler accepts for namespace/bucket/db
// names. The middle run is not optional: making it so also matches a single
// character, which is not the 2–63 this rule and its error message promise.
const NAME = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

function isResourceKind(value: string): value is ResourceKind {
  // SAFETY: RESOURCE_KINDS is the literal tuple of every ResourceKind, so
  // membership in it is exactly the type predicate.
  return (RESOURCE_KINDS as readonly string[]).includes(value);
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

export async function listResources(request: Request): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  return Response.json({ resources: ownerResources(actor.id) });
}

/* ---------------------------------------------------------------------------
 * #77 — per-kind collections.
 *
 * `/api/resources` stays the aggregate view the CLI and the deploy-time
 * resolver use. Each kind also gets its own collection, so a KV namespace is
 * addressed as a KV namespace rather than as "a resource that happens to have
 * kind=kv" — which is what lets a kind grow its own nouns later (the keys in a
 * namespace, the objects in a bucket) without overloading one endpoint.
 *
 * The URL segment is the plural a person would type; `queues` maps to the
 * `queue` kind the store records.
 * ------------------------------------------------------------------------- */

export const KIND_SEGMENTS = {
  kv: "kv",
  d1: "d1",
  r2: "r2",
  queues: "queue",
} as const satisfies Readonly<Record<string, ResourceKind>>;

export function resourceKindForSegment(segment: string): ResourceKind | undefined {
  if (!Object.hasOwn(KIND_SEGMENTS, segment)) return undefined;
  // SAFETY: the hasOwn guard above is exactly the key predicate — a segment
  // that passes it is one of KIND_SEGMENTS' own keys.
  return KIND_SEGMENTS[segment as keyof typeof KIND_SEGMENTS];
}

/** List one kind, each row carrying the projects still bound to it. */
export async function listResourcesOfKind(request: Request, kind: ResourceKind): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const bound = ownerResourceProjects(actor.id);
  const resources = ownerResources(actor.id)
    .filter((resource) => resource.kind === kind)
    .map((resource) => ({ ...resource, projects: bound.get(resource.id) ?? [] }));
  return Response.json({ kind, resources });
}

/** Create within one kind: the body carries a name, the path carries the kind. */
export async function createResourceOfKind(request: Request, kind: ResourceKind): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;

  const body: { readonly [key: string]: JsonInput } = await request.json().catch(() => ({}));
  const name = asText(body.name);
  if (!NAME.test(name)) {
    return Response.json({ error: "name must be a 2–63 character lowercase slug (a–z, 0–9, hyphen)" }, { status: 400 });
  }
  const existing = ownerResources(actor.id).find((resource) => resource.kind === kind && resource.name === name);
  if (existing) {
    if (asText(body.ifExists) === "return") return Response.json({ resource: existing }, { status: 200 });
    return Response.json({ error: `a ${kind} named "${name}" already exists` }, { status: 409 });
  }
  if (resourceCount(actor.id) >= LIMITS.resourcesPerAccount()) {
    return Response.json(
      { error: `an account may hold at most ${LIMITS.resourcesPerAccount()} resources` },
      { status: 429 },
    );
  }
  return Response.json({ resource: createResource(actor.id, kind, name) }, { status: 201 });
}

/**
 * Guard for the per-kind item routes: an id whose kind prefix disagrees with
 * the collection it was addressed through is a 404, not someone else's row.
 */
export async function resourceOfKind(request: Request, kind: ResourceKind, id: string): Promise<Response | null> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const resource = resourceById(actor.id, id);
  if (!resource || resource.kind !== kind) return Response.json({ error: "resource not found" }, { status: 404 });
  return null;
}

export async function createResourceHandler(request: Request): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;

  const body: { readonly [key: string]: JsonInput } = await request.json().catch(() => ({}));
  const kind = asText(body.kind);
  const name = asText(body.name);
  if (!isResourceKind(kind)) {
    return Response.json({ error: `kind must be one of: ${RESOURCE_KINDS.join(", ")}` }, { status: 400 });
  }
  if (!NAME.test(name)) {
    return Response.json({ error: "name must be a 2–63 character lowercase slug (a–z, 0–9, hyphen)" }, { status: 400 });
  }
  // `ifExists: "return"` makes this find-or-create — the deploy-time
  // auto-provisioner (#74) calls it that way so a re-deploy isn't a 409.
  const existing = ownerResources(actor.id).find((resource) => resource.kind === kind && resource.name === name);
  if (existing) {
    if (asText(body.ifExists) === "return") return Response.json({ resource: existing }, { status: 200 });
    return Response.json({ error: `a ${kind} named "${name}" already exists` }, { status: 409 });
  }
  if (resourceCount(actor.id) >= LIMITS.resourcesPerAccount()) {
    return Response.json(
      { error: `an account may hold at most ${LIMITS.resourcesPerAccount()} resources` },
      { status: 429 },
    );
  }

  const resource = createResource(actor.id, kind, name);
  return Response.json({ resource }, { status: 201 });
}

export async function updateResourceHandler(request: Request, id: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;

  const existing = resourceById(actor.id, id);
  if (!existing) return Response.json({ error: "resource not found" }, { status: 404 });

  const body: { readonly [key: string]: JsonInput } = await request.json().catch(() => ({}));
  const name = asText(body.name);
  if (!NAME.test(name)) {
    return Response.json({ error: "name must be a 2–63 character lowercase slug (a–z, 0–9, hyphen)" }, { status: 400 });
  }
  if (
    name !== existing.name &&
    ownerResources(actor.id).some((resource) => resource.kind === existing.kind && resource.name === name)
  ) {
    return Response.json({ error: `a ${existing.kind} named "${name}" already exists` }, { status: 409 });
  }

  renameResource(actor.id, id, name);
  return Response.json({ resource: { ...existing, name } });
}

export async function deleteResourceHandler(request: Request, id: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  if (!resourceById(actor.id, id)) return Response.json({ error: "resource not found" }, { status: 404 });
  const referencing = resourceReferencingProjects(actor.id, id);
  if (referencing.length > 0) {
    return Response.json(
      { error: `still bound by ${referencing.join(", ")} — redeploy those without it first`, projects: referencing },
      { status: 409 },
    );
  }
  deleteResource(actor.id, id);
  return Response.json({ deleted: id });
}
