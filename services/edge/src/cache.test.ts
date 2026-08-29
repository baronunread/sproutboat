import { expect, test } from "bun:test";
import { EdgeCache, cacheableForSeconds } from "./cache";

test("cacheableForSeconds honours max-age / s-maxage and opt-outs", () => {
  expect(cacheableForSeconds(null)).toBeNull();
  expect(cacheableForSeconds("max-age=60")).toBe(60);
  expect(cacheableForSeconds("public, max-age=300")).toBe(300);
  expect(cacheableForSeconds("max-age=60, s-maxage=120")).toBe(120); // s-maxage wins
  expect(cacheableForSeconds("no-store")).toBeNull();
  expect(cacheableForSeconds("private, max-age=60")).toBeNull();
  expect(cacheableForSeconds("no-cache")).toBeNull();
  expect(cacheableForSeconds("max-age=0")).toBeNull();
});

const buf = (n: number) => new ArrayBuffer(n);

test("EdgeCache stores, serves within TTL, expires after", () => {
  let now = 1_000;
  const cache = new EdgeCache(10, 1 << 20, 1 << 20, () => now);
  const key = EdgeCache.key("app.test", "GET", "/x");
  expect(cache.set(key, 200, [["content-type", "text/plain"]], buf(3), 5)).toBe(true);
  expect(cache.get(key)?.status).toBe(200);
  now = 6_001; // past 5s TTL
  expect(cache.get(key)).toBeUndefined();
  expect(cache.size).toBe(0);
});

test("EdgeCache refuses uncacheable status and oversized bodies, evicts oldest", () => {
  const cache = new EdgeCache(2, 1 << 20, 4);
  expect(cache.set("a", 500, [], buf(2), 10)).toBe(false); // status
  expect(cache.set("b", 200, [], buf(8), 10)).toBe(false); // > maxEntryBytes (4)
  expect(cache.set("k1", 200, [], buf(2), 10)).toBe(true);
  expect(cache.set("k2", 200, [], buf(2), 10)).toBe(true);
  expect(cache.set("k3", 200, [], buf(2), 10)).toBe(true); // over maxEntries(2) → evict k1
  expect(cache.get("k1")).toBeUndefined();
  expect(cache.get("k3")?.status).toBe(200);
});

test("purgeHost drops only the given host's entries", () => {
  const cache = new EdgeCache();
  cache.set(EdgeCache.key("a.test", "GET", "/x"), 200, [], buf(2), 30);
  cache.set(EdgeCache.key("a.test", "GET", "/y"), 200, [], buf(2), 30);
  cache.set(EdgeCache.key("b.test", "GET", "/x"), 200, [], buf(2), 30);
  cache.purgeHost("a.test");
  expect(cache.get(EdgeCache.key("a.test", "GET", "/x"))).toBeUndefined();
  expect(cache.get(EdgeCache.key("b.test", "GET", "/x"))?.status).toBe(200);
  expect(cache.size).toBe(1);
});
