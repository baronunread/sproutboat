import { Database } from "bun:sqlite";
import { getAuth } from "./auth";

export type Actor = {
  id: string;
  username: string;
  authentication: "session" | "bootstrap";
  isAdmin: boolean;
};

export type Profile = { userId: string; username: string; createdAt: string };

/** #21: the safe view of a Better Auth API key — never the hashed `key` column. */
export type CliCredential = {
  id: string;
  name: string | null;
  prefix: string | null;
  start: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  enabled: boolean;
};

const slug = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
const reservedUsernames = new Set(["www", "api", "admin", "status", "docs", "support", "cli", "dashboard", "sproutboat"]);
let database: Database | undefined;
let databasePath: string | undefined;

function db(): Database {
  const path = process.env.SPROUTBOAT_DATABASE_PATH || "/var/lib/sproutboat/sproutboat.sqlite";
  if (database && databasePath === path) return database;
  database?.close();
  database = new Database(path);
  // Same file as store.ts; match its waiting/FK behaviour so a write here that
  // collides with a store transaction retries instead of failing SQLITE_BUSY.
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  database.run("CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL)");
  databasePath = path;
  return database;
}

export function validUsername(username: string): boolean {
  return slug.test(username) && !reservedUsernames.has(username);
}

export function profileForUser(userId: string): Profile | undefined {
  // SAFETY: the query selects the Profile columns from the table created in db().
  const row = db().query("SELECT user_id, username, created_at FROM profiles WHERE user_id = ?").get(userId) as { user_id: string; username: string; created_at: string } | null;
  return row ? { userId: row.user_id, username: row.username, createdAt: row.created_at } : undefined;
}

/**
 * Reserve a namespace for a user. `allowReserved` is for the seeded single admin
 * only (auth.ensureAdminSeeded): the reserved-word list keeps other users from
 * claiming names like `api`/`admin`, but on a one-admin box the admin may hold
 * one. The slug shape is still enforced.
 */
export function reserveUsername(userId: string, username: string, options: { allowReserved?: boolean } = {}): Profile {
  const ok = options.allowReserved ? slug.test(username) : validUsername(username);
  if (!ok) throw new Error("username must be a 3–32 character lowercase slug and cannot be reserved");
  const existing = profileForUser(userId);
  if (existing) {
    if (existing.username === username) return existing;
    throw new Error("username is already reserved for this account");
  }
  const createdAt = new Date().toISOString();
  try {
    db().query("INSERT INTO profiles (user_id, username, created_at) VALUES (?, ?, ?)").run(userId, username, createdAt);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new Error("username is already taken");
    throw error;
  }
  return { userId, username, createdAt };
}

export async function actorFor(request: Request): Promise<Actor | undefined> {
  const bootstrapToken = process.env.SPROUTBOAT_BOOTSTRAP_TOKEN;
  const bootstrapUsername = process.env.SPROUTBOAT_BOOTSTRAP_USERNAME;
  const suppliedBootstrapToken = request.headers.get("x-api-key") || request.headers.get("authorization")?.replace(/^Bearer\s+/, "");
  if (bootstrapToken && bootstrapUsername && suppliedBootstrapToken === bootstrapToken && validUsername(bootstrapUsername)) {
    return { id: `bootstrap:${bootstrapUsername}`, username: bootstrapUsername, authentication: "bootstrap", isAdmin: false };
  }

  const session = await getAuth().api.getSession({ headers: request.headers });
  const user = session?.user;
  if (!user) return undefined;
  const profile = profileForUser(user.id);
  if (!profile) return undefined;
  // Admin = Better Auth admin role. SPROUTBOAT_ADMIN_EMAILS is a bootstrap
  // seeder: the first time such a user is seen, promote them to role "admin" so
  // the admin-plugin endpoints (which check the role) work for them too.
  let isAdmin = user.role === "admin";
  if (!isAdmin) {
    const seeds = new Set((process.env.SPROUTBOAT_ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
    if (seeds.has(user.email.toLowerCase())) {
      try { db().query("UPDATE user SET role = 'admin' WHERE id = ?").run(user.id); } catch { /* user table may lag a migration */ }
      isAdmin = true;
    }
  }
  return { id: profile.userId, username: profile.username, authentication: "session", isAdmin };
}

const isoTime = (value: string | number | null): string =>
  value === null ? new Date(0).toISOString() : new Date(value).toISOString();

/**
 * #21: list one user's CLI credentials from Better Auth's `apikey` table, owner
 * (`referenceId`) scoped, projecting only safe metadata. The hashed `key`
 * column is never selected. Returns [] before any key has been issued (table
 * absent on a fresh DB).
 */
export function listCredentials(userId: string): CliCredential[] {
  try {
    // SAFETY: these columns are the Better Auth api-key schema; `key` (the hash)
    // is deliberately not selected.
    const rows = db().query(
      "SELECT id, name, prefix, start, enabled, createdAt, lastRequest, expiresAt FROM apikey WHERE referenceId = ? ORDER BY createdAt DESC",
    ).all(userId) as Array<{
      id: string; name: string | null; prefix: string | null; start: string | null;
      enabled: number | null; createdAt: string | number | null; lastRequest: string | number | null; expiresAt: string | number | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      start: row.start,
      createdAt: isoTime(row.createdAt),
      lastUsedAt: row.lastRequest === null ? null : isoTime(row.lastRequest),
      expiresAt: row.expiresAt === null ? null : isoTime(row.expiresAt),
      enabled: row.enabled !== 0,
    }));
  } catch { return []; }
}

/** #21: revoke one credential; effective immediately (Better Auth verifies against this row). */
export function revokeCredential(userId: string, id: string): boolean {
  try { return db().query("DELETE FROM apikey WHERE id = ? AND referenceId = ?").run(id, userId).changes > 0; }
  catch { return false; }
}

/** #21: revoke every CLI credential the user holds. The browser session is unaffected. */
export function revokeAllCredentials(userId: string): number {
  try { return db().query("DELETE FROM apikey WHERE referenceId = ?").run(userId).changes; }
  catch { return 0; }
}

/** #18: the session-safe view of the signed-in user — never OAuth tokens (those live in `account`). */
export type SessionUser = { id: string; name: string | null; email: string; image: string | null };

export function safeSessionUser(user: { id: string; name?: string | null; email: string; image?: string | null }): SessionUser {
  return { id: user.id, name: user.name ?? null, email: user.email, image: user.image ?? null };
}

export async function sessionUser(request: Request): Promise<SessionUser | undefined> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  return session?.user ? safeSessionUser(session.user) : undefined;
}

/**
 * #16: remove every identity row for a user — Sproutboat profile, CLI device
 * authorizations, Better Auth API keys, sessions, linked OAuth accounts, and the
 * user record. Idempotent: safe to re-run after a partial failure. Returns the
 * tables it touched. Call only after the user's deployments and routes are gone.
 */
export function purgeUser(userId: string): string[] {
  const database = db();
  const touched: string[] = [];
  const wipe = database.transaction(() => {
    for (const [table, column] of [
      ["profiles", "user_id"],
      ["cli_authorizations", "user_id"],
      ["apikey", "referenceId"], // Better Auth api-key owner column
      ["session", "userId"],
      ["account", "userId"],
      ["user", "id"],
    ] as const) {
      try {
        const changed = database.query(`DELETE FROM ${table} WHERE ${column} = ?`).run(userId).changes;
        if (changed) touched.push(table);
      } catch { /* table may not exist yet on a fresh DB; nothing to remove */ }
    }
  });
  wipe();
  return [...new Set(touched)];
}
