import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CandidateSprout, SproutPool } from "../../supervisor/src/run";

type Command = ({ op: "stage" } & CandidateSprout) | { op: "promote" | "discard"; id: string };

const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

function command(value: unknown, artifacts: string): Command | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (!validId(input.id)) return null;
  if (input.op === "promote" || input.op === "discard") return { op: input.op, id: input.id };
  if (input.op !== "stage" || typeof input.sproutPath !== "string") return null;
  const sproutPath = resolve(input.sproutPath);
  if (!sproutPath.startsWith(`${artifacts}/`) || !sproutPath.endsWith("/sprout")) return null;
  const secretsPath =
    typeof input.secretsPath === "string" && input.secretsPath.startsWith("/") ? input.secretsPath : null;
  let services: Record<string, string> | null = null;
  if (input.services && typeof input.services === "object" && !Array.isArray(input.services)) {
    const entries = Object.entries(input.services).filter(
      ([binding, host]) => /^[A-Z][A-Z0-9_]*$/.test(binding) && typeof host === "string" && /^[a-z0-9.-]+$/.test(host),
    );
    services = Object.fromEntries(entries);
  }
  return { op: "stage", id: input.id, sproutPath, secretsPath, services };
}

/**
 * Control writes immutable, control-owned command files; edge writes replies.
 * This avoids a loopback HTTP control endpoint: a sandboxed sprout cannot forge
 * a command because it has neither the control uid nor write access to requests.
 */
export class ActivationSpool {
  readonly #requests: string;
  readonly #responses: string;
  readonly #artifacts: string;
  readonly #controlUid: number | null;
  #running = false;

  constructor(
    private readonly pool: SproutPool,
    root = resolve(process.env.SPROUTBOAT_ACTIVATION_DIR || "/var/lib/sproutboat/activation"),
  ) {
    this.#requests = resolve(root, "requests");
    this.#responses = resolve(root, "responses");
    this.#artifacts = resolve(process.env.SPROUTBOAT_ARTIFACTS_DIR || "/var/lib/sproutboat/artifacts");
    const uid = Number(process.env.SPROUTBOAT_CONTROL_UID);
    this.#controlUid = Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
  }

  async poll(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await mkdir(this.#responses, { recursive: true, mode: 0o750 });
      const names = await readdir(this.#requests).catch(() => [] as string[]);
      for (const name of names.filter((entry) => /^[a-f0-9-]{36}\.json$/i.test(entry)).sort()) await this.#handle(name);
    } finally {
      this.#running = false;
    }
  }

  async #handle(name: string): Promise<void> {
    const path = resolve(this.#requests, name);
    try {
      // Control owns request removal. A reply means this immutable command has
      // already run and must not be replayed by the edge poller.
      try {
        await stat(resolve(this.#responses, name));
        return;
      } catch {
        /* no reply yet */
      }
      const info = await stat(path);
      if (!info.isFile() || (this.#controlUid !== null && info.uid !== this.#controlUid) || (info.mode & 0o022) !== 0)
        return;
      const parsed = command(JSON.parse(await readFile(path, "utf8")), this.#artifacts);
      if (!parsed) return;
      let result: { ok: true } | { ok: false; error: string };
      try {
        if (parsed.op === "stage") await this.pool.stageCandidate(parsed);
        else if (parsed.op === "promote") this.pool.promoteCandidate(parsed.id);
        else this.pool.discardCandidate(parsed.id);
        result = { ok: true };
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : "activation failed" };
      }
      const destination = resolve(this.#responses, name);
      const temporary = `${destination}.${process.pid}.tmp`;
      const requestId = name.slice(0, -".json".length);
      await writeFile(temporary, JSON.stringify({ id: requestId, ...result }), { mode: 0o640 });
      await rename(temporary, destination);
    } catch (error) {
      console.error(`activation command ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
