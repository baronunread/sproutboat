/** The GET response cache: hit, miss, DYNAMIC, BYPASS, expiry, entry size limit, purge. */
import type { Case } from "./runner";
import { get, supRoute } from "./helpers";

const G = "cache";
const PUB = "public, max-age=60";
const q = (cc: string, extra = "") => `/gen?cc=${encodeURIComponent(cc)}${extra}`;
const AGE = { loose: { tolerance: { age: 1 } } } as const;

export const cacheCases: Case[] = [
  {
    id: "cache-miss-then-hit",
    group: G,
    run: async (ctx) => {
      await get(ctx, "first (MISS)", q(PUB), AGE);
      await get(ctx, "second (HIT)", q(PUB), AGE);
      await get(ctx, "third (HIT)", q(PUB), AGE);
      await get(ctx, "other query is its own key", q(PUB, "&n=2"), AGE);
      await get(ctx, "other query again (HIT)", q(PUB, "&n=2"), AGE);
      await get(ctx, "path without cacheable cc (DYNAMIC)", "/hello");
    },
  },
  {
    id: "cache-hit-keeps-headers",
    group: G,
    run: async (ctx) => {
      await get(ctx, "fill with etag, custom header, cpu", q(PUB, "&etag=1&x=kept&cpu=2.5&ct=text/html"), AGE);
      await get(ctx, "hit: headers replayed, cpu not", q(PUB, "&etag=1&x=kept&cpu=2.5&ct=text/html"), AGE);
    },
  },
  {
    id: "cache-host-is-part-of-key",
    group: G,
    setup: async (fx) => {
      const a = await supRoute(fx, "a.test", "a");
      return [a, { hostname: "b.test", sproutPath: a.sproutPath }];
    },
    run: async (ctx) => {
      await get(ctx, "a fills", q(PUB), { host: "a.test", ...AGE });
      await get(ctx, "a hits", q(PUB), { host: "a.test", ...AGE });
      await get(ctx, "b is a miss", q(PUB), { host: "b.test", ...AGE });
      await get(ctx, "b hits", q(PUB), { host: "b.test", ...AGE });
      await get(ctx, "uppercase host shares a's entry", q(PUB), { host: "A.TEST", ...AGE });
      await get(ctx, "host with port shares a's entry", q(PUB), { host: "a.test:99", ...AGE });
    },
  },
  {
    id: "cache-dynamic-responses",
    group: G,
    run: async (ctx) => {
      await get(ctx, "no cache-control", "/gen?x=1");
      await get(ctx, "max-age without public", q("max-age=60"));
      await get(ctx, "public without lifetime", q("public"));
      await get(ctx, "public, max-age=0", q("public, max-age=0"));
      await get(ctx, "public, no-store", q("public, no-store, max-age=60"));
      await get(ctx, "public, no-cache", q("public, no-cache, max-age=60"));
      await get(ctx, "public, private", q("public, private, max-age=60"));
      await get(ctx, "private with a field list", q('public, private="x", max-age=60'));
      await get(ctx, "duplicate max-age", q("public, max-age=10, max-age=20"));
      await get(ctx, "junk max-age", q("public, max-age=10junk"));
      await get(ctx, "negative max-age", q("public, max-age=-5"));
      await get(ctx, "Vary present", q(PUB, "&vary=accept-language"));
      await get(ctx, "Set-Cookie present", q(PUB, "&cookie=1"));
      await get(ctx, "Age present", q(PUB, "&age=5"));
      await get(ctx, "Date in the future", q(PUB, "&date=600"));
      await get(ctx, "stale by its own Date", q(PUB, "&date=-120"));
      await get(ctx, "empty cache-control", q(""));
      await get(ctx, "mixed-case directives still miss (HIT later)", q("PUBLIC, MAX-AGE=60", "&n=ci"), AGE);
      await get(ctx, "mixed-case second", q("PUBLIC, MAX-AGE=60", "&n=ci"), AGE);
    },
  },
  {
    id: "cache-ttl-forms",
    group: G,
    run: async (ctx) => {
      await get(ctx, "s-maxage wins", q("public, max-age=1, s-maxage=60", "&n=1"), AGE);
      await get(ctx, "s-maxage wins (HIT)", q("public, max-age=1, s-maxage=60", "&n=1"), AGE);
      await get(ctx, "s-maxage only", q("public, s-maxage=60", "&n=2"), AGE);
      await get(ctx, "s-maxage only (HIT)", q("public, s-maxage=60", "&n=2"), AGE);
      await get(ctx, "s-maxage=0 with max-age", q("public, max-age=60, s-maxage=0", "&n=3"));
      await get(ctx, "extra spaces", q("public ,  max-age = 60", "&n=4"));
      await get(ctx, "no spaces", q("public,max-age=60", "&n=5"), AGE);
      await get(ctx, "no spaces (HIT)", q("public,max-age=60", "&n=5"), AGE);
      await get(ctx, "immutable", q("public, max-age=60, immutable", "&n=6"), AGE);
      await get(ctx, "immutable (HIT)", q("public, max-age=60, immutable", "&n=6"), AGE);
      await get(ctx, "stale-while-revalidate", q("public, max-age=60, stale-while-revalidate=30", "&n=7"), AGE);
      await get(ctx, "stale-while-revalidate (HIT)", q("public, max-age=60, stale-while-revalidate=30", "&n=7"), AGE);
    },
  },
  {
    id: "cache-date-header-offsets",
    group: G,
    run: async (ctx) => {
      await get(ctx, "origin Date 30s old, max-age 60: fill", q(PUB, "&date=-30"), AGE);
      await get(ctx, "origin Date 30s old: hit shows age >= 30", q(PUB, "&date=-30"), AGE);
    },
  },
  {
    id: "cache-bypass-requests",
    group: G,
    run: async (ctx) => {
      await get(ctx, "fill", q(PUB), AGE);
      await get(ctx, "cookie", q(PUB), { headers: { cookie: "s=1" }, ...AGE });
      await get(ctx, "authorization", q(PUB), { headers: { authorization: "Bearer x" }, ...AGE });
      await get(ctx, "Cache-Control: no-cache", q(PUB), { headers: { "cache-control": "no-cache" }, ...AGE });
      await get(ctx, "Cache-Control: max-age=0", q(PUB), { headers: { "cache-control": "max-age=0" }, ...AGE });
      await get(ctx, "Pragma", q(PUB), { headers: { pragma: "no-cache" }, ...AGE });
      await get(ctx, "Range", q(PUB), { headers: { range: "bytes=0-1" }, ...AGE });
      await get(ctx, "If-None-Match", q(PUB), { headers: { "if-none-match": '"v1"' }, ...AGE });
      await get(ctx, "If-Modified-Since", q(PUB), {
        headers: { "if-modified-since": "Thu, 01 Jan 2026 00:00:00 GMT" },
        ...AGE,
      });
      await get(ctx, "If-Match", q(PUB), { headers: { "if-match": '"v1"' }, ...AGE });
      await get(ctx, "If-Unmodified-Since", q(PUB), {
        headers: { "if-unmodified-since": "Thu, 01 Jan 2030 00:00:00 GMT" },
        ...AGE,
      });
      await get(ctx, "empty cookie header", q(PUB), { headers: { cookie: "" }, ...AGE });
      await get(ctx, "unrelated headers still hit", q(PUB), {
        headers: { accept: "text/html", "x-foo": "bar" },
        ...AGE,
      });
      await get(ctx, "unfilled path is BYPASS with a cookie", q(PUB, "&n=other"), {
        headers: { cookie: "s=1" },
        ...AGE,
      });
    },
  },
  {
    id: "cache-non-get-methods",
    group: G,
    run: async (ctx) => {
      await get(ctx, "fill", q(PUB), AGE);
      await ctx.req("HEAD does not read the cache", { method: "HEAD", path: q(PUB), ...AGE });
      await ctx.req("POST", { method: "POST", path: q(PUB), body: "x", ...AGE });
      await ctx.req("PUT", { method: "PUT", path: q(PUB), body: "x", ...AGE });
      await ctx.req("OPTIONS", { method: "OPTIONS", path: q(PUB), ...AGE });
      await get(ctx, "GET still hits", q(PUB), AGE);
    },
  },
  {
    id: "cache-ttl-expiry",
    group: G,
    timeoutMs: 40_000,
    run: async (ctx) => {
      await get(ctx, "fill (max-age=2)", q("public, max-age=2"), AGE);
      await get(ctx, "hit", q("public, max-age=2"), AGE);
      await ctx.sleep(2300);
      await get(ctx, "expired: miss again with a new body", q("public, max-age=2"), AGE);
      await get(ctx, "hit on the refilled entry", q("public, max-age=2"), AGE);
    },
  },
  {
    id: "cache-age-grows",
    group: G,
    run: async (ctx) => {
      await get(ctx, "fill", q("public, max-age=30"), AGE);
      await ctx.sleep(1100);
      await get(ctx, "hit after 1.1 s: age >= 1", q("public, max-age=30"), AGE);
    },
  },
  {
    id: "cache-status-codes",
    group: G,
    run: async (ctx) => {
      for (const status of [200, 203, 301, 404, 410, 204, 206, 302, 304, 400, 500, 503]) {
        const path = q(PUB, `&status=${status}&n=s${status}`);
        await get(ctx, `status ${status}: first`, path, AGE);
        await get(ctx, `status ${status}: second`, path, AGE);
      }
    },
  },
  {
    id: "cache-entry-size-limit",
    group: G,
    run: async (ctx) => {
      const limit = 512 * 1024;
      for (const size of [limit - 1, limit, limit + 1]) {
        const path = q(PUB, `&size=${size}&n=z${size}`);
        const first = await get(ctx, `${size} bytes: first`, path, { loose: { body: true, tolerance: { age: 1 } } });
        const second = await get(ctx, `${size} bytes: second`, path, { loose: { body: true, tolerance: { age: 1 } } });
        ctx.note(`${size} bytes: body prefixes`, [
          Buffer.from(first.body).toString("latin1", 0, 24),
          Buffer.from(second.body).toString("latin1", 0, 24),
          first.body.length,
          second.body.length,
        ]);
      }
    },
  },
  {
    id: "cache-entry-size-limit-chunked",
    group: G,
    run: async (ctx) => {
      const limit = 512 * 1024;
      for (const size of [limit, limit + 1]) {
        const path = q(PUB, `&size=${size}&nolen=1&n=c${size}`);
        const first = await get(ctx, `${size} bytes chunked: first`, path, {
          loose: { body: true, tolerance: { age: 1 } },
        });
        const second = await get(ctx, `${size} bytes chunked: second`, path, {
          loose: { body: true, tolerance: { age: 1 } },
        });
        ctx.note(`${size} chunked: body prefixes`, [
          Buffer.from(first.body).toString("latin1", 0, 24),
          Buffer.from(second.body).toString("latin1", 0, 24),
          first.body.length,
          second.body.length,
        ]);
      }
    },
  },
  {
    id: "cache-chunked-small-entry",
    group: G,
    run: async (ctx) => {
      await get(ctx, "chunked fill", q(PUB, "&nolen=1&size=2000"), AGE);
      await get(ctx, "chunked hit (now with a content-length?)", q(PUB, "&nolen=1&size=2000"), AGE);
    },
  },
  {
    id: "cache-off",
    group: G,
    env: { SPROUTBOAT_EDGE_CACHE: "off" },
    run: async (ctx) => {
      await get(ctx, "first", q(PUB));
      await get(ctx, "second (no cache)", q(PUB));
      await get(ctx, "no cache-control", "/hello");
      await ctx.req("POST", { method: "POST", path: "/upload", body: "x" });
    },
  },
  {
    id: "cache-off-other-values",
    group: G,
    env: { SPROUTBOAT_EDGE_CACHE: "OFF" },
    run: async (ctx) => {
      await get(ctx, "first", q(PUB), AGE);
      await get(ctx, "second", q(PUB), AGE);
    },
  },
  {
    id: "cache-purge-on-sprout-change",
    group: G,
    setup: async (fx) => {
      const v1 = await supRoute(fx, "app.test", "v1");
      await supRoute(fx, "app.test", "v2");
      return [v1];
    },
    run: async (ctx) => {
      await get(ctx, "v1 fills", q(PUB), AGE);
      await get(ctx, "v1 hit", q(PUB), AGE);
      ctx.writeRoutes([{ hostname: "app.test", sproutPath: ctx.fx.sprouts.get("v2")! }]);
      await ctx.sleep(300);
      await get(ctx, "v2: purged, new sprout answers", q(PUB), AGE);
      await get(ctx, "v2 hit", q(PUB), AGE);
    },
  },
  {
    id: "cache-kept-on-identical-reload",
    group: G,
    run: async (ctx) => {
      await get(ctx, "fills", q(PUB), AGE);
      ctx.writeRoutes([{ hostname: "app.test", sproutPath: ctx.fx.sprouts.get("app")! }]);
      await ctx.sleep(300);
      await get(ctx, "still a hit after an identical snapshot", q(PUB), AGE);
      await get(ctx, "pool: nothing respawned", "/__sb/pool");
    },
  },
  {
    id: "cache-purge-on-secrets-hash-change",
    group: G,
    run: async (ctx) => {
      const sproutPath = ctx.fx.sprouts.get("app")!;
      await get(ctx, "fills", q(PUB), AGE);
      ctx.writeRoutes([{ hostname: "app.test", sproutPath, secretsHash: "new-hash" }]);
      await ctx.sleep(300);
      await get(ctx, "purged and respawned", q(PUB), AGE);
      await get(ctx, "pool: one respawn", "/__sb/pool");
    },
  },
  {
    id: "cache-other-host-survives-reload",
    group: G,
    setup: async (fx) => [await supRoute(fx, "a.test", "a"), await supRoute(fx, "b.test", "b")],
    run: async (ctx) => {
      await get(ctx, "a fills", q(PUB), { host: "a.test", ...AGE });
      await get(ctx, "b fills", q(PUB), { host: "b.test", ...AGE });
      const a = ctx.fx.sprouts.get("a")!;
      const c = await ctx.fx.makeSprout("c");
      ctx.writeRoutes([
        { hostname: "a.test", sproutPath: a },
        { hostname: "b.test", sproutPath: c },
      ]);
      await ctx.sleep(300);
      await get(ctx, "a still hits", q(PUB), { host: "a.test", ...AGE });
      await get(ctx, "b was purged", q(PUB), { host: "b.test", ...AGE });
    },
  },
  {
    id: "cache-purge-on-route-removal",
    group: G,
    run: async (ctx) => {
      const sproutPath = ctx.fx.sprouts.get("app")!;
      await get(ctx, "fills", q(PUB), AGE);
      ctx.writeRoutes([]);
      await ctx.sleep(300);
      await get(ctx, "route removed", q(PUB), AGE);
      ctx.writeRoutes([{ hostname: "app.test", sproutPath }]);
      await ctx.sleep(300);
      await get(ctx, "route back: cache was purged", q(PUB), AGE);
    },
  },
  {
    id: "cache-with-uncaught-and-cpu",
    group: G,
    run: async (ctx) => {
      await get(ctx, "cpu header on a cacheable response, miss", q(PUB, "&cpu=3.14159&n=cpu"), AGE);
      await get(ctx, "hit drops the cpu header", q(PUB, "&cpu=3.14159&n=cpu"), AGE);
      await get(ctx, "500 is never cached", "/uncaught");
      await get(ctx, "500 again", "/uncaught");
    },
  },
  {
    id: "cache-hit-log-fields",
    group: G,
    run: async (ctx) => {
      await get(ctx, "fill", q(PUB, "&size=1234"), AGE);
      await get(ctx, "hit", q(PUB, "&size=1234"), AGE);
      await ctx.req("hit with POST body is not a hit", {
        method: "POST",
        path: q(PUB, "&size=1234"),
        body: "abc",
        ...AGE,
      });
      await get(ctx, "hit logged without cold-start fields", q(PUB, "&size=1234"), { headers: { "x-a": "1" }, ...AGE });
    },
  },
];
