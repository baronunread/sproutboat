export type SourceValidation = { ok: true } | { ok: false; errors: string[] };

const forbidden: Array<[RegExp, string]> = [
  [/^\s*import\s/m, "imports are not supported"],
  [/\brequire\s*\(/, "CommonJS require is not supported"],
  [/(?:\breturn\s+|\bawait\s+|=\s*)fetch\s*\(|\b(WebSocket|XMLHttpRequest)\s*\(/, "outbound networking is not supported"],
  [/\b(process|Bun|Deno|Buffer|node:)\b/, "Node, Bun, and Deno APIs are not supported"],
];

export function validateHttpSyncSource(source: string): SourceValidation {
  const errors: string[] = [];
  if (!/^\s*export\s+default\s*{\s*(?:async\s+)?fetch\s*\(/s.test(source)) {
    errors.push("handler must default-export an object with fetch(request)");
  }
  for (const [pattern, message] of forbidden) if (pattern.test(source)) errors.push(message);
  return errors.length ? { ok: false, errors } : { ok: true };
}
