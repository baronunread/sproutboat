import { neon, neonConfig, Pool } from "@neondatabase/serverless";

const CONN = "postgres://postgres:postgres@db.localtest.me:5432/main";
neonConfig.fetchEndpoint = () => "http://127.0.0.1:14444/sql";
neonConfig.useSecureWebSocket = false;
neonConfig.wsProxy = () => "127.0.0.1:14444/v2";
neonConfig.pipelineTLS = false;
neonConfig.pipelineConnect = false;

const j = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? "bigint:" + x : x));
const err = (e) => "THROW " + (e && e.name) + ": " + (e && e.message) + (e && e.code ? " [" + e.code + "]" : "");

const CASES = [
  // HTTP path: neon()
  ["http:select1", async () => j(await neon(CONN)`select 1 as one`)],
  [
    "http:setup",
    async (p) => {
      const sql = neon(CONN);
      await sql.query(`drop table if exists ${p}_h`);
      await sql.query(
        `create table ${p}_h (id serial primary key, name text, score float8, meta jsonb, ts timestamptz default now())`,
      );
      return "ok";
    },
  ],
  [
    "http:insert-params",
    async (p) => {
      const sql = neon(CONN);
      const r =
        await sql`insert into ${sql.unsafe ? sql.unsafe(p + "_h") : p + "_h"} (name, score, meta) values (${"héllo wörld"}, ${1.5}, ${JSON.stringify({ a: [1, 2] })}) returning id, name, score, meta`;
      return j(r);
    },
  ],
  [
    "http:query-fn-params",
    async (p) => {
      const sql = neon(CONN);
      const r = await sql.query(`insert into ${p}_h (name, score) values ($1, $2) returning id, name, score`, [
        "fn",
        2.5,
      ]);
      return j(r);
    },
  ],
  [
    "http:types",
    async () => {
      const sql = neon(CONN);
      const r =
        await sql`select 1::int as i, 3.14::float8 as f, 'x'::text as s, null::text as n, true as b, 12345678901234::bigint as big, 3.14::numeric as num, '{"a":1}'::jsonb as js, array[1,2,3] as arr, '2024-01-02T03:04:05Z'::timestamptz as ts, '\\xdeadbeef'::bytea as by`;
      const x = r[0];
      return j({
        ...x,
        ts: typeof x.ts + ":" + (x.ts instanceof Date ? x.ts.toISOString() : x.ts),
        by: x.by && x.by.constructor && x.by.constructor.name + ":" + Array.from(x.by).join(","),
      });
    },
  ],
  [
    "http:arrayMode-fullResults",
    async () => {
      const sql = neon(CONN, { arrayMode: true, fullResults: true });
      const r = await sql`select 1 as a, 'b' as b`;
      return j({ rows: r.rows, fields: r.fields.map((f) => f.name), rc: r.rowCount, cmd: r.command });
    },
  ],
  [
    "http:transaction",
    async (p) => {
      const sql = neon(CONN);
      const r = await sql.transaction([
        sql`insert into ${sql.unsafe ? sql.unsafe(p + "_h") : p + "_h"} (name) values (${"t1"}) returning id`,
        sql`select count(*)::int as c from ${sql.unsafe ? sql.unsafe(p + "_h") : p + "_h"}`,
      ]);
      return j(r.map((x) => x.length).concat(r[1][0].c));
    },
  ],
  [
    "http:transaction-rollback",
    async (p) => {
      const sql = neon(CONN);
      try {
        await sql.transaction([
          sql.query(`insert into ${p}_h (name) values ('rb')`),
          sql.query(`select * from nope_${p}`),
        ]);
        return "no error";
      } catch (e) {
        const c = await sql.query(`select count(*)::int as c from ${p}_h where name = 'rb'`);
        return err(e) + " | rb rows=" + c[0].c;
      }
    },
  ],
  [
    "http:error-syntax",
    async () => {
      await neon(CONN)`selec nonsense`;
      return "no error";
    },
  ],
  [
    "http:error-missing-table",
    async (p) => {
      await neon(CONN).query("select * from nope_" + p);
      return "no error";
    },
  ],
  [
    "http:error-constraint",
    async (p) => {
      await neon(CONN).query(`insert into ${p}_h (id, name) values (1, 'dup')`);
      return "no error";
    },
  ],
  [
    "http:bad-credentials",
    async () => {
      await neon("postgres://postgres:wrong@db.localtest.me:5432/main")`select 1`;
      return "no error";
    },
  ],
  [
    "http:concurrent-20",
    async () => {
      const sql = neon(CONN);
      const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => sql`select ${i}::int * 2 as v`));
      return j(rs.map((r) => r[0].v));
    },
  ],
  // WebSocket path: Pool / Client
  [
    "ws:select1",
    async () => {
      const pool = new Pool({ connectionString: CONN });
      try {
        const r = await pool.query("select 1 as one");
        return j(r.rows);
      } finally {
        await pool.end();
      }
    },
  ],
  [
    "ws:params",
    async () => {
      const pool = new Pool({ connectionString: CONN });
      try {
        const r = await pool.query(
          "select $1::int as a, $2::text as b, $3::bool as c, $4::float8 as d, $5::text as e",
          [1, "héllo", true, 1.5, null],
        );
        return j({ rows: r.rows, fields: r.fields.map((f) => f.name), rc: r.rowCount });
      } finally {
        await pool.end();
      }
    },
  ],
  [
    "ws:types",
    async () => {
      const pool = new Pool({ connectionString: CONN });
      try {
        const r = await pool.query(
          `select 12345678901234::bigint as big, 3.14::numeric as num, '{"a":1}'::jsonb as js, array[1,2,3] as arr, '2024-01-02T03:04:05Z'::timestamptz as ts, '\\xdeadbeef'::bytea as by`,
        );
        const x = r.rows[0];
        return j({
          ...x,
          ts: typeof x.ts + ":" + (x.ts instanceof Date ? x.ts.toISOString() : x.ts),
          by: x.by && x.by.constructor && x.by.constructor.name + ":" + Array.from(x.by).join(","),
        });
      } finally {
        await pool.end();
      }
    },
  ],
  [
    "ws:setup",
    async (p) => {
      const pool = new Pool({ connectionString: CONN });
      try {
        await pool.query(`drop table if exists ${p}_w`);
        await pool.query(`create table ${p}_w (id serial primary key, name text unique)`);
        return "ok";
      } finally {
        await pool.end();
      }
    },
  ],
  [
    "ws:transaction-commit",
    async (p) => {
      const pool = new Pool({ connectionString: CONN });
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`insert into ${p}_w (name) values ($1)`, ["a"]);
        await c.query(`insert into ${p}_w (name) values ($1)`, ["b"]);
        await c.query("COMMIT");
        const r = await c.query(`select count(*)::int as c from ${p}_w`);
        return j(r.rows);
      } finally {
        c.release();
        await pool.end();
      }
    },
  ],
  [
    "ws:transaction-rollback",
    async (p) => {
      const pool = new Pool({ connectionString: CONN });
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`insert into ${p}_w (name) values ($1)`, ["zz"]);
        await c.query("ROLLBACK");
        const r = await c.query(`select count(*)::int as c from ${p}_w where name = 'zz'`);
        return j(r.rows);
      } finally {
        c.release();
        await pool.end();
      }
    },
  ],
  [
    "ws:error-syntax",
    async () => {
      const pool = new Pool({ connectionString: CONN });
      try {
        await pool.query("selec nonsense");
        return "no error";
      } finally {
        await pool.end();
      }
    },
  ],
  [
    "ws:error-constraint",
    async (p) => {
      const pool = new Pool({ connectionString: CONN });
      try {
        await pool.query(`insert into ${p}_w (name) values ('a')`);
        return "no error";
      } finally {
        await pool.end();
      }
    },
  ],
  [
    "ws:error-then-reuse",
    async (p) => {
      const pool = new Pool({ connectionString: CONN });
      try {
        try {
          await pool.query("select * from nope_" + p);
        } catch {}
        const r = await pool.query("select 7 as ok");
        return j(r.rows);
      } finally {
        await pool.end();
      }
    },
  ],
  [
    "ws:bad-credentials",
    async () => {
      const pool = new Pool({ connectionString: "postgres://postgres:wrong@db.localtest.me:5432/main" });
      try {
        await pool.query("select 1");
        return "no error";
      } finally {
        await pool.end().catch(() => {});
      }
    },
  ],
  [
    "ws:concurrent-10",
    async () => {
      const pool = new Pool({ connectionString: CONN, max: 5 });
      try {
        const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => pool.query("select $1::int * 2 as v", [i])));
        return j(rs.map((r) => r.rows[0].v));
      } finally {
        await pool.end();
      }
    },
  ],
];

async function one(name, p) {
  const c = CASES.find((x) => x[0] === name);
  try {
    return await c[1](p);
  } catch (e) {
    return err(e);
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
      const r = await neon(CONN)`select ${1}::int as v`;
      return Response.json({ v: r[0].v });
    }
    if (u.pathname === "/bench") {
      const n = Number(u.searchParams.get("n") || 40);
      const mode = u.searchParams.get("mode") || "http";
      const ts = [];
      if (mode === "http") {
        const sql = neon(CONN);
        await sql`select 1`;
        for (let i = 0; i < n; i++) {
          const t0 = Date.now();
          await sql`select ${i}::int as v`;
          ts.push(Date.now() - t0);
        }
      } else {
        const pool = new Pool({ connectionString: CONN });
        await pool.query("select 1");
        for (let i = 0; i < n; i++) {
          const t0 = Date.now();
          await pool.query("select $1::int as v", [i]);
          ts.push(Date.now() - t0);
        }
        await pool.end();
      }
      ts.sort((a, b) => a - b);
      return Response.json({
        mode,
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
