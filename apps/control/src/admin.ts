import { getAuth } from "./auth";
import { backupPath, createBackup, deleteBackup, listBackups } from "./backups";
import { actorFor } from "./identity";
import { globalLogTotals } from "./logs";
import { banOwner, globalStats, ownerDeployments, ownerRollups, syncRoutes, unbanOwner } from "./store";

/**
 * Admin surface (#admin). Every handler is gated on `actor.isAdmin`
 * (Better Auth `role === "admin"`, or the SPROUTBOAT_ADMIN_EMAILS bootstrap
 * list). Identity operations proxy the Better Auth admin plugin; the stats are
 * Sproutboat-specific aggregates over the store and edge logs. A ban also stops
 * the user's routes — `banOwner` + `syncRoutes` drop their hostnames from the
 * snapshot; `unbanOwner` restores them.
 */

async function requireAdmin(request: Request): Promise<Response | null> {
  const actor = await actorFor(request).catch(() => undefined);
  if (!actor) return Response.json({ error: "sign in required" }, { status: 401 });
  if (!actor.isAdmin) return Response.json({ error: "admin access required" }, { status: 403 });
  return null;
}


type ListedUser = {
  id: string; email: string; name?: string | null; image?: string | null;
  role?: string | null; banned?: boolean | null; banReason?: string | null; banExpires?: string | Date | null;
  createdAt: string | Date;
};

type AdminUserQuery = {
  limit?: number; offset?: number; sortBy?: string; sortDirection?: "asc" | "desc";
  searchField?: "email" | "name"; searchOperator?: "contains" | "starts_with" | "ends_with"; searchValue?: string;
  filterField?: string; filterOperator?: "eq"; filterValue?: string;
};

async function listUsers(headers: Headers, query: AdminUserQuery): Promise<{ users: ListedUser[]; total: number }> {
  const raw = await getAuth().api.listUsers({ query, headers });
  // SAFETY: the admin plugin returns { users, total } for an authenticated admin.
  const result = raw as { users: ListedUser[]; total?: number };
  return { users: result.users, total: result.total ?? result.users.length };
}

const publicUser = (user: ListedUser) => ({
  id: user.id, email: user.email, name: user.name ?? null, image: user.image ?? null,
  role: user.role ?? "user", banned: user.banned === true,
  banReason: user.banReason ?? null,
  banExpires: user.banExpires ? new Date(user.banExpires).toISOString() : null,
  createdAt: new Date(user.createdAt).toISOString(),
});

/** #30 — best-effort runtime gauges from the edge's worker pool (loopback). */
async function poolGauges(): Promise<Record<string, number> | null> {
  try {
    const url = (process.env.SPROUTBOAT_EDGE_INTERNAL_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
    const response = await fetch(`${url}/__sb/pool`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    // SAFETY: the edge's /__sb/pool returns PoolStats — a flat number map.
    return await response.json() as Record<string, number>;
  } catch { return null; }
}

export async function adminOverview(request: Request): Promise<Response> {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const stats = globalStats();
  const [traffic, runtime] = await Promise.all([globalLogTotals(), poolGauges()]);
  return Response.json({ ...stats, requests24h: traffic.requests, errors24h: traffic.errors, since: traffic.from, runtime });
}

export async function adminUsers(request: Request): Promise<Response> {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(1, Number(params.get("limit")) || 50), 200);
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const search = params.get("q")?.trim();
  const query: AdminUserQuery = { limit, offset, sortBy: "createdAt", sortDirection: "desc" };
  if (search) {
    query.searchField = "email";
    query.searchOperator = "contains";
    query.searchValue = search;
  }
  const { users, total } = await listUsers(request.headers, query);
  const rollups = new Map(ownerRollups().map((row) => [row.ownerId, row]));
  const rows = users.map((user) => {
    const rollup = rollups.get(user.id);
    return {
      ...publicUser(user),
      projects: rollup?.projects ?? 0,
      deployments: rollup?.deployments ?? 0,
      activeProjects: rollup?.activeProjects ?? 0,
    };
  });
  return Response.json({ users: rows, total, limit, offset });
}

export async function adminUserDetail(request: Request, id: string): Promise<Response> {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const { users } = await listUsers(request.headers, { filterField: "id", filterOperator: "eq", filterValue: id, limit: 1 });
  const user = users[0];
  if (!user) return Response.json({ error: "user not found" }, { status: 404 });
  const deployments = ownerDeployments(id).map(({ id: deploymentId, project, hostname, artifact, deployedAt, active }) =>
    ({ id: deploymentId, project, hostname, artifact, deployedAt, active }));
  let sessions: Array<{ id: string; createdAt: string; expiresAt: string; ipAddress: string | null; userAgent: string | null }> = [];
  try {
    const raw = await getAuth().api.listUserSessions({ body: { userId: id }, headers: request.headers });
    // SAFETY: listUserSessions returns { sessions: Session[] } for an authenticated admin.
    const result = raw as { sessions: Array<{ id: string; createdAt: string | Date; expiresAt: string | Date; ipAddress?: string | null; userAgent?: string | null }> };
    sessions = result.sessions.map((session) => ({
      id: session.id,
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      ipAddress: session.ipAddress ?? null,
      userAgent: session.userAgent ?? null,
    }));
  } catch { /* sessions are best-effort */ }
  return Response.json({ user: publicUser(user), deployments, sessions });
}

type JsonInput = string | number | boolean | null | undefined | JsonInput[] | { readonly [key: string]: JsonInput };

const asText = (value: JsonInput): string | undefined =>
  Object(value) !== value && value === String(value) && String(value).trim() ? String(value).trim() : undefined;
const asPositive = (value: JsonInput): number | undefined =>
  Object(value) !== value && value === Number(value) && Number.isFinite(value) && Number(value) > 0 ? Number(value) : undefined;

export async function banUser(request: Request, id: string): Promise<Response> {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  const banReason = asText(body.reason);
  const banExpiresIn = asPositive(body.expiresIn);
  await getAuth().api.banUser({ body: { userId: id, banReason, banExpiresIn }, headers: request.headers });
  banOwner(id);
  await syncRoutes();
  return Response.json({ banned: id, routesStopped: true });
}

export async function unbanUser(request: Request, id: string): Promise<Response> {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  await getAuth().api.unbanUser({ body: { userId: id }, headers: request.headers });
  unbanOwner(id);
  await syncRoutes();
  return Response.json({ unbanned: id, routesRestored: true });
}

export async function revokeUserSessions(request: Request, id: string): Promise<Response> {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  await getAuth().api.revokeUserSessions({ body: { userId: id }, headers: request.headers });
  return Response.json({ revoked: id });
}

// --- #27 backups ---------------------------------------------------------

export async function adminBackups(request: Request): Promise<Response> {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  return Response.json({ backups: await listBackups() });
}

export async function adminCreateBackup(request: Request): Promise<Response> {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    return Response.json({ backup: await createBackup() }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "backup failed" }, { status: 500 });
  }
}

export async function adminDownloadBackup(request: Request, name: string): Promise<Response> {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const path = backupPath(name);
  if (!path) return Response.json({ error: "invalid backup name" }, { status: 400 });
  const file = Bun.file(path);
  if (!(await file.exists())) return Response.json({ error: "backup not found" }, { status: 404 });
  return new Response(file, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${name}"`,
    },
  });
}

export async function adminDeleteBackup(request: Request, name: string): Promise<Response> {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  return Response.json({ deleted: await deleteBackup(name) });
}
