export type SourceValidation = { ok: true } | { ok: false; errors: string[] };

const alwaysForbidden: Array<[RegExp, string]> = [
  [/^\s*import\s/m, "imports are not supported"],
  [/\brequire\s*\(/, "CommonJS require is not supported"],
  [/\b(WebSocket|XMLHttpRequest)\s*\(/, "WebSocket / XMLHttpRequest are not supported"],
  [/\b(process|Bun|Deno|Buffer|node:)\b/, "Node, Bun, and Deno APIs are not supported"],
];

const fetchWithoutAllowlist: [RegExp, string] = [
  /(?:\breturn\s+|\bawait\s+|=\s*)fetch\s*\(/,
  "outbound networking needs an `outbound` host allowlist in sproutboat.jsonc",
];

export function validateHttpSyncSource(source: string, outboundAllowed = false): SourceValidation {
  const errors: string[] = [];
  // The default export must be an object literal with a `fetch` method. A module
  // may also declare Durable Object classes / helpers before it, so this is not
  // anchored to the start of the file.
  if (!/\bexport\s+default\s*\{/.test(source) || !/\bfetch\s*\(/.test(source)) {
    errors.push("handler must default-export an object with fetch(request)");
  }
  for (const [pattern, message] of alwaysForbidden) if (pattern.test(source)) errors.push(message);
  if (!outboundAllowed && fetchWithoutAllowlist[0].test(source)) errors.push(fetchWithoutAllowlist[1]);
  return errors.length ? { ok: false, errors } : { ok: true };
}
