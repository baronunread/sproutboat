/**
 * #183 — read-only R2 object browsing for the dashboard, the deferred
 * follow-up from #136 ("R2 object browsing" was explicitly out of scope
 * there). Same posture as kv.ts: authenticated, resource-ownership checked,
 * bounded, no object contents in logs.
 *
 * Object bytes live in their own file, not a SQLite column
 * (baronunread/sproutboat#56, @sproutboat/wire's broker.ts) — the metadata
 * row's `bucket` value is the resource id itself (storeFor() in broker.ts,
 * for an account-level binding), so listing here reads the exact same
 * `<resource-id>.sqlite` KV/D1 already reads, plus a sibling `r2-blobs/`
 * directory for the bytes.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { actorFor } from "./identity";
import { ownerResources, resourceById } from "./store";

const MAX_LIST_LIMIT = 1000;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_R2_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_R2_MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;

type OwnedR2 = { id: string; actorId: string; path: string };
type R2Row = {
  key: string;
  size: number;
  etag: string;
  uploaded: string;
  http_json: string;
  custom_json: string;
  /** Immutable on-disk generation. Older rows stored no explicit generation. */
  blob_id?: string | null;
};

const resourceRoot = (): string =>
  resolve(
    process.env.SPROUTBOAT_RESOURCE_DIR ||
      resolve(dirname(process.env.SPROUTBOAT_DATABASE_PATH || "/var/lib/sproutboat/sproutboat.sqlite"), "resources"),
  );

async function ownedR2(request: Request, id: string): Promise<Response | OwnedR2> {
  const actor = await actorFor(request).catch(() => null);
  if (!actor)
    return Response.json({ error: "sign in and reserve a username before using this endpoint" }, { status: 401 });
  const resource = resourceById(actor.id, id);
  if (!resource || resource.kind !== "r2") return Response.json({ error: "bucket not found" }, { status: 404 });
  return { id: resource.id, actorId: actor.id, path: resolve(resourceRoot(), `${resource.id}.sqlite`) };
}

function audit(owned: OwnedR2, operation: string, status: "ok" | "rejected", count: number): void {
  console.info(JSON.stringify({ event: "r2", actor: owned.actorId, resourceId: owned.id, operation, status, count }));
}

function openR2(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  // Mirrors transport-embedded.js / broker.ts exactly (#56): metadata only,
  // object bytes live in r2-blobs/, never a column here.
  db.exec(
    "CREATE TABLE IF NOT EXISTS r2 (bucket TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL, " +
      "etag TEXT NOT NULL, uploaded TEXT NOT NULL, http_json TEXT NOT NULL DEFAULT '{}', custom_json TEXT NOT NULL DEFAULT '{}', " +
      "PRIMARY KEY (bucket, key))",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS r2_part (bucket TEXT NOT NULL, key TEXT NOT NULL, upload_id TEXT NOT NULL, " +
      "part_number INTEGER NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL, " +
      "PRIMARY KEY (bucket, key, upload_id, part_number))",
  );
  return db;
}

const positiveEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

/** Account-wide R2 capacity and direct-transfer rejection counters for the dashboard. */
export async function r2Usage(request: Request): Promise<Response> {
  const actor = await actorFor(request).catch(() => null);
  if (!actor)
    return Response.json({ error: "sign in and reserve a username before using this endpoint" }, { status: 401 });
  const resources = ownerResources(actor.id).filter((resource) => resource.kind === "r2");
  let usedBytes = 0;
  for (const resource of resources) {
    const path = resolve(resourceRoot(), `${resource.id}.sqlite`);
    if (!existsSync(path)) continue;
    const db = openR2(path);
    try {
      usedBytes +=
        db
          .query<{ bytes: number }, []>(
            "SELECT (SELECT COALESCE(SUM(size), 0) FROM r2) + (SELECT COALESCE(SUM(size), 0) FROM r2_part) AS bytes",
          )
          .get()?.bytes ?? 0;
    } finally {
      db.close();
    }
  }
  const metrics = { reservedBytes: 0, ticketsIssued: 0, rejectedQuota: 0, rejectedDisk: 0, rejectedSize: 0 };
  const quotaPath = resolve(resourceRoot(), "r2-quota.sqlite");
  if (existsSync(quotaPath)) {
    const db = new Database(quotaPath, { readonly: true });
    try {
      const quota = db
        .query<{ reserved_bytes: number }, [string]>("SELECT reserved_bytes FROM r2_account_quota WHERE owner = ?")
        .get(actor.id);
      metrics.reservedBytes = quota?.reserved_bytes ?? 0;
      const transfers = db
        .query<
          { tickets_issued: number; rejected_quota: number; rejected_disk: number; rejected_size: number },
          [string]
        >("SELECT tickets_issued, rejected_quota, rejected_disk, rejected_size FROM r2_transfer_metric WHERE owner = ?")
        .get(actor.id);
      metrics.ticketsIssued = transfers?.tickets_issued ?? 0;
      metrics.rejectedQuota = transfers?.rejected_quota ?? 0;
      metrics.rejectedDisk = transfers?.rejected_disk ?? 0;
      metrics.rejectedSize = transfers?.rejected_size ?? 0;
    } finally {
      db.close();
    }
  }
  const quotaBytes = positiveEnv("SPROUTBOAT_R2_QUOTA_BYTES", DEFAULT_R2_QUOTA_BYTES);
  return Response.json({
    resources: resources.length,
    usedBytes,
    quotaBytes,
    availableBytes: Math.max(0, quotaBytes - usedBytes - metrics.reservedBytes),
    minFreeBytes: positiveEnv("SPROUTBOAT_R2_MIN_FREE_BYTES", DEFAULT_R2_MIN_FREE_BYTES),
    ...metrics,
  });
}

/**
 * Same hash as @sproutboat/wire's broker.ts `r2BlobId` (bucket+key, sha256,
 * hex). It must stay identical, since it's how both sides find the same file
 * on disk. Duplicated rather than imported because it is a small stable
 * storage-format boundary between the control plane and wire package.
 */
function r2BlobPath(resourceDbPath: string, bucket: string, key: string, generation?: string | null): string {
  const hash = createHash("sha256")
    .update(generation ? `${bucket}\0${key}\0${generation}` : `${bucket}\0${key}`)
    .digest("hex");
  return join(dirname(resourceDbPath), "r2-blobs", `${hash}.blob`);
}

export async function listR2Objects(request: Request, id: string): Promise<Response> {
  const owned = await ownedR2(request, id);
  if (owned instanceof Response) return owned;
  const url = new URL(request.url);
  const prefix = url.searchParams.get("prefix") ?? "";
  const cursor = url.searchParams.get("cursor") ?? "";
  const requested = Number(url.searchParams.get("limit") ?? 100);
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_LIST_LIMIT)
    return Response.json({ error: `limit must be between 1 and ${MAX_LIST_LIMIT}` }, { status: 400 });
  const db = openR2(owned.path);
  try {
    const rows = db
      .query<R2Row, [string, string, string, string, number]>(
        "SELECT key, size, etag, uploaded, http_json, custom_json FROM r2 " +
          "WHERE bucket = ? AND key > ? AND substr(key, 1, length(?)) = ? ORDER BY key LIMIT ?",
      )
      .all(id, cursor, prefix, prefix, requested + 1);
    const more = rows.length > requested;
    const page = rows.slice(0, requested);
    const objects = page.map((row) => ({
      key: row.key,
      size: row.size,
      etag: row.etag,
      uploaded: row.uploaded,
      httpMetadata: JSON.parse(row.http_json || "{}"),
      customMetadata: JSON.parse(row.custom_json || "{}"),
    }));
    audit(owned, "list", "ok", objects.length);
    return Response.json({ objects, cursor: more ? page.at(-1)?.key : null });
  } finally {
    db.close();
  }
}

/** GET metadata + bytes for one object (download). Read-only: no PUT/DELETE — out of scope for #183, same as #136 for KV/D1. */
export async function r2Object(request: Request, id: string, key: string): Promise<Response> {
  const owned = await ownedR2(request, id);
  if (owned instanceof Response) return owned;
  const db = openR2(owned.path);
  let row: R2Row | null;
  try {
    row = db.query<R2Row, [string, string]>("SELECT * FROM r2 WHERE bucket = ? AND key = ?").get(id, key);
  } finally {
    db.close();
  }
  if (!row) {
    audit(owned, "get", "ok", 0);
    return Response.json({ error: "object not found" }, { status: 404 });
  }
  if (row.size > MAX_DOWNLOAD_BYTES) {
    audit(owned, "get", "rejected", 0);
    return Response.json({ error: `object exceeds the ${MAX_DOWNLOAD_BYTES} byte download limit` }, { status: 413 });
  }
  // Current broker writes use immutable blobs keyed by `blob_id`; retain the
  // original key-only filename as a compatibility fallback for pre-generation
  // rows created before @sproutboat/wire 0.7.
  const blobPath = r2BlobPath(owned.path, id, key, row.blob_id);
  if (!existsSync(blobPath)) {
    // A metadata row with no blob file (disk issue, deleted out from under
    // it) reads as not-found rather than a 500.
    audit(owned, "get", "ok", 0);
    return Response.json({ error: "object not found" }, { status: 404 });
  }
  // SAFETY: http_json is only ever written by sb_r2_put_c/broker.ts's r2.put,
  // both of which JSON.stringify a plain httpMetadata object.
  const httpMetadata = JSON.parse(row.http_json || "{}") as { contentType?: string };
  const bytes = readFileSync(blobPath);
  audit(owned, "get", "ok", 1);
  return new Response(bytes, {
    headers: {
      "content-type": httpMetadata.contentType || "application/octet-stream",
      "content-length": String(statSync(blobPath).size),
      etag: `"${row.etag}"`,
      "content-disposition": `attachment; filename="${encodeURIComponent(key.split("/").pop() || key)}"`,
    },
  });
}
