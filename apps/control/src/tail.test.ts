import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogRecord } from "./logs";
import type { TailEvent, TailFrame } from "./tail";

let dir: string;
let logFile: string;
let sproutFile: string;
let tail: typeof import("./tail");
let logs: typeof import("./logs");

const HOST = "app.alice.test";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-tail-"));
  logFile = join(dir, "requests.ndjson");
  sproutFile = join(dir, "sprouts", "digest.log");
  process.env.SPROUTBOAT_LOG_PATH = logFile;
  tail = await import("./tail");
  logs = await import("./logs");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await mkdir(join(dir, "sprouts"), { recursive: true });
  await writeFile(logFile, "");
  await writeFile(sproutFile, "");
});

const edgeLine = (over: Record<string, string | number | boolean>) =>
  `${JSON.stringify({ at: "2026-01-01T00:00:10.000Z", hostname: HOST, method: "GET", path: "/", status: 200, durationMs: 5, ...over })}\n`;

function record(over: Record<string, string | number | boolean>): LogRecord {
  const parsed = logs.parseLine(edgeLine(over).trim(), HOST);
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
}

const filtersOf = (query: string) => {
  const parsed = tail.parseTailFilters(new URLSearchParams(query));
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.filters;
};

test("outcome maps edge errorKind and the uncaught marker", () => {
  const outcome = (over: Record<string, string | number | boolean>) => tail.outcomeOf(record(over));
  expect(outcome({})).toBe("ok");
  expect(outcome({ status: 500, errorKind: "upstream-5xx" })).toBe("ok"); // handler returned 500 itself
  expect(outcome({ status: 500, errorKind: "upstream-5xx", uncaught: true })).toBe("exception");
  expect(outcome({ status: 504, errorKind: "timed-out" })).toBe("exceededWallTime");
  expect(outcome({ status: 499, errorKind: "client-closed" })).toBe("canceled");
  expect(outcome({ status: 503, errorKind: "sprout-unavailable" })).toBe("unavailable");
  expect(outcome({ status: 502, errorKind: "proxy" })).toBe("proxyError");
  expect(outcome({ status: 404, errorKind: "no-route" })).toBe("noRoute");
  expect(outcome({ status: 502, errorKind: "cpu-limit" })).toBe("exceededCpu");
  expect(outcome({ status: 502, errorKind: "something-new" })).toBe("something-new");
});

test("request event has the Workers tail shape", () => {
  const event = tail.requestEvent(
    record({ at: "2026-01-01T00:00:10.000Z", durationMs: 40, cpuMs: 3.5, method: "post", path: "/api/x" }),
    "app",
    HOST,
  );
  expect(event).toEqual({
    scriptName: "app",
    outcome: "ok",
    eventTimestamp: Date.parse("2026-01-01T00:00:10.000Z") - 40,
    event: { request: { url: `https://${HOST}/api/x`, method: "POST" }, response: { status: 200 } },
    cpuTime: 3.5,
    wallTime: 40,
    logs: [],
    exceptions: [],
  });
  // Old log lines have no path or CPU: unknown stays unknown.
  const old = tail.requestEvent(record({ path: "" }), "app", HOST);
  expect(old.cpuTime).toBeNull();
});

test("sprout text: plain lines are log, Uncaught plus stack frames is one exception", () => {
  const text = [
    "hello world",
    "\u001b[33m42\u001b[0m",
    "Uncaught (in fetch) TypeError: x is not a function",
    "    at handler (index.js:3:9)",
    "    at dispatch (runtime.js:10:1)",
    "after",
    "Uncaught (in promise) boom",
    "",
  ].join("\n");
  const items = tail.parseSproutText(text, 1000);
  expect(items.map((item) => item.kind)).toEqual(["log", "log", "exception", "log", "exception"]);
  const first = items[1];
  expect(first.kind === "log" && first.log.message).toEqual(["42"]); // ANSI stripped
  const exception = items[2];
  expect(exception.kind === "exception" && exception.exception).toEqual({
    name: "TypeError",
    message: "x is not a function",
    timestamp: 1000,
    stack:
      "Uncaught (in fetch) TypeError: x is not a function\n    at handler (index.js:3:9)\n    at dispatch (runtime.js:10:1)",
  });
  const bare = items[4];
  expect(bare.kind === "exception" && bare.exception).toEqual({ name: "Error", message: "boom", timestamp: 1000 });
});

test("sprout events group console runs, never attach to a request, and cap lines per event", () => {
  const lines = Array.from({ length: 130 }, (_, index) => `line ${index}`).join("\n");
  const { events, overflow } = tail.sproutEvents(
    [...tail.parseSproutText(`${lines}\nUncaught (in fetch) Error: bad\nlater`, 5)],
    "app",
    5,
  );
  expect(events.map((event) => [event.outcome, event.logs.length, event.exceptions.length])).toEqual([
    ["ok", 100, 0],
    ["exception", 0, 1],
    ["ok", 1, 0],
  ]);
  expect(overflow).toBe(30);
  for (const event of events) expect(event.event).toBeNull();
});

test("filter parsing validates and normalizes", () => {
  const filters = filtersOf(
    "status=500,4xx&status=ok&method=get&method=post,PUT&sampling-rate=0.25&search=Boom&outcome=Exception",
  );
  expect(tail.summarizeFilters(filters)).toEqual({
    status: ["500", "4xx", "ok"],
    method: ["GET", "POST", "PUT"],
    samplingRate: 0.25,
    search: "boom",
    outcome: ["exception"],
  });
  for (const bad of [
    "status=teapot",
    "status=999",
    "method=G E",
    "sampling-rate=2",
    "sampling-rate=abc",
    "sampling-rate=-1",
  ])
    expect("error" in tail.parseTailFilters(new URLSearchParams(bad))).toBe(true);
  expect(tail.summarizeFilters(filtersOf(""))).toEqual({
    status: [],
    method: [],
    samplingRate: 1,
    search: "",
    outcome: [],
  });
});

function requestFixture(over: Record<string, string | number | boolean>): TailEvent {
  return tail.requestEvent(record(over), "app", HOST);
}
const consoleFixture = (message: string): TailEvent => ({
  scriptName: "app",
  outcome: "ok",
  eventTimestamp: 1,
  event: null,
  cpuTime: null,
  wallTime: 0,
  logs: [{ level: "log", message: [message], timestamp: 1 }],
  exceptions: [],
});

test("status filter: ok, error, code, class; console events match by outcome only", () => {
  const ok = requestFixture({ status: 200 });
  const notFound = requestFixture({ status: 404 });
  const boom = requestFixture({ status: 500, errorKind: "upstream-5xx", uncaught: true });
  const handler500 = requestFixture({ status: 500, errorKind: "upstream-5xx" });
  const timeout = requestFixture({ status: 504, errorKind: "timed-out" });
  const closed = requestFixture({ status: 499, errorKind: "client-closed" });
  const keep = (query: string, event: TailEvent) => tail.eventMatches(event, filtersOf(query));

  expect([ok, notFound, boom, handler500, timeout, closed].map((e) => keep("status=ok", e))).toEqual([
    true,
    false,
    false,
    false,
    false,
    false,
  ]);
  expect([ok, notFound, boom, handler500, timeout, closed].map((e) => keep("status=error", e))).toEqual([
    false,
    false,
    true,
    true,
    true,
    false,
  ]);
  expect([ok, notFound, boom].map((e) => keep("status=404", e))).toEqual([false, true, false]);
  expect([ok, notFound, boom].map((e) => keep("status=4xx", e))).toEqual([false, true, false]);
  expect([ok, notFound, boom, timeout].map((e) => keep("status=5xx", e))).toEqual([false, false, true, true]);
  expect([ok, notFound].map((e) => keep("status=5xx&status=404", e))).toEqual([false, true]);

  const logLine = consoleFixture("hi");
  const [thrown] = tail.sproutEvents(tail.parseSproutText("Uncaught (in fetch) Error: x", 1), "app", 1).events;
  expect(keep("status=ok", logLine)).toBe(true);
  expect(keep("status=error", logLine)).toBe(false);
  expect(keep("status=error", thrown)).toBe(true);
  expect(keep("status=500", thrown)).toBe(false);
});

test("method, outcome, and search filters", () => {
  const get = requestFixture({ method: "GET", path: "/api/Users" });
  const post = requestFixture({ method: "POST", path: "/login", status: 502, errorKind: "proxy" });
  const keep = (query: string, event: TailEvent) => tail.eventMatches(event, filtersOf(query));

  expect([get, post].map((e) => keep("method=post", e))).toEqual([false, true]);
  expect([get, post].map((e) => keep("method=GET&method=POST", e))).toEqual([true, true]);
  expect(keep("method=GET", consoleFixture("x"))).toBe(false); // no method on console events
  expect([get, post].map((e) => keep("outcome=proxyError", e))).toEqual([false, true]);
  expect([get, post].map((e) => keep("search=api/users", e))).toEqual([true, false]);
  expect(keep("search=needle", consoleFixture("a NEEDLE in a log"))).toBe(true);
  const [thrown] = tail.sproutEvents(
    tail.parseSproutText("Uncaught (in fetch) RangeError: bad index 7", 1),
    "app",
    1,
  ).events;
  expect(keep("search=bad%20index", thrown)).toBe(true);
  expect(keep("search=rangeerror", thrown)).toBe(true);
  expect(keep("search=absent", thrown)).toBe(false);
});

test("sampling uses the injected random source", () => {
  const event = requestFixture({});
  const filters = filtersOf("sampling-rate=0.5");
  expect(tail.eventMatches(event, filters, () => 0.49)).toBe(true);
  expect(tail.eventMatches(event, filters, () => 0.5)).toBe(false);
  expect(tail.eventMatches(event, filtersOf("sampling-rate=0"), () => 0)).toBe(false);
  expect(tail.eventMatches(event, filtersOf("sampling-rate=1"), () => 0.999)).toBe(true);
});

// --- stream ---------------------------------------------------------------

async function collect(
  options: Partial<Parameters<typeof tail.tailEvents>[0]>,
  act: () => Promise<void>,
  until: (frames: TailFrame[]) => boolean,
): Promise<TailFrame[]> {
  const controller = new AbortController();
  const response = tail.tailEvents({
    hostname: HOST,
    scriptName: "app",
    sproutLog: () => sproutFile,
    filters: tail.NO_FILTERS,
    signal: controller.signal,
    pollMs: 20,
    ...options,
  });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: TailFrame[] = [];
  let buffer = "";
  const pump = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      buffer += decoder.decode(next.value);
      for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (block.startsWith("data: ")) frames.push(JSON.parse(block.slice(6)));
      }
    }
  })();
  await Bun.sleep(40); // ready frame + cursors at end of the files
  await act();
  const deadline = Date.now() + 3000;
  while (!until(frames) && Date.now() < deadline) await Bun.sleep(10);
  controller.abort();
  await pump;
  return frames;
}

const eventsOf = (frames: TailFrame[]): TailEvent[] =>
  frames.flatMap((frame) => (frame.type === "event" ? [frame.event] : []));

test("stream tails only new data and merges requests with console output and exceptions", async () => {
  // Written before connect: must not appear.
  await writeFile(logFile, edgeLine({ path: "/old" }));
  await writeFile(sproutFile, "old console line\n");
  const frames = await collect(
    {},
    async () => {
      await appendFile(sproutFile, "hello from the app\nUncaught (in fetch) Error: kaput\n    at h (i.js:1:1)\n");
      await appendFile(
        logFile,
        edgeLine({ path: "/ok", cpuMs: 2 }) +
          edgeLine({ path: "/boom", status: 500, errorKind: "upstream-5xx", uncaught: true }) +
          `${JSON.stringify({ at: "2026-01-01T00:00:11.000Z", hostname: "other.bob.test", status: 200, durationMs: 1 })}\n`,
      );
    },
    (all) => eventsOf(all).length >= 4,
  );
  expect(frames[0]).toEqual({
    type: "ready",
    filters: { status: [], method: [], samplingRate: 1, search: "", outcome: [] },
  });
  const events = eventsOf(frames);
  const summary = events.map(
    (event) => event.event?.request.url ?? event.logs[0]?.message[0] ?? event.exceptions[0]?.message,
  );
  expect(summary).toEqual(["hello from the app", "kaput", `https://${HOST}/ok`, `https://${HOST}/boom`]);
  expect(events[1].outcome).toBe("exception");
  expect(events[1].exceptions[0].name).toBe("Error");
  expect(events[1].exceptions[0].stack).toContain("at h (i.js:1:1)");
  expect(events[2].cpuTime).toBe(2);
  expect(events[3].outcome).toBe("exception");
  expect(events.every((event) => event.scriptName === "app")).toBe(true);
  // Console events are never attached to a request.
  expect(events.filter((event) => event.logs.length).every((event) => event.event === null)).toBe(true);
});

test("stream applies filters server side", async () => {
  const frames = await collect(
    { filters: filtersOf("status=5xx&search=boom") },
    async () => {
      await appendFile(
        logFile,
        edgeLine({ path: "/fine" }) +
          edgeLine({ path: "/boom", status: 500, errorKind: "upstream-5xx" }) +
          edgeLine({ path: "/other", status: 500, errorKind: "upstream-5xx" }),
      );
      await appendFile(sproutFile, "noise\n");
    },
    (all) => eventsOf(all).length >= 1,
  );
  await Bun.sleep(0);
  expect(eventsOf(frames).map((event) => event.event?.request.url)).toEqual([`https://${HOST}/boom`]);
});

test("stream caps events per second and reports a dropped frame", async () => {
  const frames = await collect(
    { maxEventsPerSecond: 5, pollMs: 30 },
    async () => {
      await appendFile(logFile, Array.from({ length: 40 }, (_, i) => edgeLine({ path: `/r${i}` })).join(""));
    },
    (all) => all.some((frame) => frame.type === "dropped"),
  );
  expect(eventsOf(frames)).toHaveLength(5);
  const dropped = frames.find((frame) => frame.type === "dropped");
  expect(dropped).toEqual({ type: "dropped", count: 35, reason: "rate" });
});

test("stream follows a truncated sprout log and a redeploy to a new file", async () => {
  let current = sproutFile;
  const second = join(dir, "sprouts", "digest2.log");
  const frames = await collect(
    { sproutLog: () => current },
    async () => {
      await appendFile(sproutFile, "first instance\n");
      await Bun.sleep(80);
      await writeFile(sproutFile, "x\n"); // fresh spawn truncates the file
      await Bun.sleep(80);
      await writeFile(second, "second deployment\n");
      current = second;
    },
    (all) => eventsOf(all).some((event) => event.logs[0]?.message[0] === "second deployment"),
  );
  const lines = eventsOf(frames).flatMap((event) => event.logs.map((log) => log.message[0]));
  expect(lines).toEqual(["first instance", "x", "second deployment"]);
});

test("stream closes at the time cap with a closed frame", async () => {
  const frames = await collect(
    { maxMs: 60 },
    async () => {},
    (all) => all.some((frame) => frame.type === "closed"),
  );
  expect(frames.at(-1)).toEqual({ type: "closed", reason: "tail time limit reached" });
});

test("search narrows a grouped console event to the lines that match", () => {
  const event = tail.sproutEvents(tail.parseSproutText("alpha\nbeta needle\ngamma", 1), "app", 1).events[0];
  const kept = tail.filterEvent(event, filtersOf("search=NEEDLE"));
  expect(kept?.logs.map((log) => log.message[0])).toEqual(["beta needle"]);
  expect(tail.filterEvent(event, filtersOf("search=absent"))).toBeNull();
  expect(tail.filterEvent(event, filtersOf(""))).toBe(event);
});

test("sprout text: a multi-line object stays one message, the startup banner is dropped, real runtime output", () => {
  // Captured from a sprout built by the toolchain: console.log/warn/error/info share one stream.
  const text = [
    "Porffor native fetch server listening on http://127.0.0.1:19555",
    "hello from tailer {",
    "  n: 1",
    "}",
    "a warning line",
    "an error line",
    "multi",
    "line text",
    "Uncaught (in fetch) Error: boom from handler",
    "",
  ].join("\n");
  const items = tail.parseSproutText(text, 7);
  expect(
    items.map((item) =>
      item.kind === "log" ? item.log.message[0] : `!${item.exception.name}: ${item.exception.message}`,
    ),
  ).toEqual([
    "hello from tailer {\n  n: 1\n}",
    "a warning line",
    "an error line",
    "multi",
    "line text",
    "!Error: boom from handler",
  ]);
  // An unclosed opener with no indented follow-up is just a line.
  expect(
    tail.parseSproutText("opening {\nnext line", 1).map((item) => item.kind === "log" && item.log.message[0]),
  ).toEqual(["opening {", "next line"]);
});
