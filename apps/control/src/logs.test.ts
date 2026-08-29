import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let logFile: string;
let logs: typeof import("./logs");

const HOST = "app.alice.test";
type LineOverride = Partial<{ at: string; hostname: string; status: number; durationMs: number; error: string }>;
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
    line({ at: "2026-01-01T00:00:03.000Z", status: 503, error: "worker failure" }),
    line({ hostname: "other.bob.test", status: 500 }),
    "not json\n",
    `${JSON.stringify({ at: "x", hostname: HOST })}\n`,
  ].join(""));

  const all = await logs.readLogHistory(HOST, {});
  expect(all.events.map((event) => event.status)).toEqual([503, 404, 200]); // newest first, other tenant + junk gone

  const server = await logs.readLogHistory(HOST, { statusClass: "5xx" });
  expect(server.events.map((event) => event.status)).toEqual([503]);
  expect(server.events[0].failure).toBe("worker failure");
  expect(server.events[0].statusClass).toBe("5xx");

  const text = await logs.readLogHistory(HOST, { q: "worker failure" });
  expect(text.events).toHaveLength(1);

  const missing = await logs.readLogHistory(HOST, { statusClass: "4xx" });
  expect(missing.events[0].failure).toBe("no route");
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
    line({ at: ago(2 * 3_600_000 + 10_000), status: 503, durationMs: 900, error: "worker failure" }),
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

  await appendFile(logFile, line({ at: "2026-09-09T00:00:00.000Z", status: 502, error: "worker failure" }));
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
