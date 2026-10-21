// The JSON a suite run writes (driver.ts) and reads back (compare.ts), with parsers for
// both the caller's replies and a saved run.

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

type JsonInput = JsonValue | undefined;

export function isObject(value: JsonInput): value is JsonObject {
  return value !== null && Object(value) === value && !Array.isArray(value);
}

export function isString(value: JsonInput): value is string {
  return Object(value) !== value && value === String(value);
}

function isNumber(value: JsonInput): value is number {
  return Object(value) !== value && value === Number(value);
}

/** One HTTP exchange with the caller, timed by the driver. Status 0 means no response. */
export interface Reply {
  readonly status: number;
  readonly ms: number;
  readonly text: string;
}

/** What one case observed: the caller's HTTP status and its JSON report (or raw text). */
export interface CaseResult {
  readonly status: number;
  readonly value: JsonValue;
}

export interface Reliability {
  readonly responsiveDuringCall: { pingMs: number; pingStatus: number; slowMs: number; slowStatus: number };
  readonly concurrent8x500ms: { totalMs: number; statuses: number[] };
  readonly selfRecursion: Reply;
  readonly mutualRecursion: Reply;
  readonly calleeNeverAnswers: Reply;
}

export interface SuiteRun {
  readonly base: string;
  readonly host: string | null;
  readonly cases: ReadonlyMap<string, CaseResult>;
  readonly reliability: Reliability;
}

/** Parses JSON text, keeping text that is not JSON as a string. */
export function parseJson(text: string): JsonValue {
  try {
    const value: JsonValue = JSON.parse(text);
    return value;
  } catch {
    return text;
  }
}

/** The caller's `/cases` reply: a JSON array of case names. */
export function parseCaseNames(text: string): string[] {
  const value = parseJson(text);
  if (!Array.isArray(value) || !value.every(isString))
    throw new Error(`/cases did not return a list of names: ${text.slice(0, 120)}`);
  return value.filter(isString);
}

function field(object: JsonObject, key: string, where: string): JsonValue {
  const value = object[key];
  if (value === undefined) throw new Error(`${where}: missing ${key}`);
  return value;
}

function num(object: JsonObject, key: string, where: string): number {
  const value = field(object, key, where);
  if (!isNumber(value)) throw new Error(`${where}.${key}: not a number`);
  return value;
}

function text(object: JsonObject, key: string, where: string): string {
  const value = field(object, key, where);
  if (!isString(value)) throw new Error(`${where}.${key}: not a string`);
  return value;
}

function obj(object: JsonObject, key: string, where: string): JsonObject {
  const value = field(object, key, where);
  if (!isObject(value)) throw new Error(`${where}.${key}: not an object`);
  return value;
}

function reply(object: JsonObject, key: string): Reply {
  const r = obj(object, key, "reliability");
  return { status: num(r, "status", key), ms: num(r, "ms", key), text: text(r, "text", key) };
}

/** A run file written by driver.ts. */
export function parseRun(source: string, where: string): SuiteRun {
  const root = parseJson(source);
  if (!isObject(root)) throw new Error(`${where}: not a suite run`);
  const cases = new Map<string, CaseResult>();
  for (const [name, entry] of Object.entries(obj(root, "cases", where))) {
    if (!isObject(entry)) throw new Error(`${where}: case ${name} is not an object`);
    cases.set(name, { status: num(entry, "status", name), value: field(entry, "value", name) });
  }
  const rel = obj(root, "reliability", where);
  const during = obj(rel, "responsiveDuringCall", "reliability");
  const concurrent = obj(rel, "concurrent8x500ms", "reliability");
  const statuses = field(concurrent, "statuses", "concurrent8x500ms");
  if (!Array.isArray(statuses) || !statuses.every(isNumber)) throw new Error(`${where}: concurrent8x500ms.statuses`);
  const host = root.host ?? null;
  return {
    base: text(root, "base", where),
    host: isString(host) ? host : null,
    cases,
    reliability: {
      responsiveDuringCall: {
        pingMs: num(during, "pingMs", "responsiveDuringCall"),
        pingStatus: num(during, "pingStatus", "responsiveDuringCall"),
        slowMs: num(during, "slowMs", "responsiveDuringCall"),
        slowStatus: num(during, "slowStatus", "responsiveDuringCall"),
      },
      concurrent8x500ms: {
        totalMs: num(concurrent, "totalMs", "concurrent8x500ms"),
        statuses: statuses.filter(isNumber),
      },
      selfRecursion: reply(rel, "selfRecursion"),
      mutualRecursion: reply(rel, "mutualRecursion"),
      calleeNeverAnswers: reply(rel, "calleeNeverAnswers"),
    },
  };
}

/** The JSON form of a run, as written to disk. */
export function serializeRun(run: SuiteRun): string {
  return JSON.stringify({ ...run, cases: Object.fromEntries(run.cases) }, null, 2);
}
