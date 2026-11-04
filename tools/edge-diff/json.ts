/** Guards for the `Json` value type: validate once at the boundary, then branch on the typed result. */
import type { Json } from "./lib";

export type JsonObject = { [key: string]: Json };

/** A string primitive: `String(x) === x` holds only when `x` already is one. */
export function isString(value: Json | undefined): value is string {
  return String(value) === value;
}

/** A finite or non-finite number primitive (NaN excluded): `Number(x) === x` holds only for numbers. */
export function isNumber(value: Json | undefined): value is number {
  return Number(value) === value;
}

/** A plain JSON object (not null, not an array). */
export function asRecord(value: Json | undefined): JsonObject | null {
  if (value === null || value === undefined || Array.isArray(value)) return null;
  return value instanceof Object ? value : null;
}

export function asString(value: Json | undefined): string | null {
  return isString(value) ? value : null;
}
