export const ARTIFACT_SCHEMA_VERSION = 2;
export const RUNTIME = "native-fetch";
export const CAPABILITY_PROFILE = "http-sync-v0";

export type ArtifactManifest = {
  schemaVersion: 2;
  project: string;
  target: "linux-x86_64";
  runtime: "native-fetch";
  capabilityProfile: "http-sync-v0";
  porfforVersion: string;
  esbuildVersion: string;
  buildImage: string;
  sourceHash: `sha256:${string}`;
  binaryHash: `sha256:${string}`;
  binarySize: number;
  builtAt: string;
};

export type ManifestValidation =
  | { ok: true; value: ArtifactManifest }
  | { ok: false; errors: string[] };

type JsonValue = string | number | boolean | null | ManifestJsonObject | JsonValue[];

interface ManifestJsonObject {
  readonly [key: string]: JsonValue;
}

type ManifestInput = JsonValue | undefined;

function isRecord(value: ManifestInput): value is ManifestJsonObject {
  return value !== null && Object(value) === value && !Array.isArray(value)
    && !(value instanceof Function);
}

function isString(value: ManifestInput): value is string {
  return Object(value) !== value && value === String(value);
}

function sha256(value: ManifestInput): value is `sha256:${string}` {
  return isString(value) && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isPositiveInteger(value: ManifestInput): value is number {
  return Number.isSafeInteger(value) && value === Number(value) && Number(value) > 0;
}

export function validateManifest(value: ManifestInput): ManifestValidation {
  if (!isRecord(value)) return { ok: false, errors: ["manifest must be an object"] };
  const errors: string[] = [];
  const required = ["schemaVersion", "project", "target", "runtime", "capabilityProfile", "porfforVersion", "esbuildVersion", "buildImage", "sourceHash", "binaryHash", "binarySize", "builtAt"];
  for (const field of required) if (!(field in value)) errors.push(`missing manifest field: ${field}`);
  const schemaVersion = value.schemaVersion === ARTIFACT_SCHEMA_VERSION ? ARTIFACT_SCHEMA_VERSION : null;
  if (schemaVersion === null) errors.push("schemaVersion must be 2");
  const project = isString(value.project) && /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(value.project) ? value.project : null;
  if (project === null) errors.push("project must be a valid slug");
  const target = value.target === "linux-x86_64" ? value.target : null;
  if (target === null) errors.push("target must be linux-x86_64");
  const runtime = value.runtime === RUNTIME ? value.runtime : null;
  if (runtime === null) errors.push("runtime must be native-fetch");
  const capabilityProfile = value.capabilityProfile === CAPABILITY_PROFILE ? value.capabilityProfile : null;
  if (capabilityProfile === null) errors.push("capabilityProfile must be http-sync-v0");
  const versions = ["porfforVersion", "esbuildVersion", "buildImage"] as const;
  const [porfforVersion, esbuildVersion, buildImage] = versions.map((field) => isString(value[field]) && value[field] ? value[field] : null);
  for (const [field, version] of versions.map((field, index) => [field, [porfforVersion, esbuildVersion, buildImage][index]] as const)) {
    if (version === null) errors.push(`${field} must be a non-empty string`);
  }
  const sourceHash = sha256(value.sourceHash) ? value.sourceHash : null;
  if (sourceHash === null) errors.push("sourceHash must be a sha256 digest");
  const binaryHash = sha256(value.binaryHash) ? value.binaryHash : null;
  if (binaryHash === null) errors.push("binaryHash must be a sha256 digest");
  const binarySize = isPositiveInteger(value.binarySize) ? value.binarySize : null;
  if (binarySize === null) errors.push("binarySize must be a positive integer");
  const builtAt = isString(value.builtAt) && !Number.isNaN(Date.parse(value.builtAt)) ? value.builtAt : null;
  if (builtAt === null) errors.push("builtAt must be an ISO-8601 timestamp");
  if (errors.length || schemaVersion === null || project === null || target === null || runtime === null || capabilityProfile === null || porfforVersion === null || esbuildVersion === null || buildImage === null || sourceHash === null || binaryHash === null || binarySize === null || builtAt === null) return { ok: false, errors };
  return { ok: true, value: { ...value, schemaVersion, project, target, runtime, capabilityProfile, porfforVersion, esbuildVersion, buildImage, sourceHash, binaryHash, binarySize, builtAt } };
}
