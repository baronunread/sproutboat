import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { getAuth } from "./auth";
import { actorFor, listCredentials, revokeAllCredentials, revokeCredential } from "./identity";

type Authorization = { user_code: string; device_hash: string; user_id: string | null; state: "pending" | "approved" | "issuing" | "issued"; expires_at: string };
let database: Database | undefined;

function db(): Database {
  if (!database) {
    database = new Database(process.env.SPROUTBOAT_DATABASE_PATH || "/var/lib/sproutboat/sproutboat.sqlite");
    database.run("CREATE TABLE IF NOT EXISTS cli_authorizations (user_code TEXT PRIMARY KEY, device_hash TEXT NOT NULL UNIQUE, user_id TEXT, state TEXT NOT NULL, expires_at TEXT NOT NULL, token_issued_at TEXT)");
  }
  return database;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function active(record: Authorization): boolean { return new Date(record.expires_at).getTime() > Date.now(); }
function userCode(): string { return randomBytes(4).toString("hex").toUpperCase().replace(/(.{4})(.{4})/, "$1-$2"); }

export async function createCliAuthorization(): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = userCode();
    const deviceCode = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    try {
      db().query("INSERT INTO cli_authorizations (user_code, device_hash, user_id, state, expires_at) VALUES (?, ?, NULL, 'pending', ?)").run(code, hash(deviceCode), expiresAt);
      const dashboardUrl = (process.env.SPROUTBOAT_DASHBOARD_URL || "https://dashboard.sproutboat.com").replace(/\/$/, "");
      return Response.json({ deviceCode, userCode: code, verificationUri: `${dashboardUrl}/?cli_code=${code}`, interval: 2, expiresAt }, { status: 201 });
    } catch (error) {
      if (!(error instanceof Error) || !/UNIQUE constraint failed/.test(error.message)) throw error;
    }
  }
  return Response.json({ error: "unable to create a CLI authorization; try again" }, { status: 503 });
}

export async function approveCliAuthorization(request: Request, code: string): Promise<Response> {
  const actor = await actorFor(request);
  if (!actor || actor.authentication !== "session") return Response.json({ error: "sign in and reserve a namespace before approving a CLI request" }, { status: 401 });
  // SAFETY: the query selects the Authorization columns from the table created in db().
  const record = db().query("SELECT user_code, device_hash, user_id, state, expires_at FROM cli_authorizations WHERE user_code = ?").get(code) as Authorization | null;
  if (!record || !active(record)) return Response.json({ error: "CLI request has expired or is invalid" }, { status: 404 });
  if (record.state !== "pending") return Response.json({ error: "CLI request was already handled" }, { status: 409 });
  db().query("UPDATE cli_authorizations SET user_id = ?, state = 'approved' WHERE user_code = ? AND state = 'pending'").run(actor.id, code);
  return Response.json({ approved: true, username: actor.username });
}

export async function exchangeCliAuthorization(deviceCode: string | undefined): Promise<Response> {
  if (!deviceCode || deviceCode.length < 32) return Response.json({ error: "deviceCode is required" }, { status: 400 });
  // SAFETY: the query selects the Authorization columns from the table created in db().
  const record = db().query("SELECT user_code, device_hash, user_id, state, expires_at FROM cli_authorizations WHERE device_hash = ?").get(hash(deviceCode)) as Authorization | null;
  if (!record || !active(record)) return Response.json({ error: "CLI request has expired or is invalid" }, { status: 404 });
  if (record.state === "pending") return Response.json({ error: "authorization pending" }, { status: 428 });
  if (record.state !== "approved" || !record.user_id) return Response.json({ error: "CLI request was already used" }, { status: 410 });
  const claimed = db().query("UPDATE cli_authorizations SET state = 'issuing' WHERE user_code = ? AND state = 'approved'").run(record.user_code);
  if (!claimed.changes) return Response.json({ error: "CLI request was already used" }, { status: 410 });
  try {
    const result = await getAuth().api.createApiKey({ body: { userId: record.user_id, name: "Sproutboat CLI" } });
    const key = result?.key;
    if (!key) throw new Error("API key creation did not return a key");
    db().query("UPDATE cli_authorizations SET state = 'issued', token_issued_at = ? WHERE user_code = ?").run(new Date().toISOString(), record.user_code);
    return Response.json({ token: key });
  } catch (error) {
    db().query("UPDATE cli_authorizations SET state = 'approved' WHERE user_code = ? AND state = 'issuing'").run(record.user_code);
    return Response.json({ error: error instanceof Error ? error.message : "unable to create CLI key" }, { status: 503 });
  }
}

/**
 * #21: CLI credential management. Session callers only — a CLI token cannot
 * list or revoke credentials (keeps the browser session and CLI keys separate).
 * Ownership is enforced by scoping every query to the caller's user id.
 */
async function sessionUser(request: Request): Promise<{ id: string } | Response> {
  const actor = await actorFor(request).catch(() => undefined);
  if (!actor) return Response.json({ error: "sign in required" }, { status: 401 });
  if (actor.authentication !== "session") return Response.json({ error: "manage CLI credentials from the dashboard, not a CLI token" }, { status: 403 });
  return { id: actor.id };
}

export async function listCliCredentials(request: Request): Promise<Response> {
  const user = await sessionUser(request);
  if (user instanceof Response) return user;
  return Response.json({ credentials: listCredentials(user.id) });
}

export async function revokeCliCredential(request: Request, id: string): Promise<Response> {
  const user = await sessionUser(request);
  if (user instanceof Response) return user;
  return revokeCredential(user.id, id)
    ? Response.json({ revoked: id })
    : Response.json({ error: "credential not found" }, { status: 404 });
}

export async function revokeAllCliCredentials(request: Request): Promise<Response> {
  const user = await sessionUser(request);
  if (user instanceof Response) return user;
  return Response.json({ revoked: revokeAllCredentials(user.id) });
}
