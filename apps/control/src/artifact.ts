import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { validateManifest, type ArtifactManifest } from "sproutboat/runtime/manifest";

/** #74 — one `{ binding, id }` storage-binding entry from bindings.json.resources. */
export type ResourceBindingRef = { binding: string; kind: "kv" | "d1" | "r2" | "queue"; id: string };

/**
 * #76 — every binding the sidecar bindings.json declares, as the dashboard's
 * Bindings view reads it. `resources` is the same list as `resourceBindings`;
 * the rest are the plain name lists the CLI writes for the broker.
 */
export type ArtifactBindings = {
  kv: string[]; secrets: string[]; outbound: string[]; d1: string[]; r2: string[];
  queues: string[]; analytics: string[]; crons: string[];
  assets: string | null;
  durableObjects: Array<{ binding: string; className: string }>;
  resources: ResourceBindingRef[];
};

export type ValidatedArtifact = {
  manifest: ArtifactManifest;
  sproutPath: string;
  resourceBindings: ResourceBindingRef[];
  /** null when the artifact carries no bindings.json at all. */
  bindings: ArtifactBindings | null;
};
export type ArtifactValidation = { ok: true; value: ValidatedArtifact } | { ok: false; errors: string[] };

const RESOURCE_KINDS = new Set(["kv", "d1", "r2", "queue"]);
const isResourceKind = (value: string): value is ResourceBindingRef["kind"] => RESOURCE_KINDS.has(value);

// The sprout is always present; these may sit beside it (#1 — deploy carries
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
  if ("resources" in value) {
    const resources = value.resources;
    const ok = isObj(resources) && Object.values(resources).every((entry) =>
      isObj(entry) && isStr(entry.id) && isStr(entry.kind) && isResourceKind(entry.kind));
    if (!ok) errors.push("bindings.json.resources must map binding names to { kind, id }");
  }
  return errors;
}

/** The `resources` map from a bindings.json already known to pass `bindingsErrors`. */
function resourceBindingsOf(value: Json | undefined): ResourceBindingRef[] {
  if (!isObj(value) || !isObj(value.resources)) return [];
  const refs: ResourceBindingRef[] = [];
  for (const [binding, entry] of Object.entries(value.resources)) {
    if (isObj(entry) && isStr(entry.id) && isStr(entry.kind) && isResourceKind(entry.kind)) {
      refs.push({ binding, kind: entry.kind, id: entry.id });
    }
  }
  return refs;
}

/** #76 — the whole binding set from a bindings.json already known to pass `bindingsErrors`. */
function bindingsOf(value: Json | undefined): ArtifactBindings {
  const names = (key: string): string[] => (isObj(value) && isStrArray(value[key]) ? value[key] : []);
  const dos = isObj(value) && Array.isArray(value.do) ? value.do : [];
  return {
    kv: names("kv"), secrets: names("secrets"), outbound: names("outbound"),
    d1: names("d1"), r2: names("r2"), queues: names("queues"),
    analytics: names("analytics"), crons: names("crons"),
    assets: isObj(value) && isStr(value.assets) ? value.assets : null,
    durableObjects: dos.flatMap((entry) =>
      isObj(entry) && isStr(entry.binding) && isStr(entry.className)
        ? [{ binding: entry.binding, className: entry.className }]
        : []),
    resources: resourceBindingsOf(value),
  };
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
  const unexpected = entries.filter((entry) => entry !== "manifest.json" && entry !== "sprout" && !OPTIONAL_ENTRIES.has(entry));
  if (!entries.includes("manifest.json") || !entries.includes("sprout")) errors.push("artifact directory must contain manifest.json and sprout");
  if (unexpected.length) errors.push(`artifact directory has unexpected entries: ${unexpected.join(", ")}`);
  const manifestPath = resolve(directory, "manifest.json");
  const sproutPath = resolve(directory, "sprout");
  let manifest: ArtifactManifest | undefined;
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    const result = validateManifest(parsed);
    if (!result.ok) errors.push(...result.errors);
    else manifest = result.value;
  } catch {
    errors.push("manifest.json is not valid JSON");
  }
  let sprout: Buffer | undefined;
  try {
    sprout = await readFile(sproutPath);
    const info = await stat(sproutPath);
    if (!info.isFile() || info.size < 1 || info.size > 16 * 1024 * 1024) errors.push("sprout must be a 1 byte–16 MiB regular file");
    if (sprout[0] !== 0x7f || sprout[1] !== 0x45 || sprout[2] !== 0x4c || sprout[3] !== 0x46) errors.push("sprout is not an ELF executable");
    else if (sprout[4] !== 2 || sprout[5] !== 1 || sprout.readUInt16LE(18) !== 62) errors.push("sprout must be a 64-bit little-endian x86-64 ELF executable");
  } catch {
    errors.push("sprout is missing or unreadable");
  }
  if (manifest && sprout && digest(sprout) !== manifest.binaryHash) errors.push("sprout digest does not match manifest binaryHash");

  let bindings: ArtifactBindings | null = null;
  if (entries.includes("bindings.json")) {
    const parsed = parseJson(await readFile(resolve(directory, "bindings.json"), "utf8").catch(() => ""));
    const bindingsIssues = parsed === undefined ? ["bindings.json is not valid JSON"] : bindingsErrors(parsed);
    errors.push(...bindingsIssues);
    if (bindingsIssues.length === 0) bindings = bindingsOf(parsed);
  }
  const hasAssetsJson = entries.includes("assets.json");
  const hasAssetsDir = entries.includes("assets");
  if (hasAssetsJson !== hasAssetsDir) errors.push("assets.json and the assets/ directory must be present together");
  else if (hasAssetsJson) errors.push(...await assetsErrors(directory));

  return errors.length || !manifest
    ? { ok: false, errors }
    : { ok: true, value: { manifest, sproutPath, resourceBindings: bindings?.resources ?? [], bindings } };
}
