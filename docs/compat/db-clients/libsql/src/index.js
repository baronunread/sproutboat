import { createClient } from "@libsql/client/web";

const URL_ = "http://127.0.0.1:18080";
const j = (v) =>
  JSON.stringify(v, (k, x) =>
    typeof x === "bigint"
      ? "bigint:" + x
      : x instanceof ArrayBuffer
        ? "ab:" + Array.from(new Uint8Array(x)).join(",")
        : x,
  );
const row = (r) => ({ ...r });
const mk = (o) => createClient({ url: URL_, ...o });

const CASES = [
  ["connect+select1", async (p) => j(row((await mk().execute("select 1 as one")).rows[0]))],
  [
    "drop",
    async (p) => {
      await mk().execute(`drop table if exists ${p}_items`);
      return "ok";
    },
  ],
  [
    "create",
    async (p) => {
      await mk().execute(`create table ${p}_items (id integer primary key, name text, score real, data blob)`);
      return "ok";
    },
  ],
  [
    "insert-positional",
    async (p) => {
      const r = await mk().execute({
        sql: `insert into ${p}_items (name, score) values (?, ?)`,
        args: ["héllo wörld", 1.5],
      });
      return j({ ra: r.rowsAffected, id: r.lastInsertRowid });
    },
  ],
  [
    "insert-named",
    async (p) => {
      const r = await mk().execute({
        sql: `insert into ${p}_items (name, score) values (:n, :s)`,
        args: { n: "named", s: 2 },
      });
      return j({ ra: r.rowsAffected, id: r.lastInsertRowid });
    },
  ],
  [
    "select-params",
    async (p) => {
      const r = await mk().execute({
        sql: `select id, name, score from ${p}_items where score > ? order by id`,
        args: [1],
      });
      return j({ cols: r.columns, rows: r.rows.map(row), len: r.rows.length });
    },
  ],
  [
    "types",
    async (p) => {
      const r = await mk().execute({
        sql: "select ? as i, ? as f, ? as s, ? as n, ? as b",
        args: [42, 3.14, "txt", null, new Uint8Array([1, 2, 3]).buffer],
      });
      return j(Object.fromEntries(r.columns.map((c, i) => [c, r.rows[0][i]])));
    },
  ],
  [
    "intMode-bigint",
    async (p) => j((await mk({ intMode: "bigint" }).execute("select 9007199254740993 as big")).rows[0].big),
  ],
  [
    "batch",
    async (p) => {
      const r = await mk().batch(
        [
          { sql: `insert into ${p}_items (name, score) values (?, ?)`, args: ["b1", 10] },
          { sql: `insert into ${p}_items (name, score) values (?, ?)`, args: ["b2", 20] },
          `select count(*) as c from ${p}_items`,
        ],
        "write",
      );
      return j(r.map((x) => ({ ra: x.rowsAffected, rows: x.rows.map(row) })));
    },
  ],
  [
    "transaction-commit",
    async (p) => {
      const db = mk();
      const tx = await db.transaction("write");
      await tx.execute({ sql: `insert into ${p}_items (name, score) values (?, ?)`, args: ["tx1", 100] });
      const mid = await tx.execute(`select count(*) as c from ${p}_items`);
      await tx.commit();
      const after = await db.execute(`select count(*) as c from ${p}_items`);
      return j({ mid: row(mid.rows[0]), after: row(after.rows[0]) });
    },
  ],
  [
    "transaction-rollback",
    async (p) => {
      const db = mk();
      const before = (await db.execute(`select count(*) as c from ${p}_items`)).rows[0].c;
      const tx = await db.transaction("write");
      await tx.execute({ sql: `insert into ${p}_items (name, score) values (?, ?)`, args: ["tx2", 200] });
      await tx.rollback();
      const after = (await db.execute(`select count(*) as c from ${p}_items`)).rows[0].c;
      return j({ before, after });
    },
  ],
  [
    "error-syntax",
    async (p) => {
      await mk().execute("selec nonsense");
      return "no error";
    },
  ],
  [
    "error-missing-table",
    async (p) => {
      await mk().execute("select * from nope_" + p);
      return "no error";
    },
  ],
  [
    "error-constraint",
    async (p) => {
      await mk().execute(`insert into ${p}_items (id, name) values (1, 'dup')`);
      return "no error";
    },
  ],
  [
    "error-batch-atomic",
    async (p) => {
      await mk().batch(
        [`insert into ${p}_items (name) values ('ok-in-failing-batch')`, "select * from nope_" + p],
        "write",
      );
      return "no error";
    },
  ],
  [
    "count-after-failed-batch",
    async (p) => j(row((await mk().execute(`select count(*) as c from ${p}_items`)).rows[0])),
  ],
  [
    "concurrent-20",
    async (p) => {
      const db = mk();
      const rs = await Promise.all(
        Array.from({ length: 20 }, (_, i) => db.execute({ sql: "select ? * 2 as v", args: [i] })),
      );
      return j(rs.map((r) => r.rows[0].v));
    },
  ],
  [
    "concurrent-writes-10",
    async (p) => {
      const db = mk();
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          db.execute({ sql: `insert into ${p}_items (name, score) values (?, ?)`, args: ["c" + i, i] }),
        ),
      );
      return j(row((await db.execute(`select count(*) as c from ${p}_items where name like 'c%'`)).rows[0]));
    },
  ],
  [
    "executeMultiple",
    async (p) => {
      const db = mk();
      await db.executeMultiple(
        `drop table if exists ${p}_m; create table if not exists ${p}_m (a); insert into ${p}_m values (1); insert into ${p}_m values (2);`,
      );
      return j(row((await db.execute(`select sum(a) as s from ${p}_m`)).rows[0]));
    },
  ],
];

async function one(name, p) {
  const c = CASES.find((x) => x[0] === name);
  try {
    return await c[1](p);
  } catch (e) {
    return "THROW " + (e && e.name) + ": " + (e && e.message) + (e && e.code ? " [" + e.code + "]" : "");
  }
}

export default {
  async fetch(req) {
    const u = new URL(req.url);
    const p = u.searchParams.get("p") || "x";
    if (u.pathname === "/cases") return Response.json(CASES.map((c) => c[0]));
    if (u.pathname === "/case") return new Response(await one(u.searchParams.get("c"), p));
    if (u.pathname === "/ping") return new Response("pong");
    if (u.pathname === "/q") {
      const r = await mk().execute({ sql: "select ? as v", args: [1] });
      return Response.json({ v: r.rows[0].v });
    }
    if (u.pathname === "/bench") {
      const n = Number(u.searchParams.get("n") || 40);
      const db = mk();
      await db.execute("select 1");
      const ts = [];
      for (let i = 0; i < n; i++) {
        const t0 = Date.now();
        await db.execute({ sql: "select ? as v", args: [i] });
        ts.push(Date.now() - t0);
      }
      ts.sort((a, b) => a - b);
      return Response.json({
        n,
        p50: ts[Math.floor(n / 2)],
        p95: ts[Math.floor(n * 0.95)],
        max: ts[n - 1],
        mean: ts.reduce((a, b) => a + b, 0) / n,
      });
    }
    return new Response("not found", { status: 404 });
  },
};
