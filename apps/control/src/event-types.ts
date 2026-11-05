/**
 * The Activity event vocabulary: the dotted type names, what each is allowed to
 * carry in `data`, and the exact-or-prefix filter syntax shared by the activity
 * API and webhook subscriptions (`deploy.succeeded`, `deploy.*`).
 */

export const EVENT_TYPES = [
  "deploy.started",
  "deploy.succeeded",
  "deploy.failed",
  "deploy.activated",
  "deploy.rolled_back",
  "deploy.deleted",
  "project.created",
  "project.deleted",
  "secret.set",
  "secret.deleted",
  "domain.added",
  "domain.verified",
  "domain.removed",
  "token.created",
  "token.revoked",
  "member.created",
  "member.disabled",
  "member.enabled",
  "backup.created",
  "backup.failed",
  "webhook.test",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Events with this owner belong to the box, not an account; only admins see them. */
export const SYSTEM_OWNER = "system";

export function isEventType(value: string): value is EventType {
  return EVENT_TYPES.some((type) => type === value);
}

/**
 * The only `data` keys each type may carry. Anything else is dropped before the
 * row is written, so a caller that passes a secret value, a verification token,
 * an API key or a password hash by mistake cannot leak it into history or a
 * webhook body.
 */
export const EVENT_DATA_KEYS = {
  "deploy.started": ["project"],
  "deploy.succeeded": ["deploymentId", "digest", "hostname", "binarySize", "compileMs", "newProject", "unchanged"],
  "deploy.failed": ["reason"],
  "deploy.activated": ["from", "to"],
  "deploy.rolled_back": ["from", "to"],
  "deploy.deleted": ["deploymentId"],
  "project.created": ["hostname"],
  "project.deleted": ["hostnames"],
  "secret.set": ["name"],
  "secret.deleted": ["name"],
  "domain.added": ["hostname"],
  "domain.verified": ["hostname"],
  "domain.removed": ["hostname"],
  "token.created": ["name", "keyId"],
  "token.revoked": ["keyId", "count", "all"],
  "member.created": ["userId", "username", "email"],
  "member.disabled": ["userId"],
  "member.enabled": ["userId"],
  "backup.created": ["name", "sizeBytes", "encrypted", "offsite"],
  "backup.failed": ["error"],
  "webhook.test": ["webhookId"],
} as const satisfies Record<EventType, readonly string[]>;

/** `deploy.*` for every prefix that names at least one type. */
export const EVENT_GROUPS: readonly string[] = [...new Set(EVENT_TYPES.map((type) => `${type.split(".")[0]}.*`))];

export type TypeFilter = { exact: string } | { prefix: string };

/** Parse one filter token, or undefined if it names no known type or group. */
export function parseTypeFilter(token: string): TypeFilter | undefined {
  if (isEventType(token)) return { exact: token };
  if (token.endsWith(".*") && EVENT_GROUPS.includes(token)) return { prefix: token.slice(0, -1) };
  return undefined;
}

/** True when `type` satisfies any filter; an empty filter list matches everything. */
export function typeMatches(filters: readonly TypeFilter[], type: string): boolean {
  if (filters.length === 0) return true;
  return filters.some((filter) => ("exact" in filter ? filter.exact === type : type.startsWith(filter.prefix)));
}

/** Re-parse stored filter tokens, skipping any a newer or older build does not know. */
export function parseStoredFilters(tokens: readonly string[]): TypeFilter[] {
  return tokens.flatMap((token) => parseTypeFilter(token) ?? []);
}
