const slugPattern = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

export type SproutboatConfig = {
  $schema?: string;
  name: string;
  main: string;
  compatibility_date: string;
  vars?: Record<string, string>;
};

export type ConfigValidation =
  | { ok: true; value: SproutboatConfig }
  | { ok: false; errors: string[] };

type JsonValue = string | number | boolean | null | ConfigJsonObject | JsonValue[];

interface ConfigJsonObject {
  readonly [key: string]: JsonValue;
}

type ConfigInput = JsonValue | undefined;

function isRecord(value: ConfigInput): value is ConfigJsonObject {
  return value !== null && Object(value) === value && !Array.isArray(value)
    && !(value instanceof Function);
}

function isString(value: ConfigInput): value is string {
  return Object(value) !== value && value === String(value);
}

function isProjectSlug(value: string): boolean {
  return slugPattern.test(value);
}

function validateConfig(value: ConfigInput): ConfigValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["config must be an object"] };
  const allowed = new Set(["$schema", "name", "main", "compatibility_date", "vars"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`unsupported config field: ${key}`);
  const name = isString(value.name) && isProjectSlug(value.name) ? value.name : null;
  if (name === null) {
    errors.push("name must be a 3–32 character lowercase slug");
  }
  const main = isString(value.main) && value.main.startsWith("src/") && !value.main.includes("..") ? value.main : null;
  if (main === null) {
    errors.push("main must be a relative entry point under src/");
  }
  const compatibility_date = isString(value.compatibility_date) && /^\d{4}-\d{2}-\d{2}$/.test(value.compatibility_date) ? value.compatibility_date : null;
  if (compatibility_date === null) {
    errors.push("compatibility_date must use YYYY-MM-DD");
  }
  const schema = value.$schema === undefined ? undefined : isString(value.$schema) ? value.$schema : null;
  if (schema === null) errors.push("$schema must be a string");
  let vars: Record<string, string> | undefined;
  if (value.vars !== undefined) {
    if (!isRecord(value.vars)) errors.push("vars must be an object of plain string values");
    else {
      vars = {};
      for (const [key, item] of Object.entries(value.vars)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !isString(item)) errors.push(`vars.${key} must be a string environment name`);
        else vars[key] = item;
      }
    }
  }
  if (errors.length || name === null || main === null || compatibility_date === null || schema === null) return { ok: false, errors };
  const config: SproutboatConfig = { name, main, compatibility_date };
  if ("$schema" in value) config.$schema = schema;
  if ("vars" in value) config.vars = vars;
  return { ok: true, value: config };
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
    return { ok: false, errors: [`invalid sproutboat.jsonc: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
