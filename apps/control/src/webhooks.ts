/**
 * Per-account webhooks: registration, the delivery queue, and the sender.
 *
 * Every delivery leaves through the egress service (`SB_EGRESS_URL`), never a
 * direct fetch. That service is what refuses private and reserved addresses, so
 * a webhook pointed at the box's own network is refused rather than followed.
 * With no egress configured a delivery fails closed.
 */
import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { egressAllowList, egressRefusal } from "@sproutboat/runtime";
import { SYSTEM_OWNER, parseStoredFilters, typeMatches } from "./event-types";
import type { ActivityEvent } from "./events";
import { profileForUser } from "./identity";
import { decryptSecret, encryptSecret } from "./secrets-crypto";
import { storeDatabase } from "./store";
import { CONTROL_VERSION } from "./version";
import { webhookBody, type WebhookFormat, type WebhookPayload } from "./webhook-formats";

export type Webhook = {
  id: string;
  ownerId: string;
  url: string;
  types: string[];
  format: WebhookFormat;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type WebhookRow = {
  id: string;
  owner_id: string;
  url: string;
  types: string;
  format: string;
  secret_ciphertext: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

const COLUMNS = "id, owner_id, url, types, format, secret_ciphertext, enabled, created_at, updated_at";

function toWebhook(row: WebhookRow): Webhook {
  let types: string[] = [];
  try {
    // SAFETY: written by createWebhook/updateWebhook as a JSON array of strings.
    types = JSON.parse(row.types) as string[];
  } catch {
    /* an unreadable filter list reads as "all", the safe default for a subscriber */
  }
  return {
    id: row.id,
    ownerId: row.owner_id,
    url: row.url,
    types,
    format: row.format === "discord" ? "discord" : "json",
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- registry ---------------------------------------------------------------

export function listWebhooks(ownerId: string): Webhook[] {
  // SAFETY: the SELECT lists exactly the WebhookRow columns.
  const rows = storeDatabase()
    .query(`SELECT ${COLUMNS} FROM webhooks WHERE owner_id = ? ORDER BY created_at, rowid`)
    .all(ownerId) as WebhookRow[];
  return rows.map(toWebhook);
}

export function getWebhook(ownerId: string, id: string): Webhook | undefined {
  // SAFETY: the SELECT lists exactly the WebhookRow columns.
  const row = storeDatabase()
    .query(`SELECT ${COLUMNS} FROM webhooks WHERE id = ? AND owner_id = ?`)
    .get(id, ownerId) as WebhookRow | null;
  return row ? toWebhook(row) : undefined;
}

export function webhookCount(ownerId: string): number {
  // SAFETY: COUNT(*) returns one numeric column.
  return (storeDatabase().query("SELECT COUNT(*) AS n FROM webhooks WHERE owner_id = ?").get(ownerId) as { n: number })
    .n;
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function createWebhook(input: {
  ownerId: string;
  url: string;
  types: string[];
  format: WebhookFormat;
  secret: string;
}): Webhook {
  const now = new Date().toISOString();
  const id = `wh_${randomBytes(12).toString("hex")}`;
  storeDatabase()
    .query(`INSERT INTO webhooks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(
      id,
      input.ownerId,
      input.url,
      JSON.stringify(input.types),
      input.format,
      encryptSecret(input.secret),
      now,
      now,
    );
  const created = getWebhook(input.ownerId, id);
  if (!created) throw new Error("webhook was not stored");
  return created;
}

export type WebhookPatch = { url?: string; types?: string[]; format?: WebhookFormat; enabled?: boolean };

export function updateWebhook(ownerId: string, id: string, patch: WebhookPatch): Webhook | undefined {
  const current = getWebhook(ownerId, id);
  if (!current) return undefined;
  storeDatabase()
    .query(
      "UPDATE webhooks SET url = ?, types = ?, format = ?, enabled = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
    )
    .run(
      patch.url ?? current.url,
      JSON.stringify(patch.types ?? current.types),
      patch.format ?? current.format,
      (patch.enabled ?? current.enabled) ? 1 : 0,
      new Date().toISOString(),
      id,
      ownerId,
    );
  return getWebhook(ownerId, id);
}

export function deleteWebhook(ownerId: string, id: string): boolean {
  const db = storeDatabase();
  if (!getWebhook(ownerId, id)) return false;
  db.query("DELETE FROM webhook_deliveries WHERE webhook_id = ?").run(id);
  db.query("DELETE FROM webhooks WHERE id = ? AND owner_id = ?").run(id, ownerId);
  return true;
}

/** Why `raw` may not be a webhook URL, or the parsed URL. */
export function validateWebhookUrl(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "url must be an absolute http or https URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "url must use http or https" };
  if (url.username || url.password) return { error: "url must not carry credentials" };
  if (url.port === "25") return { error: "port 25 is blocked" };
  if (raw.length > 2048) return { error: "url is too long" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host) !== 0;
  if (literal || host === "localhost" || host.endsWith(".localhost")) {
    // Names that resolve elsewhere are the egress service's to refuse; a literal
    // address can be judged here, so the operator hears about it at creation.
    const refusal = egressRefusal(
      url.hostname,
      literal ? host : "127.0.0.1",
      egressAllowList(process.env.SB_EGRESS_ALLOW),
    );
    if (refusal) return { error: refusal };
  }
  return { url };
}

// --- queue ------------------------------------------------------------------

/** Seconds to wait after the Nth failed attempt before the next one. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const KEEP_DELIVERIES = 200;

export type DeliveryState = "pending" | "delivered" | "failed" | "refused";

/** Queue the event for each enabled webhook of its account whose filter matches. */
export function enqueueDeliveries(event: ActivityEvent, onlyWebhookId?: string): void {
  if (event.ownerId === SYSTEM_OWNER) return;
  if (event.type === "webhook.test" && !onlyWebhookId) return;
  const targets = listWebhooks(event.ownerId).filter((hook) =>
    onlyWebhookId ? hook.id === onlyWebhookId : hook.enabled && typeMatches(parseStoredFilters(hook.types), event.type),
  );
  const db = storeDatabase();
  for (const hook of targets) {
    db.query(
      "INSERT INTO webhook_deliveries (id, webhook_id, event_id, attempt, state, next_attempt_at, created_at) VALUES (?, ?, ?, 0, 'pending', ?, ?)",
    ).run(`dl_${randomBytes(12).toString("hex")}`, hook.id, event.id, event.ts, event.ts);
    db.query(
      `DELETE FROM webhook_deliveries WHERE webhook_id = ? AND id NOT IN (
         SELECT id FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    ).run(hook.id, hook.id, KEEP_DELIVERIES);
  }
}

export type Delivery = {
  id: string;
  eventId: number;
  eventType: string | null;
  attempt: number;
  state: DeliveryState;
  httpStatus: number | null;
  error: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  deliveredAt: string | null;
};

export function listDeliveries(webhookId: string, limit: number): Delivery[] {
  // SAFETY: the SELECT lists exactly the columns of this row shape.
  const rows = storeDatabase()
    .query(
      `SELECT d.id, d.event_id, e.type AS event_type, d.attempt, d.state, d.http_status, d.error, d.next_attempt_at, d.created_at, d.delivered_at
         FROM webhook_deliveries d LEFT JOIN events e ON e.id = d.event_id
        WHERE d.webhook_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`,
    )
    .all(webhookId, Math.min(Math.max(1, limit), 200)) as Array<{
    id: string;
    event_id: number;
    event_type: string | null;
    attempt: number;
    state: string;
    http_status: number | null;
    error: string | null;
    next_attempt_at: string | null;
    created_at: string;
    delivered_at: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    attempt: row.attempt,
    // SAFETY: only this module writes the state column, from DeliveryState.
    state: row.state as DeliveryState,
    httpStatus: row.http_status,
    error: row.error,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  }));
}

// --- sending ----------------------------------------------------------------

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` */
export function signatureHeader(secret: string, unixSeconds: number, body: string): string {
  return `t=${unixSeconds},v1=${createHmac("sha256", secret).update(`${unixSeconds}.${body}`).digest("hex")}`;
}

const ATTEMPT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

function accountName(ownerId: string): string {
  if (ownerId.startsWith("bootstrap:")) return ownerId.slice("bootstrap:".length);
  try {
    return profileForUser(ownerId)?.username ?? ownerId;
  } catch {
    return ownerId;
  }
}

type Outcome =
  | { kind: "delivered"; status: number }
  | { kind: "refused"; status: number; error: string }
  | { kind: "retry"; status: number | null; error: string };

async function send(
  hook: Webhook,
  secret: string,
  event: ActivityEvent,
  deliveryId: string,
  now: Date,
  fetchImpl: FetchLike,
): Promise<Outcome> {
  const egress = process.env.SB_EGRESS_URL;
  const token = process.env.SB_EGRESS_TOKEN;
  if (!egress || !token) return { kind: "retry", status: null, error: "egress not configured" };
  const payload: WebhookPayload = {
    id: event.id,
    type: event.type,
    ts: event.ts,
    account: accountName(event.ownerId),
    project: event.project,
    actor: event.actor,
    summary: event.summary,
    data: event.data,
  };
  const body = webhookBody(hook.format, payload);
  try {
    const response = await fetchImpl(`${egress.replace(/\/+$/, "")}/`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      headers: {
        "x-sb-egress-url": hook.url,
        "x-sb-egress-token": token,
        "content-type": "application/json",
        "user-agent": `sproutboat-webhooks/${CONTROL_VERSION}`,
        "x-sproutboat-event": event.type,
        "x-sproutboat-delivery": deliveryId,
        "x-sproutboat-signature": signatureHeader(secret, Math.floor(now.getTime() / 1000), body),
      },
      body,
    });
    if (response.headers.get("x-sb-egress-error") === "1") {
      const text = await readCapped(response, MAX_RESPONSE_BYTES);
      let message = text.slice(0, 500);
      try {
        // SAFETY: the egress service's refusal body is {"error": "<message>"}; anything else falls back to the text.
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error === String(parsed.error)) message = parsed.error.slice(0, 500);
      } catch {
        /* not JSON; keep the text */
      }
      return { kind: "refused", status: response.status, error: message || "refused by the egress service" };
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 200 && response.status < 300) return { kind: "delivered", status: response.status };
    return { kind: "retry", status: response.status, error: `receiver responded ${response.status}` };
  } catch (error) {
    return {
      kind: "retry",
      status: null,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    };
  }
}

type DueRow = { id: string; webhook_id: string; event_id: number; attempt: number };
const inFlight = new Set<string>();

function finish(
  id: string,
  state: DeliveryState,
  attempt: number,
  fields: { status?: number | null; error?: string | null; next?: string | null; deliveredAt?: string | null },
): void {
  storeDatabase()
    .query(
      "UPDATE webhook_deliveries SET state = ?, attempt = ?, http_status = ?, error = ?, next_attempt_at = ?, delivered_at = ? WHERE id = ?",
    )
    .run(
      state,
      attempt,
      fields.status ?? null,
      fields.error ?? null,
      fields.next ?? null,
      fields.deliveredAt ?? null,
      id,
    );
}

async function attemptDelivery(row: DueRow, now: Date, fetchImpl: FetchLike): Promise<void> {
  const db = storeDatabase();
  // SAFETY: the SELECT lists exactly the WebhookRow columns.
  const hookRow = db.query(`SELECT ${COLUMNS} FROM webhooks WHERE id = ?`).get(row.webhook_id) as WebhookRow | null;
  if (!hookRow) {
    db.query("DELETE FROM webhook_deliveries WHERE id = ?").run(row.id);
    return;
  }
  const hook = toWebhook(hookRow);
  // SAFETY: the SELECT lists exactly the EventRow columns.
  const eventRow = db
    .query("SELECT id, ts, owner_id, project, type, actor, summary, data FROM events WHERE id = ?")
    .get(row.event_id) as {
    id: number;
    ts: string;
    owner_id: string;
    project: string | null;
    type: string;
    actor: string | null;
    summary: string;
    data: string;
  } | null;
  const attempt = row.attempt + 1;
  if (!eventRow) return finish(row.id, "failed", row.attempt, { error: "event no longer retained" });
  const event: ActivityEvent = {
    id: eventRow.id,
    ts: eventRow.ts,
    ownerId: eventRow.owner_id,
    project: eventRow.project,
    // SAFETY: only recordEvent writes this column, from an EventType.
    type: eventRow.type as ActivityEvent["type"],
    actor: eventRow.actor,
    summary: eventRow.summary,
    // SAFETY: recordEvent stores a scrubbed JSON object.
    data: JSON.parse(eventRow.data) as ActivityEvent["data"],
  };
  if (!hook.enabled && event.type !== "webhook.test")
    return finish(row.id, "failed", row.attempt, { error: "webhook disabled" });

  let secret: string;
  try {
    secret = decryptSecret(hookRow.secret_ciphertext);
  } catch {
    return finish(row.id, "failed", row.attempt, { error: "webhook secret could not be decrypted" });
  }
  const outcome = await send(hook, secret, event, row.id, now, fetchImpl);
  const stamp = now.toISOString();
  if (outcome.kind === "delivered")
    return finish(row.id, "delivered", attempt, { status: outcome.status, deliveredAt: stamp });
  if (outcome.kind === "refused")
    return finish(row.id, "refused", attempt, { status: outcome.status, error: outcome.error });
  if (attempt >= MAX_ATTEMPTS)
    return finish(row.id, "failed", attempt, { status: outcome.status, error: outcome.error });
  const next = new Date(now.getTime() + RETRY_DELAYS_MS[attempt - 1]).toISOString();
  finish(row.id, "pending", attempt, { status: outcome.status, error: outcome.error, next });
}

/**
 * Attempt every delivery whose time has come. Exported for tests, which pass
 * their own clock and fetch. Returns how many attempts ran.
 */
export async function deliverDue(options: { now?: Date; fetchImpl?: FetchLike; limit?: number } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  // SAFETY: the SELECT lists exactly the DueRow columns.
  const due = (
    storeDatabase()
      .query(
        "SELECT id, webhook_id, event_id, attempt FROM webhook_deliveries WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, rowid LIMIT ?",
      )
      .all(now.toISOString(), options.limit ?? 20) as DueRow[]
  ).filter((row) => !inFlight.has(row.id));
  for (const row of due) inFlight.add(row.id);
  await Promise.all(
    due.map(async (row) => {
      try {
        await attemptDelivery(row, now, fetchImpl);
      } catch (error) {
        console.error(
          `webhooks: delivery ${row.id} errored: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        inFlight.delete(row.id);
      }
    }),
  );
  return due.length;
}

/** Poll for due deliveries. The timer is unref'd so it never holds the process open. */
export function startWebhookWorker(options: { intervalMs: number }): ReturnType<typeof setInterval> {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    deliverDue()
      .catch((error) =>
        console.error(`webhooks: worker tick failed: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        running = false;
      });
  }, options.intervalMs);
  timer.unref();
  return timer;
}
