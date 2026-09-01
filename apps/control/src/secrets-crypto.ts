/**
 * #2 — encryption at rest for project secrets. AES-256-GCM. The key comes from
 * `SPROUTBOAT_SECRETS_KEY` (base64, 32 bytes) or, if unset, a `secrets.key` file
 * (32 random bytes, mode 0600) written next to the database on first use — same
 * "just works on a fresh box, never plaintext in the DB" shape as the SQLite
 * file itself. Ciphertext is stored as base64 `iv(12) || ct || tag(16)`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Same state-dir resolution as backups.ts, so `secrets.key` lands where the
// backup archive expects to find it.
const keyPath = () => {
  const stateDir = process.env.SPROUTBOAT_STATE_DIR
    ? resolve(process.env.SPROUTBOAT_STATE_DIR)
    : dirname(resolve(process.env.SPROUTBOAT_DATABASE_PATH || "/var/lib/sproutboat/sproutboat.sqlite"));
  return resolve(stateDir, "secrets.key");
};

let cachedKey: Buffer | undefined;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.SPROUTBOAT_SECRETS_KEY;
  if (fromEnv) {
    const bytes = Buffer.from(fromEnv, "base64");
    if (bytes.length !== 32) throw new Error("SPROUTBOAT_SECRETS_KEY must be 32 bytes, base64-encoded");
    cachedKey = bytes;
    return bytes;
  }
  const path = keyPath();
  try {
    const bytes = readFileSync(path);
    if (bytes.length !== 32) throw new Error(`${path} is not a 32-byte key`);
    cachedKey = bytes;
    return bytes;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code !== "ENOENT") throw error;
    const bytes = randomBytes(32);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
    chmodSync(path, 0o600);
    cachedKey = bytes;
    return bytes;
  }
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64");
}

export function decryptSecret(stored: string): string {
  const raw = Buffer.from(stored, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct, undefined, "utf8") + decipher.final("utf8");
}

/** Test hook — forget the cached key so a test can point at a fresh key file. */
export function resetSecretsKeyForTest(): void {
  cachedKey = undefined;
}
