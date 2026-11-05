/** Request body limits for control's own JSON endpoints. */

export const JSON_BODY_LIMIT = 64 * 1024;
/** Non-multipart bodies larger than this are refused before routing. */
export const BODY_LIMIT = 1024 * 1024;

/** 413 for a declared non-multipart body over BODY_LIMIT; null otherwise. */
export function rejectOversizeBody(request: Request, limit = BODY_LIMIT): Response | null {
  if ((request.headers.get("content-type") || "").toLowerCase().startsWith("multipart/form-data")) return null;
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit)
    return Response.json({ error: "request body too large" }, { status: 413 });
  return null;
}

/** Read a JSON body, stopping at `maxBytes`. Returns null when missing, oversize or malformed. */
export async function readJsonBody(request: Request, maxBytes = JSON_BODY_LIMIT): Promise<JsonInput> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // SAFETY: JSON.parse yields JSON values, which JsonInput describes.
    return JSON.parse(new TextDecoder().decode(bytes)) as JsonInput;
  } catch {
    return null;
  }
}

export type JsonInput =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonInput[]
  | { readonly [key: string]: JsonInput };

/** Like readJsonBody, but always an object: `{}` for a missing, malformed or non-object body. */
export async function readJsonObject(
  request: Request,
  maxBytes = JSON_BODY_LIMIT,
): Promise<{ readonly [key: string]: JsonInput }> {
  const value = await readJsonBody(request, maxBytes);
  // SAFETY: a parsed JSON object, checked to be a non-array object above.
  return value instanceof Object && !Array.isArray(value) ? (value as { readonly [key: string]: JsonInput }) : {};
}
