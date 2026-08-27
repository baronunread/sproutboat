export const ARTIFACT_SCHEMA_VERSION = 1;
export const ABI_VERSION = "abi-v1";
export const CAPABILITY_PROFILE = "http-sync-v0";

export type ArtifactManifest = {
  schemaVersion: 1;
  project: string;
  target: "linux-x86_64";
  abi: "abi-v1";
  capabilityProfile: "http-sync-v0";
  porfforVersion: string;
  rolldownVersion: string;
  buildImage: string;
  sourceHash: `sha256:${string}`;
  binaryHash: `sha256:${string}`;
  binarySize: number;
  builtAt: string;
};

export type ManifestValidation =
  | { ok: true; value: ArtifactManifest }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

export function validateManifest(value: unknown): ManifestValidation {
  if (!isRecord(value)) return { ok: false, errors: ["manifest must be an object"] };
  const errors: string[] = [];
  const required = ["schemaVersion", "project", "target", "abi", "capabilityProfile", "porfforVersion", "rolldownVersion", "buildImage", "sourceHash", "binaryHash", "binarySize", "builtAt"];
  for (const field of required) if (!(field in value)) errors.push(`missing manifest field: ${field}`);
  if (value.schemaVersion !== ARTIFACT_SCHEMA_VERSION) errors.push("schemaVersion must be 1");
  if (typeof value.project !== "string" || !/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(value.project)) errors.push("project must be a valid slug");
  if (value.target !== "linux-x86_64") errors.push("target must be linux-x86_64");
  if (value.abi !== ABI_VERSION) errors.push("abi must be abi-v1");
  if (value.capabilityProfile !== CAPABILITY_PROFILE) errors.push("capabilityProfile must be http-sync-v0");
  for (const field of ["porfforVersion", "rolldownVersion", "buildImage"] as const) if (typeof value[field] !== "string" || !value[field]) errors.push(`${field} must be a non-empty string`);
  if (!sha256(value.sourceHash)) errors.push("sourceHash must be a sha256 digest");
  if (!sha256(value.binaryHash)) errors.push("binaryHash must be a sha256 digest");
  if (!Number.isSafeInteger(value.binarySize) || (value.binarySize as number) < 1) errors.push("binarySize must be a positive integer");
  if (typeof value.builtAt !== "string" || Number.isNaN(Date.parse(value.builtAt))) errors.push("builtAt must be an ISO-8601 timestamp");
  return errors.length ? { ok: false, errors } : { ok: true, value: value as ArtifactManifest };
}
