/**
 * HTTP handlers for the Activity feed (`/api/activity`) and per-account
 * webhooks (`/api/webhooks`). The event and delivery logic lives in
 * `events.ts` and `webhooks.ts`; this file is auth, validation and shapes.
 */
import { EVENT_GROUPS, EVENT_TYPES, listEvents, parseTypeList, recordEvent } from "./events";
import { actorFor, type Actor } from "./identity";
import { LIMITS } from "./limits";
import {
  createWebhook,
  deleteWebhook,
  generateWebhookSecret,
  getWebhook,
  listDeliveries,
  listWebhooks,
  updateWebhook,
  validateWebhookUrl,
  webhookCount,
  type Webhook,
  type WebhookPatch,
} from "./webhooks";
import type { WebhookFormat } from "./webhook-formats";

type JsonInput = string | number | boolean | null | undefined | JsonInput[] | { readonly [key: string]: JsonInput };

async function authorized(request: Request): Promise<Actor | Response> {
  try {
    const actor = await actorFor(request);
    return (
      actor || Response.json({ error: "sign in and reserve a username before using this endpoint" }, { status: 401 })
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "authentication is unavailable" },
      { status: 503 },
    );
  }
}

const bad = (error: string, status = 400) => Response.json({ error }, { status });

/** An ISO-8601 timestamp normalised to the stored form, or undefined if it is not one. */
function isoTime(raw: string): string | undefined {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

export function activityTypes(): Response {
  return Response.json({ types: EVENT_TYPES, groups: EVENT_GROUPS });
}

export async function activityFeed(request: Request): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const params = new URL(request.url).searchParams;
  const all = params.get("all") === "1";
  if (all && !actor.isAdmin) return bad("admin access required", 403);

  const typeParam = params.get("type");
  let types;
  if (typeParam) {
    const parsed = parseTypeList(typeParam);
    if ("invalid" in parsed) return bad(`unknown event type: ${parsed.invalid}`);
    types = parsed.filters;
  }
  let since: string | undefined;
  let until: string | undefined;
  if (params.get("since")) {
    since = isoTime(params.get("since") ?? "");
    if (!since) return bad("since must be an ISO timestamp");
  }
  if (params.get("until")) {
    until = isoTime(params.get("until") ?? "");
    if (!until) return bad("until must be an ISO timestamp");
  }
  let before: number | undefined;
  if (params.get("before")) {
    before = Number(params.get("before"));
    if (!Number.isInteger(before) || before < 1) return bad("before must be an event id");
  }
  const limit = Math.min(Math.max(1, Math.floor(Number(params.get("limit"))) || 50), 200);

  const page = listEvents({
    ownerId: actor.id,
    all,
    project: params.get("project") || undefined,
    types,
    since,
    until,
    before,
    limit,
  });
  return Response.json({
    events: page.events.map(({ ownerId, ...event }) => (all ? { ...event, ownerId } : event)),
    nextBefore: page.nextBefore,
  });
}

// --- webhooks -----------------------------------------------------------------

const publicWebhook = ({ ownerId: _owner, ...hook }: Webhook) => hook;

/** Validate a `types` array; returns the cleaned list or an error message. */
function parseTypes(value: JsonInput): string[] | string {
  if (!Array.isArray(value)) return "types must be an array of event types ([] for all)";
  const out: string[] = [];
  for (const entry of value) {
    if (entry !== String(entry)) return "types must be an array of strings";
    const parsed = parseTypeList(String(entry));
    if ("invalid" in parsed || parsed.filters.length !== 1) return `unknown event type: ${String(entry)}`;
    out.push(String(entry).trim());
  }
  return [...new Set(out)];
}

const parseFormat = (value: JsonInput): WebhookFormat | undefined =>
  value === "json" || value === "discord" ? value : undefined;

async function readBody(request: Request): Promise<{ readonly [key: string]: JsonInput }> {
  const body = await request.json().catch(() => ({}));
  return body instanceof Object && !Array.isArray(body) ? body : {};
}

export async function webhooksList(request: Request): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  return Response.json({ webhooks: listWebhooks(actor.id).map(publicWebhook) });
}

export async function webhookCreate(request: Request): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const body = await readBody(request);
  if (body.url !== String(body.url) || !body.url) return bad("url is required");
  const checked = validateWebhookUrl(String(body.url));
  if ("error" in checked) return bad(checked.error);
  const types = parseTypes(body.types ?? []);
  if (!Array.isArray(types)) return bad(types);
  const format = body.format === undefined ? "json" : parseFormat(body.format);
  if (!format) return bad('format must be "json" or "discord"');
  let secret = generateWebhookSecret();
  if (body.secret !== undefined) {
    if (body.secret !== String(body.secret) || !body.secret || String(body.secret).length > 256)
      return bad("secret must be a non-empty string of at most 256 characters");
    secret = String(body.secret);
  }
  if (webhookCount(actor.id) >= LIMITS.webhooksPerAccount())
    return bad(`an account may hold at most ${LIMITS.webhooksPerAccount()} webhooks`, 429);
  const hook = createWebhook({ ownerId: actor.id, url: checked.url.toString(), types, format, secret });
  // The secret is shown once, here; every later read omits it.
  return Response.json({ ...publicWebhook(hook), secret }, { status: 201 });
}

export async function webhookUpdate(request: Request, id: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  if (!getWebhook(actor.id, id)) return bad("webhook not found", 404);
  const body = await readBody(request);
  const patch: WebhookPatch = {};
  if (body.url !== undefined) {
    if (body.url !== String(body.url)) return bad("url must be a string");
    const checked = validateWebhookUrl(String(body.url));
    if ("error" in checked) return bad(checked.error);
    patch.url = checked.url.toString();
  }
  if (body.types !== undefined) {
    const types = parseTypes(body.types);
    if (!Array.isArray(types)) return bad(types);
    patch.types = types;
  }
  if (body.format !== undefined) {
    const format = parseFormat(body.format);
    if (!format) return bad('format must be "json" or "discord"');
    patch.format = format;
  }
  if (body.enabled !== undefined) {
    if (body.enabled !== Boolean(body.enabled)) return bad("enabled must be a boolean");
    patch.enabled = Boolean(body.enabled);
  }
  const hook = updateWebhook(actor.id, id, patch);
  return hook ? Response.json(publicWebhook(hook)) : bad("webhook not found", 404);
}

export async function webhookDelete(request: Request, id: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  return deleteWebhook(actor.id, id) ? Response.json({ deleted: id }) : bad("webhook not found", 404);
}

export async function webhookTest(request: Request, id: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const hook = getWebhook(actor.id, id);
  if (!hook) return bad("webhook not found", 404);
  const event = recordEvent({
    ownerId: actor.id,
    type: "webhook.test",
    actor: actor.username,
    summary: `Test event for webhook ${hook.id}`,
    data: { webhookId: hook.id },
    webhookId: hook.id,
  });
  if (!event) return bad("could not record the test event", 500);
  return Response.json({ queued: true, eventId: event.id }, { status: 202 });
}

export async function webhookDeliveries(request: Request, id: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  if (!getWebhook(actor.id, id)) return bad("webhook not found", 404);
  const limit = Math.min(Math.max(1, Math.floor(Number(new URL(request.url).searchParams.get("limit"))) || 50), 200);
  return Response.json({ deliveries: listDeliveries(id, limit) });
}
