/**
 * #25 — control-plane abuse limits: rate-limit deploys per account and per IP,
 * cap projects per account, and record every rejection as its own event line so
 * limit violations are observable. Runtime (per-worker cgroup) caps live in the
 * supervisor; this file is the API side.
 *
 * The limiter is an in-process fixed-window counter — correct for the
 * single-node self-hosted control plane. A fleet would need a shared store.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const num = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const LIMITS = {
  /** deploys per account per minute */
  deployPerAccount: () => num("SPROUTBOAT_DEPLOY_RATE_PER_MIN", 10),
  /** deploys per source IP per minute */
  deployPerIp: () => num("SPROUTBOAT_DEPLOY_RATE_PER_IP_PER_MIN", 20),
  /** distinct projects one account may hold */
  projectsPerAccount: () => num("SPROUTBOAT_MAX_PROJECTS_PER_ACCOUNT", 50),
  /** retained inactive versions per project (active is always kept) */
  versionsPerProject: () => num("SPROUTBOAT_MAX_VERSIONS_PER_PROJECT", 25),
};

const WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

/** @returns seconds to wait, or 0 if under the limit. */
export function rateHit(key: string, limit: number, now = Date.now()): number {
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return 0;
  }
  if (bucket.count < limit) {
    bucket.count += 1;
    return 0;
  }
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
}

/** Best-effort periodic sweep so the map can't grow without bound. */
function sweep(now = Date.now()): void {
  if (buckets.size < 4096) return;
  for (const [key, bucket] of buckets) if (now >= bucket.resetAt) buckets.delete(key);
}

/** First hop of X-Forwarded-For (Caddy sets it); "unknown" if absent. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

const eventLogPath = (): string =>
  process.env.SPROUTBOAT_CONTROL_LOG_PATH || resolve(dirname(process.env.SPROUTBOAT_LOG_PATH || "/var/lib/sproutboat/logs/requests.ndjson"), "control.ndjson");

export type LimitEvent = "deploy-rate-account" | "deploy-rate-ip" | "project-cap" | "tls-issuance";

export async function logLimitEvent(event: LimitEvent, fields: { actor?: string; ip?: string; detail?: string }): Promise<void> {
  const line = JSON.stringify({ at: new Date().toISOString(), kind: "limit", event, ...fields }) + "\n";
  try {
    await mkdir(dirname(eventLogPath()), { recursive: true });
    await appendFile(eventLogPath(), line);
  } catch { /* observability is best-effort; never block the request path */ }
}

function tooMany(retryAfterSec: number, message: string): Response {
  return Response.json({ error: message }, { status: 429, headers: { "retry-after": String(retryAfterSec) } });
}

/**
 * Rate-limit a deploy by account and by source IP. Returns a 429 response to
 * send back, or null to proceed.
 */
export async function guardDeploy(actorId: string, request: Request): Promise<Response | null> {
  sweep();
  const ip = clientIp(request);
  const byIp = rateHit(`deploy:ip:${ip}`, LIMITS.deployPerIp());
  if (byIp > 0) {
    await logLimitEvent("deploy-rate-ip", { actor: actorId, ip, detail: `limit ${LIMITS.deployPerIp()}/min` });
    return tooMany(byIp, "too many deploys from this network; slow down");
  }
  const byAccount = rateHit(`deploy:acct:${actorId}`, LIMITS.deployPerAccount());
  if (byAccount > 0) {
    await logLimitEvent("deploy-rate-account", { actor: actorId, ip, detail: `limit ${LIMITS.deployPerAccount()}/min` });
    return tooMany(byAccount, "too many deploys; slow down");
  }
  return null;
}

/**
 * Enforce the per-account project cap when a deploy would create a *new*
 * project. Returns a 429 response, or null to proceed.
 */
export async function guardNewProject(actorId: string, request: Request, currentProjectCount: number): Promise<Response | null> {
  const cap = LIMITS.projectsPerAccount();
  if (currentProjectCount < cap) return null;
  await logLimitEvent("project-cap", { actor: actorId, ip: clientIp(request), detail: `cap ${cap}` });
  return Response.json({ error: `project limit reached (${cap}); delete a project first` }, { status: 429, headers: { "retry-after": "0" } });
}

// --- #26 ACME issuance ceiling -----------------------------------------

const HOUR_MS = 3_600_000;
const tlsSeen = new Map<string, number>(); // hostname -> last approval ms
let tlsApprovals: number[] = []; // approval timestamps for NEW hostnames, last hour

/**
 * Bound how many *new* deployment certificates Caddy is told to order per hour,
 * so a burst of deployments can't run the zone into a Let's Encrypt block. A
 * hostname already approved recently is a renewal/repeat and does not count.
 * @returns true to let issuance proceed.
 */
export function tlsIssuanceAllowed(hostname: string, now = Date.now()): boolean {
  const last = tlsSeen.get(hostname);
  tlsSeen.set(hostname, now);
  if (last !== undefined && now - last < 24 * HOUR_MS) return true; // repeat within a day
  tlsApprovals = tlsApprovals.filter((ms) => now - ms < HOUR_MS);
  const cap = num("SPROUTBOAT_TLS_NEW_CERTS_PER_HOUR", 20);
  if (tlsApprovals.length >= cap) return false;
  tlsApprovals.push(now);
  // keep the seen-map from growing forever
  if (tlsSeen.size > 8192) for (const [key, ms] of tlsSeen) if (now - ms > 48 * HOUR_MS) tlsSeen.delete(key);
  return true;
}

/** Test hook. */
export function resetLimiter(): void {
  buckets.clear();
  tlsSeen.clear();
  tlsApprovals = [];
}
