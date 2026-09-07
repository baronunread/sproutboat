import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { actorFor } from "./identity";
import { resourceById } from "./store";

const MAX_KEY_BYTES = 512;
const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_BULK_ITEMS = 100;
const MAX_LIST_LIMIT = 1000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

type JsonInput = string | number | boolean | null | undefined | JsonInput[] | { readonly [key: string]: JsonInput };
type Input = { readonly [key: string]: JsonInput };
type OwnedKv = { id: string; actorId: string; path: string };

const resourceRoot = (): string =>
  resolve(
    process.env.SPROUTBOAT_RESOURCE_DIR ||
      resolve(dirname(process.env.SPROUTBOAT_DATABASE_PATH || "/var/lib/sproutboat/sproutboat.sqlite"), "resources"),
  );

async function ownedKv(request: Request, id: string): Promise<Response | OwnedKv> {
  const actor = await actorFor(request).catch(() => null);
  if (!actor)
    return Response.json({ error: "sign in and reserve a username before using this endpoint" }, { status: 401 });
  const resource = resourceById(actor.id, id);
  if (!resource || resource.kind !== "kv") return Response.json({ error: "namespace not found" }, { status: 404 });
  return { id: resource.id, actorId: actor.id, path: resolve(resourceRoot(), `${resource.id}.sqlite`) };
}

function audit(owned: OwnedKv, operation: string, status: "ok" | "partial" | "rejected", count: number): void {
  console.info(JSON.stringify({ event: "kv", actor: owned.actorId, resourceId: owned.id, operation, status, count }));
}

function openKv(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(
    "CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (ns, key))",
  );
  return db;
}

function validKey(key: JsonInput): key is string {
  return (
    Object(key) !== key &&
    key === String(key) &&
    encoder.encode(key).byteLength > 0 &&
    encoder.encode(key).byteLength <= MAX_KEY_BYTES
  );
}

function validValue(value: JsonInput): value is string {
  return Object(value) !== value && value === String(value) && encoder.encode(value).byteLength <= MAX_VALUE_BYTES;
}

function jsonWithinLimit(value: JsonInput): Response {
  const body = JSON.stringify(value);
  if (encoder.encode(body).byteLength > MAX_RESPONSE_BYTES)
    return Response.json({ error: "response exceeds the configured byte limit" }, { status: 413 });
  return new Response(body, { headers: { "content-type": "application/json" } });
}

export async function listKvKeys(request: Request, id: string): Promise<Response> {
  const owned = await ownedKv(request, id);
  if (owned instanceof Response) return owned;
  const url = new URL(request.url);
  const prefix = url.searchParams.get("prefix") ?? "";
  const cursor = url.searchParams.get("cursor") ?? "";
  const requested = Number(url.searchParams.get("limit") ?? 100);
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_LIST_LIMIT)
    return Response.json({ error: `limit must be between 1 and ${MAX_LIST_LIMIT}` }, { status: 400 });
  const db = openKv(owned.path);
  try {
    const rows = db
      .query<{ key: string }, [string, string, string, string, number]>(
        "SELECT key FROM kv WHERE ns = ? AND key > ? AND substr(key, 1, length(?)) = ? ORDER BY key LIMIT ?",
      )
      .all(id, cursor, prefix, prefix, requested + 1);
    const more = rows.length > requested;
    const keys = rows.slice(0, requested).map((row) => row.key);
    audit(owned, "list", "ok", keys.length);
    return Response.json({ keys, cursor: more ? keys.at(-1) : null });
  } finally {
    db.close();
  }
}

export async function kvKey(request: Request, id: string, key: string): Promise<Response> {
  const owned = await ownedKv(request, id);
  if (owned instanceof Response) return owned;
  if (!validKey(key)) return Response.json({ error: `key must be 1-${MAX_KEY_BYTES} UTF-8 bytes` }, { status: 400 });
  const db = openKv(owned.path);
  try {
    if (request.method === "GET") {
      const row = db
        .query<{ value: string }, [string, string]>("SELECT value FROM kv WHERE ns = ? AND key = ?")
        .get(id, key);
      if (!row) {
        audit(owned, "get", "ok", 0);
        return Response.json({ error: "key not found" }, { status: 404 });
      }
      const response = jsonWithinLimit({ key, value: row.value });
      audit(owned, "get", response.status === 413 ? "rejected" : "ok", response.status === 413 ? 0 : 1);
      return response;
    }
    if (request.method === "PUT") {
      // SAFETY: the fields are parsed below before use; non-object JSON fails the value check.
      const body = (await request.json().catch(() => null)) as Input | null;
      if (!body || !validValue(body.value))
        return Response.json(
          { error: `value must be a string no larger than ${MAX_VALUE_BYTES} UTF-8 bytes` },
          { status: 400 },
        );
      db.query(
        "INSERT INTO kv (ns, key, value) VALUES (?1, ?2, ?3) ON CONFLICT (ns, key) DO UPDATE SET value = ?3",
      ).run(id, key, body.value);
      audit(owned, "put", "ok", 1);
      return Response.json({ key, written: true });
    }
    const result = db.query("DELETE FROM kv WHERE ns = ? AND key = ?").run(id, key);
    audit(owned, "delete", "ok", result.changes);
    return Response.json({ deleted: result.changes === 1 });
  } finally {
    db.close();
  }
}

export async function kvBulk(request: Request, id: string, operation: "get" | "put" | "delete"): Promise<Response> {
  const owned = await ownedKv(request, id);
  if (owned instanceof Response) return owned;
  // SAFETY: array membership and every consumed field are validated below.
  const body = (await request.json().catch(() => null)) as JsonInput;
  const items = Array.isArray(body) ? body : null;
  if (!items || items.length < 1 || items.length > MAX_BULK_ITEMS)
    return Response.json({ error: `body must be an array of 1-${MAX_BULK_ITEMS} items` }, { status: 400 });
  const db = openKv(owned.path);
  try {
    if (operation === "get") {
      if (!items.every(validKey))
        return Response.json({ error: "every item must be a valid key string" }, { status: 400 });
      const get = db.query<{ value: string }, [string, string]>("SELECT value FROM kv WHERE ns = ? AND key = ?");
      const response = jsonWithinLimit(items.map((key) => ({ key, value: get.get(id, key)?.value ?? null })));
      audit(owned, "bulk.get", response.status === 413 ? "rejected" : "ok", response.status === 413 ? 0 : items.length);
      return response;
    }
    if (operation === "put") {
      // SAFETY: every entry and field is validated by the following guard before use.
      const entries = items as Input[];
      if (!entries.every((entry) => entry && validKey(entry.key) && validValue(entry.value)))
        return Response.json({ error: "every item must contain a valid key and string value" }, { status: 400 });
      const put = db.query(
        "INSERT INTO kv (ns, key, value) VALUES (?1, ?2, ?3) ON CONFLICT (ns, key) DO UPDATE SET value = ?3",
      );
      const failures: Array<{ index: number; error: string }> = [];
      db.transaction(() =>
        entries.forEach((entry, index) => {
          if (!validKey(entry.key) || !validValue(entry.value)) return;
          try {
            put.run(id, entry.key, entry.value);
          } catch {
            failures.push({ index, error: "write failed" });
          }
        }),
      )();
      audit(owned, "bulk.put", failures.length ? "partial" : "ok", entries.length - failures.length);
      return Response.json(
        { written: entries.length - failures.length, failures },
        { status: failures.length ? 207 : 200 },
      );
    }
    if (!items.every(validKey))
      return Response.json({ error: "every item must be a valid key string" }, { status: 400 });
    const del = db.query("DELETE FROM kv WHERE ns = ? AND key = ?");
    let deleted = 0;
    db.transaction(() =>
      items.forEach((key) => {
        deleted += del.run(id, key).changes;
      }),
    )();
    audit(owned, "bulk.delete", "ok", deleted);
    return Response.json({ deleted, failures: [] });
  } finally {
    db.close();
  }
}
