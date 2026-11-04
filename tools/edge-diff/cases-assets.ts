/** Edge-served static assets: resolution, conditional requests, _headers, _redirects, sprout-first, cache-control. */
import type { AssetsSpec } from "./lib";
import type { Case } from "./runner";
import { backendRoute, get, header, pattern, supRoute } from "./helpers";

const G = "assets";

export const FILES: AssetsSpec["files"] = {
  "index.html": "<h1>home</h1>\n",
  "about.html": "<h1>about</h1>\n",
  "page.html": "<h1>page.html</h1>\n",
  "page/index.html": "<h1>page/index.html</h1>\n",
  "docs/index.html": "<h1>docs index</h1>\n",
  "docs/guide.html": "<h1>guide</h1>\n",
  "blog/post.html": "<h1>post</h1>\n",
  "v1.2/index.html": "<h1>v1.2</h1>\n",
  "sub/dir/deep.html": "<h1>deep</h1>\n",
  "style.css": "body { color: red }\n",
  "app.js": "console.log(1)\n",
  "data.json": '{"a":1}\n',
  "robots.txt": "User-agent: *\n",
  "favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
  "logo.PNG": pattern(300),
  "unknown.xyz": "mystery",
  noext: "no extension at all",
  "empty.txt": "",
  "file with space.txt": "spaced",
  "ünï.txt": "unicode name",
  "a%b.txt": "percent in the name",
  "assets/app-a1b2c3d4.js": "fingerprinted\n",
  "assets/main.8f3a2b1c.chunk.js": "stacked fingerprint\n",
  "assets/index.Ke7awTe2.css": "a{}\n",
  "assets/plainname.js": "plain\n",
  "assets/12345678.js": "digits only, not a fingerprint\n",
  "assets/abcdefgh.js": "letters only, not a fingerprint\n",
  "fonts/bricolage-grotesque-latin.woff2": pattern(2048),
  "public/x/y.png": pattern(64),
  "big.bin": pattern(300 * 1024),
};

const RULES_HEADERS = `# comment
/*
  X-Frame-Options: DENY
  Cache-Control: no-store

/public/*
  Cache-Control: public, max-age=60
  ! X-Frame-Options
  X-Public: yes

/assets/*
  X-Assets: yes

/about
  X-About: exact
  X-Multi: a
  X-Multi: b

/docs/guide
  ! Cache-Control
  X-Guide: 1
`;

const RULES_REDIRECTS = `# comment
/old /new 301
/blog/:slug /posts/:slug 302
/docs/* https://docs.example.com/:splat 308
/about.html /elsewhere 301
/q /target?a=1 307
/nostatus /dest
/bad /x 200
/a/:x/b/:y /b/:y/:x 303
/page /moved 301
/star/* /dest/:splat
/exact/ /exact-dir 301
`;

const sup = (spec: AssetsSpec): Pick<Case, "setup"> => ({
  setup: async (fx) => [await supRoute(fx, "app.test", "app", { assets: spec })],
});

const PLAIN: AssetsSpec = { files: FILES };
const RULES: AssetsSpec = { files: FILES, headers: RULES_HEADERS };
const REDIRECTS: AssetsSpec = { files: FILES, redirects: RULES_REDIRECTS };

export const assetCases: Case[] = [
  {
    id: "assets-exact-and-index",
    group: G,
    ...sup(PLAIN),
    run: async (ctx) => {
      for (const path of [
        "/index.html",
        "/",
        "/about.html",
        "/style.css",
        "/app.js",
        "/data.json",
        "/robots.txt",
        "/favicon.svg",
        "/logo.PNG",
        "/unknown.xyz",
        "/noext",
        "/empty.txt",
        "/sub/dir/deep.html",
        "/fonts/bricolage-grotesque-latin.woff2",
      ])
        await get(ctx, path, path);
    },
  },
  {
    id: "assets-directory-and-extensionless",
    group: G,
    ...sup(PLAIN),
    run: async (ctx) => {
      for (const path of [
        "/docs/",
        "/docs",
        "/docs/guide",
        "/about",
        "/page",
        "/page/",
        "/blog/",
        "/blog",
        "/blog/post",
        "/sub/dir/deep",
        "/v1.2",
        "/v1.2/",
        "/sub/",
        "/sub/dir/",
        "/index",
        "/missing",
        "/missing/",
        "/about/",
        "/docs//",
        "//docs/",
      ])
        await get(ctx, path, path);
    },
  },
  {
    id: "assets-case-and-dots",
    group: G,
    ...sup(PLAIN),
    run: async (ctx) => {
      for (const path of [
        "/ABOUT.html",
        "/About",
        "/logo.png",
        "/logo.PNG",
        "/./about.html",
        "/docs/../about.html",
        "/about.html.",
        "/about.html/",
        "/%61bout.html",
        "/INDEX.HTML",
      ])
        await get(ctx, path, path);
    },
  },
  {
    id: "assets-encoded-paths",
    group: G,
    ...sup(PLAIN),
    run: async (ctx) => {
      // Bun answers a malformed sequence with its HTML dev error page, whose body names its temp dir.
      const malformed = new Set(["/a%b.txt", "/%E0%A4%A", "/%ZZ", "/%", "/a%2", "/%C3", "/%ff"]);
      for (const path of [
        "/file%20with%20space.txt",
        "/file+with+space.txt",
        "/%C3%BCn%C3%AF.txt",
        "/a%25b.txt",
        "/a%b.txt",
        "/about%2Ehtml",
        "/docs%2Fguide.html",
        "/docs%2fguide",
        "/%2e%2e/about.html",
        "/..%2fabout.html",
        "/%00",
        "/about.html%00",
        "/%E0%A4%A",
        "/%ZZ",
        "/%",
        "/a%2",
        "/%C3",
        "/%ff",
      ])
        await get(ctx, path, path, { loose: { body: malformed.has(path) } });
    },
  },
  {
    id: "assets-malformed-percent-encoding",
    group: G,
    ...sup(PLAIN),
    run: async (ctx) => {
      // decodeURIComponent throws in the Bun edge's handler.
      await get(ctx, "bad %-sequence", "/%E0%A4%A", { loose: { body: true } });
      await get(ctx, "lone percent", "/100%", { loose: { body: true } });
      await get(ctx, "alive after", "/about.html");
      await ctx.req("POST with a bad %-sequence (not an asset method)", { method: "POST", path: "/%ZZ", body: "x" });
      await get(ctx, "bad %-sequence in the query only", "/about.html?x=%ZZ");
    },
  },
  {
    id: "assets-query-and-fragment-chars",
    group: G,
    ...sup(PLAIN),
    run: async (ctx) => {
      await get(ctx, "asset with query", "/style.css?v=123");
      await get(ctx, "asset with empty query", "/style.css?");
      await get(ctx, "index with query", "/?utm=1");
      await get(ctx, "directory with query", "/docs/?x=y");
    },
  },
  {
    id: "assets-conditional-304",
    group: G,
    ...sup(PLAIN),
    run: async (ctx) => {
      const first = await get(ctx, "200 with etag", "/style.css");
      const etag = header(first, "etag") ?? '"?"';
      await get(ctx, "If-None-Match matches", "/style.css", { headers: { "if-none-match": etag } });
      await get(ctx, "weak validator does not match", "/style.css", { headers: { "if-none-match": `W/${etag}` } });
      await get(ctx, "list of validators does not match", "/style.css", {
        headers: { "if-none-match": `"zzz", ${etag}` },
      });
      await get(ctx, "star does not match", "/style.css", { headers: { "if-none-match": "*" } });
      await get(ctx, "wrong validator", "/style.css", { headers: { "if-none-match": '"nope"' } });
      await get(ctx, "unquoted validator", "/style.css", { headers: { "if-none-match": etag.replace(/"/g, "") } });
      await ctx.req("HEAD with matching If-None-Match", {
        method: "HEAD",
        path: "/style.css",
        headers: { "if-none-match": etag },
      });
      await get(ctx, "If-Modified-Since is ignored", "/style.css", {
        headers: { "if-modified-since": "Thu, 01 Jan 2099 00:00:00 GMT" },
      });
      await get(ctx, "304 for a directory index", "/", {
        headers: { "if-none-match": header(await get(ctx, "index etag", "/"), "etag") ?? "" },
      });
    },
  },
  {
    id: "assets-head",
    group: G,
    ...sup(PLAIN),
    run: async (ctx) => {
      for (const path of ["/style.css", "/", "/about", "/empty.txt", "/big.bin", "/missing"])
        await ctx.req(`HEAD ${path}`, { method: "HEAD", path });
      await get(ctx, "GET after HEAD", "/style.css");
    },
  },
  {
    id: "assets-other-methods-reach-the-sprout",
    group: G,
    ...sup(PLAIN),
    run: async (ctx) => {
      for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
        await ctx.req(`${method} /style.css`, {
          method,
          path: "/style.css",
          body: method === "OPTIONS" ? undefined : "x",
        });
    },
  },
  {
    id: "assets-range-and-other-request-headers",
    group: G,
    ...sup(PLAIN),
    run: async (ctx) => {
      await get(ctx, "Range on an asset", "/big.bin", { headers: { range: "bytes=0-9" }, loose: { body: true } });
      await get(ctx, "Accept-Encoding gzip", "/style.css", { headers: { "accept-encoding": "gzip, br" } });
      await get(ctx, "cookie and authorization are irrelevant", "/style.css", {
        headers: { cookie: "a=1", authorization: "Bearer x" },
      });
      await get(ctx, "Cache-Control: no-cache request", "/style.css", { headers: { "cache-control": "no-cache" } });
    },
  },
  {
    id: "assets-large-file",
    group: G,
    ...sup(PLAIN),
    run: async (ctx) => {
      const res = await get(ctx, "300 KiB asset", "/big.bin");
      ctx.note("length", res.body.length);
    },
  },
  {
    id: "assets-fall-through-to-sprout",
    group: G,
    ...sup(PLAIN),
    run: async (ctx) => {
      await get(ctx, "no such asset", "/api/hello");
      await get(ctx, "no such asset with extension", "/missing.png");
      await get(ctx, "extensionless miss", "/nothing-here");
      const pool = await get(ctx, "pool: only the misses started the sprout", "/__sb/pool");
      ctx.note("pool bytes", pool.body.length);
    },
  },
  {
    id: "assets-do-not-start-the-sprout",
    group: G,
    ...sup(PLAIN),
    run: async (ctx) => {
      await get(ctx, "asset", "/about.html");
      await get(ctx, "pool: nothing spawned", "/__sb/pool");
    },
  },
  {
    id: "assets-cache-control",
    group: G,
    ...sup(PLAIN),
    run: async (ctx) => {
      for (const path of [
        "/assets/app-a1b2c3d4.js",
        "/assets/main.8f3a2b1c.chunk.js",
        "/assets/index.Ke7awTe2.css",
        "/assets/plainname.js",
        "/assets/12345678.js",
        "/assets/abcdefgh.js",
        "/fonts/bricolage-grotesque-latin.woff2",
        "/favicon.svg",
        "/robots.txt",
        "/index.html",
        "/style.css",
        "/",
      ])
        await get(ctx, path, path);
    },
  },
  {
    id: "assets-headers-rules",
    group: G,
    ...sup(RULES),
    run: async (ctx) => {
      for (const path of [
        "/style.css",
        "/index.html",
        "/public/x/y.png",
        "/assets/app-a1b2c3d4.js",
        "/about",
        "/about.html",
        "/docs/guide",
        "/docs/guide.html",
        "/docs/",
        "/fonts/bricolage-grotesque-latin.woff2",
      ])
        await get(ctx, path, path);
      await ctx.req("HEAD with rules", { method: "HEAD", path: "/public/x/y.png" });
      await get(ctx, "304 carries only the etag", "/style.css", {
        headers: { "if-none-match": header(await get(ctx, "etag", "/style.css"), "etag") ?? "" },
      });
    },
  },
  {
    id: "assets-headers-rules-do-not-touch-sprout-responses",
    group: G,
    ...sup(RULES),
    run: async (ctx) => {
      await get(ctx, "sprout answer", "/api/x");
      await get(ctx, "redirect-less asset miss", "/missing.css");
    },
  },
  {
    id: "assets-headers-custom-content-type",
    group: G,
    ...sup({
      files: { "a.html": "<p>a</p>", "b.txt": "b", "c.json": "{}" },
      headers:
        '/a.html\n  Content-Type: text/x-custom\n  ETag: "mine"\n/b.txt\n  ! Content-Type\n/c.json\n  X-Weird-Name_1: v\n  Set-Cookie: s=1\n',
    }),
    run: async (ctx) => {
      for (const path of ["/a.html", "/b.txt", "/c.json"]) await get(ctx, path, path);
    },
  },
  {
    id: "assets-headers-rule-sets-content-length",
    group: G,
    ...sup({ files: { "a.html": "<p>a</p>" }, headers: "/a.html\n  Content-Length: 1\n" }),
    run: async (ctx) => {
      const res = await get(ctx, "a _headers rule sets Content-Length", "/a.html");
      ctx.note("body length", res.body.length);
    },
  },
  {
    id: "assets-headers-rule-framing-headers",
    group: G,
    ...sup({
      files: { "a.html": "<p>a</p>", "b.html": "<p>b</p>", "c.html": "<p>c</p>" },
      headers:
        "/a.html\n  Transfer-Encoding: chunked\n  Connection: close\n  X-Kept: yes\n/b.html\n  ! Content-Length\n  X-Kept: yes\n/c.html\n  Content-Length: 99999\n  Keep-Alive: timeout=1\n",
    }),
    run: async (ctx) => {
      for (const path of ["/a.html", "/b.html", "/c.html"]) {
        const res = await get(ctx, path, path);
        ctx.note(`${path} body length`, res.body.length);
      }
      await get(ctx, "connection still usable", "/a.html");
    },
  },
  {
    id: "assets-headers-pattern-edge-cases",
    group: G,
    ...sup({
      files: { "index.html": "i", "a/b/c.html": "abc", "a/b.html": "ab", "x.html": "x" },
      headers:
        "/a/*\n  X-A: splat\n/a/b/c.html\n  X-Exact: yes\n/*.html\n  X-Glob: ignored?\n/x.html/\n  X-Slash: trailing\n/\n  X-Root: yes\n/:id/c.html\n  X-Placeholder: yes\n",
    }),
    run: async (ctx) => {
      for (const path of ["/a/b/c.html", "/a/b.html", "/x.html", "/", "/index.html", "/a/b/c"])
        await get(ctx, path, path);
    },
  },
  {
    id: "assets-headers-file-format-quirks",
    group: G,
    ...sup({
      files: { "a.txt": "a", "b.txt": "b", "c.txt": "c" },
      headers:
        "\r\n/a.txt\r\n  X-Crlf: yes\r\n\r\n/b.txt\n\tX-Tab: yes\n  NoColonLine\n  X-Colon-In-Value: a:b:c\n  X-Empty:\n/c.txt\n  X-Spaced :   padded value   \n",
    }),
    run: async (ctx) => {
      for (const path of ["/a.txt", "/b.txt", "/c.txt"]) await get(ctx, path, path);
    },
  },
  {
    id: "assets-redirects",
    group: G,
    ...sup(REDIRECTS),
    run: async (ctx) => {
      for (const path of [
        "/old",
        "/old/",
        "/blog/hello",
        "/blog/a/b",
        "/blog",
        "/docs/guide",
        "/docs/",
        "/docs/a/b/c",
        "/docs",
        "/about.html",
        "/about",
        "/q",
        "/q?keep=1",
        "/nostatus",
        "/bad",
        "/a/1/b/2",
        "/page",
        "/star/",
        "/star/x/y",
        "/exact/",
        "/exact",
        "/index.html",
      ])
        await get(ctx, path, path);
      await ctx.req("HEAD redirect", { method: "HEAD", path: "/old" });
      await ctx.req("POST is also redirected", { method: "POST", path: "/old", body: "x" });
    },
  },
  {
    id: "assets-redirects-and-headers-together",
    group: G,
    ...sup({ files: FILES, headers: RULES_HEADERS, redirects: RULES_REDIRECTS }),
    run: async (ctx) => {
      await get(ctx, "redirect response is not given header rules", "/old");
      await get(ctx, "asset still gets header rules", "/about");
    },
  },
  {
    id: "assets-redirect-special-targets",
    group: G,
    ...sup({
      files: { "index.html": "i" },
      redirects:
        "/spaces /a%20b 301\n/unicode /café 301\n/abs https://example.com/x?y=1#z 302\n/proto //other.example/x 302\n/q/:a /t?x=:a&y=:a 302\n/same /same 301\n/dollar /$1 301\n/colon/:a/:ab /:ab/:a 301\n",
    }),
    run: async (ctx) => {
      for (const path of [
        "/spaces",
        "/unicode",
        "/abs",
        "/proto",
        "/q/hello",
        "/q/a%20b",
        "/same",
        "/dollar",
        "/colon/1/2",
      ])
        await get(ctx, path, path);
    },
  },
  {
    id: "assets-run-sprout-first-true",
    group: G,
    ...sup({ ...PLAIN, runSproutFirst: true }),
    run: async (ctx) => {
      for (const path of ["/index.html", "/", "/style.css", "/nothing"]) await get(ctx, path, path);
    },
  },
  {
    id: "assets-run-sprout-first-list",
    group: G,
    ...sup({ ...PLAIN, runSproutFirst: ["/api/**", "/docs/*", "!/docs/guide.html", "/*.css"] }),
    run: async (ctx) => {
      for (const path of [
        "/about.html",
        "/style.css",
        "/docs/guide.html",
        "/docs/index.html",
        "/docs/",
        "/docs",
        "/api/x",
        "/sub/dir/deep.html",
        "/page",
      ])
        await get(ctx, path, path);
    },
  },
  {
    id: "assets-run-sprout-first-redirects-still-win",
    group: G,
    ...sup({ ...PLAIN, redirects: "/about.html /elsewhere 301\n", runSproutFirst: true }),
    run: async (ctx) => {
      await get(ctx, "redirect beats sprout-first", "/about.html");
      await get(ctx, "sprout-first otherwise", "/style.css");
    },
  },
  {
    id: "assets-not-found-modes",
    group: G,
    ...sup({ ...PLAIN, notFound: "single-page-application" }),
    run: async (ctx) => {
      await get(ctx, "SPA mode: edge does not fall back itself", "/some/client/route");
    },
  },
  {
    id: "assets-no-manifest",
    group: G,
    run: async (ctx) => {
      await get(ctx, "no assets.json", "/index.html");
      await get(ctx, "no assets.json, root", "/");
    },
  },
  {
    id: "assets-malformed-manifest",
    group: G,
    ...sup({ files: { "index.html": "x" }, rawManifest: "{ this is not json" }),
    run: async (ctx) => {
      await get(ctx, "unparsable assets.json", "/index.html");
      await get(ctx, "again", "/");
    },
  },
  {
    id: "assets-manifest-without-files",
    group: G,
    ...sup({ files: {}, rawManifest: '{"notFound":"none","runSproutFirst":false}' }),
    run: async (ctx) => {
      await get(ctx, "manifest has no files object", "/index.html", { loose: { body: true } });
    },
  },
  {
    id: "assets-manifest-missing-file-on-disk",
    group: G,
    ...sup({
      files: { "index.html": "x" },
      rawManifest: JSON.stringify({
        notFound: "none",
        runSproutFirst: false,
        files: {
          "/ghost.html": { hash: "abc", size: 5, type: "text/html; charset=utf-8" },
          "/real.html": { hash: "def", size: 99, type: "text/html" },
        },
      }),
    }),
    run: async (ctx) => {
      await get(ctx, "listed but not on disk", "/ghost.html", { loose: { body: true } });
      await get(ctx, "size in the manifest is not the file size", "/real.html", { loose: { body: true } });
      await get(ctx, "304 still works for a ghost", "/ghost.html", { headers: { "if-none-match": '"abc"' } });
    },
  },
  {
    id: "assets-manifest-rules-shapes",
    group: G,
    ...sup({
      files: { "a.txt": "a" },
      rawManifest: JSON.stringify({
        notFound: "none",
        runSproutFirst: false,
        files: { "/a.txt": { hash: "h1", size: 1, type: "text/plain" } },
        headers: [
          { pattern: "/a.txt", set: [["x-one", "1"]], unset: [] },
          { pattern: "/a.txt", set: [], unset: ["content-type"] },
        ],
        redirects: [
          { from: "/r", to: "/a.txt", status: 301 },
          { from: "/s", to: "/a.txt", status: 200 },
        ],
      }),
    }),
    run: async (ctx) => {
      await get(ctx, "unset content-type", "/a.txt");
      await get(ctx, "redirect", "/r");
      await get(ctx, "a rule with a non-redirect status", "/s");
    },
  },
  {
    id: "assets-two-hosts-share-a-manifest",
    group: G,
    setup: async (fx) => {
      const route = await supRoute(fx, "a.test", "app", { assets: PLAIN });
      return [route, { hostname: "b.test", sproutPath: route.sproutPath }];
    },
    run: async (ctx) => {
      await get(ctx, "a", "/about.html", { host: "a.test" });
      await get(ctx, "b", "/about.html", { host: "b.test" });
    },
  },
  {
    id: "assets-reload-picks-up-new-manifest",
    group: G,
    setup: async (fx) => [
      await supRoute(fx, "app.test", "one", { assets: { files: { "index.html": "one" } } }),
      await supRoute(fx, "other.test", "two", { assets: { files: { "index.html": "two" } } }),
    ],
    run: async (ctx) => {
      await get(ctx, "v1", "/index.html");
      ctx.writeRoutes([{ hostname: "app.test", sproutPath: ctx.fx.sprouts.get("two")! }]);
      await ctx.sleep(300);
      await get(ctx, "v2", "/index.html");
    },
  },
  {
    id: "assets-sproutd-route-does-not-serve-assets",
    group: G,
    setup: async (fx) => [await backendRoute(fx)],
    run: async (ctx) => {
      await get(ctx, "backend answers everything", "/index.html");
    },
  },
];
