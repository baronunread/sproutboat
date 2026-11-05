import { Database } from "bun:sqlite";

/**
 * A screen for the SQL the broker runs on a tenant's behalf.
 *
 * Tenant SQL reaches SQLite through the broker's own connections, so it can use
 * statements that D1 does not offer: attaching another file, writing the schema
 * table, listing loaded modules. This refuses those before SQLite sees them.
 *
 * It is a token-level screen, not a parser: it skips comments, string literals and
 * quoted identifiers, splits on top-level semicolons, and looks at the first
 * keyword of each statement. It is paired with `PRAGMA trusted_schema = OFF`.
 */

export class SqliteGuardError extends Error {
  constructor(readonly kind: string) {
    super(`${kind} is not allowed`);
    this.name = "SqliteGuardError";
  }
}

/** The PRAGMAs Cloudflare D1 allows. */
const D1_PRAGMAS = [
  "table_list",
  "table_info",
  "table_xinfo",
  "index_list",
  "index_info",
  "index_xinfo",
  "quick_check",
  "foreign_key_list",
  "foreign_key_check",
  "foreign_keys",
  "defer_foreign_keys",
  "case_sensitive_like",
  "ignore_check_constraints",
  "legacy_alter_table",
  "recursive_triggers",
  "reverse_unordered_selects",
  "optimize",
];

/** What the broker (@sproutboat/wire) issues itself, plus the one this guard sets. */
const BROKER_PRAGMAS = [
  "journal_mode",
  "synchronous",
  "busy_timeout",
  "integrity_check",
  "user_version",
  "wal_checkpoint",
  "trusted_schema",
];

const ALLOWED_PRAGMAS = new Set([...D1_PRAGMAS, ...BROKER_PRAGMAS]);

type Token = { kind: "word" | "punct" | "other"; text: string };

/** The statements of `sql`, each as its significant tokens (comments and whitespace dropped). */
function statements(sql: string): Token[][] {
  const out: Token[][] = [[]];
  const n = sql.length;
  let i = 0;
  const push = (token: Token) => out[out.length - 1]!.push(token);
  while (i < n) {
    const c = sql[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? n : end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (; j < n; j++) {
        if (sql[j] !== close) continue;
        // A doubled quote is an escaped quote (not for [brackets]).
        if (close !== "]" && sql[j + 1] === close) {
          j++;
          continue;
        }
        break;
      }
      // An identifier in quotes still names something: keep it as a word. A string is opaque.
      if (c === "'") push({ kind: "other", text: "'" });
      else
        push({
          kind: "word",
          text: sql
            .slice(i + 1, j)
            .replaceAll(close + close, close)
            .toLowerCase(),
        });
      i = j + 1;
    } else if (c === ";") {
      out.push([]);
      i++;
    } else if (/[A-Za-z0-9_$\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j]!)) j++;
      push({ kind: "word", text: sql.slice(i, j).toLowerCase() });
      i = j;
    } else {
      push({ kind: "punct", text: c });
      i++;
    }
  }
  return out;
}

/** Throws a `SqliteGuardError` if any statement in `sql` is one tenant SQL may not run. */
export function screenSql(sql: string): void {
  for (const tokens of statements(sql)) {
    let at = 0;
    if (tokens[at]?.text === "explain" && tokens[at]?.kind === "word") {
      at++;
      if (tokens[at]?.text === "query" && tokens[at + 1]?.text === "plan") at += 2;
    }
    const first = tokens[at];
    if (!first || first.kind !== "word") continue;
    switch (first.text) {
      case "attach":
      case "detach":
        throw new SqliteGuardError(first.text.toUpperCase());
      case "vacuum": {
        // `VACUUM [schema] INTO file`
        const rest = tokens.slice(at + 1);
        if (rest.some((t) => t.kind === "word" && t.text === "into")) throw new SqliteGuardError("VACUUM INTO");
        break;
      }
      case "pragma": {
        // `PRAGMA [schema.]name [= value | (value)]`
        let name = tokens[at + 1];
        if (tokens[at + 2]?.text === "." && tokens[at + 3]) name = tokens[at + 3];
        if (!name || name.kind !== "word" || !ALLOWED_PRAGMAS.has(name.text))
          throw new SqliteGuardError(`PRAGMA ${name?.text ?? ""}`.trim());
        break;
      }
    }
  }
}

const guarded = new WeakSet<Database>();
let installed = false;

/**
 * The broker's own backup is `db.run("VACUUM INTO ?", [dest])` with a destination it built itself. Tenant SQL
 * never reaches `run` (it goes through `exec`, `query` and `prepare`), so that one statement passes there only.
 */
const BROKER_BACKUP = "VACUUM INTO ?";

/**
 * Screen every SQL string any `bun:sqlite` Database in this process runs, and turn `trusted_schema` off on each.
 * Process-wide, so it covers the broker's main thread. A Worker has its own copy of the module: one that runs tenant
 * SQL (the D1 pool) would need this installed there too.
 */
export function installSqliteGuard(): void {
  if (installed) return;
  installed = true;
  const proto = Database.prototype;
  const turnOffTrustedSchema = proto.exec;
  /** `original` with the same signature, preceded by the screen. `skip` names a statement that is let through. */
  const screened = <F extends (this: Database, sql: string, ...rest: never[]) => void | object>(
    original: F,
    skip?: string,
  ): F => {
    const wrapper = function (this: Database, sql: string, ...rest: never[]) {
      if (!guarded.has(this)) {
        guarded.add(this);
        turnOffTrustedSchema.call(this, "PRAGMA trusted_schema = OFF");
      }
      if (sql !== skip) screenSql(sql);
      return original.call(this, sql, ...rest);
    };
    // SAFETY: the wrapper forwards every argument and returns the result unchanged, so it has `original`'s signature.
    return wrapper as F;
  };
  proto.exec = screened(proto.exec);
  proto.run = screened(proto.run, BROKER_BACKUP);
  proto.prepare = screened(proto.prepare);
  proto.query = screened(proto.query);
}
