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
export type ActivationClient = {
  stage(deployment: Deployment): Promise<void>;
  promote(id: string): Promise<void>;
  discard(id: string): Promise<void>;
};
let testClient: ActivationClient | null = null;
export function setActivationClientForTest(client: ActivationClient | null): void {
  testClient = client;
}

async function command(payload: Record<string, unknown>): Promise<void> {
  const id = randomUUID();
  await mkdir(requests(), { recursive: true, mode: 0o750 });
  const path = resolve(requests(), `${id}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ id, ...payload }), { mode: 0o640 });
  await rename(temporary, path);
  const reply = resolve(responses(), `${id}.json`);
  const deadline = Date.now() + timeoutMs();
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await readFile(reply, "utf8")) as Reply;
      if (result.id !== id || typeof result.ok !== "boolean") throw new Error("invalid edge activation reply");
      await unlink(reply).catch(() => {});
      await unlink(path).catch(() => {});
      if (!result.ok) throw new Error(result.error || "candidate activation failed");
      return;
    } catch (error) {
      if (error instanceof Error && error.message !== "ENOENT" && !/ENOENT/.test(error.message)) throw error;
    }
    await Bun.sleep(50);
  }
  throw new Error("edge activation timed out");
}

export async function stageCandidate(deployment: Deployment): Promise<void> {
  if (testClient) return testClient.stage(deployment);
  const context = await deploymentRouteContext(deployment);
  await command({
    op: "stage",
    id: deployment.id,
    sproutPath: deployment.sproutPath,
    secretsPath: context.secretsPath,
    services: context.services,
  });
}

export async function promoteCandidate(id: string): Promise<void> {
  if (testClient) return testClient.promote(id);
  await command({ op: "promote", id });
}

export async function discardCandidate(id: string): Promise<void> {
  if (testClient) return testClient.discard(id);
  try {
    await command({ op: "discard", id });
  } catch {
    // Best-effort after a failed stage. The edge also drops candidates on exit.
  }
}
