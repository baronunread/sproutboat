/**
 * #2 — project secrets. Encrypted at rest (`secrets-crypto.ts`); the decrypted
 * `{ NAME: value }` map is written to a per-project `secrets.json` by
 * `syncRoutes()`, which the supervisor hands to the deployment's binding broker.
 *
 * A running worker keeps the secrets it started with — a change takes effect on
 * the next deploy or worker restart, matching Cloudflare ("secrets apply to the
 * next deployment"). The API never returns a secret value, only its name.
 */
import { actorFor, type Actor } from "./identity";
import { LIMITS } from "./limits";
import { deleteSecret, projectDeployments, secretCount, secretNames, setSecret, syncRoutes } from "./store";

type JsonInput = string | number | boolean | null | undefined | JsonInput[] | { readonly [key: string]: JsonInput };
const asText = (value: JsonInput): string =>
  Object(value) !== value && value === String(value) ? String(value) : "";

const NAME = /^[A-Z][A-Z0-9_]*$/;
const MAX_VALUE_BYTES = 8 * 1024;

async function authorized(request: Request): Promise<Actor | Response> {
  try {
    const actor = await actorFor(request);
    return actor || Response.json({ error: "sign in and reserve a username before using this endpoint" }, { status: 401 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "authentication is unavailable" }, { status: 503 });
  }
}

export async function listSecrets(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  return Response.json({ names: secretNames(actor.id, project) });
}

export async function putSecret(request: Request, project: string, name: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  if (!NAME.test(name)) return Response.json({ error: "secret name must be UPPER_SNAKE_CASE" }, { status: 400 });
  if (projectDeployments(actor.id, project).length === 0) {
    return Response.json({ error: "deploy the project at least once before setting secrets" }, { status: 409 });
  }

  const body: { readonly [key: string]: JsonInput } = await request.json().catch(() => ({}));
  const value = asText(body.value);
  if (!value) return Response.json({ error: "a non-empty string `value` is required" }, { status: 400 });
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) return Response.json({ error: `value exceeds ${MAX_VALUE_BYTES} bytes` }, { status: 413 });
  const isNew = !secretNames(actor.id, project).includes(name);
  if (isNew && secretCount(actor.id, project) >= LIMITS.secretsPerProject()) {
    return Response.json({ error: `a project may hold at most ${LIMITS.secretsPerProject()} secrets` }, { status: 429 });
  }

  setSecret(actor.id, project, name, value);
  await syncRoutes();
  return Response.json({ name, set: true, appliesOn: "next deploy or worker restart" }, { status: isNew ? 201 : 200 });
}

export async function removeSecret(request: Request, project: string, name: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  if (!deleteSecret(actor.id, project, name)) return Response.json({ error: "secret not found" }, { status: 404 });
  await syncRoutes();
  return Response.json({ deleted: name });
}
