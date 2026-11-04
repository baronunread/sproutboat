/** Normalisation and comparison of two RunResults, plus markdown rendering. */
import type { HttpObs, Json, Loose, Obs } from "./lib";
import type { Case, RunResult } from "./runner";
import { asRecord, asString, isNumber, isString } from "./json";

const MS_KEYS = new Set(["durationMs", "ttfbMs", "startupMs", "bootMs"]);
const MS_MAX = 120_000;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

export interface Diff {
  /** Observation label, "log", "stdout" or "run". */
  where: string;
  lines: string[];
}

const jsonOf = (value: Json | undefined) => JSON.stringify(value);

function scrubber(ports: Record<string, number>): (text: string) => string {
  const entries = Object.entries(ports).filter(([, port]) => port > 0);
  return (text) => {
    let out = text;
    for (const [name, port] of entries)
      out = out.replace(new RegExp(`(?<![0-9])${port}(?![0-9])`, "g"), `<port:${name}>`);
    return out;
  };
}

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

/** Printable rendering of a body: UTF-8 text when it is valid, else hex of the head; truncated around `at`. */
function preview(bytes: Uint8Array, at = 0): string {
  const buf = Buffer.from(bytes);
  const start = Math.max(0, at - 40);
  const slice = buf.subarray(start, start + 160);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    text = `hex:${slice.toString("hex")}`;
  }
  return `${start > 0 ? "..." : ""}${jsonOf(text)}${start + 160 < buf.length ? "..." : ""} (${buf.length} bytes)`;
}

// ---- HTTP observations ----

/**
 * Framing is not behaviour: when either side streams with `transfer-encoding: chunked`, neither
 * `content-length` nor `transfer-encoding` is compared (the body bytes still are).
 */
const chunkedEither = (a: HttpObs, b: HttpObs) =>
  [a, b].some((o) => o.headers.some(([n, v]) => n === "transfer-encoding" && v.toLowerCase().includes("chunked")));

function headerMap(
  obs: HttpObs,
  scrub: (s: string) => string,
  loose?: Loose,
  dropFraming = false,
): Map<string, string[]> {
  // `connection` / `keep-alive` are transport noise from the fake app's node:http keep-alive; the
  // "hop-by-hop" case compares them explicitly (strictHop).
  const ignore = new Set([
    "date",
    ...(loose?.strictHop ? [] : ["connection", "keep-alive"]),
    ...(loose?.headers ?? []).map((h) => h.toLowerCase()),
  ]);
  const map = new Map<string, string[]>();
  for (const [name, value] of obs.headers) {
    if (ignore.has(name)) continue;
    if (dropFraming && (name === "content-length" || name === "transfer-encoding")) continue;
    map.set(name, [...(map.get(name) ?? []), scrub(value)]);
  }
  // Repeated fields other than set-cookie are equivalent to one comma-joined field.
  for (const [name, values] of map) if (name !== "set-cookie" && values.length > 1) map.set(name, [values.join(", ")]);
  return new Map([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function compareHttp(
  bun: HttpObs,
  rust: HttpObs,
  bunScrub: (s: string) => string,
  rustScrub: (s: string) => string,
): string[] {
  const out: string[] = [];
  const loose = { ...bun.loose, ...rust.loose };
  if (!loose.status && bun.status !== rust.status) out.push(`status: bun ${bun.status}, rust ${rust.status}`);
  if (bun.error !== rust.error) out.push(`transport: bun ${bun.error ?? "ok"}, rust ${rust.error ?? "ok"}`);
  if (bun.hungUp || rust.hungUp) return out;
  const framing = chunkedEither(bun, rust);
  const a = headerMap(bun, bunScrub, loose, framing);
  const b = headerMap(rust, rustScrub, loose, framing);
  const missing: string[] = [];
  const extra: string[] = [];
  const different: string[] = [];
  for (const [name, values] of a) {
    const other = b.get(name);
    if (!other) {
      missing.push(`${name}: ${values.join(" | ")}`);
      continue;
    }
    const tol = loose.tolerance?.[name];
    const same =
      values.length === other.length &&
      values.every(
        (value, i) => value === other[i] || (tol !== undefined && Math.abs(Number(value) - Number(other[i])) <= tol),
      );
    if (!same) different.push(`${name}: bun ${jsonOf(values)} / rust ${jsonOf(other)}`);
  }
  for (const [name, values] of b) if (!a.has(name)) extra.push(`${name}: ${values.join(" | ")}`);
  if (missing.length) out.push(`headers missing in rust (present in bun): ${missing.join("; ")}`);
  if (extra.length) out.push(`headers extra in rust (absent in bun): ${extra.join("; ")}`);
  if (different.length) out.push(`headers different: ${different.join("; ")}`);
  if (bun.complete !== rust.complete) out.push(`body complete: bun ${bun.complete}, rust ${rust.complete}`);
  if (!loose.body) {
    const x = bunScrub(latin1(bun.body));
    const y = rustScrub(latin1(rust.body));
    if (x !== y) {
      let at = 0;
      while (at < x.length && at < y.length && x[at] === y[at]) at++;
      out.push(
        `body differs at byte ${at}: bun ${preview(Buffer.from(x, "latin1"), at)} / rust ${preview(Buffer.from(y, "latin1"), at)}`,
      );
    }
  }
  return out;
}

function compareObs(
  bunObs: Obs[],
  rustObs: Obs[],
  bunPorts: Record<string, number>,
  rustPorts: Record<string, number>,
): Diff[] {
  const diffs: Diff[] = [];
  const bunScrub = scrubber(bunPorts);
  const rustScrub = scrubber(rustPorts);
  const count = Math.max(bunObs.length, rustObs.length);
  for (let i = 0; i < count; i++) {
    const a = bunObs[i];
    const b = rustObs[i];
    if (!a || !b) {
      diffs.push({ where: (a ?? b)!.label, lines: [`observation only present in ${a ? "bun" : "rust"}`] });
      continue;
    }
    if (a.label !== b.label || a.kind !== b.kind) {
      diffs.push({ where: `#${i}`, lines: [`observation order differs: bun ${a.label}, rust ${b.label}`] });
      continue;
    }
    let lines: string[] = [];
    if (a.kind === "http" && b.kind === "http") lines = compareHttp(a, b, bunScrub, rustScrub);
    else if (a.kind === "note" && b.kind === "note") {
      const x = bunScrub(jsonOf(a.value));
      const y = rustScrub(jsonOf(b.value));
      if (x !== y) lines = [`value: bun ${x} / rust ${y}`];
    }
    if (lines.length) diffs.push({ where: a.label, lines });
  }
  return diffs;
}

// ---- request log ----

type Pair = [string, Json];

/** Ordered key/value pairs of one event with the timing fields reduced to presence/null-ness. */
function normaliseLog(event: Json, run: RunResult, scrub: (s: string) => string): Pair[] {
  const record = asRecord(event);
  if (record === null) return [["<not an object>", scrub(jsonOf(event))]];
  const pairs: Pair[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === "at") {
      const at = asString(value);
      const ok =
        at !== null && ISO.test(at) && Date.parse(at) >= run.startedAt - 2000 && Date.parse(at) <= run.endedAt + 5000;
      pairs.push([key, ok ? "<iso-time>" : `<bad at: ${jsonOf(value)}>`]);
    } else if (MS_KEYS.has(key)) {
      if (value === null) pairs.push([key, null]);
      else if (isNumber(value) && Number.isFinite(value) && value >= 0 && value <= MS_MAX) pairs.push([key, "<ms>"]);
      else pairs.push([key, `<ms out of range or wrong type: ${jsonOf(value)}>`]);
    } else pairs.push([key, isString(value) ? scrub(value) : value]);
  }
  return pairs;
}

const pairsText = (pairs: Pair[]) => `{${pairs.map(([k, v]) => `${jsonOf(k)}:${jsonOf(v)}`).join(",")}}`;

function diffEvent(bun: Pair[], rust: Pair[]): string[] {
  const lines: string[] = [];
  const bk = bun.map(([k]) => k);
  const rk = rust.map(([k]) => k);
  const missing = bk.filter((k) => !rk.includes(k));
  const extra = rk.filter((k) => !bk.includes(k));
  if (missing.length) lines.push(`fields missing in rust: ${missing.join(", ")}`);
  if (extra.length) lines.push(`fields extra in rust: ${extra.join(", ")}`);
  const common = bk.filter((k) => rk.includes(k));
  if (!missing.length && !extra.length && bk.join() !== rk.join())
    lines.push(`field order: bun [${bk.join(", ")}] / rust [${rk.join(", ")}]`);
  else if (bk.filter((k) => common.includes(k)).join() !== rk.filter((k) => common.includes(k)).join())
    lines.push(`field order: bun [${bk.join(", ")}] / rust [${rk.join(", ")}]`);
  for (const key of common) {
    const x = bun.find(([k]) => k === key)![1];
    const y = rust.find(([k]) => k === key)![1];
    if (jsonOf(x) !== jsonOf(y))
      lines.push(`${key}: bun ${jsonOf(x)} (${typeOf(x)}) / rust ${jsonOf(y)} (${typeOf(y)})`);
  }
  return lines;
}

function typeOf(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isString(value)) return "string";
  if (isNumber(value)) return "number";
  return value === true || value === false ? "boolean" : "object";
}

function compareLogs(
  mode: "ordered" | "sorted",
  bun: RunResult,
  rust: RunResult,
  bunScrub: (s: string) => string,
  rustScrub: (s: string) => string,
): Diff[] {
  let a = bun.logs.map((e) => normaliseLog(e, bun, bunScrub));
  // Intentional (docs section 13, item 6): Rust adds a second line when a relayed WebSocket closes.
  // The intentional-more-events-logged case asserts it; every other case compares the rest.
  let b = rust.logs
    .filter((e) => {
      const event = asRecord(e);
      return event === null || !("closedBy" in event);
    })
    .map((e) => normaliseLog(e, rust, rustScrub));
  if (mode === "sorted") {
    a = a.sort((x, y) => (pairsText(x) < pairsText(y) ? -1 : 1));
    b = b.sort((x, y) => (pairsText(x) < pairsText(y) ? -1 : 1));
  }
  const lines: string[] = [];
  const count = Math.max(a.length, b.length);
  if (a.length !== b.length) lines.push(`log event count: bun ${a.length}, rust ${b.length}`);
  for (let i = 0; i < count; i++) {
    if (!a[i] || !b[i]) {
      lines.push(`event #${i} only in ${a[i] ? "bun" : "rust"}: ${pairsText((a[i] ?? b[i])!)}`);
      continue;
    }
    const d = diffEvent(a[i], b[i]);
    if (d.length) lines.push(`event #${i} ${pairsText(a[i])}`, ...d.map((line) => `    ${line}`));
  }
  return lines.length ? [{ where: "log", lines }] : [];
}

// ---- whole case ----

export function compareRuns(c: Case, bun: RunResult, rust: RunResult): Diff[] {
  const diffs: Diff[] = [];
  if (bun.error || rust.error) {
    if (bun.error !== rust.error)
      diffs.push({ where: "run", lines: [`error: bun ${bun.error ?? "none"} / rust ${rust.error ?? "none"}`] });
    else diffs.push({ where: "run", lines: [`both sides failed identically: ${bun.error}`] });
  }
  if (c.expectStartFailure) {
    const x = bun.startFailure;
    const y = rust.startFailure;
    const summary = (f: RunResult["startFailure"]) => (f ? `exit ${f.code === 0 ? "0" : "non-zero"}` : "started");
    if (summary(x) !== summary(y)) diffs.push({ where: "startup", lines: [`bun ${summary(x)} / rust ${summary(y)}`] });
  }
  diffs.push(...compareObs(bun.obs, rust.obs, bun.ports, rust.ports));
  const bunScrub = scrubber(bun.ports);
  const rustScrub = scrubber(rust.ports);
  if (c.logs !== "off") diffs.push(...compareLogs(c.logs ?? "ordered", bun, rust, bunScrub, rustScrub));
  if (c.stdout) {
    const x = bun.stdout.map(bunScrub);
    const y = rust.stdout.map(rustScrub);
    if (jsonOf(x) !== jsonOf(y)) diffs.push({ where: "stdout", lines: [`bun ${jsonOf(x)} / rust ${jsonOf(y)}`] });
  }
  return diffs;
}

// ---- rendering ----

export function renderObs(obs: Obs, ports: Record<string, number>): string[] {
  const scrub = scrubber(ports);
  if (obs.kind === "note") return [`- note \`${obs.label}\`: \`${scrub(jsonOf(obs.value))}\``];
  const headers = obs.headers.filter(([name]) => name !== "date").map(([n, v]) => `${n}: ${scrub(v)}`);
  const lines = [
    `- request \`${obs.label}\` -> ${obs.status}${obs.error ? ` (${obs.error})` : ""}${obs.complete ? "" : " [incomplete]"}${obs.hungUp ? " [hung up]" : ""}`,
  ];
  if (headers.length) lines.push(`  - headers: \`${headers.join(" | ")}\``);
  lines.push(`  - body: ${scrub(preview(obs.body)).replace(/\n/g, "\\n")}`);
  return lines;
}

export function renderLogs(run: RunResult): string[] {
  const scrub = scrubber(run.ports);
  return run.logs.map((event) => `  ${pairsText(normaliseLog(event, run, scrub))}`);
}
