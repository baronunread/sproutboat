import { connect, cast } from "@planetscale/database";
import { format } from "sql-escaper";

const fetcher = (url, init) => {
  delete init.cache;
  return fetch(String(url).replace("https://", "http://"), init);
};
const mk = (o) => connect({ url: "http://root:unused@127.0.0.1:13900", fetch: fetcher, ...o });
const j = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? "bigint:" + x : x));
const err = (e) => "THROW " + (e && e.name) + ": " + (e && e.message) + (e && e.code ? " [" + e.code + "]" : "");
const strip = (r) => ({
  rows: r.rows,
  headers: r.headers,
  rowsAffected: r.rowsAffected,
  insertId: r.insertId,
  size: r.size,
});

const CASES = [
  ["select1", async () => j(strip(await mk().execute("select 1 as one")))],
  [
    "drop",
    async (p) => {
      await mk().execute(`drop table if exists ${p}_t`);
      return "ok";
    },
  ],
  [
    "create",
    async (p) => {
      await mk().execute(
        `create table ${p}_t (id int auto_increment primary key, name varchar(64) unique, score double, meta json, ts datetime default current_timestamp)`,
      );
      return "ok";
    },
  ],
  [
    "insert-positional",
    async (p) =>
      j(
        strip(
          await mk().execute(
            format(`insert into ${p}_t (name, score, meta) values (?, ?, ?)`, [
              "héllo wörld",
              1.5,
              JSON.stringify({ a: [1, 2] }),
            ]),
          ),
        ),
      ),
  ],
  [
    "insert-named-via-format",
    async (p) => j(strip(await mk().execute(format(`insert into ${p}_t (name, score) values (?, ?)`, ["named", 2])))),
  ],
  [
    "select-params-object",
    async (p) =>
      j((await mk().execute(format(`select id, name, score, meta from ${p}_t where score > ? order by id`, [1]))).rows),
  ],
  [
    "select-array-mode",
    async (p) => j((await mk().execute(`select id, name from ${p}_t order by id`, { as: "array" })).rows),
  ],
  [
    "types",
    async () =>
      j(
        (
          await mk().execute(
            "select 1 as i, 3.14 as d, cast(3.14 as decimal(10,2)) as dec, 'x' as s, null as n, cast('2024-01-02 03:04:05' as datetime) as dt, cast('{\"a\":1}' as json) as js, 12345678901234 as big, x'deadbeef' as bin",
          )
        ).rows[0],
      ),
  ],
  [
    "custom-cast",
    async () => {
      const r = await mk({ cast: (f, v) => (f.type === "INT64" ? "cast64:" + v : cast(f, v)) }).execute(
        "select 12345678901234 as big, 5 as small",
      );
      return j(r.rows[0]);
    },
  ],
  [
    "params-array-rejected",
    async () => {
      await mk().execute("select ? as a", [1]);
      return "no error";
    },
  ],
  [
    "format-escape",
    async () =>
      (await mk().execute(format("select ? as a, ? as b, ? as c", ["it's", null, "2024-01-02 03:04:05"]))).statement,
  ],
  [
    "transaction-commit",
    async (p) => {
      const r = await mk().transaction(async (tx) => {
        await tx.execute(format(`insert into ${p}_t (name) values (?)`, ["tx1"]));
        const c = await tx.execute(`select count(*) as c from ${p}_t`);
        return c.rows[0].c;
      });
      const after = (await mk().execute(`select count(*) as c from ${p}_t`)).rows[0].c;
      return j({ inTx: r, after });
    },
  ],
  [
    "transaction-rollback",
    async (p) => {
      try {
        await mk().transaction(async (tx) => {
          await tx.execute(format(`insert into ${p}_t (name) values (?)`, ["rb"]));
          throw new Error("boom");
        });
        return "no error";
      } catch (e) {
        const c = (await mk().execute(`select count(*) as c from ${p}_t where name = 'rb'`)).rows[0].c;
        return err(e) + " | rb=" + c;
      }
    },
  ],
  [
    "error-syntax",
    async () => {
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
    "error-duplicate",
    async (p) => {
      await mk().execute(`insert into ${p}_t (name) values ('named')`);
      return "no error";
    },
  ],
  [
    "concurrent-20",
    async () => {
      const c = mk();
      const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => c.execute(format("select ? * 2 as v", [i]))));
      return j(rs.map((r) => r.rows[0].v));
    },
  ],
  [
    "refresh-noop",
    async () => {
      const c = mk();
      await c.execute("select 1");
      return typeof c.refresh;
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
      const r = await mk().execute(format("select ? as v", [1]));
      return Response.json({ v: r.rows[0].v });
    }
    if (u.pathname === "/bench") {
      const n = Number(u.searchParams.get("n") || 40);
      const c = mk();
      await c.execute("select 1");
      const ts = [];
      for (let i = 0; i < n; i++) {
        const t0 = Date.now();
        await c.execute(format("select ? as v", [i]));
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
