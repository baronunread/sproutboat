import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createBroker } from "@sproutboat/wire";
import { SqliteGuardError, installSqliteGuard, screenSql } from "./sqlite-guard";

const refused = [
  "ATTACH DATABASE ':memory:' AS x",
  "attach database '/etc/passwd' as p",
  "AtTaCh DATABASE 'x' AS y",
  "/**/attach database 'x' as y",
  "--c\nattach database 'x' as y",
  "  \n\t ATTACH 'x' AS y",
  "explain attach database 'x' as y",
  "EXPLAIN QUERY PLAN attach database 'x' as y",
  "select 1; attach database 'x' as y",
  "select 1;/* c */ ATTACH 'x' AS y;",
  "select ';'; attach 'x' as y",
  "select 'it''s'; attach 'x' as y",
  "select \"a;b\"; attach 'x' as y",
  "DETACH DATABASE x",
  "VACUUM INTO '/tmp/x'",
  "vacuum main into '/tmp/x'",
  "VACUUM /* c */ INTO ?",
  "PRAGMA writable_schema = ON",
  "pragma writable_schema=1",
  "PRAGMA main.writable_schema = ON",
  "PRAGMA schema_version",
  "PRAGMA schema_version = 5",
  "PRAGMA module_list",
  "PRAGMA /* x */ writable_schema(1)",
  'PRAGMA "writable_schema" = 1',
  "select 1; PRAGMA writable_schema = 1",
  "EXPLAIN PRAGMA writable_schema = 1",
  "PRAGMA",
  "PRAGMA temp.trusted_schema_x",
];

const allowed = [
  "SELECT 1",
  "select 'attach database x as y'",
  "SELECT 'a;b'; SELECT 2",
  "INSERT INTO attach (detach) VALUES ('vacuum into')",
  'SELECT "attach" FROM t',
  "SELECT [attach] FROM t -- attach database",
  "/* attach database */ SELECT 1",
  "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)",
  "DROP TABLE t",
  "VACUUM",
  "EXPLAIN QUERY PLAN SELECT * FROM t",
  "PRAGMA table_info(t)",
  "pragma TABLE_INFO ( t )",
  "PRAGMA main.table_info(t)",
  "PRAGMA table_list",
  "PRAGMA table_xinfo(t)",
  "PRAGMA index_list(t)",
  "PRAGMA index_info(i)",
  "PRAGMA index_xinfo(i)",
  "PRAGMA quick_check",
  "PRAGMA foreign_key_list(t)",
  "PRAGMA foreign_key_check",
  "PRAGMA foreign_keys = ON",
  "PRAGMA defer_foreign_keys = ON",
  "PRAGMA case_sensitive_like = ON",
  "PRAGMA ignore_check_constraints = ON",
  "PRAGMA legacy_alter_table = ON",
  "PRAGMA recursive_triggers = ON",
  "PRAGMA reverse_unordered_selects = ON",
  "PRAGMA optimize",
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL; PRAGMA busy_timeout=5000",
  "PRAGMA integrity_check",
  "PRAGMA trusted_schema = OFF",
];

describe("screenSql", () => {
  for (const sql of refused)
    test(`refuses ${JSON.stringify(sql)}`, () => {
      expect(() => screenSql(sql)).toThrow(SqliteGuardError);
    });
  for (const sql of allowed)
    test(`allows ${JSON.stringify(sql)}`, () => {
      expect(() => screenSql(sql)).not.toThrow();
    });
  test("the error names the statement kind", () => {
    expect(() => screenSql("select 1; attach 'x' as y")).toThrow("ATTACH");
    expect(() => screenSql("pragma writable_schema = 1")).toThrow("PRAGMA writable_schema");
  });
});

describe("installSqliteGuard", () => {
  installSqliteGuard();

  test("every Database method screens, and trusted_schema is off", () => {
    const db = new Database(":memory:");
    expect(() => db.exec("ATTACH ':memory:' AS x")).toThrow(SqliteGuardError);
    expect(() => db.query("attach ':memory:' as x")).toThrow(SqliteGuardError);
    expect(() => db.prepare("PRAGMA writable_schema = ON")).toThrow(SqliteGuardError);
    expect(() => db.run("PRAGMA writable_schema = ON")).toThrow(SqliteGuardError);
    expect(db.query("PRAGMA trusted_schema").get()).toEqual({ trusted_schema: 0 });
    db.exec("CREATE TABLE t (a)");
    expect(db.query("PRAGMA table_info(t)").all()).toHaveLength(1);
    db.close();
  });

  test("the broker's own backup statement still works", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-guard-"));
    try {
      const db = new Database(join(dir, "a.sqlite"), { create: true });
      db.exec("CREATE TABLE t (a)");
      db.run("VACUUM INTO ?", [join(dir, "b.sqlite")]);
      expect(() => db.exec(`VACUUM INTO '${join(dir, "c.sqlite")}'`)).toThrow(SqliteGuardError);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("through the broker: D1 refuses ATTACH and writable_schema, allows table_info", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-guard-"));
    const broker = createBroker({ bindings: { d1: ["DB"] } });
    try {
      const d1 = (op: string, sql: string) => broker.dispatch({ op, db: "DB", sql, params: [] });
      await d1("d1.exec", "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
      await expect(d1("d1.exec", "ATTACH DATABASE ':memory:' AS x")).rejects.toThrow("ATTACH");
      await expect(d1("d1.query", "PRAGMA writable_schema=ON")).rejects.toThrow("writable_schema");
      await expect(d1("d1.exec", "SELECT 1; ATTACH DATABASE ':memory:' AS x")).rejects.toThrow("ATTACH");
      const info = await d1("d1.query", "PRAGMA table_info(t)");
      expect(JSON.stringify(info)).toContain("name");
    } finally {
      broker.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
