import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/**
 * On-disk layout of the shared resource directory (`SPROUTBOAT_RESOURCE_DIR`).
 *
 * KV, D1, R2 and queue resources keep their `<kind>_<24hex>.sqlite` file at the
 * top level, as they always have. What used to be shared by every account is now
 * per owner, so a broker can be given one owner's bytes and nothing else:
 *
 *   owners/<owner-dir>/r2-blobs/    R2 object bodies (was `r2-blobs/`)
 *   owners/<owner-dir>/r2-parts/    multipart upload parts (was `r2-parts/`)
 *   owners/<owner-dir>/r2-quota.sqlite   the owner's quota ledger (was one file for all owners)
 *
 * The control plane reads the same paths (apps/control/src/r2.ts), so both import this file.
 */

/** A resource id as the control plane mints it: `<kind>_<24 lowercase hex>`. */
export const RESOURCE_ID = /^(kv|d1|r2|queue)_[0-9a-f]{24}$/;
/** A Durable Object store id (`do_<24hex>`), per project. */
export const DO_STORE_ID = /^do_[0-9a-f]{24}$/;

/** Owner ids are opaque (Better Auth ids, `bootstrap:<name>`): never put one in a path as is. */
export function ownerDirName(ownerId: string | null | undefined): string {
  if (!ownerId) return "unowned";
  return createHash("sha256").update(ownerId).digest("hex").slice(0, 32);
}

export function ownerStorageDir(resourceDir: string, ownerId: string | null | undefined): string {
  return join(resourceDir, "owners", ownerDirName(ownerId));
}

/** The same hash as @sproutboat/wire's broker `r2BlobId`: it is how both sides find a file. */
export function r2BlobName(bucket: string, key: string, generation?: string | null): string {
  return createHash("sha256")
    .update(generation ? `${bucket}\0${key}\0${generation}` : `${bucket}\0${key}`)
    .digest("hex");
}

function r2PartName(bucket: string, key: string, uploadId: string, partNumber: number): string {
  return createHash("sha256").update(`${bucket}\0${key}\0${uploadId}\0${partNumber}`).digest("hex");
}

const MIGRATED = ".layout-1";

function moveIfPresent(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) return;
  try {
    renameSync(from, to);
  } catch {
    // Another deployment of the same owner moved it first, or it vanished: either way it is not ours to retry.
  }
}

/**
 * One-time move of an owner's R2 bodies and parts out of the old shared
 * `r2-blobs/` and `r2-parts/` into the owner's own directory. The names are
 * hashes of (resource id, key), so the owner's rows say which files are theirs.
 * Renames only, on one filesystem, so it is atomic per file and safe to repeat.
 * Returns the owner directory.
 */
export function adoptOwnerR2Files(
  resourceDir: string,
  ownerId: string | null | undefined,
  r2ResourceIds: string[],
): string {
  const dir = ownerStorageDir(resourceDir, ownerId);
  const blobs = join(dir, "r2-blobs");
  const parts = join(dir, "r2-parts");
  mkdirSync(blobs, { recursive: true });
  mkdirSync(parts, { recursive: true });
  const marker = join(dir, MIGRATED);
  if (existsSync(marker)) return dir;
  const legacyBlobs = join(resourceDir, "r2-blobs");
  const legacyParts = join(resourceDir, "r2-parts");
  for (const id of r2ResourceIds) {
    if (!RESOURCE_ID.test(id)) continue;
    const file = join(resourceDir, `${id}.sqlite`);
    if (!existsSync(file)) continue;
    const db = new Database(file, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      type Row = { bucket: string; key: string; blob_id: string | null };
      let objects: Row[] = [];
      try {
        objects = db.query<Row, []>("SELECT bucket, key, blob_id FROM r2").all();
      } catch {
        // A resource file from before the blob_id column: its rows use the key-only name.
        objects = db.query<Row, []>("SELECT bucket, key, NULL AS blob_id FROM r2").all();
      }
      for (const row of objects) {
        const name = `${r2BlobName(row.bucket, row.key, row.blob_id)}.blob`;
        moveIfPresent(join(legacyBlobs, name), join(blobs, name));
      }
      try {
        const rows = db
          .query<{ bucket: string; key: string; upload_id: string; part_number: number }, []>(
            "SELECT bucket, key, upload_id, part_number FROM r2_part",
          )
          .all();
        for (const row of rows) {
          const name = `${r2PartName(row.bucket, row.key, row.upload_id, row.part_number)}.part`;
          moveIfPresent(join(legacyParts, name), join(parts, name));
        }
      } catch {
        // no multipart table yet: no parts to move
      }
    } finally {
      db.close();
    }
  }
  writeFileSync(marker, "");
  return dir;
}

/** SQLite creates `-wal` and `-shm` beside a database; a file-only mount needs them to exist first. */
export function sqliteFileSet(path: string): string[] {
  return [path, `${path}-wal`, `${path}-shm`];
}

export function touchFiles(paths: string[]): void {
  for (const path of paths) if (!existsSync(path)) writeFileSync(path, "", { flag: "a", mode: 0o660 });
}
