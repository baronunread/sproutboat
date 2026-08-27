export const NODE_ENROLLMENT_VERSION = 1;

export type NodeRole = "all-in-one" | "control" | "edge";
export type NodeEnrollmentRequest = {
  version: 1;
  name: string;
  role: NodeRole;
  region: string;
  architecture: "x86_64";
  publicKey: string;
};

export type NodeValidation = { ok: true; value: NodeEnrollmentRequest } | { ok: false; errors: string[] };

export function validateNodeEnrollment(value: unknown): NodeValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, errors: ["node enrollment must be an object"] };
  const node = value as Record<string, unknown>;
  const errors: string[] = [];
  if (node.version !== NODE_ENROLLMENT_VERSION) errors.push("node enrollment version must be 1");
  if (typeof node.name !== "string" || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(node.name)) errors.push("node name must be a lowercase slug");
  if (node.role !== "all-in-one" && node.role !== "control" && node.role !== "edge") errors.push("node role must be all-in-one, control, or edge");
  if (typeof node.region !== "string" || !/^[a-z]+-[a-z]+(?:-\d+)?$/.test(node.region)) errors.push("region must be a provider-neutral region slug");
  if (node.architecture !== "x86_64") errors.push("architecture must be x86_64");
  if (typeof node.publicKey !== "string" || node.publicKey.length < 32) errors.push("publicKey must be a non-empty enrollment key");
  return errors.length ? { ok: false, errors } : { ok: true, value: node as NodeEnrollmentRequest };
}
