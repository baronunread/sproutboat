import { Database } from "bun:sqlite";
import { getAuth } from "./auth";

export type Actor = {
  id: string;
  username: string;
  authentication: "session" | "bootstrap";
  isOperator: boolean;
};

export type Profile = { userId: string; username: string; createdAt: string };

const slug = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
const reservedUsernames = new Set(["www", "api", "admin", "status", "docs", "support", "cli", "dashboard", "sproutboat"]);
let database: Database | undefined;

function db(): Database {
  if (!database) {
    database = new Database(process.env.SPROUTBOAT_DATABASE_PATH || "/var/lib/sproutboat/sproutboat.sqlite");
    database.run("CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL)");
  }
  return database;
}

export function validUsername(username: string): boolean {
  return slug.test(username) && !reservedUsernames.has(username);
}

export function profileForUser(userId: string): Profile | undefined {
  const row = db().query("SELECT user_id, username, created_at FROM profiles WHERE user_id = ?").get(userId) as { user_id: string; username: string; created_at: string } | null;
  return row ? { userId: row.user_id, username: row.username, createdAt: row.created_at } : undefined;
}

export function reserveUsername(userId: string, username: string): Profile {
  if (!validUsername(username)) throw new Error("username must be a 3–32 character lowercase slug and cannot be reserved");
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
    return { id: `bootstrap:${bootstrapUsername}`, username: bootstrapUsername, authentication: "bootstrap", isOperator: false };
  }

  const session = await getAuth().api.getSession({ headers: request.headers });
  const user = session?.user as { id?: unknown; email?: unknown } | undefined;
  if (!user || typeof user.id !== "string") return undefined;
  const profile = profileForUser(user.id);
  const operators = new Set((process.env.SPROUTBOAT_OPERATOR_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
  return profile ? { id: profile.userId, username: profile.username, authentication: "session", isOperator: typeof user.email === "string" && operators.has(user.email.toLowerCase()) } : undefined;
}

export async function signedInUserId(request: Request): Promise<string | undefined> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  const user = session?.user as { id?: unknown } | undefined;
  return user && typeof user.id === "string" ? user.id : undefined;
}
