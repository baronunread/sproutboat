import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { deploymentRouteContext, type Deployment } from "./store";

const root = () => resolve(process.env.SPROUTBOAT_ACTIVATION_DIR || "/var/lib/sproutboat/activation");
const requests = () => resolve(root(), "requests");
const responses = () => resolve(root(), "responses");
const timeoutMs = () =>
  Math.min(30_000, Math.max(1_000, Number(process.env.SPROUTBOAT_ACTIVATION_TIMEOUT_MS) || 10_000));

type Reply = { id: string; ok: boolean; error?: string };
type ActivationPayload =
  | {
      op: "stage" | "promote" | "confirm";
      id: string;
      hostname: string;
      sproutPath: string;
      secretsPath: string | null;
      secretsHash: string | null;
      services: Record<string, string> | null;
    }
  | { op: "discard"; id: string };
export type ActivationClient = {
  stage(deployment: Deployment): Promise<void>;
  promote(id: string): Promise<void>;
  discard(id: string): Promise<void>;
};
let testClient: ActivationClient | null = null;
export function setActivationClientForTest(client: ActivationClient | null): void {
  testClient = client;
}

async function command(payload: ActivationPayload, cleanup = false): Promise<void> {
  const id = randomUUID();
  await mkdir(requests(), { recursive: true, mode: 0o750 });
  const path = resolve(requests(), `${id}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  // The filename is the request envelope id. The payload id remains the
  // candidate id that stage/promote/discard must address.
  await writeFile(temporary, JSON.stringify(payload), { mode: 0o640 });
  await rename(temporary, path);
  const reply = resolve(responses(), `${id}.json`);
  const deadline = Date.now() + timeoutMs();
  while (Date.now() < deadline) {
    try {
      // SAFETY: replies are created by the edge spool with the envelope id and
      // `{ ok: boolean }` result contract; reject any malformed payload below.
      const result = JSON.parse(await readFile(reply, "utf8")) as Reply;
      if (result.id !== id || (result.ok !== true && result.ok !== false))
        throw new Error("invalid edge activation reply");
      await unlink(reply).catch(() => {});
      await unlink(path).catch(() => {});
      if (!result.ok) throw new Error(result.error || "candidate activation failed");
      return;
    } catch (error) {
      if (error instanceof Error && error.message !== "ENOENT" && !/ENOENT/.test(error.message)) throw error;
    }
    await Bun.sleep(50);
  }
  if (!cleanup && (payload.op === "stage" || payload.op === "promote")) {
    // A timed-out request can still be polled after control gives up. Do not
    // report the activation failure until edge has acknowledged a discard for
    // the candidate id, otherwise that late command can orphan a live sprout.
    await command({ op: "discard", id: payload.id }, true);
    await unlink(path).catch(() => {});
    await unlink(reply).catch(() => {});
  }
  throw new Error("edge activation timed out");
}

export async function stageCandidate(deployment: Deployment): Promise<void> {
  if (testClient) return testClient.stage(deployment);
  const context = await deploymentRouteContext(deployment);
  await command({
    op: "stage",
    id: deployment.id,
    hostname: deployment.hostname,
    sproutPath: deployment.sproutPath,
    secretsPath: context.secretsPath,
    secretsHash: context.secretsHash,
    services: context.services,
  });
}

export async function promoteCandidate(deployment: Deployment): Promise<void> {
  if (testClient) return testClient.promote(deployment.id);
  const context = await deploymentRouteContext(deployment);
  await command({
    op: "promote",
    id: deployment.id,
    hostname: deployment.hostname,
    sproutPath: deployment.sproutPath,
    secretsPath: context.secretsPath,
    secretsHash: context.secretsHash,
    services: context.services,
  });
}

/** Confirm that edge force-loaded this active generation after a rollback. */
export async function confirmRoute(deployment: Deployment): Promise<void> {
  if (testClient) return;
  const context = await deploymentRouteContext(deployment);
  await command({
    op: "confirm",
    id: deployment.id,
    hostname: deployment.hostname,
    sproutPath: deployment.sproutPath,
    secretsPath: context.secretsPath,
    secretsHash: context.secretsHash,
    services: context.services,
  });
}

export async function discardCandidate(id: string): Promise<void> {
  if (testClient) return testClient.discard(id);
  await command({ op: "discard", id });
}
