import { afterEach, beforeEach, expect, test } from "bun:test";
import { allowedOriginsFor, rejectCrossSite, viaProxy } from "./csrf";

const saved = { ...process.env };
beforeEach(() => {
  process.env.SPROUTBOAT_DASHBOARD_URL = "https://dash.example.test";
  process.env.BETTER_AUTH_URL = "https://auth.example.test/";
});
afterEach(() => {
  process.env = { ...saved };
});

const call = (headers: Record<string, string>, method = "POST", body?: string) =>
  new Request("https://dash.example.test/api/projects/x/secrets", { method, headers, body });
const check = (request: Request) => rejectCrossSite(request, allowedOriginsFor(request));
const json = { "content-type": "application/json" };

test("cookie + foreign Origin is refused", async () => {
  const response = check(call({ cookie: "s=1", origin: "https://evil.example.test", ...json }, "POST", "{}"));
  expect(response?.status).toBe(403);
  expect(await response?.json()).toEqual({ error: "cross-site request refused" });
});

test("cookie + null Origin is refused", () => {
  expect(check(call({ cookie: "s=1", origin: "null", ...json }, "DELETE"))?.status).toBe(403);
});

test("cookie + dashboard, auth and Host origins pass", () => {
  for (const origin of ["https://dash.example.test", "https://auth.example.test", "http://dash.example.test"])
    expect(check(call({ cookie: "s=1", origin, host: "dash.example.test", ...json }, "POST", "{}"))).toBeNull();
});

test("sec-fetch-site: same-origin and none pass, same-site and cross-site are refused", () => {
  for (const site of ["same-origin", "none"])
    expect(check(call({ cookie: "s=1", "sec-fetch-site": site, ...json }, "POST", "{}"))).toBeNull();
  for (const site of ["same-site", "cross-site"])
    expect(check(call({ cookie: "s=1", "sec-fetch-site": site, ...json }, "POST", "{}"))?.status).toBe(403);
});

test("sec-fetch-site wins over a matching Origin", () => {
  const headers = { cookie: "s=1", "sec-fetch-site": "cross-site", origin: "https://dash.example.test" };
  expect(check(call(headers))?.status).toBe(403);
});

test("x-api-key and authorization callers are exempt even with a foreign Origin", () => {
  expect(check(call({ cookie: "s=1", "x-api-key": "k", origin: "https://evil.example.test" }))).toBeNull();
  expect(check(call({ cookie: "s=1", authorization: "Bearer k", "sec-fetch-site": "cross-site" }))).toBeNull();
});

test("no cookie passes; no Origin and no Fetch Metadata passes", () => {
  expect(check(call({ origin: "https://evil.example.test" }))).toBeNull();
  expect(check(call({ cookie: "s=1", ...json }, "POST", "{}"))).toBeNull();
});

test("GET, HEAD and OPTIONS are never gated", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"])
    expect(check(call({ cookie: "s=1", origin: "https://evil.example.test" }, method))).toBeNull();
});

test("cookie request with a text/plain, form or missing content-type body is 415", async () => {
  for (const type of ["text/plain;charset=UTF-8", "application/x-www-form-urlencoded", undefined]) {
    const headers = new Headers({ cookie: "s=1", "content-length": "2" });
    if (type) headers.set("content-type", type);
    const response = check(new Request("https://dash.example.test/x", { method: "POST", headers }));
    expect(response?.status).toBe(415);
    expect(await response?.json()).toEqual({ error: "expected application/json" });
  }
  // a real fetch with a string body and no explicit type is text/plain
  expect(check(call({ cookie: "s=1" }, "POST", "{}"))?.status).toBe(415);
});

test("JSON, multipart and bodyless cookie requests pass the content-type rule", () => {
  expect(check(call({ cookie: "s=1", ...json }, "POST", "{}"))).toBeNull();
  expect(check(call({ cookie: "s=1", "content-type": "multipart/form-data; boundary=x" }, "POST", "x"))).toBeNull();
  expect(check(call({ cookie: "s=1" }, "POST"))).toBeNull();
  expect(check(call({ cookie: "s=1", "content-length": "0" }, "DELETE"))).toBeNull();
});

test("viaProxy detects every proxy header", () => {
  for (const name of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "via"])
    expect(viaProxy(new Request("http://127.0.0.1/internal/tls/allow", { headers: { [name]: "x" } }))).toBe(true);
  expect(viaProxy(new Request("http://127.0.0.1:8787/internal/tls/allow?domain=a"))).toBe(false);
});
