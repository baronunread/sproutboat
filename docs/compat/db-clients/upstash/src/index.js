import { Redis } from "@upstash/redis/cloudflare";

const mk = (o) => new Redis({ url: "http://127.0.0.1:18079", token: "dbc_token", ...o });
const j = (v) => JSON.stringify(v);
const err = (e) => "THROW " + (e && e.name) + ": " + (e && e.message);

const CASES = [
  ["ping", async () => j(await mk().ping())],
  [
    "set-get",
    async (p) => {
      const r = mk();
      await r.set(`${p}:k`, "héllo wörld");
      return j(await r.get(`${p}:k`));
    },
  ],
  [
    "json-roundtrip",
    async (p) => {
      const r = mk();
      await r.set(`${p}:o`, { a: 1, b: [1, 2, { c: "x" }], d: null });
      return j(await r.get(`${p}:o`));
    },
  ],
  [
    "number-roundtrip",
    async (p) => {
      const r = mk();
      await r.set(`${p}:n`, 42);
      const v = await r.get(`${p}:n`);
      return j({ v, t: typeof v });
    },
  ],
  ["get-missing", async (p) => j(await mk().get(`${p}:nope`))],
  [
    "incr-del",
    async (p) => {
      const r = mk();
      await r.del(`${p}:c`);
      const a = await r.incr(`${p}:c`);
      const b = await r.incrby(`${p}:c`, 5);
      const d = await r.del(`${p}:c`);
      return j([a, b, d]);
    },
  ],
  [
    "set-ex-ttl",
    async (p) => {
      const r = mk();
      await r.set(`${p}:e`, "v", { ex: 100 });
      const t = await r.ttl(`${p}:e`);
      return j(t > 90 && t <= 100);
    },
  ],
  [
    "hash",
    async (p) => {
      const r = mk();
      await r.del(`${p}:h`);
      await r.hset(`${p}:h`, { f1: "v1", f2: 2 });
      return j({ all: await r.hgetall(`${p}:h`), one: await r.hget(`${p}:h`, "f1") });
    },
  ],
  [
    "list",
    async (p) => {
      const r = mk();
      await r.del(`${p}:l`);
      await r.rpush(`${p}:l`, "a", "b", "c");
      return j({ range: await r.lrange(`${p}:l`, 0, -1), len: await r.llen(`${p}:l`) });
    },
  ],
  [
    "sorted-set",
    async (p) => {
      const r = mk();
      await r.del(`${p}:z`);
      await r.zadd(`${p}:z`, { score: 2, member: "b" }, { score: 1, member: "a" });
      return j(await r.zrange(`${p}:z`, 0, -1, { withScores: true }));
    },
  ],
  [
    "pipeline",
    async (p) => {
      const r = mk();
      const pl = r.pipeline();
      pl.set(`${p}:p1`, 1);
      pl.incr(`${p}:p1`);
      pl.get(`${p}:p1`);
      return j(await pl.exec());
    },
  ],
  [
    "multi-transaction",
    async (p) => {
      const r = mk();
      const tx = r.multi();
      tx.set(`${p}:m1`, "a");
      tx.get(`${p}:m1`);
      return j(await tx.exec());
    },
  ],
  [
    "autopipeline",
    async (p) => {
      const r = mk({ enableAutoPipelining: true });
      await r.set(`${p}:a1`, 1);
      await r.set(`${p}:a2`, 2);
      const rs = await Promise.all([r.get(`${p}:a1`), r.get(`${p}:a2`), r.incr(`${p}:a1`), r.get(`${p}:a2`)]);
      return j(rs);
    },
  ],
  [
    "error-wrong-type",
    async (p) => {
      const r = mk();
      await r.set(`${p}:str`, "x");
      await r.lpush(`${p}:str`, "y");
      return "no error";
    },
  ],
  [
    "error-bad-token",
    async () => {
      await new Redis({ url: "http://127.0.0.1:18079", token: "wrong", retry: false }).get("k");
      return "no error";
    },
  ],
  [
    "error-network",
    async () => {
      await new Redis({ url: "http://127.0.0.1:1", token: "x", retry: false }).get("k");
      return "no error";
    },
  ],
  [
    "concurrent-20",
    async (p) => {
      const r = mk();
      const rs = await Promise.all(
        Array.from({ length: 20 }, (_, i) => r.set(`${p}:cc${i}`, i).then(() => r.get(`${p}:cc${i}`))),
      );
      return j(rs);
    },
  ],
  [
    "scan-keys",
    async (p) => {
      const r = mk();
      const ks = await r.keys(`${p}:cc1*`);
      return j(ks.sort());
    },
  ],
  [
    "fromEnv",
    async () => {
      const r = Redis.fromEnv({
        UPSTASH_REDIS_REST_URL: "http://127.0.0.1:18079",
        UPSTASH_REDIS_REST_TOKEN: "dbc_token",
      });
      return j(await r.ping());
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
      const r = mk();
      await r.set("q", 1);
      return Response.json({ v: await r.get("q") });
    }
    if (u.pathname === "/bench") {
      const n = Number(u.searchParams.get("n") || 40);
      const r = mk();
      await r.ping();
      const ts = [];
      for (let i = 0; i < n; i++) {
        const t0 = Date.now();
        await r.get("q");
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
