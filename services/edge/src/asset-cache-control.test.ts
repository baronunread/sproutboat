import { expect, test } from "bun:test";
import { cacheControlFor } from "./asset-cache-control";

test("every mainstream framework's fingerprinted filenames are cached forever as immutable", () => {
  expect(cacheControlFor("/_astro/index.Ke7awTe2.css")).toBe("public, max-age=31536000, immutable"); // Astro
  expect(cacheControlFor("/assets/index-a1b2c3d4.js")).toBe("public, max-age=31536000, immutable"); // plain Vite
  expect(cacheControlFor("/static/js/main.8f3a2b1c.chunk.js")).toBe("public, max-age=31536000, immutable"); // webpack/CRA, stacked extension
  expect(cacheControlFor("/_next/static/chunks/main.a1b2c3d4.js")).toBe("public, max-age=31536000, immutable"); // Next.js
  expect(cacheControlFor("/_app/immutable/chunks/0.b2c3d4e5.js")).toBe("public, max-age=31536000, immutable"); // SvelteKit
  expect(cacheControlFor("/_nuxt/entry.c3d4e5f6.js")).toBe("public, max-age=31536000, immutable"); // Nuxt
});

test("plain, human-named assets (fonts, favicon, OG images) get a bounded day-long cache, not immutable", () => {
  expect(cacheControlFor("/fonts/bricolage-grotesque-latin.woff2")).toBe("public, max-age=86400");
  expect(cacheControlFor("/fonts/jetbrains-mono-latin.woff2")).toBe("public, max-age=86400");
  expect(cacheControlFor("/favicon.svg")).toBe("public, max-age=86400");
  expect(cacheControlFor("/logo.svg")).toBe("public, max-age=86400");
  expect(cacheControlFor("/og/home.png")).toBe("public, max-age=86400");
  expect(cacheControlFor("/robots.txt")).toBe("public, max-age=86400");
});
