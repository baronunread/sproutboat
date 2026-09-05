import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";

/**
 * #3: bounded, filterable edge-log history + a live tail for one project's
 * route. The edge appends one JSON object per line to SPROUTBOAT_LOG_PATH:
 * `{ at, hostname, method, status, durationMs, ttfbMs?, reqBytes?, resBytes?,
 * coldStart?, startupMs?, bootMs?, cpuMs?, error?, errorKind? }`. Older lines carry only the
 * first five fields; every added field is read defensively and treated as
 * "unavailable" when absent.
 *
 * Every read is bounded to the last SCAN_CAP bytes of the file, so a large log
 * can never drive an unbounded request.
 * ponytail: poll-based tail (1s) with a hard 10-minute cap, not inotify —
 * fine for a single-VPS POC; revisit if the log surface gets heavy use.
 */

const logPath = () => resolve(process.env.SPROUTBOAT_LOG_PATH || "/var/lib/sproutboat/logs/requests.ndjson");

const SCAN_CAP = 1 << 20; // 1 MiB
const MAX_LIMIT = 200;
const TAIL_POLL_MS = 1000;
const TAIL_MAX_MS = 10 * 60 * 1000;
const TAIL_READ_CAP = 256 * 1024;

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "other";

export type LogRecord = {
  at: string;
  method: string | null;
  status: number;
  durationMs: number;
  ttfbMs: number | null;
  reqBytes: number | null;
  resBytes: number | null;
  coldStart: boolean;
  startupMs: number | null;
  bootMs: number | null;
  cpuMs: number | null;
  failure: string | null;
  errorKind: string | null;
  cacheStatus: string | null;
  statusClass: StatusClass;
};

export type LogPage = { events: LogRecord[]; nextBefore: string | null; windowTruncated: boolean };

function statusClassOf(status: number): StatusClass {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

type LogJson = string | number | boolean | null | { readonly [key: string]: LogJson } | LogJson[];

function isRecord(value: LogJson | undefined): value is { readonly [key: string]: LogJson } {
  return value !== null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function);
}
function isText(value: LogJson | undefined): value is string {
  return Object(value) !== value && value === String(value);
}
function isFiniteNumber(value: LogJson | undefined): value is number {
  return Object(value) !== value && value === Number(value) && Number.isFinite(value);
}

function parseLine(line: string, hostname?: string): LogRecord | undefined {
  if (!line) return undefined;
  let value: LogJson;
  try {
    // SAFETY: the edge writes one JSON value per line; it is read only through
    // the guards below, and any line that fails them is dropped.
    value = JSON.parse(line) as LogJson;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isText(value.hostname) || (hostname !== undefined && value.hostname !== hostname))
    return undefined;
  if (!isText(value.at) || !isFiniteNumber(value.status) || !isFiniteNumber(value.durationMs)) return undefined;
  const status = value.status;
  const failure = isText(value.error)
    ? value.error
    : status >= 500
      ? "upstream error"
      : status === 404
        ? "no route"
        : null;
  const num = (v: LogJson | undefined): number | null => (isFiniteNumber(v) ? v : null);
  return {
    at: value.at,
    method: isText(value.method) ? value.method : null,
    status,
    durationMs: value.durationMs,
    ttfbMs: num(value.ttfbMs),
    reqBytes: num(value.reqBytes),
    resBytes: num(value.resBytes),
    coldStart: value.coldStart === true,
    startupMs: num(value.startupMs),
    bootMs: num(value.bootMs),
    cpuMs: num(value.cpuMs),
    failure,
    errorKind: isText(value.errorKind) ? value.errorKind : null,
    cacheStatus: isText(value.cacheStatus) ? value.cacheStatus : null,
    statusClass: statusClassOf(status),
  };
}

async function tailBytes(from: number, to: number): Promise<string> {
  try {
    return await Bun.file(logPath()).slice(from, to).text();
  } catch {
    return "";
  }
}

/** Last-SCAN_CAP-bytes tail of the log as lines, with the partial leading line dropped. */
async function tailLines(): Promise<{ lines: string[]; windowTruncated: boolean }> {
  let size = 0;
  try {
    size = Bun.file(logPath()).size;
  } catch {
    return { lines: [], windowTruncated: false };
  }
  const start = Math.max(0, size - SCAN_CAP);
  const windowTruncated = start > 0;
  const lines = (await tailBytes(start, size)).split("\n");
  if (windowTruncated) lines.shift();
  return { lines, windowTruncated };
}

/** Newest-first page of matching records, scanning only the last SCAN_CAP bytes. */
export async function readLogHistory(
  hostname: string,
  options: {
    before?: string;
    limit?: number;
    statusClass?: string;
    q?: string;
    // #3 query builder: the dashboard's field filters, applied in the same
    // single pass as the text match so a filtered page costs one scan.
    method?: string;
    minDurationMs?: number;
    coldStart?: boolean;
  },
): Promise<LogPage> {
  const limit = Math.min(Math.max(1, options.limit ?? 100), MAX_LIMIT);
  const { lines, windowTruncated } = await tailLines();

  const q = options.q?.toLowerCase().trim();
  const wantClass = options.statusClass && options.statusClass !== "all" ? options.statusClass : undefined;
  const wantMethod = options.method && options.method !== "all" ? options.method.toUpperCase() : undefined;
  const matched: LogRecord[] = [];
  for (const line of lines) {
    const record = parseLine(line, hostname);
    if (!record) continue;
    if (wantClass && record.statusClass !== wantClass) continue;
    if (wantMethod && record.method?.toUpperCase() !== wantMethod) continue;
    if (options.minDurationMs !== undefined && record.durationMs < options.minDurationMs) continue;
    if (options.coldStart === true && !record.coldStart) continue;
    if (options.before && record.at >= options.before) continue;
    if (q && !line.toLowerCase().includes(q)) continue;
    matched.push(record);
  }
  matched.reverse();
  const events = matched.slice(0, limit);
  const more = matched.length > limit || (windowTruncated && !options.before);
  return { events, nextBefore: more && events.length ? events[events.length - 1].at : null, windowTruncated };
}

// --- #10: bounded aggregation for the traffic charts ---------------------

const RANGE_MS = {
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
} as const;
type RangeKey = keyof typeof RANGE_MS;
function resolveRange(range: string): RangeKey {
  return range === "1h" || range === "6h" || range === "7d" ? range : "24h";
}
const BUCKET_COUNT = 24;

export type MetricsBucket = { start: string; count: number; errors: number; coldStarts: number };
export type Percentiles = { p50: number; p90: number; p99: number };
export type Metrics = {
  range: string;
  from: string;
  to: string;
  bucketMs: number;
  buckets: MetricsBucket[];
  statusDistribution: Record<StatusClass, number>;
  methodDistribution: Record<string, number>;
  /** ok | timed-out | sprout-unavailable | proxy | response-too-large | upstream-5xx | no-route */
  invocationStatus: Record<string, number>;
  latencyMs: Percentiles | null;
  /** Edge → first upstream byte. Null until some request reached a sprout. */
  ttfbMs: Percentiles | null;
  /** Spawn → listening wait, over the cold starts in the window. */
  startupMs: Percentiles | null;
  /** Of startupMs, the spawn → JS-start slice (process + runtime bootstrap). #41 */
  bootMs: Percentiles | null;
  /** Sprout CPU time per invocation, over requests that reported it. #28
   *  Excludes streamed-body and Set-Cookie responses (the sprout can't tag those). */
  cpuMs: Percentiles | null;
  coldStarts: number;
  bytesIn: number;
  bytesOut: number;
  /** Edge cache: hits / (hits + misses) over cacheable GETs. Null if none. */
  cacheHitRate: number | null;
  cacheHits: number;
  sampleCount: number;
  /** Same-length window immediately before this one, for delta-vs-previous chips.
   *  Under-counts when `windowTruncated` (the tail did not reach back far enough). */
  previous: { requests: number; errors: number; latencyP50: number | null };
  windowTruncated: boolean;
};

const bySize = (left: number, right: number) => left - right;

function percentilesOf(sorted: number[]): Percentiles | null {
  if (!sorted.length) return null;
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { p50: at(50), p90: at(90), p99: at(99) };
}

/**
 * Coarse traffic aggregation over one route's edge log, scanning only the last
 * SCAN_CAP bytes. The range is split into a fixed BUCKET_COUNT (24) buckets, so
 * `bucketMs = rangeMs / 24` (2.5 min for 1h … 7 h for 7d). "errors" is
 * `status >= 500`; 4xx shows in the status distribution instead. Percentiles are
 * nearest-rank over the in-window samples. An unknown range falls back to 24h.
 * ponytail: on a very busy route a wide range can exceed the 1 MiB window —
 * `windowTruncated` says so; the numbers then cover the recent slice only.
 */
export async function aggregateLogs(hostname: string, range: string): Promise<Metrics> {
  const resolved = resolveRange(range);
  const rangeMs = RANGE_MS[resolved];
  const bucketMs = Math.floor(rangeMs / BUCKET_COUNT);
  const to = Date.now();
  const from = to - rangeMs;

  const { lines, windowTruncated } = await tailLines();

  const buckets: MetricsBucket[] = Array.from({ length: BUCKET_COUNT }, (_, index) => ({
    start: new Date(from + index * bucketMs).toISOString(),
    count: 0,
    errors: 0,
    coldStarts: 0,
  }));
  const statusDistribution = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 } satisfies Record<StatusClass, number>;
  const methodDistribution: Record<string, number> = {};
  const invocationStatus: Record<string, number> = {};
  const latencies: number[] = [];
  const ttfbs: number[] = [];
  const startups: number[] = [];
  const boots: number[] = [];
  const cpus: number[] = [];
  let coldStarts = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  const prevFrom = from - rangeMs;
  let prevRequests = 0;
  let prevErrors = 0;
  const prevLatencies: number[] = [];

  for (const line of lines) {
    const record = parseLine(line, hostname);
    if (!record) continue;
    const at = Date.parse(record.at);
    if (Number.isNaN(at)) continue;
    if (at >= prevFrom && at < from) {
      prevRequests += 1;
      if (record.status >= 500) prevErrors += 1;
      prevLatencies.push(record.durationMs);
      continue;
    }
    if (at < from || at > to) continue;
    const index = Math.min(BUCKET_COUNT - 1, Math.floor((at - from) / bucketMs));
    buckets[index].count += 1;
    if (record.status >= 500) buckets[index].errors += 1;
    statusDistribution[record.statusClass] += 1;
    if (record.method) methodDistribution[record.method] = (methodDistribution[record.method] ?? 0) + 1;
    const invStatus = record.errorKind ?? (record.status >= 500 ? "upstream-5xx" : "ok");
    invocationStatus[invStatus] = (invocationStatus[invStatus] ?? 0) + 1;
    latencies.push(record.durationMs);
    if (record.ttfbMs !== null) ttfbs.push(record.ttfbMs);
    if (record.cpuMs !== null) cpus.push(record.cpuMs);
    if (record.coldStart) {
      coldStarts += 1;
      buckets[index].coldStarts += 1;
      if (record.startupMs !== null) startups.push(record.startupMs);
      if (record.bootMs !== null) boots.push(record.bootMs);
    }
    if (record.reqBytes !== null) bytesIn += record.reqBytes;
    if (record.resBytes !== null) bytesOut += record.resBytes;
    if (record.cacheStatus === "hit") cacheHits += 1;
    else if (record.cacheStatus === "miss") cacheMisses += 1;
  }

  return {
    range: resolved,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    bucketMs,
    buckets,
    statusDistribution,
    methodDistribution,
    invocationStatus,
    latencyMs: percentilesOf(latencies.sort(bySize)),
    ttfbMs: percentilesOf(ttfbs.sort(bySize)),
    startupMs: percentilesOf(startups.sort(bySize)),
    bootMs: percentilesOf(boots.sort(bySize)),
    cpuMs: percentilesOf(cpus.sort(bySize)),
    coldStarts,
    bytesIn,
    bytesOut,
    cacheHits,
    cacheHitRate: cacheHits + cacheMisses > 0 ? (cacheHits / (cacheHits + cacheMisses)) * 100 : null,
    sampleCount: latencies.length,
    previous: {
      requests: prevRequests,
      errors: prevErrors,
      latencyP50: percentilesOf(prevLatencies.sort(bySize))?.p50 ?? null,
    },
    windowTruncated,
  };
}

/**
 * #dashboard: request + success (2xx/3xx) counts across a set of routes, bounded
 * to the tail window. Backs the owner overview's success-rate metric.
 *
 * #76 — also returns the same window split into BUCKET_COUNT buckets, so the
 * account overview can draw a traffic trend without a second scan of the log.
 */
export async function routeTraffic(
  hostnames: Set<string>,
  rangeMs = RANGE_MS["24h"],
): Promise<{
  requests: number;
  successes: number;
  buckets: Array<{ start: string; count: number; errors: number }>;
  /** #78 — the same scan, kept per route so a list can show each one's traffic. */
  byHostname: Record<string, { requests: number; errors: number; latencyP50: number | null }>;
}> {
  const to = Date.now();
  const from = to - rangeMs;
  const bucketMs = Math.floor(rangeMs / BUCKET_COUNT);
  const counts: number[] = Array.from({ length: BUCKET_COUNT }, () => 0);
  const errors: number[] = Array.from({ length: BUCKET_COUNT }, () => 0);
  const perRoute = new Map<string, { requests: number; errors: number; durations: number[] }>();
  const { lines } = await tailLines();
  let requests = 0;
  let successes = 0;
  for (const line of lines) {
    let value: LogJson;
    try {
      // SAFETY: one JSON value per line from the edge; read only via the guards below.
      value = JSON.parse(line) as LogJson;
    } catch {
      continue;
    }
    if (!isRecord(value) || !isText(value.hostname) || !hostnames.has(value.hostname)) continue;
    if (!isText(value.at) || !isFiniteNumber(value.status)) continue;
    const at = Date.parse(value.at);
    if (at < from) continue;
    requests += 1;
    if (value.status >= 200 && value.status < 400) successes += 1;
    // The final bucket is still filling; clamp so a just-now record lands in it.
    const index = Math.min(BUCKET_COUNT - 1, Math.max(0, Math.floor((at - from) / bucketMs)));
    counts[index] += 1;
    if (value.status >= 500) errors[index] += 1;

    const route = perRoute.get(value.hostname) ?? { requests: 0, errors: 0, durations: [] };
    route.requests += 1;
    if (value.status >= 500) route.errors += 1;
    if (isFiniteNumber(value.durationMs)) route.durations.push(value.durationMs);
    perRoute.set(value.hostname, route);
  }
  const byHostname: Record<string, { requests: number; errors: number; latencyP50: number | null }> = {};
  for (const [hostname, route] of perRoute) {
    byHostname[hostname] = {
      requests: route.requests,
      errors: route.errors,
      latencyP50: percentilesOf(route.durations.sort(bySize))?.p50 ?? null,
    };
  }
  return {
    requests,
    successes,
    buckets: counts.map((count, index) => ({
      start: new Date(from + index * bucketMs).toISOString(),
      count,
      errors: errors[index],
    })),
    byHostname,
  };
}

/** #admin: request/error totals across every route, bounded to the tail window. */
export async function globalLogTotals(
  rangeMs = RANGE_MS["24h"],
): Promise<{ requests: number; errors: number; from: string; to: string }> {
  const to = Date.now();
  const from = to - rangeMs;
  const { lines } = await tailLines();
  let requests = 0;
  let errors = 0;
  for (const line of lines) {
    const record = parseLine(line);
    if (!record) continue;
    const at = Date.parse(record.at);
    if (Number.isNaN(at) || at < from || at > to) continue;
    requests += 1;
    if (record.status >= 500) errors += 1;
  }
  return { requests, errors, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** Chronological last-N records as NDJSON text — backs the CLI `tail` endpoint. */
export async function readLogTailText(hostname: string, limit = 100): Promise<string> {
  const page = await readLogHistory(hostname, { limit });
  return page.events.length
    ? `${page.events
        .map((event) => JSON.stringify(event))
        .reverse()
        .join("\n")}\n`
    : "";
}

/**
 * Tail of a deployment's sprout+broker stdout/stderr — the plain-text file the
 * supervisor tees each running instance to (`sprouts/<artifact digest>.log`
 * beside the request log). Empty string when the deployment has never started
 * or produced no output. `digest` is the artifact-dir name, i.e.
 * `basename(dirname(sproutPath))`.
 */
export async function readSproutLogText(digest: string, maxBytes = 64 * 1024): Promise<string> {
  try {
    const file = Bun.file(resolve(dirname(logPath()), "sprouts", `${digest}.log`));
    const size = file.size;
    return await file.slice(Math.max(0, size - maxBytes), size).text();
  } catch {
    return "";
  }
}

/** Server-Sent Events stream of new matching records; stops on disconnect or the time cap. */
type TailFrame = { type: "ready" } | { type: "closed"; reason: string } | { type: "event"; event: LogRecord };

export function tailLogs(hostname: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      try {
        offset = Bun.file(logPath()).size;
      } catch {
        offset = 0;
      }
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        signal.removeEventListener("abort", finish);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const send = (payload: TailFrame) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          finish();
        }
      };

      send({ type: "ready" });
      const deadline = Date.now() + TAIL_MAX_MS;
      const timer = setInterval(() => {
        void poll();
      }, TAIL_POLL_MS);
      signal.addEventListener("abort", finish);

      async function poll(): Promise<void> {
        if (signal.aborted) return finish();
        if (Date.now() > deadline) {
          send({ type: "closed", reason: "tail time limit reached" });
          return finish();
        }
        let size = 0;
        try {
          size = Bun.file(logPath()).size;
        } catch {
          return;
        }
        if (size < offset) offset = 0; // log rotated or truncated
        if (size <= offset) return;
        const end = Math.min(size, offset + TAIL_READ_CAP);
        const chunk = await tailBytes(offset, end);
        const lastNewline = chunk.lastIndexOf("\n");
        if (lastNewline < 0) {
          if (end < size) offset = end;
          return;
        }
        const complete = chunk.slice(0, lastNewline);
        offset += Buffer.byteLength(complete, "utf8") + 1;
        for (const line of complete.split("\n")) {
          const record = parseLine(line, hostname);
          if (record) send({ type: "event", event: record });
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
