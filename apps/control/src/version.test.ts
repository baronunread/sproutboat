import { expect, test } from "bun:test";
import { CONTROL_VERSION, MIN_CLI_VERSION, stampVersion } from "./version";

test("stamps the handshake on API responses", () => {
  const stamped = stampVersion(Response.json({ ok: true }), "/api/account");
  expect(stamped.headers.get("x-sproutboat-control")).toBe(CONTROL_VERSION);
  expect(stamped.headers.get("x-sproutboat-min-cli")).toBe(MIN_CLI_VERSION);
});

test("leaves non-API paths alone", () => {
  const plain = stampVersion(new Response("hi"), "/caddy/ask");
  expect(plain.headers.get("x-sproutboat-control")).toBeNull();
});

test("an immutable response passes through instead of throwing", () => {
  // Response.redirect() has immutable headers; better-auth returns redirects on
  // the /api/auth/* routes, so this path is real, not theoretical.
  const redirect = Response.redirect("https://example.com/", 302);
  expect(() => stampVersion(redirect, "/api/auth/callback")).not.toThrow();
});

test("the advertised minimum is a real version string", () => {
  expect(MIN_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(CONTROL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
