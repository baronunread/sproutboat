const slugPattern = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

export type SproutboatConfig = {
  $schema?: string;
  name: string;
  main: string;
  compatibility_date: string;
  vars?: Record<string, string>;
  /** KV namespace binding names, exposed as `env.<NAME>`. */
  kv_namespaces?: string[];
  /** Secret binding names, exposed as `env.<NAME>` (value fetched at use). */
  secrets?: string[];
  /** Hostnames the worker's `fetch()` may reach (exact host match). */
  outbound?: string[];
  /** D1 (SQLite) database binding names, exposed as `env.<NAME>`. */
  d1_databases?: string[];
  /** R2 (object storage) bucket binding names, exposed as `env.<NAME>`. */
  r2_buckets?: string[];
  /** Queue producer binding names, exposed as `env.<NAME>.send()`. A `queue(batch)` handler consumes them. */
  queues?: string[];
  /** Analytics Engine dataset binding names, exposed as `env.<NAME>.writeDataPoint()`. */
  analytics_engine_datasets?: string[];
  /** Durable Object bindings: `{ BINDING_NAME: "ClassName" }`. The class is defined in the handler module. */
  durable_objects?: Record<string, string>;
  /** Scheduled triggers, e.g. `{ "crons": ["0 3 * * *"] }` — a `scheduled(event)` handler runs on each tick. */
  triggers?: { crons?: string[] };
  /** Static assets: a directory served edge-first (like Cloudflare), optionally bound as `env.<BINDING>.fetch(request)`. */
  assets?: AssetsConfig;
};

export type AssetsConfig = {
  /** Project-relative directory of files to publish with the artifact. */
  directory: string;
  /** Optional binding name for `env.<BINDING>.fetch(request)`. */
  binding?: string;
  /** What to serve when a request matches no file (applied by the broker on `env.<BINDING>.fetch`). */
  not_found_handling?: "none" | "single-page-application" | "404-page";
  /** `true` = run the worker before serving any asset; string[] = selective route patterns (`!` negates). */
  run_sprout_first?: boolean | string[];
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
  const allowed = new Set([
    "$schema", "name", "main", "compatibility_date", "vars",
    "kv_namespaces", "secrets", "outbound", "d1_databases", "r2_buckets",
    "queues", "analytics_engine_datasets", "durable_objects", "triggers", "assets",
  ]);
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
  const bindingName = /^[A-Z][A-Z0-9_]*$/;
  const hostPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
  const stringArray = (
    field: "kv_namespaces" | "secrets" | "outbound" | "d1_databases" | "r2_buckets" | "queues" | "analytics_engine_datasets",
    item: RegExp,
    label: string,
  ): string[] | undefined => {
    if (value[field] === undefined) return undefined;
    const raw = value[field];
    if (!Array.isArray(raw)) {
      errors.push(`${field} must be an array of ${label}`);
      return undefined;
    }
    const out: string[] = [];
    for (const entry of raw) {
      if (!isString(entry) || !item.test(entry)) errors.push(`${field} entries must be ${label}`);
      else out.push(entry);
    }
    return out;
  };
  const kv_namespaces = stringArray("kv_namespaces", bindingName, "binding names (UPPER_SNAKE_CASE)");
  const secrets = stringArray("secrets", bindingName, "binding names (UPPER_SNAKE_CASE)");
  const outbound = stringArray("outbound", hostPattern, "hostnames");
  const d1_databases = stringArray("d1_databases", bindingName, "binding names (UPPER_SNAKE_CASE)");
  const r2_buckets = stringArray("r2_buckets", bindingName, "binding names (UPPER_SNAKE_CASE)");
  const queues = stringArray("queues", bindingName, "binding names (UPPER_SNAKE_CASE)");
  const analytics_engine_datasets = stringArray("analytics_engine_datasets", bindingName, "binding names (UPPER_SNAKE_CASE)");

  let durable_objects: Record<string, string> | undefined;
  if (value.durable_objects !== undefined) {
    if (!isRecord(value.durable_objects)) {
      errors.push("durable_objects must be an object of { BINDING_NAME: \"ClassName\" }");
    } else {
      durable_objects = {};
      for (const [binding, className] of Object.entries(value.durable_objects)) {
        if (!bindingName.test(binding) || !isString(className) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(className)) {
          errors.push(`durable_objects.${binding} must map an UPPER_SNAKE binding to a class identifier`);
        } else durable_objects[binding] = className;
      }
    }
  }

  let triggers: { crons?: string[] } | undefined;
  if (value.triggers !== undefined) {
    if (!isRecord(value.triggers)) {
      errors.push("triggers must be an object with an optional `crons` array");
    } else {
      triggers = {};
      if (value.triggers.crons !== undefined) {
        const raw = value.triggers.crons;
        if (!Array.isArray(raw) || raw.some((c) => !isString(c) || c.trim().split(/\s+/).length !== 5)) {
          errors.push("triggers.crons must be an array of 5-field cron expressions");
        } else triggers.crons = raw.map((c) => String(c).trim());
      }
    }
  }

  let assets: AssetsConfig | undefined;
  if (value.assets !== undefined) {
    if (!isRecord(value.assets)) {
      errors.push("assets must be an object with a `directory`");
    } else {
      const raw = value.assets;
      const dir = isString(raw.directory) && raw.directory.length > 0 && !raw.directory.includes("..")
        ? raw.directory.replace(/^\.\//, "").replace(/\/$/, "")
        : null;
      if (dir === null) errors.push("assets.directory must be a project-relative path");
      const binding = raw.binding === undefined ? undefined
        : isString(raw.binding) && bindingName.test(raw.binding) ? raw.binding : null;
      if (binding === null) errors.push("assets.binding must be a binding name (UPPER_SNAKE_CASE)");
      const nfh = raw.not_found_handling === "none" || raw.not_found_handling === "single-page-application"
        || raw.not_found_handling === "404-page" ? raw.not_found_handling : undefined;
      if (raw.not_found_handling !== undefined && nfh === undefined) {
        errors.push('assets.not_found_handling must be "none", "single-page-application", or "404-page"');
      }
      let rwf: boolean | string[] | undefined;
      const rwfRaw = raw.run_sprout_first;
      if (rwfRaw === true || rwfRaw === false) rwf = rwfRaw;
      else if (Array.isArray(rwfRaw) && rwfRaw.every((p) => isString(p) && /^!?\//.test(p))) {
        rwf = rwfRaw.map((p) => String(p));
      } else if (rwfRaw !== undefined) {
        errors.push("assets.run_sprout_first must be a boolean or an array of route patterns");
      }
      if (dir !== null && binding !== null) {
        assets = { directory: dir };
        if (binding !== undefined) assets.binding = binding;
        if (nfh !== undefined) assets.not_found_handling = nfh;
        if (rwf !== undefined) assets.run_sprout_first = rwf;
      }
    }
  }

  const bindingSlots = [
    ...(kv_namespaces ?? []), ...(secrets ?? []), ...(d1_databases ?? []), ...(r2_buckets ?? []),
    ...(queues ?? []), ...(analytics_engine_datasets ?? []), ...Object.keys(durable_objects ?? {}), ...Object.keys(vars ?? {}),
    ...(assets?.binding ? [assets.binding] : []),
  ];
  if (new Set(bindingSlots).size !== bindingSlots.length) errors.push("vars and binding names must not collide");

  if (errors.length || name === null || main === null || compatibility_date === null || schema === null) return { ok: false, errors };
  const config: SproutboatConfig = { name, main, compatibility_date };
  if ("$schema" in value) config.$schema = schema;
  if ("vars" in value) config.vars = vars;
  if ("kv_namespaces" in value) config.kv_namespaces = kv_namespaces;
  if ("secrets" in value) config.secrets = secrets;
  if ("outbound" in value) config.outbound = outbound;
  if ("d1_databases" in value) config.d1_databases = d1_databases;
  if ("r2_buckets" in value) config.r2_buckets = r2_buckets;
  if ("queues" in value) config.queues = queues;
  if ("analytics_engine_datasets" in value) config.analytics_engine_datasets = analytics_engine_datasets;
  if ("durable_objects" in value) config.durable_objects = durable_objects;
  if ("triggers" in value) config.triggers = triggers;
  if ("assets" in value) config.assets = assets;
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
