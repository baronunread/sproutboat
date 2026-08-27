export const ABI_VERSION = "abi-v1";
export const MAX_FRAME_BYTES = 1_048_576;
export const MAX_BODY_BYTES = 262_144;
export const MAX_HEADERS = 64;

export type HeaderMap = Record<string, string>;

export type AbiRequest = {
  version: "abi-v1";
  kind: "request";
  method: string;
  url: string;
  headers: HeaderMap;
  body: string;
};

export type AbiResponse = {
  version: "abi-v1";
  kind: "response";
  status: number;
  headers: HeaderMap;
  body: string;
};

export type AbiMessage = AbiRequest | AbiResponse;

function isHeaderMap(value: unknown): value is HeaderMap {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length <= MAX_HEADERS
    && Object.entries(value).every(([key, item]) => /^[a-z0-9-]+$/i.test(key) && typeof item === "string");
}

export function validateAbiMessage(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["ABI message must be an object"];
  const message = value as Record<string, unknown>;
  const errors: string[] = [];
  if (message.version !== ABI_VERSION) errors.push("unsupported ABI version");
  if (message.kind !== "request" && message.kind !== "response") errors.push("message kind must be request or response");
  if (!isHeaderMap(message.headers)) errors.push("headers must contain at most 64 string values");
  if (typeof message.body !== "string" || new TextEncoder().encode(message.body).byteLength > MAX_BODY_BYTES) errors.push("body exceeds ABI limit");
  if (message.kind === "request") {
    if (typeof message.method !== "string" || !/^[A-Z]+$/.test(message.method)) errors.push("request method must be uppercase ASCII");
    if (typeof message.url !== "string" || !/^https?:\/\//.test(message.url)) errors.push("request url must be absolute http(s)");
  }
  if (message.kind === "response" && (!Number.isInteger(message.status) || (message.status as number) < 100 || (message.status as number) > 599)) errors.push("response status must be 100–599");
  return errors;
}

export function encodeFrame(message: AbiMessage): Uint8Array {
  const errors = validateAbiMessage(message);
  if (errors.length) throw new TypeError(errors.join("; "));
  const payload = new TextEncoder().encode(JSON.stringify(message));
  if (payload.byteLength > MAX_FRAME_BYTES) throw new RangeError("ABI frame exceeds maximum size");
  const frame = new Uint8Array(payload.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

export function decodeFrame(frame: Uint8Array): AbiMessage {
  if (frame.byteLength < 4) throw new TypeError("ABI frame is truncated");
  const payloadSize = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
  if (payloadSize > MAX_FRAME_BYTES || payloadSize !== frame.byteLength - 4) throw new TypeError("invalid ABI frame length");
  const message = JSON.parse(new TextDecoder().decode(frame.subarray(4))) as AbiMessage;
  const errors = validateAbiMessage(message);
  if (errors.length) throw new TypeError(errors.join("; "));
  return message;
}
