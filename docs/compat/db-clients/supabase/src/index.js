import { createClient } from "@supabase/supabase-js";

// PostgREST serves at / ; supabase-js appends /rest/v1. Strip it in a custom fetch (stack setup, not a client issue).
const pgrstFetch = (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  return fetch(url.replace("/rest/v1/", "/"), init);
};
const mk = () =>
  createClient(
    "http://127.0.0.1:13000",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoicG9zdGdyZXMifQ.6pQJuxwfGhGAHabLSyVKnUYTkoQ_PK_yUA5S6nE27Pc",
    { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: pgrstFetch } },
  );
const j = (v) => JSON.stringify(v);
const err = (e) => "THROW " + (e && e.name) + ": " + (e && e.message);
const norm = (r) =>
  r.error
    ? "ERR " + j({ code: r.error.code, message: r.error.message, status: r.status })
    : j({ status: r.status, data: r.data, count: r.count });

const CASES = [
  ["reset", async (p) => norm(await mk().from(`${p}_items`).delete().gte("id", 0))],
  [
    "insert-select",
    async (p) =>
      norm(
        await mk()
          .from(`${p}_items`)
          .insert([
            { name: "héllo wörld", score: 1.5, meta: { a: [1, 2] } },
            { name: "b", score: 2 },
          ])
          .select("id,name,score,meta"),
      ),
  ],
  ["select-all", async (p) => norm(await mk().from(`${p}_items`).select("id,name,score,meta").order("id"))],
  [
    "filter-order-limit",
    async (p) =>
      norm(
        await mk()
          .from(`${p}_items`)
          .select("name")
          .gt("score", 1)
          .in("name", ["b", "x"])
          .order("name", { ascending: false })
          .limit(5),
      ),
  ],
  ["single", async (p) => norm(await mk().from(`${p}_items`).select("name").eq("name", "b").single())],
  ["maybeSingle-none", async (p) => norm(await mk().from(`${p}_items`).select("name").eq("name", "zzz").maybeSingle())],
  ["count-exact", async (p) => norm(await mk().from(`${p}_items`).select("*", { count: "exact", head: true }))],
  [
    "update",
    async (p) => norm(await mk().from(`${p}_items`).update({ score: 9 }).eq("name", "b").select("name,score")),
  ],
  [
    "upsert",
    async (p) =>
      norm(await mk().from(`${p}_items`).upsert({ name: "b", score: 10 }, { onConflict: "name" }).select("name,score")),
  ],
  ["rpc", async () => norm(await mk().rpc("add_numbers", { a: 2, b: 3 }))],
  ["delete", async (p) => norm(await mk().from(`${p}_items`).delete().eq("name", "b").select("name"))],
  [
    "error-missing-table",
    async (p) =>
      norm(
        await mk()
          .from("nope_" + p)
          .select("*"),
      ),
  ],
  [
    "error-unique",
    async (p) => {
      const c = mk();
      await c.from(`${p}_items`).insert({ name: "dup" });
      return norm(await c.from(`${p}_items`).insert({ name: "dup" }));
    },
  ],
  ["error-bad-column", async (p) => norm(await mk().from(`${p}_items`).select("nope"))],
  [
    "error-network",
    async () => {
      const c = createClient("http://127.0.0.1:1", "k", { auth: { persistSession: false, autoRefreshToken: false } });
      return norm(await c.from("x").select("*"));
    },
  ],
  [
    "concurrent-20",
    async (p) => {
      const c = mk();
      const rs = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          c
            .from(`${p}_items`)
            .insert({ name: "c" + i, score: i })
            .select("name"),
        ),
      );
      return j(rs.map((r) => (r.error ? "ERR" : r.data[0].name)).sort());
    },
  ],
  [
    "abort-signal",
    async (p) => {
      const ac = new AbortController();
      ac.abort();
      const r = await mk().from(`${p}_items`).select("*").abortSignal(ac.signal);
      return r.error ? "ERR " + r.error.name : "no error";
    },
  ],
  [
    "auth-client-offline",
    async () => {
      const c = mk();
      const { data, error } = await c.auth.getSession();
      return j({ session: data.session, error: error && error.message });
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
      const r = await mk().from("wd_items").select("id").limit(1);
      return Response.json({ n: (r.data || []).length });
    }
    if (u.pathname === "/bench") {
      const n = Number(u.searchParams.get("n") || 40);
      const c = mk();
      await c.from("wd_items").select("id").limit(1);
      const ts = [];
      for (let i = 0; i < n; i++) {
        const t0 = Date.now();
        await c.from("wd_items").select("id").limit(1);
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
