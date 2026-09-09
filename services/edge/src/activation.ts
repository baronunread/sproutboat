import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CandidateSprout, SproutPool } from "../../supervisor/src/run";

type CandidateCommand = CandidateSprout & { hostname: string };
type Command = ({ op: "stage" | "promote" | "confirm" } & CandidateCommand) | { op: "discard"; id: string };
type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { readonly [key: string]: JsonValue };

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function);
const isString = (value: JsonValue | undefined): value is string => Object(value) !== value && value === String(value);

const validId = (value: JsonValue | undefined): value is string =>
  isString(value) && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

function command(value: JsonValue, artifacts: string): Command | null {
  if (!isObject(value)) return null;
  const input = value;
  if (!validId(input.id)) return null;
  if (input.op === "discard") return { op: input.op, id: input.id };
  if ((input.op !== "stage" && input.op !== "promote" && input.op !== "confirm") || !isString(input.sproutPath))
    return null;
  const sproutPath = resolve(input.sproutPath);
  if (!sproutPath.startsWith(`${artifacts}/`) || !sproutPath.endsWith("/sprout")) return null;
  const secretsPath = isString(input.secretsPath) && input.secretsPath.startsWith("/") ? input.secretsPath : null;
  const secretsHash = isString(input.secretsHash) ? input.secretsHash : null;
  let services: Record<string, string> | null = null;
  if (isObject(input.services)) {
    const entries: Array<[string, string]> = [];
    for (const [binding, host] of Object.entries(input.services)) {
      if (/^[A-Z][A-Z0-9_]*$/.test(binding) && isString(host) && /^[a-z0-9.-]+$/.test(host))
        entries.push([binding, host]);
    }
    services = Object.fromEntries(entries);
  }
  if (!isString(input.hostname) || !/^[a-z0-9.-]+$/.test(input.hostname)) return null;
  return { op: input.op, id: input.id, hostname: input.hostname, sproutPath, secretsPath, secretsHash, services };
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
  readonly #cancelled = new Set<string>();
  #running = false;

  constructor(
    private readonly pool: SproutPool,
    root = resolve(process.env.SPROUTBOAT_ACTIVATION_DIR || "/var/lib/sproutboat/activation"),
    private readonly validatePromotion: (candidate: CandidateCommand) => Promise<void> = async () => {},
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
      const names = await readdir(this.#requests).catch((): string[] => []);
      await this.#handleSequentially(names.filter((entry) => /^[a-f0-9-]{36}\.json$/i.test(entry)).sort());
    } finally {
      this.#running = false;
    }
  }

  async #handleSequentially(names: readonly string[], index = 0): Promise<void> {
    const name = names[index];
    if (!name) return;
    await this.#handle(name);
    return this.#handleSequentially(names, index + 1);
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
      // SAFETY: command() parses every JSON field it consumes before the
      // activation protocol acts on it.
      const parsed = command(JSON.parse(await readFile(path, "utf8")) as JsonValue, this.#artifacts);
      if (!parsed) return;
      let result: { ok: true } | { ok: false; error: string };
      try {
        if (parsed.op === "stage") {
          if (this.#cancelled.has(parsed.id)) this.pool.discardCandidate(parsed.id);
          else await this.pool.stageCandidate(parsed);
        } else if (parsed.op === "promote") {
          await this.validatePromotion(parsed);
          this.pool.promoteCandidate(parsed.id);
        } else if (parsed.op === "confirm") {
          await this.validatePromotion(parsed);
        } else {
          this.#cancelled.add(parsed.id);
          this.pool.discardCandidate(parsed.id);
        }
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
