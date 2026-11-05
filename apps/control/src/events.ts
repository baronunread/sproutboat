/**
 * Activity events: an append-only history of what changed on this box, written
 * by the mutation handlers and read back by `GET /api/activity`. Webhook
 * deliveries are enqueued from here (`webhooks.ts`), so one `recordEvent` call
 * is the whole contract for a writer.
 *
 * Recording is best-effort by design: a failure to write history must never fail
 * the action that was being recorded.
 */
import { LIMITS } from "./limits";
import { storeDatabase } from "./store";
import { enqueueDeliveries } from "./webhooks";
import { EVENT_DATA_KEYS, parseTypeFilter, type EventType, type TypeFilter } from "./event-types";

export { EVENT_TYPES, EVENT_GROUPS, SYSTEM_OWNER, type EventType } from "./event-types";

export type EventValue = string | number | boolean | null;
export type EventData = { [key: string]: EventValue };

export type ActivityEvent = {
  id: number;
  ts: string;
  ownerId: string;
  project: string | null;
  type: EventType;
  actor: string | null;
  summary: string;
  data: EventData;
};

export type NewEvent = {
  ownerId: string;
  project?: string;
  type: EventType;
  actor?: string;
  summary: string;
  data?: { [key: string]: EventValue | undefined };
  /** Deliver to this one webhook only (the `webhook.test` event). */
  webhookId?: string;
};

const MAX_STRING = 500;

/**
 * Keep only the allowlisted keys for `type`, and only plain scalars. Strings are
 * cut to a bounded length so one event cannot become a large row.
 */
export function scrub(type: EventType, data: { [key: string]: EventValue | undefined } | undefined) {
  const allowed = EVENT_DATA_KEYS[type];
  const out: EventData = {};
  for (const key of allowed) {
    const value = data?.[key];
    if (value === undefined) continue;
    if (value === null || value === Number(value) || value === Boolean(value)) out[key] = value;
    else if (value === String(value)) out[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  }
  return out;
}

type EventRow = {
  id: number;
  ts: string;
  owner_id: string;
  project: string | null;
  type: string;
  actor: string | null;
  summary: string;
  data: string;
};

function toEvent(row: EventRow): ActivityEvent {
  let data: EventData = {};
  try {
    // SAFETY: rows are only written by recordEvent, which stores a scrubbed EventData object.
    data = JSON.parse(row.data) as EventData;
  } catch {
    /* an unreadable row is shown without data rather than hidden */
  }
  return {
    id: row.id,
    ts: row.ts,
    ownerId: row.owner_id,
    project: row.project,
    // SAFETY: rows are only written by recordEvent, which takes an EventType.
    type: row.type as EventType,
    actor: row.actor,
    summary: row.summary,
    data,
  };
}

let inserts = 0;
let prunedPath: string | undefined;
const currentPath = () => process.env.SPROUTBOAT_DATABASE_PATH || "/var/lib/sproutboat/sproutboat.sqlite";

/**
 * Drop events past the retention window, then the oldest beyond the row cap.
 * Returns how many rows went.
 */
export function pruneEvents(now = Date.now()): number {
  const db = storeDatabase();
  const cutoff = new Date(now - LIMITS.eventsKeepDays() * 86_400_000).toISOString();
  let removed = db.query("DELETE FROM events WHERE ts < ?").run(cutoff).changes;
  removed += db
    .query("DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)")
    .run(LIMITS.eventsMaxRows()).changes;
  return removed;
}

/**
 * Write one event and queue its webhook deliveries. Synchronous and never
 * throws: a failure is logged and the caller carries on.
 */
export function recordEvent(input: NewEvent): ActivityEvent | undefined {
  try {
    const db = storeDatabase();
    const data = scrub(input.type, input.data);
    const ts = new Date().toISOString();
    const result = db
      .query("INSERT INTO events (ts, owner_id, project, type, actor, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        ts,
        input.ownerId,
        input.project ?? null,
        input.type,
        input.actor ?? null,
        input.summary.slice(0, 300),
        JSON.stringify(data),
      );
    const event: ActivityEvent = {
      id: Number(result.lastInsertRowid),
      ts,
      ownerId: input.ownerId,
      project: input.project ?? null,
      type: input.type,
      actor: input.actor ?? null,
      summary: input.summary.slice(0, 300),
      data,
    };
    inserts += 1;
    if (prunedPath !== currentPath() || inserts % 100 === 0) {
      prunedPath = currentPath();
      try {
        pruneEvents();
      } catch (error) {
        console.error(`events: prune failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      enqueueDeliveries(event, input.webhookId);
    } catch (error) {
      console.error(`events: webhook enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return event;
  } catch (error) {
    console.error(`events: could not record ${input.type}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export type EventQuery = {
  /** One account's events. Omit with `all` for every account plus system events. */
  ownerId?: string;
  all?: boolean;
  project?: string;
  types?: readonly TypeFilter[];
  since?: string;
  until?: string;
  before?: number;
  limit: number;
};

/** Newest first. `nextBefore` is set when more rows exist past this page. */
export function listEvents(query: EventQuery) {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (!query.all) {
    where.push("owner_id = ?");
    args.push(query.ownerId ?? "");
  }
  if (query.project !== undefined) {
    where.push("project = ?");
    args.push(query.project);
  }
  if (query.types && query.types.length > 0) {
    const parts = query.types.map((filter) => {
      if ("exact" in filter) {
        args.push(filter.exact);
        return "type = ?";
      }
      args.push(filter.prefix.length, filter.prefix);
      return "substr(type, 1, ?) = ?";
    });
    // Bun binds positionally; the prefix form pushes (length, prefix) in that order.
    where.push(`(${parts.join(" OR ")})`);
  }
  if (query.since !== undefined) {
    where.push("ts >= ?");
    args.push(query.since);
  }
  if (query.until !== undefined) {
    where.push("ts <= ?");
    args.push(query.until);
  }
  if (query.before !== undefined) {
    where.push("id < ?");
    args.push(query.before);
  }
  const limit = Math.min(Math.max(1, query.limit), 200);
  // SAFETY: the SELECT lists exactly the EventRow columns.
  const rows = storeDatabase()
    .query(
      `SELECT id, ts, owner_id, project, type, actor, summary, data FROM events ${
        where.length ? `WHERE ${where.join(" AND ")}` : ""
      } ORDER BY id DESC LIMIT ?`,
    )
    .all(...args, limit + 1) as EventRow[];
  const page = rows.slice(0, limit).map(toEvent);
  const nextBefore: number | null = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;
  return { events: page, nextBefore };
}

/** Parse a comma list of exact types or `group.*` prefixes; undefined names the first bad token. */
export function parseTypeList(raw: string): { filters: TypeFilter[] } | { invalid: string } {
  const filters: TypeFilter[] = [];
  for (const token of raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const filter = parseTypeFilter(token);
    if (!filter) return { invalid: token };
    filters.push(filter);
  }
  return { filters };
}
