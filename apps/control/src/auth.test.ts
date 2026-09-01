import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authDatabase } from "./auth";

// Regression: Better Auth's connection shares store.ts's WAL file. Without a
// busy_timeout it fails SQLITE_BUSY the moment a session read/write races
// another connection's write, which logged users straight back out after login.
test("authDatabase waits on locks instead of failing SQLITE_BUSY", () => {
  const path = join(mkdtempSync(join(tmpdir(), "sb-auth-")), "sproutboat.sqlite");
  process.env.SPROUTBOAT_DATABASE_PATH = path;

  const auth = authDatabase();
  // SAFETY: `PRAGMA busy_timeout` returns one row with a `timeout` column.
  const busy = auth.query("PRAGMA busy_timeout").get() as { timeout: number };
  // SAFETY: `PRAGMA journal_mode` returns one row with a `journal_mode` column.
  const mode = auth.query("PRAGMA journal_mode").get() as { journal_mode: string };
  expect(busy.timeout).toBe(5000);
  expect(mode.journal_mode).toBe("wal");

  // A second connection holds a write transaction open; the auth connection
  // must still be able to read (WAL) and, when it writes, wait rather than throw.
  const other = new Database(path);
  other.exec("PRAGMA busy_timeout = 5000");
  auth.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  other.exec("BEGIN IMMEDIATE");
  other.run("INSERT INTO t (v) VALUES ('held')");
  expect(() => auth.query("SELECT count(*) FROM t").get()).not.toThrow();
  other.exec("COMMIT");
  expect(() => auth.run("INSERT INTO t (v) VALUES ('after')")).not.toThrow();

  other.close();
  auth.close();
});
