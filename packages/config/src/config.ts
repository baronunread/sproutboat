export const CONFIG_SCHEMA_VERSION = 1;

const slugPattern = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

export type PorfferConfig = {
  $schema?: string;
  name: string;
  main: string;
  compatibility_date: string;
  vars?: Record<string, string>;
};

export type ConfigValidation =
  | { ok: true; value: PorfferConfig }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProjectSlug(value: string): boolean {
  return slugPattern.test(value);
}

export function validateConfig(value: unknown): ConfigValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["config must be an object"] };
  const allowed = new Set(["$schema", "name", "main", "compatibility_date", "vars"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`unsupported config field: ${key}`);
  if (typeof value.name !== "string" || !isProjectSlug(value.name)) {
    errors.push("name must be a 3–32 character lowercase slug");
  }
  if (typeof value.main !== "string" || !value.main.startsWith("src/") || value.main.includes("..")) {
    errors.push("main must be a relative entry point under src/");
  }
  if (typeof value.compatibility_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.compatibility_date)) {
    errors.push("compatibility_date must use YYYY-MM-DD");
  }
  if (value.$schema !== undefined && typeof value.$schema !== "string") errors.push("$schema must be a string");
  if (value.vars !== undefined) {
    if (!isRecord(value.vars)) errors.push("vars must be an object of plain string values");
    else for (const [key, item] of Object.entries(value.vars)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof item !== "string") errors.push(`vars.${key} must be a string environment name`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: value as PorfferConfig };
}

export function parseConfig(source: string): ConfigValidation {
  try {
    // Config files intentionally support comments and trailing commas, but not
    // arbitrary JavaScript expressions.
    let json = "";
    let quoted = false;
    for (let index = 0; index < source.length; index++) {
      const character = source[index];
      if (character === '"' && source[index - 1] !== "\\") quoted = !quoted;
      if (!quoted && character === "/" && source[index + 1] === "/") {
        index = source.indexOf("\n", index);
        if (index < 0) break;
        json += "\n";
      } else if (!quoted && character === "/" && source[index + 1] === "*") {
        index = source.indexOf("*/", index + 2);
        if (index < 0) throw new SyntaxError("unterminated block comment");
        index++;
      } else json += character;
    }
    json = json.replace(/,\s*([}\]])/g, "$1");
    return validateConfig(JSON.parse(json));
  } catch (error) {
    return { ok: false, errors: [`invalid porffer.jsonc: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
