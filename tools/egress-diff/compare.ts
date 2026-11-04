/** Normalisation and comparison of two services' results. */
import { asRecord, isString } from "./json";
import type { Json, JsonObject } from "./lib";

/** Headers that are framing, not contract (and `date`, which is never equal). */
const HOP = new Set(["date", "connection", "keep-alive"]);

function normHeaders(headers: JsonObject, drop: string[]): JsonObject {
  const entries: Array<[string, Json]> = [];
  for (const [name, value] of Object.entries(headers)) {
    if (HOP.has(name) || drop.includes(name)) continue;
    const text = String(value);
    entries.push([name, name === "user-agent" && text.startsWith("Bun/") ? "Bun/*" : text]);
  }
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The result with header framing removed and transport-error wording replaced. */
export function norm(value: Json | undefined, drop: string[]): Json {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => norm(v, drop));
  const record = asRecord(value);
  if (record === null) return value;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(record)) {
    const headers = k === "headers" ? asRecord(v) : null;
    if (k === "error" && isString(v) && record.status === 0) out[k] = "<client error>";
    else if (headers !== null) out[k] = normHeaders(headers, drop);
    else out[k] = norm(v, drop);
  }
  return out;
}

/** One line per leaf that differs, `path: ts=... rust=...`. */
export function diffPaths(a: Json | undefined, b: Json | undefined, path = ""): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const [ra, rb] = [asRecord(a), asRecord(b)];
  if (ra !== null && rb !== null) {
    const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
    return [...keys].flatMap((k) => diffPaths(ra[k], rb[k], `${path}.${k}`));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    return Array.from({ length: n }, (_, i) => diffPaths(a[i], b[i], `${path}.${i}`)).flat();
  }
  return [`${path}: ts=${JSON.stringify(a)} rust=${JSON.stringify(b)}`];
}
