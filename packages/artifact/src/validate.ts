import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { validateManifest, type ArtifactManifest } from "./manifest";

export type ValidatedArtifact = { manifest: ArtifactManifest; workerPath: string };
export type ArtifactValidation = { ok: true; value: ValidatedArtifact } | { ok: false; errors: string[] };

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function validateArtifactDirectory(directory: string): Promise<ArtifactValidation> {
  const errors: string[] = [];
  let entries: string[];
  try {
    entries = (await readdir(directory)).sort();
  } catch {
    return { ok: false, errors: ["artifact directory does not exist"] };
  }
  if (entries.join(",") !== "manifest.json,worker") errors.push("artifact directory must contain only manifest.json and worker");
  const manifestPath = resolve(directory, "manifest.json");
  const workerPath = resolve(directory, "worker");
  let manifest: ArtifactManifest | undefined;
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    const result = validateManifest(parsed);
    if (!result.ok) errors.push(...result.errors);
    else manifest = result.value;
  } catch {
    errors.push("manifest.json is not valid JSON");
  }
  let worker: Buffer | undefined;
  try {
    worker = await readFile(workerPath);
    const info = await stat(workerPath);
    if (!info.isFile() || info.size < 1 || info.size > 16 * 1024 * 1024) errors.push("worker must be a 1 byte–16 MiB regular file");
    if (worker[0] !== 0x7f || worker[1] !== 0x45 || worker[2] !== 0x4c || worker[3] !== 0x46) errors.push("worker is not an ELF executable");
    else if (worker[4] !== 2 || worker[5] !== 1 || worker.readUInt16LE(18) !== 62) errors.push("worker must be a 64-bit little-endian x86-64 ELF executable");
  } catch {
    errors.push("worker is missing or unreadable");
  }
  if (manifest && worker && digest(worker) !== manifest.binaryHash) errors.push("worker digest does not match manifest binaryHash");
  return errors.length || !manifest ? { ok: false, errors } : { ok: true, value: { manifest, workerPath } };
}
