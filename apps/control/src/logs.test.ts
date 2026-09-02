import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let logFile: string;
let logs: typeof import("./logs");

const HOST = "app.alice.test";
type LineOverride = Partial<{
  at: string; hostname: string; status: number; durationMs: number; error: string; errorKind: string;
  method: string; ttfbMs: number; reqBytes: number; resBytes: number; coldStart: boolean; startupMs: number; bootMs: number; cpuMs: number; cacheStatus: string;
}>;
const line = (over: LineOverride) =>
  `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", hostname: HOST, status: 200, durationMs: 5, ...over })}\n`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-logs-"));
  logFile = join(dir, "requests.ndjson");
  process.env.SPROUTBOAT_LOG_PATH = logFile;
  logs = await import("./logs");
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
beforeEach(async () => { await writeFile(logFile, ""); });

test("filters by hostname, status class, and free text; drops malformed lines", async () => {
  await writeFile(logFile, [
    line({ at: "2026-01-01T00:00:01.000Z", status: 200 }),
    line({ at: "2026-01-01T00:00:02.000Z", status: 404 }),
    line({ at: "2026-01-01T00:00:03.000Z", status: 503, error: "sprout failure" }),
    line({ hostname: "other.bob.test", status: 500 }),
    "not json\n",
    `${JSON.stringify({ at: "x", hostname: HOST })}\n`,
  ].join(""));

  const all = await logs.readLogHistory(HOST, {});
  expect(all.events.map((event) => event.status)).toEqual([503, 404, 200]); // newest first, other tenant + junk gone

  const server = await logs.readLogHistory(HOST, { statusClass: "5xx" });
  expect(server.events.map((event) => event.status)).toEqual([503]);
  expect(server.events[0].failure).toBe("sprout failure");
  expect(server.events[0].statusClass).toBe("5xx");

  const text = await logs.readLogHistory(HOST, { q: "sprout failure" });
  expect(text.events).toHaveLength(1);

  const missing = await logs.readLogHistory(HOST, { statusClass: "4xx" });
  expect(missing.events[0].failure).toBe("no route");
});

test("#3 — filters by method, minimum duration, and cold start", async () => {
  await writeFile(logFile, [
    line({ at: "2026-01-01T00:00:01.000Z", method: "GET", durationMs: 5 }),
    line({ at: "2026-01-01T00:00:02.000Z", method: "POST", durationMs: 250 }),
    line({ at: "2026-01-01T00:00:03.000Z", method: "get", durationMs: 900, coldStart: true }),
  ].join(""));

  const posts = await logs.readLogHistory(HOST, { method: "POST" });
  expect(posts.events.map((event) => event.at)).toEqual(["2026-01-01T00:00:02.000Z"]);

  const gets = await logs.readLogHistory(HOST, { method: "get" }); // case-insensitive both ways
  expect(gets.events).toHaveLength(2);

  const slow = await logs.readLogHistory(HOST, { minDurationMs: 250 });
  expect(slow.events.map((event) => event.durationMs)).toEqual([900, 250]);

  const cold = await logs.readLogHistory(HOST, { coldStart: true });
  expect(cold.events.map((event) => event.at)).toEqual(["2026-01-01T00:00:03.000Z"]);

  const combined = await logs.readLogHistory(HOST, { method: "GET", minDurationMs: 250, coldStart: true });
  expect(combined.events).toHaveLength(1);

  // An omitted filter must not narrow anything.
  expect((await logs.readLogHistory(HOST, { method: "all" })).events).toHaveLength(3);
  expect((await logs.readLogHistory(HOST, { coldStart: undefined })).events).toHaveLength(3);
});

test("paginates with nextBefore and caps the limit", async () => {
  const many = Array.from({ length: 10 }, (_, index) =>
    line({ at: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`, status: 200 + index }));
  await writeFile(logFile, many.join(""));

  const first = await logs.readLogHistory(HOST, { limit: 4 });
  expect(first.events.map((event) => event.status)).toEqual([209, 208, 207, 206]);
  expect(first.nextBefore).toBe("2026-01-01T00:00:06.000Z");

  const second = await logs.readLogHistory(HOST, { limit: 4, before: first.nextBefore ?? undefined });
  expect(second.events.map((event) => event.status)).toEqual([205, 204, 203, 202]);
});

test("read window is bounded to the tail of a large file", async () => {
  const filler = line({ status: 200 }).repeat(20000); // ~2 MiB, past the 1 MiB scan cap
  await writeFile(logFile, filler + line({ at: "2026-06-01T00:00:00.000Z", status: 201 }));
  const page = await logs.readLogHistory(HOST, { limit: 500 });
  expect(page.windowTruncated).toBe(true);
  expect(page.events.length).toBeLessThanOrEqual(500);
  expect(page.events[0].status).toBe(201); // newest line still seen
});

test("readLogTailText returns chronological NDJSON", async () => {
  await writeFile(logFile, [
    line({ at: "2026-01-01T00:00:01.000Z", status: 200 }),
    line({ at: "2026-01-01T00:00:02.000Z", status: 500 }),
  ].join(""));
  const out = await logs.readLogTailText(HOST, 10);
  const parsed = out.trim().split("\n").map((row) => JSON.parse(row));
  expect(parsed.map((row) => row.status)).toEqual([200, 500]);
});

test("aggregateLogs: 24 buckets over the range, right bucket, errors, distribution, percentiles", async () => {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  await writeFile(logFile, [
    line({ at: ago(2 * 3_600_000 + 60_000), status: 200, durationMs: 10 }), // ~22h into a 24h range
    line({ at: ago(2 * 3_600_000 + 30_000), status: 200, durationMs: 20 }),
    line({ at: ago(2 * 3_600_000 + 10_000), status: 503, durationMs: 900, error: "sprout failure" }),
    line({ at: ago(60_000), status: 404, durationMs: 5 }),                    // last bucket
    line({ at: ago(48 * 3_600_000), status: 200, durationMs: 1 }),            // older than 24h -> ignored
  ].join(""));

  const metrics = await logs.aggregateLogs(HOST, "24h");
  expect(metrics.buckets).toHaveLength(24);
  expect(metrics.bucketMs).toBe(3_600_000);
  expect(metrics.sampleCount).toBe(4); // the >24h line dropped

  const filled = metrics.buckets.filter((bucket) => bucket.count > 0);
  expect(filled.map((bucket) => bucket.count)).toEqual([3, 1]);
  expect(filled[0].errors).toBe(1); // the 503
  expect(metrics.buckets[21].count).toBe(3); // ~21.98h from `from` -> bucket 21
  expect(metrics.buckets[23].count).toBe(1); // most recent bucket

  expect(metrics.statusDistribution).toEqual({ "2xx": 2, "3xx": 0, "4xx": 1, "5xx": 1, other: 0 });
  expect(metrics.latencyMs).toEqual({ p50: 20, p90: 900, p99: 900 });
});

test("aggregateLogs: cold starts, startup/ttfb percentiles, byte totals, method split", async () => {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  await writeFile(logFile, [
    line({ at: ago(60_000), status: 200, method: "GET", ttfbMs: 4, reqBytes: 0, resBytes: 100, coldStart: true, startupMs: 30, bootMs: 12, cpuMs: 2 }),
    line({ at: ago(50_000), status: 200, method: "GET", ttfbMs: 8, reqBytes: 0, resBytes: 100, cpuMs: 6 }),
    line({ at: ago(40_000), status: 201, method: "POST", ttfbMs: 12, reqBytes: 50, resBytes: 20, coldStart: true, startupMs: 90, bootMs: 40 }),
  ].join(""));

  const metrics = await logs.aggregateLogs(HOST, "1h");
  expect(metrics.invocationStatus).toEqual({ ok: 3 });
  expect(metrics.cacheHitRate).toBeNull(); // no cacheStatus on these lines
  expect(metrics.coldStarts).toBe(2);
  expect(metrics.startupMs).toEqual({ p50: 90, p90: 90, p99: 90 });
  expect(metrics.bootMs).toEqual({ p50: 40, p90: 40, p99: 40 });
  expect(metrics.ttfbMs).toEqual({ p50: 8, p90: 12, p99: 12 });
  expect(metrics.cpuMs).toEqual({ p50: 6, p90: 6, p99: 6 }); // #28 — only the 2 lines that reported it

  expect(metrics.bytesIn).toBe(50);
  expect(metrics.bytesOut).toBe(220);
  expect(metrics.methodDistribution).toEqual({ GET: 2, POST: 1 });
  expect(metrics.buckets.reduce((sum, bucket) => sum + bucket.coldStarts, 0)).toBe(2);
});

test("aggregateLogs: invocationStatus classifies errorKind and bare 5xx (#27/#33)", async () => {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  await writeFile(logFile, [
    line({ at: ago(10_000), status: 200 }),
    line({ at: ago(9_000), status: 200 }),
    line({ at: ago(8_000), status: 504, error: "request timed out", errorKind: "timed-out" }),
    line({ at: ago(7_000), status: 502, errorKind: "response-too-large" }),
    line({ at: ago(6_000), status: 500 }), // bare 5xx, no errorKind -> upstream-5xx
    line({ at: ago(5_000), status: 404, errorKind: "no-route" }),
  ].join(""));

  const metrics = await logs.aggregateLogs(HOST, "1h");
  expect(metrics.invocationStatus).toEqual({
    ok: 2, "timed-out": 1, "response-too-large": 1, "upstream-5xx": 1, "no-route": 1,
  });
});

test("aggregateLogs: cache hit rate over cacheable GETs (#38)", async () => {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  await writeFile(logFile, [
    line({ at: ago(10_000), status: 200, method: "GET", cacheStatus: "hit" }),
    line({ at: ago(9_000), status: 200, method: "GET", cacheStatus: "hit" }),
    line({ at: ago(8_000), status: 200, method: "GET", cacheStatus: "hit" }),
    line({ at: ago(7_000), status: 200, method: "GET", cacheStatus: "miss" }),
    line({ at: ago(6_000), status: 200, method: "GET", cacheStatus: "dynamic" }), // not counted
    line({ at: ago(5_000), status: 200 }), // no cache status
  ].join(""));

  const metrics = await logs.aggregateLogs(HOST, "1h");
  expect(metrics.cacheHits).toBe(3);
  expect(metrics.cacheHitRate).toBe(75); // 3 hits / (3 hits + 1 miss)
});

test("aggregateLogs: previous-window totals for delta chips (#37)", async () => {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const H = 3_600_000;
  await writeFile(logFile, [
    // this 1h window: 3 requests, 1 error
    line({ at: ago(10_000), status: 200, durationMs: 10 }),
    line({ at: ago(20_000), status: 200, durationMs: 30 }),
    line({ at: ago(30_000), status: 503, durationMs: 40 }),
    // the previous 1h window: 2 requests, 0 errors
    line({ at: ago(H + 5 * 60_000), status: 200, durationMs: 5 }),
    line({ at: ago(H + 10 * 60_000), status: 200, durationMs: 7 }),
    // older than both windows -> ignored
    line({ at: ago(3 * H), status: 200, durationMs: 1 }),
  ].join(""));

  const metrics = await logs.aggregateLogs(HOST, "1h");
  expect(metrics.sampleCount).toBe(3);
  expect(metrics.previous).toEqual({ requests: 2, errors: 0, latencyP50: 7 });
});

test("aggregateLogs: empty window and unknown range", async () => {
  await writeFile(logFile, "");
  const empty = await logs.aggregateLogs(HOST, "6h");
  expect(empty.sampleCount).toBe(0);
  expect(empty.latencyMs).toBeNull();
  expect(empty.buckets.every((bucket) => bucket.count === 0)).toBe(true);

  const fallback = await logs.aggregateLogs(HOST, "bogus");
  expect(fallback.range).toBe("24h");
  expect(fallback.bucketMs).toBe(3_600_000);
});

test("tailLogs emits a ready frame, streams new lines, and closes on abort", async () => {
  const controller = new AbortController();
  const response = logs.tailLogs(HOST, controller.signal);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  const firstFrame = decoder.decode((await reader.read()).value);
  expect(firstFrame).toContain('"type":"ready"');

  await appendFile(logFile, line({ at: "2026-09-09T00:00:00.000Z", status: 502, error: "sprout failure" }));
  let streamed = "";
  const deadline = Date.now() + 4000;
  while (!streamed.includes('"type":"event"') && Date.now() < deadline) {
    const { value } = await reader.read();
    streamed += decoder.decode(value);
  }
  expect(streamed).toContain('"status":502');

  controller.abort();
  const tail = await reader.read();
  expect(tail.done).toBe(true);
});

test("#76 — routeTraffic buckets the window and counts only the given routes", async () => {
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  await writeFile(logFile, [
    line({ at: at(10), status: 200 }),
    line({ at: at(10), status: 503 }),
    line({ at: at(600), status: 200 }),          // ~10h ago: a different bucket
    line({ at: at(2000), status: 200 }),         // outside the 24h window
    line({ at: at(5), hostname: "other.bob.test", status: 200 }), // another tenant
  ].join(""));

  const traffic = await logs.routeTraffic(new Set([HOST]));
  expect(traffic.requests).toBe(3);
  expect(traffic.successes).toBe(2);
  expect(traffic.buckets).toHaveLength(24);
  expect(traffic.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
  expect(traffic.buckets.reduce((sum, bucket) => sum + bucket.errors, 0)).toBe(1); // only the 503
  expect(traffic.buckets.filter((bucket) => bucket.count > 0)).toHaveLength(2);    // two distinct hours
  expect(traffic.buckets.at(-1)?.count).toBe(2);                                   // newest bucket holds the recent pair
});
