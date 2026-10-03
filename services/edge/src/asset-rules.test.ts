import { expect, test } from "bun:test";
import type { AssetManifest } from "@sproutboat/assets";
import { applyAssetHeaders, assetRedirect } from "./asset-rules";

const manifest: AssetManifest = {
  notFound: "none",
  runSproutFirst: false,
  files: { "/new.html": { hash: "h", size: 1, type: "text/html" } },
  redirects: [
    { from: "/new.html", to: "/elsewhere", status: 301 },
    { from: "/blog/:slug", to: "/posts/:slug", status: 302 },
    { from: "/docs/*", to: "https://docs.example.com/:splat", status: 308 },
  ],
  headers: [
    {
      pattern: "/*",
      set: [
        ["x-frame-options", "DENY"],
        ["cache-control", "no-store"],
      ],
      unset: [],
    },
    { pattern: "/public/*", set: [["cache-control", "public, max-age=60"]], unset: ["x-frame-options"] },
  ],
};

test("the first matching redirect wins, even over an existing file", () => {
  const exact = assetRedirect(manifest, "/new.html");
  expect([exact?.status, exact?.headers.get("location")]).toEqual([301, "/elsewhere"]);
  expect(assetRedirect(manifest, "/blog/hello")?.headers.get("location")).toBe("/posts/hello");
  expect(assetRedirect(manifest, "/docs/a/b")?.headers.get("location")).toBe("https://docs.example.com/a/b");
  expect(assetRedirect(manifest, "/blog/a/b")).toBeNull();
  expect(assetRedirect({ ...manifest, redirects: undefined }, "/new.html")).toBeNull();
});

test("matching header rules override edge defaults, later rules override and unset earlier ones", () => {
  const root = applyAssetHeaders(new Headers({ "cache-control": "public, max-age=86400" }), manifest, "/a.css");
  expect([root.get("cache-control"), root.get("x-frame-options")]).toEqual(["no-store", "DENY"]);
  const pub = applyAssetHeaders(new Headers(), manifest, "/public/x/y.png");
  expect([pub.get("cache-control"), pub.has("x-frame-options")]).toEqual(["public, max-age=60", false]);
});
