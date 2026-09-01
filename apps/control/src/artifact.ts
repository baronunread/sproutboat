import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { validateManifest, type ArtifactManifest } from "sproutboat/runtime/manifest";

export type ValidatedArtifact = { manifest: ArtifactManifest; workerPath: string };
export type ArtifactValidation = { ok: true; value: ValidatedArtifact } | { ok: false; errors: string[] };

// The worker is always present; these may sit beside it (#1 — deploy carries
// them so the supervisor can start the binding broker and serve static assets).
const OPTIONAL_ENTRIES = new Set(["bindings.json", "assets.json", "assets"]);
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_FILES = 4096;

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };
const isObj = (value: Json | undefined): value is { readonly [key: string]: Json } =>
  value !== null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function);
const isStr = (value: Json | undefined): value is string => Object(value) !== value && value === String(value);
const isNum = (value: Json | undefined): value is number => Object(value) !== value && value === Number(value) && Number.isFinite(value);
const isStrArray = (value: Json | undefined): value is string[] => Array.isArray(value) && value.every(isStr);

function parseJson(text: string): Json | undefined {
  try {
    // SAFETY: the parsed value is only read through the isObj/isStr/... guards below.
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Shape check for a sidecar `bindings.json` (the `Bindings` type from the CLI). */
function bindingsErrors(value: Json | undefined): string[] {
  if (!isObj(value)) return ["bindings.json must be a JSON object"];
  const errors: string[] = [];
  for (const key of ["kv", "secrets", "outbound", "d1", "r2", "queues", "analytics", "crons"] as const) {
    if (key in value && !isStrArray(value[key])) errors.push(`bindings.json.${key} must be a string[]`);
  }
  if ("assets" in value && !isStr(value.assets)) errors.push("bindings.json.assets must be a string");
  if ("do" in value) {
    const dos = value.do;
    const ok = Array.isArray(dos) && dos.every((entry) => isObj(entry) && isStr(entry.binding) && isStr(entry.className));
    if (!ok) errors.push("bindings.json.do must be an array of { binding, className }");
  }
  return errors;
}

/** Validate a sidecar `assets.json` and that every file it lists is present under `assets/`. */
async function assetsErrors(directory: string): Promise<string[]> {
  const parsed = parseJson(await readFile(resolve(directory, "assets.json"), "utf8").catch(() => ""));
  if (!isObj(parsed)) return ["assets.json is not a valid JSON object"];
  if (!isStr(parsed.notFound) || !["none", "single-page-application", "404-page"].includes(parsed.notFound)) return ["assets.json.notFound is invalid"];
  if (parsed.runSproutFirst !== true && parsed.runSproutFirst !== false && !isStrArray(parsed.runSproutFirst)) return ["assets.json.runSproutFirst must be a boolean or string[]"];
  const files = parsed.files;
  if (!isObj(files)) return ["assets.json.files must be an object"];
  const entries = Object.entries(files);
  if (entries.length > MAX_ASSET_FILES) return [`assets.json lists ${entries.length} files (max ${MAX_ASSET_FILES})`];

  const errors: string[] = [];
  let total = 0;
  for (const [key, entry] of entries) {
    if (!key.startsWith("/") || key.includes("..")) { errors.push(`assets.json key "${key}" must be an absolute posix path`); continue; }
    if (!isObj(entry) || !isStr(entry.hash) || !isNum(entry.size)) { errors.push(`assets.json["${key}"] needs a string hash and numeric size`); continue; }
    let bytes: Buffer;
    try {
      bytes = await readFile(resolve(directory, "assets", `.${key}`));
    } catch {
      errors.push(`assets/${key} is missing`);
      continue;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== entry.hash) errors.push(`assets/${key} does not match its recorded hash`);
    total += bytes.length;
  }
  if (total > MAX_ASSET_BYTES) errors.push(`assets total ${total} bytes exceeds the ${MAX_ASSET_BYTES} limit`);
  return errors;
}

export async function validateArtifactDirectory(directory: string): Promise<ArtifactValidation> {
  const errors: string[] = [];
  let entries: string[];
  try {
    entries = (await readdir(directory)).sort();
  } catch {
    return { ok: false, errors: ["artifact directory does not exist"] };
  }
  const unexpected = entries.filter((entry) => entry !== "manifest.json" && entry !== "worker" && !OPTIONAL_ENTRIES.has(entry));
  if (!entries.includes("manifest.json") || !entries.includes("worker")) errors.push("artifact directory must contain manifest.json and worker");
  if (unexpected.length) errors.push(`artifact directory has unexpected entries: ${unexpected.join(", ")}`);
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

  if (entries.includes("bindings.json")) {
    const parsed = parseJson(await readFile(resolve(directory, "bindings.json"), "utf8").catch(() => ""));
    errors.push(...(parsed === undefined ? ["bindings.json is not valid JSON"] : bindingsErrors(parsed)));
  }
  const hasAssetsJson = entries.includes("assets.json");
  const hasAssetsDir = entries.includes("assets");
  if (hasAssetsJson !== hasAssetsDir) errors.push("assets.json and the assets/ directory must be present together");
  else if (hasAssetsJson) errors.push(...await assetsErrors(directory));

  return errors.length || !manifest ? { ok: false, errors } : { ok: true, value: { manifest, workerPath } };
}
