import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentType, isSproutFirst, resolveAssetKey, walkAssets } from "./assets";

test("contentType maps known extensions, defaults to octet-stream", () => {
  expect(contentType("index.html")).toBe("text/html; charset=utf-8");
  expect(contentType("app.CSS")).toBe("text/css; charset=utf-8");
  expect(contentType("logo.png")).toBe("image/png");
  expect(contentType("archive.tar")).toBe("application/octet-stream");
  expect(contentType("noext")).toBe("application/octet-stream");
});

test("isSproutFirst: boolean short-circuits; patterns match with negation", () => {
  expect(isSproutFirst(true, "/anything")).toBe(true);
  expect(isSproutFirst(false, "/anything")).toBe(false);
  expect(isSproutFirst(["/api/*"], "/api/users")).toBe(true);
  expect(isSproutFirst(["/api/*"], "/index.html")).toBe(false);
  expect(isSproutFirst(["/api/*", "!/api/docs/*"], "/api/docs/intro")).toBe(false);
  expect(isSproutFirst(["/api/**"], "/api/a/b/c")).toBe(true);
  expect(isSproutFirst(["/api/*"], "/api/a/b")).toBe(false); // single * stays in a segment
});

test("resolveAssetKey: exact, directory, and extensionless .html resolution", () => {
  const files = new Set(["/index.html", "/cloud.html", "/blog/index.html", "/app.js", "/logo.png"]);
  const has = (k: string) => files.has(k);

  // exact hits
  expect(resolveAssetKey("/app.js", has)).toBe("/app.js");
  expect(resolveAssetKey("/cloud.html", has)).toBe("/cloud.html");

  // root + directory paths -> index.html
  expect(resolveAssetKey("/", has)).toBe("/index.html");
  expect(resolveAssetKey("/blog/", has)).toBe("/blog/index.html");

  // extensionless -> <path>.html, then <path>/index.html
  expect(resolveAssetKey("/cloud", has)).toBe("/cloud.html");
  expect(resolveAssetKey("/blog", has)).toBe("/blog/index.html");

  // leading slash is optional
  expect(resolveAssetKey("cloud", has)).toBe("/cloud.html");

  // genuine misses stay null (caller does not-found handling)
  expect(resolveAssetKey("/missing", has)).toBeNull();
  expect(resolveAssetKey("/some/client/route", has)).toBeNull();
  expect(resolveAssetKey("/missing.png", has)).toBeNull();
  expect(resolveAssetKey("/nope/", has)).toBeNull();
  // a path that already has an extension is never guessed at
  expect(resolveAssetKey("/cloud.htm", has)).toBeNull();
});

test("walkAssets hashes every file under a directory, posix keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-walk-"));
  mkdirSync(join(dir, "css"));
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
  writeFileSync(join(dir, "css", "app.css"), "body{}");
  writeFileSync(join(dir, ".hidden"), "skip me");
  const files = walkAssets(dir);
  expect(Object.keys(files).sort()).toEqual(["/css/app.css", "/index.html"]);
  expect(files["/index.html"]).toMatchObject({ size: 11, type: "text/html; charset=utf-8" });
  expect(files["/index.html"].hash).toMatch(/^[0-9a-f]{64}$/);
  rmSync(dir, { recursive: true, force: true });
});
