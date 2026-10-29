import { Buffer } from "node:buffer";
import { logPath, parseLine, type LogRecord } from "./logs";

/**
 * Per-app live tail, in the shape of a Workers tail event. Two sources merge:
 *
 *  - the edge request log (`SPROUTBOAT_LOG_PATH`): one event per finished
 *    request, with status, wall time, CPU ms and a failure class;
 *  - the sprout's own stdout/stderr file (`sprouts/<digest>.log`): console
 *    output and uncaught exceptions.
 *
 * Console lines are NOT tied to a request. Concurrent requests share one
 * process, the runtime does not tag a line with a request id, the file carries
 * no timestamps, and the edge only logs a request once it finishes. Guessing
 * which in-flight request printed a line would be wrong often enough to be
 * worse than saying nothing, so console output arrives as its own events
 * (`event: null`) and is never attached to a request.
 *
 * The runtime also routes console.log, warn, info and debug to the same stream
 * without a level marker. The only marker it writes is `Uncaught (in <where>)`
 * (always an error); every other line is level "log".
 *
 * Bounded like the other log readers: tails only data written after connect,
 * reads at most TAIL_READ_CAP bytes per source per poll, stops at the time cap,
 * and emits at most MAX_EVENTS_PER_SECOND events a second, reporting what it
 * dropped in a `dropped` frame.
 */

export const TAIL_POLL_MS = 1000;
export const TAIL_MAX_MS = 10 * 60 * 1000;
export const TAIL_READ_CAP = 256 * 1024;
/** If a source grows past this between polls, skip to its newest TAIL_READ_CAP bytes. */
const TAIL_BACKLOG_CAP = 4 * TAIL_READ_CAP;
export const MAX_EVENTS_PER_SECOND = 50;
const MAX_LOGS_PER_EVENT = 100;
const MAX_LINE_CHARS = 4096;
const MAX_STACK_CHARS = 4096;
const HEARTBEAT_MS = 10_000;

export type TailOutcome = string;

export type TailLog = { level: "log" | "info" | "warn" | "error" | "debug"; message: string[]; timestamp: number };
export type TailException = { name: string; message: string; timestamp: number; stack?: string };
export type TailEvent = {
  scriptName: string;
  /** ok | exception | exceededCpu | exceededWallTime | canceled | or a platform outcome (see outcomeOf). */
  outcome: TailOutcome;
  eventTimestamp: number;
  event: {
    request: { url: string; method: string; headers?: Record<string, string> };
    response: { status: number };
  } | null;
  /** Sprout CPU ms for the request; null when the sprout did not report it. */
  cpuTime: number | null;
  /** Edge wall time ms; 0 for console-only events. */
  wallTime: number;
  logs: TailLog[];
  exceptions: TailException[];
};

export type TailFrame =
  | { type: "ready"; filters: TailFilterSummary }
  | { type: "event"; event: TailEvent }
  | { type: "dropped"; count: number; bytes?: number; reason: "rate" | "backlog" }
  | { type: "closed"; reason: string };

// --- outcome ---------------------------------------------------------------

const KIND_OUTCOME = new Map([
  ["timed-out", "exceededWallTime"],
  ["client-closed", "canceled"],
  ["cpu-limit", "exceededCpu"],
  ["exceeded-cpu", "exceededCpu"],
  ["sprout-unavailable", "unavailable"],
  ["no-route", "noRoute"],
  ["proxy", "proxyError"],
  ["response-too-large", "responseTooLarge"],
  ["websocket-refused", "websocketRefused"],
]);

/**
 * Edge errorKind / status to a tail outcome. `uncaught` (the runtime's own 500
 * for a throwing handler) is `exception`. A handler that returns 500 itself is
 * `ok`, as on Workers: the request completed. The edge never enforces a CPU
 * limit today, so `exceededCpu` appears only if it starts logging one.
 */
export function outcomeOf(record: Pick<LogRecord, "errorKind" | "uncaught">): TailOutcome {
  if (record.uncaught) return "exception";
  if (record.errorKind && record.errorKind !== "upstream-5xx")
    return KIND_OUTCOME.get(record.errorKind) ?? record.errorKind;
  return "ok";
}

export function requestEvent(record: LogRecord, scriptName: string, hostname: string): TailEvent {
  const wall = Math.max(0, record.durationMs);
  return {
    scriptName,
    outcome: outcomeOf(record),
    eventTimestamp: Math.max(0, Date.parse(record.at) - wall),
    event: {
      request: { url: `https://${hostname}${record.path ?? ""}`, method: (record.method ?? "GET").toUpperCase() },
      response: { status: record.status },
    },
    cpuTime: record.cpuMs,
    wallTime: wall,
    logs: [],
    exceptions: [],
  };
}

// --- sprout stdout/stderr --------------------------------------------------

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
/** Startup banners of the native-fetch server and the binding broker: not the app's output. */
const LISTENING = /^(Porffor native fetch server listening on |sproutboat broker: )/;
const MAX_BLOCK_LINES = 64;
const UNCAUGHT = /^Uncaught \(in ([^)]*)\) ?(.*)$/;
const ERROR_NAME = /^([A-Za-z_$][\w$]*(?:Error|Exception)?): ?(.*)$/;

export type SproutItem = { kind: "log"; log: TailLog } | { kind: "exception"; exception: TailException };

/**
 * Parse complete lines from the sprout's output file. Stack frames (`  at ...`)
 * and other indented lines directly after an `Uncaught (in ...)` line belong to
 * that exception. `now` stamps every item: the file has no timestamps, so this
 * is when the control plane saw the line (poll resolution), not when it was printed.
 */
export function parseSproutText(text: string, now: number): SproutItem[] {
  const items: SproutItem[] = [];
  let pending: { head: string; frames: string[] } | null = null;
  const flush = () => {
    if (!pending) return;
    const match = UNCAUGHT.exec(pending.head);
    const body = (match?.[2] ?? pending.head).trim();
    const named = ERROR_NAME.exec(body);
    const stack = [pending.head, ...pending.frames].join("\n").slice(0, MAX_STACK_CHARS);
    const exception: TailException = {
      name: named?.[1] ?? "Error",
      message: (named ? named[2] : body).slice(0, MAX_LINE_CHARS),
      timestamp: now,
    };
    if (pending.frames.length) exception.stack = stack;
    items.push({ kind: "exception", exception });
    pending = null;
  };
  // console.log of an object prints it over several lines (`label {`, indented
  // members, `}`); keep those together as one message.
  let block: { lines: string[]; depth: number } | null = null;
  const pushLog = (message: string) =>
    items.push({ kind: "log", log: { level: "log", message: [message.slice(0, MAX_LINE_CHARS)], timestamp: now } });
  const flushBlock = () => {
    if (block) pushLog(block.lines.join("\n"));
    block = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").replace(ANSI, "");
    if (pending && /^\s+\S/.test(line)) {
      if (pending.frames.length < 64) pending.frames.push(line);
      continue;
    }
    flush();
    if (block && /^(\s+\S|[}\]])/.test(line)) {
      const trimmed = line.trim();
      block.lines.push(line);
      if (/^[}\]]/.test(trimmed)) block.depth -= 1;
      if (/[{[]$/.test(trimmed)) block.depth += 1;
      if (block.depth <= 0 || block.lines.length >= MAX_BLOCK_LINES) flushBlock();
      continue;
    }
    flushBlock();
    if (!line.trim() || LISTENING.test(line)) continue;
    if (UNCAUGHT.test(line)) {
      pending = { head: line.slice(0, MAX_LINE_CHARS), frames: [] };
      continue;
    }
    if (/[{[]$/.test(line.trimEnd())) block = { lines: [line], depth: 1 };
    else pushLog(line);
  }
  flush();
  flushBlock();
  return items;
}

/** Group sprout items into events: a run of console lines is one event, each exception its own. */
export type SproutEvents = { events: TailEvent[]; overflow: number };
export function sproutEvents(items: SproutItem[], scriptName: string, now: number): SproutEvents {
  const events: TailEvent[] = [];
  let overflow = 0;
  let run: TailLog[] = [];
  const base = { scriptName, eventTimestamp: now, event: null, cpuTime: null, wallTime: 0 };
  const flushRun = () => {
    if (!run.length) return;
    overflow += Math.max(0, run.length - MAX_LOGS_PER_EVENT);
    events.push({ ...base, outcome: "ok", logs: run.slice(0, MAX_LOGS_PER_EVENT), exceptions: [] });
    run = [];
  };
  for (const item of items) {
    if (item.kind === "log") {
      run.push(item.log);
      continue;
    }
    flushRun();
    events.push({ ...base, outcome: "exception", logs: [], exceptions: [item.exception] });
  }
  flushRun();
  return { events, overflow };
}

// --- filters ---------------------------------------------------------------

export type StatusMatcher =
  | { kind: "ok" }
  | { kind: "error" }
  | { kind: "code"; code: number }
  | { kind: "class"; digit: number };
export type TailFilters = {
  status: StatusMatcher[];
  methods: string[];
  /** 0..1; 1 keeps everything. */
  samplingRate: number;
  search: string;
  outcomes: string[];
};
export type TailFilterSummary = {
  status: string[];
  method: string[];
  samplingRate: number;
  search: string;
  outcome: string[];
};

export const NO_FILTERS: TailFilters = { status: [], methods: [], samplingRate: 1, search: "", outcomes: [] };

const METHOD = /^[A-Z]{1,16}$/;
const MAX_SEARCH_CHARS = 200;
const MAX_FILTER_VALUES = 16;

function values(params: URLSearchParams, key: string): string[] {
  const found: string[] = [];
  for (const raw of params.getAll(key)) for (const part of raw.split(",")) if (part.trim()) found.push(part.trim());
  return found;
}

/** Parse query parameters; `error` is a 400 message. */
export function parseTailFilters(params: URLSearchParams): { filters: TailFilters } | { error: string } {
  const status: StatusMatcher[] = [];
  const rawStatus = values(params, "status");
  if (rawStatus.length > MAX_FILTER_VALUES) return { error: "too many status filters" };
  for (const value of rawStatus) {
    const lower = value.toLowerCase();
    if (lower === "ok" || lower === "error") status.push({ kind: lower });
    else if (/^[1-5]xx$/.test(lower)) status.push({ kind: "class", digit: Number(lower[0]) });
    else if (/^[1-5]\d\d$/.test(lower)) status.push({ kind: "code", code: Number(lower) });
    else return { error: `status must be ok, error, a code such as 404, or a class such as 5xx (got "${value}")` };
  }
  const rawMethods = values(params, "method");
  if (rawMethods.length > MAX_FILTER_VALUES) return { error: "too many method filters" };
  const methods = rawMethods.map((method) => method.toUpperCase());
  for (const method of methods) if (!METHOD.test(method)) return { error: `invalid method "${method}"` };
  const rawRate = params.get("sampling-rate") ?? params.get("sampling_rate");
  let samplingRate = 1;
  if (rawRate !== null && rawRate !== "") {
    samplingRate = Number(rawRate);
    if (!Number.isFinite(samplingRate) || samplingRate < 0 || samplingRate > 1)
      return { error: "sampling-rate must be a number from 0 to 1" };
  }
  const search = (params.get("search") ?? "").slice(0, MAX_SEARCH_CHARS);
  const outcomes = values(params, "outcome");
  if (outcomes.length > MAX_FILTER_VALUES) return { error: "too many outcome filters" };
  return {
    filters: {
      status,
      methods,
      samplingRate,
      search: search.toLowerCase(),
      outcomes: outcomes.map((o) => o.toLowerCase()),
    },
  };
}

export function summarizeFilters(filters: TailFilters): TailFilterSummary {
  return {
    status: filters.status.map((s) =>
      s.kind === "code" ? String(s.code) : s.kind === "class" ? `${s.digit}xx` : s.kind,
    ),
    method: filters.methods,
    samplingRate: filters.samplingRate,
    search: filters.search,
    outcome: filters.outcomes,
  };
}

/**
 * `ok` is a response below 400 with outcome ok; `error` is a 5xx or any outcome
 * other than ok/canceled. Console-only events have no response, so they match
 * `ok` or `error` by outcome and never a code or class.
 */
function statusMatches(matcher: StatusMatcher, event: TailEvent): boolean {
  const status = event.event?.response.status;
  switch (matcher.kind) {
    case "ok":
      return event.outcome === "ok" && (status === undefined || status < 400);
    case "error":
      return (status !== undefined && status >= 500) || (event.outcome !== "ok" && event.outcome !== "canceled");
    case "code":
      return status === matcher.code;
    case "class":
      return status !== undefined && Math.floor(status / 100) === matcher.digit;
  }
}

export function eventText(event: TailEvent): string {
  const parts: string[] = [];
  if (event.event) parts.push(event.event.request.url, event.event.request.method);
  for (const log of event.logs) parts.push(...log.message);
  for (const exception of event.exceptions) parts.push(exception.name, exception.message, exception.stack ?? "");
  return parts.join("\n").toLowerCase();
}

/**
 * Apply every filter. Returns the event to emit, or null to drop it. A search
 * narrows a console-only event to the lines (and exceptions) that match, so one
 * grouped event never smuggles unrelated lines past the filter. `random` is
 * injectable for tests.
 */
export function filterEvent(
  event: TailEvent,
  filters: TailFilters,
  random: () => number = Math.random,
): TailEvent | null {
  if (!passes(event, filters, random)) return null;
  if (!filters.search || event.event) return event;
  const logs = event.logs.filter((log) => log.message.join("\n").toLowerCase().includes(filters.search));
  const exceptions = event.exceptions.filter((exception) =>
    `${exception.name}\n${exception.message}\n${exception.stack ?? ""}`.toLowerCase().includes(filters.search),
  );
  return logs.length || exceptions.length ? { ...event, logs, exceptions } : null;
}

export const eventMatches = (event: TailEvent, filters: TailFilters, random: () => number = Math.random): boolean =>
  filterEvent(event, filters, random) !== null;

function passes(event: TailEvent, filters: TailFilters, random: () => number): boolean {
  if (filters.outcomes.length && !filters.outcomes.includes(event.outcome.toLowerCase())) return false;
  if (filters.status.length && !filters.status.some((matcher) => statusMatches(matcher, event))) return false;
  // A console-only event has no method, so a method filter excludes it.
  if (filters.methods.length && !(event.event && filters.methods.includes(event.event.request.method))) return false;
  if (filters.search && !eventText(event).includes(filters.search)) return false;
  if (filters.samplingRate < 1 && random() >= filters.samplingRate) return false;
  return true;
}

// --- stream ----------------------------------------------------------------

export type TailOptions = {
  hostname: string;
  scriptName: string;
  /** Absolute path of the active deployment's sprout output file, or null. Re-read every poll. */
  sproutLog: () => string | null;
  filters: TailFilters;
  signal: AbortSignal;
  pollMs?: number;
  maxMs?: number;
  maxEventsPerSecond?: number;
  random?: () => number;
};

async function readRange(path: string, from: number, to: number): Promise<string> {
  try {
    return await Bun.file(path).slice(from, to).text();
  } catch {
    return "";
  }
}

function sizeOf(path: string): number | null {
  try {
    const file = Bun.file(path);
    const size = file.size;
    return Number.isFinite(size) && size >= 0 ? size : null;
  } catch {
    return null;
  }
}

/** A line-oriented cursor over an append-only file: complete lines only, bounded per poll. */
class Cursor {
  offset = 0;
  constructor(public path: string) {
    this.offset = sizeOf(path) ?? 0;
  }
  /** New complete lines (joined) and bytes skipped because of backlog. */
  async next(): Promise<{ text: string; skipped: number }> {
    const size = sizeOf(this.path);
    if (size === null) return { text: "", skipped: 0 };
    if (size < this.offset) this.offset = 0; // rotated, truncated, or a fresh sprout spawn
    if (size <= this.offset) return { text: "", skipped: 0 };
    let skipped = 0;
    if (size - this.offset > TAIL_BACKLOG_CAP) {
      skipped = size - TAIL_READ_CAP - this.offset;
      this.offset = size - TAIL_READ_CAP;
    }
    const end = Math.min(size, this.offset + TAIL_READ_CAP);
    const chunk = await readRange(this.path, this.offset, end);
    const bytes = Buffer.from(chunk, "utf8");
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      // No newline in a full read window: a single runaway line. Skip it.
      if (end - this.offset >= TAIL_READ_CAP) this.offset = end;
      return { text: "", skipped };
    }
    this.offset += lastNewline + 1;
    return { text: bytes.subarray(0, lastNewline).toString("utf8"), skipped };
  }
}

export function tailEvents(options: TailOptions): Response {
  const encoder = new TextEncoder();
  const pollMs = options.pollMs ?? TAIL_POLL_MS;
  const maxMs = options.maxMs ?? TAIL_MAX_MS;
  const maxPerSecond = options.maxEventsPerSecond ?? MAX_EVENTS_PER_SECOND;
  const random = options.random ?? Math.random;
  const { hostname, scriptName, filters, signal } = options;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const requests = new Cursor(logPath());
      let sprout: Cursor | null = null;
      let sproutPath: string | null = null;
      const initialSprout = options.sproutLog();
      if (initialSprout) {
        sprout = new Cursor(initialSprout);
        sproutPath = initialSprout;
      }

      let closed = false;
      let polling = false;
      let windowStart = Date.now();
      let sentInWindow = 0;
      let droppedInWindow = 0;
      let lastWrite = Date.now();
      const deadline = Date.now() + maxMs;

      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
          lastWrite = Date.now();
        } catch {
          finish();
        }
      };
      const send = (frame: TailFrame) => write(`data: ${JSON.stringify(frame)}\n\n`);
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

      const flushDropped = (reason: "rate" | "backlog", count: number, bytes?: number) => {
        if (count <= 0 && !bytes) return;
        const frame: TailFrame = { type: "dropped", count, reason };
        if (bytes) frame.bytes = bytes;
        send(frame);
      };

      const emit = (batch: TailEvent[]) => {
        for (const event of batch) {
          const kept = filterEvent(event, filters, random);
          if (!kept) continue;
          const now = Date.now();
          if (now - windowStart >= 1000) {
            flushDropped("rate", droppedInWindow);
            droppedInWindow = 0;
            windowStart = now;
            sentInWindow = 0;
          }
          if (sentInWindow >= maxPerSecond) {
            droppedInWindow += 1;
            continue;
          }
          sentInWindow += 1;
          send({ type: "event", event: kept });
        }
      };

      send({ type: "ready", filters: summarizeFilters(filters) });
      const timer = setInterval(() => void poll(), pollMs);
      signal.addEventListener("abort", finish);

      async function poll(): Promise<void> {
        if (closed || polling) return;
        polling = true;
        try {
          if (signal.aborted) return finish();
          if (Date.now() > deadline) {
            flushDropped("rate", droppedInWindow);
            send({ type: "closed", reason: "tail time limit reached" });
            return finish();
          }

          // Follow a redeploy: a different sprout file starts from its beginning.
          const wanted = options.sproutLog();
          if (wanted !== sproutPath) {
            sproutPath = wanted;
            sprout = wanted ? new Cursor(wanted) : null;
            if (sprout) sprout.offset = 0;
          }

          const now = Date.now();
          const batch: TailEvent[] = [];
          let skippedBytes = 0;

          if (sprout) {
            const next = await sprout.next();
            skippedBytes += next.skipped;
            if (next.text) {
              const { events, overflow } = sproutEvents(parseSproutText(next.text, now), scriptName, now);
              droppedInWindow += overflow;
              batch.push(...events);
            }
          }
          const next = await requests.next();
          skippedBytes += next.skipped;
          const records: LogRecord[] = [];
          for (const line of next.text.split("\n")) {
            const record = parseLine(line, hostname);
            if (record) records.push(record);
          }
          records.sort((a, b) => a.at.localeCompare(b.at));
          // Console output predates the completion of the request that printed it.
          batch.push(...records.map((record) => requestEvent(record, scriptName, hostname)));

          if (closed) return;
          emit(batch);
          if (droppedInWindow > 0 && Date.now() - windowStart >= 1000) {
            flushDropped("rate", droppedInWindow);
            droppedInWindow = 0;
            windowStart = Date.now();
            sentInWindow = 0;
          }
          if (skippedBytes > 0) flushDropped("backlog", 0, skippedBytes);
          if (Date.now() - lastWrite >= HEARTBEAT_MS) write(": keepalive\n\n");
        } finally {
          polling = false;
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
