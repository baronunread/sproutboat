/** Routing, backend (sproutd), supervisor proxying, caps, timeouts, uncaught detection. */
import { join } from "node:path";
import type { Json } from "./lib";
import type { Case } from "./runner";
import { backendRoute, both, bytes, get, hdrs, json, kindRoute, pattern, supRoute } from "./helpers";

const G = "core";

// ---- routing basics ----

const routing: Case[] = [
  {
    id: "unknown-host",
    group: G,
    run: async (ctx) => {
      await get(ctx, "GET unknown host", "/x", { host: "nope.test" });
      await get(ctx, "GET unknown host with port", "/x?y=1", { host: "nope.test:8080" });
      await ctx.req("HEAD unknown host", { method: "HEAD", path: "/", host: "nope.test" });
      await ctx.req("POST unknown host", { method: "POST", path: "/p", host: "nope.test", body: "hello" });
      await ctx.req("POST chunked unknown host", {
        method: "POST",
        path: "/p",
        host: "nope.test",
        chunks: ["ab", "cde"],
      });
    },
  },
  {
    id: "no-host-header",
    group: G,
    run: async (ctx) => {
      // Bun 500s here with its HTML dev error page (new URL(request.url) throws); only status and type matter.
      await ctx.req("HTTP/1.0 without Host", { path: "/x", host: null, httpVersion: "1.0", loose: { body: true } });
      await ctx.req("HTTP/1.1 empty Host", { path: "/x", host: "", loose: { body: true } });
    },
  },
  {
    id: "host-case-and-port",
    group: G,
    run: async (ctx) => {
      await get(ctx, "exact host", "/seen");
      await get(ctx, "upper-case host", "/seen", { host: "APP.TEST" });
      await get(ctx, "host with port", "/seen", { host: "app.test:8080" });
      await get(ctx, "host with trailing dot", "/seen", { host: "app.test." });
      await get(ctx, "host with weird port", "/seen", { host: "app.test:" });
      await get(ctx, "ipv6-ish host", "/seen", { host: "[::1]:80" });
    },
  },
  {
    id: "bare-domain-redirect",
    group: G,
    logs: "off", // Rust also logs the apex redirect (see intentional-more-events-logged)
    run: async (ctx) => {
      await get(ctx, "bare domain", "/", { host: "sproutboat.test" });
      await get(ctx, "bare domain with path and query", "/a/b?c=d", { host: "sproutboat.test" });
      await get(ctx, "bare domain, upper case", "/", { host: "SproutBoat.Test" });
      await get(ctx, "bare domain with port", "/", { host: "sproutboat.test:8443" });
      await ctx.req("bare domain POST", { method: "POST", path: "/", host: "sproutboat.test", body: "x" });
      await ctx.req("bare domain HEAD", { method: "HEAD", path: "/", host: "sproutboat.test" });
      await get(ctx, "sub-domain is not the bare domain", "/", { host: "x.sproutboat.test" });
    },
  },
  {
    id: "bare-domain-default-dashboard",
    group: G,
    logs: "off", // Rust also logs the apex redirect (see intentional-more-events-logged)
    env: { SPROUTBOAT_DASHBOARD_URL: null },
    run: async (ctx) => {
      await get(ctx, "bare domain, default dashboard", "/", { host: "sproutboat.test" });
    },
  },
  {
    id: "bare-domain-empty-dashboard-env",
    group: G,
    logs: "off", // Rust also logs the apex redirect (see intentional-more-events-logged)
    env: { SPROUTBOAT_DASHBOARD_URL: "" },
    run: async (ctx) => {
      await get(ctx, "bare domain, empty dashboard env", "/", { host: "sproutboat.test" });
    },
  },
  {
    id: "bare-domain-dashboard-variants",
    group: G,
    logs: "off", // Rust also logs the apex redirect (see intentional-more-events-logged)
    env: { SPROUTBOAT_DASHBOARD_URL: "https://Dash.Example.test:8443/some path/?q=1#frag///" },
    run: async (ctx) => {
      await get(ctx, "bare domain, odd dashboard URL", "/", { host: "sproutboat.test" });
    },
  },
  {
    id: "bare-domain-custom-domain-env",
    group: G,
    logs: "off", // Rust also logs the apex redirect (see intentional-more-events-logged)
    env: { SPROUTBOAT_DEPLOYMENT_DOMAIN: "Custom.Example.COM", SPROUTBOAT_DASHBOARD_URL: null },
    run: async (ctx) => {
      await get(ctx, "domain from env, lower-cased", "/", { host: "custom.example.com" });
      await get(ctx, "old default no longer special", "/", { host: "sproutboat.test" });
    },
  },
  {
    id: "bare-domain-routed",
    group: G,
    logs: "off", // Rust also logs the apex redirect (see intentional-more-events-logged)
    setup: async (fx) => [await supRoute(fx, "sproutboat.test")],
    run: async (ctx) => {
      await get(ctx, "bare domain attached to a project", "/hello", { host: "sproutboat.test" });
    },
  },
  {
    id: "pool-stats",
    group: G,
    run: async (ctx) => {
      await get(ctx, "pool before traffic", "/__sb/pool");
      await get(ctx, "app request", "/");
      await get(ctx, "pool after one cold start", "/__sb/pool");
      await get(ctx, "pool with query", "/__sb/pool?x=1");
      await ctx.req("pool HEAD", { method: "HEAD", path: "/__sb/pool" });
      await ctx.req("pool POST", { method: "POST", path: "/__sb/pool", body: "x" });
      await get(ctx, "pool with trailing slash", "/__sb/pool/");
    },
  },
  {
    id: "pool-stats-two-hosts-one-sprout",
    group: G,
    setup: async (fx) => {
      const a = await supRoute(fx, "a.test", "shared");
      return [a, { hostname: "b.test", sproutPath: a.sproutPath }];
    },
    host: "a.test",
    run: async (ctx) => {
      await get(ctx, "host a", "/who", { host: "a.test" });
      await get(ctx, "host b", "/who", { host: "b.test" });
      await get(ctx, "pool", "/__sb/pool");
    },
  },
  {
    id: "custom-domain-hostname",
    group: G,
    setup: async (fx) => [await supRoute(fx, "www.customer-site.example.org"), await supRoute(fx, "app.test", "other")],
    host: "www.customer-site.example.org",
    run: async (ctx) => {
      await get(ctx, "custom domain", "/page?x=1");
      await get(ctx, "custom domain, other host header case", "/page", { host: "WWW.Customer-Site.Example.ORG" });
      await get(ctx, "platform host to the other sprout", "/page", { host: "app.test" });
    },
  },
  {
    id: "method-passthrough",
    group: G,
    run: async (ctx) => {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
        await ctx.req(`${method} /seen`, {
          method,
          path: "/seen",
          body: method === "GET" || method === "OPTIONS" ? undefined : "body-" + method,
        });
      await ctx.req("HEAD /seen", { method: "HEAD", path: "/seen" });
      await ctx.req("custom method", { method: "PURGE", path: "/seen" });
    },
  },
];

// ---- forwarding behaviour, both route kinds ----

const forwarding: Case[] = [
  ...both("forward-host-path-query", G, () => ({
    run: async (ctx) => {
      await get(ctx, "plain", "/hello?x=1", { host: "app.test" });
      await get(ctx, "query only chars", "/seen?a=1&b=%20x&c&d=%2F&e=", { host: "app.test" });
      await get(ctx, "encoded path", "/seen/%7Efoo%2Fbar%20baz/%E2%9C%93", { host: "app.test" });
      await get(ctx, "double slash", "//seen//x", { host: "app.test" });
      await get(ctx, "dot segments", "/a/./b/../seen", { host: "app.test" });
      await get(ctx, "root", "/", { host: "app.test" });
      await get(ctx, "long path", `/seen/${"a".repeat(700)}`, { host: "app.test" });
    },
  })),
  ...both("request-headers-forwarded", G, () => ({
    run: async (ctx) => {
      const seen = await ctx.req("headers", {
        path: "/seen",
        method: "POST",
        body: "payload",
        headers: hdrs(
          ["content-type", "text/plain; charset=utf-8"],
          ["cookie", "a=1; b=2"],
          ["authorization", "Bearer abc"],
          ["x-custom", "one"],
          ["x-custom", "two"],
          ["x-forwarded-for", "1.2.3.4"],
          ["origin", "https://o.example"],
          ["referer", "https://r.example/x"],
          ["accept-language", "en"],
          ["if-none-match", '"abc"'],
          ["range", "bytes=0-1"],
          ["x-empty", ""],
        ),
      });
      ctx.note("parsed", json(seen));
    },
  })),
  ...both("internal-headers-stripped", G, () => ({
    run: async (ctx) => {
      await ctx.req("forged internal headers", {
        path: "/seen",
        headers: hdrs(
          ["x-sb-edge-secret", "forged"],
          ["X-SB-Edge-Token", "forged"],
          ["x-sb-binding-call", "1"],
          ["x-sb-url", "https://evil.example/"],
          ["x-keep", "yes"],
        ),
      });
      const echo = await ctx.req("echo", {
        method: "POST",
        path: "/echo",
        body: "payload",
        headers: { "x-sb-edge-secret": "forged" },
      });
      ctx.note("echo body", Buffer.from(echo.body).toString());
    },
  })),
  ...both("upstream-hop-by-hop-headers", G, () => ({
    run: async (ctx) => {
      await get(ctx, "connection and keep-alive from the app", "/cookies", { loose: { strictHop: true } });
    },
  })),
  ...both("response-headers-passthrough", G, () => ({
    run: async (ctx) => {
      await get(ctx, "duplicate set-cookie and x-dup", "/cookies");
      await get(ctx, "302 is not followed", "/redirect?to=https%3A%2F%2Fexample.org%2Fz");
      await get(ctx, "relative redirect", "/redirect");
      await get(ctx, "gen with etag and custom", "/gen?etag=1&x=hello&ct=application/json");
      await ctx.req("HEAD of gen", { method: "HEAD", path: "/gen?size=100" });
    },
  })),
  ...both("status-passthrough", G, () => ({
    run: async (ctx) => {
      for (const status of [200, 201, 204, 301, 400, 404, 418, 500, 502, 503, 504])
        await get(ctx, `status ${status}`, `/status/${status}`);
    },
  })),
  ...both("upstream-5xx", G, () => ({
    run: async (ctx) => {
      await get(ctx, "busy 503", "/busy");
      await get(ctx, "500", "/status/500");
      await get(ctx, "deliberate 500", "/deliberate");
    },
  })),
  ...both("request-body-roundtrip", G, () => ({
    run: async (ctx) => {
      const big = pattern(100 * 1024);
      const echoed = await ctx.req("100 KiB body echo", { method: "POST", path: "/echo", body: big });
      ctx.note("echo equal", Buffer.compare(Buffer.from(echoed.body), Buffer.from(big)) === 0);
      const chunked = await ctx.req("chunked body echo", {
        method: "POST",
        path: "/echo",
        chunks: ["first-", "second-", "third"],
      });
      ctx.note("chunked echo", Buffer.from(chunked.body).toString());
      await ctx.req("seen chunked", { method: "POST", path: "/seen", chunks: ["abc", "def"] });
      await ctx.req("empty POST", { method: "POST", path: "/seen" });
      await ctx.req("POST content-length 0", { method: "POST", path: "/seen", headers: { "content-length": "0" } });
    },
  })),
  ...both("large-response-streams", G, () => ({
    run: async (ctx) => {
      const big = await get(ctx, "3 MiB declared", "/big?n=3145728", { loose: { body: true } });
      ctx.note("big length", big.body.length);
      const streamed = await get(ctx, "1 MiB chunked", "/stream?n=1048576&chunk=65536", { loose: { body: true } });
      ctx.note("streamed length", streamed.body.length);
    },
  })),
  ...both("http10-and-misc-framing", G, () => ({
    run: async (ctx) => {
      await ctx.req("HTTP/1.0 GET", { path: "/hello", httpVersion: "1.0", host: "app.test" });
      await ctx.req("HEAD with body-bearing route", { method: "HEAD", path: "/big?n=1000" });
      await get(ctx, "after the HEAD", "/hello");
    },
  })),
  ...both("log-fields-request-bytes", G, () => ({
    run: async (ctx) => {
      await ctx.req("POST with content-length", { method: "POST", path: "/upload", body: "1234567" });
      await ctx.req("POST chunked", { method: "POST", path: "/upload", chunks: ["1234", "567"] });
      await ctx.req("GET with query", { path: "/hello?secret=token" });
      await get(ctx, "path capped at 512", `/seen/${"b".repeat(600)}`);
      await get(ctx, "log for 404 status", "/status/404");
    },
  })),
];

// ---- uncaught detection, cpu header ----

const uncaught: Case[] = [
  ...both("uncaught-detection", G, () => ({
    run: async (ctx) => {
      await get(ctx, "runtime bare 500 (no content-type, 21 bytes)", "/uncaught");
      await get(ctx, "deliberate 500 with content-type", "/deliberate");
      await get(ctx, "500 without content-length header", "/uncaught-nolen");
      await get(ctx, "marker header on a 500", "/marker");
      await get(ctx, "marker header on a 200", "/uncaught-200");
      await get(ctx, "after the failures", "/hello");
    },
  })),
  ...both("cpu-header-formatting", G, () => ({
    run: async (ctx) => {
      const values = [
        "1.2345",
        "0",
        "",
        "abc",
        "-1",
        "1e3",
        " 5",
        "0x10",
        "Infinity",
        "NaN",
        "1.0005",
        "0.0625",
        "0.3125",
        "2.5",
        "1234567.89012",
        "1e21",
        "1e-7",
        ".5",
        "5.",
        "+3",
        "1,5",
      ];
      for (const v of values) await get(ctx, `x-sb-cpu-ms: ${JSON.stringify(v)}`, `/cpu?v=${encodeURIComponent(v)}`);
      await get(ctx, "no cpu header", "/cpu");
      await get(ctx, "cpu on echo (1.2345) with marker", "/echo");
    },
  })),
];

// ---- caps ----

const caps: Case[] = [
  ...both("response-cap-declared", G, () => ({
    env: { SPROUTBOAT_RESPONSE_MAX_BYTES: "1024" },
    run: async (ctx) => {
      await get(ctx, "exactly the cap", "/big?n=1024");
      await get(ctx, "one over", "/big?n=1025");
      await get(ctx, "far over", "/big?n=100000");
      await get(ctx, "under", "/big?n=10");
      await get(ctx, "zero", "/big?n=0");
    },
  })),
  ...both("response-cap-stream", G, () => ({
    env: { SPROUTBOAT_RESPONSE_MAX_BYTES: "1024" },
    run: async (ctx) => {
      await get(ctx, "streamed within the cap", "/stream?n=1000&chunk=500");
      await get(ctx, "streamed exactly the cap", "/stream?n=1024&chunk=512");
      await get(ctx, "streamed over, small chunks", "/stream?n=4096&chunk=256", { loose: { body: true } });
      await get(ctx, "streamed over, one big chunk", "/stream?n=4096&chunk=4096", { loose: { body: true } });
      await get(ctx, "still serving", "/hello");
    },
  })),
  ...both("response-cap-env-invalid", G, () => ({
    env: { SPROUTBOAT_RESPONSE_MAX_BYTES: "not-a-number" },
    run: async (ctx) => {
      await get(ctx, "default cap applies", "/big?n=200000", { loose: { body: true } });
    },
  })),
  // Bun's rejection is a 413 or a reset depending on timing, so only accepted/rejected is compared.
  ...both("body-cap-content-length", G, () => ({
    env: { SPROUTBOAT_EDGE_MAX_BODY_BYTES: "1024" },
    logs: "off",
    run: async (ctx) => {
      const outcome = async (body: Uint8Array | string) => {
        const res = await ctx.quiet({ method: "POST", path: "/upload", body });
        return res.status === 200 && !res.error ? "accepted" : "rejected";
      };
      ctx.note("1024 bytes", await outcome(bytes(1024)));
      ctx.note("1025 bytes", await outcome(bytes(1025)));
      ctx.note("4000 bytes", await outcome(bytes(4000)));
      ctx.note("small after", await outcome("ok"));
      await get(ctx, "GET after", "/hello");
    },
  })),
  // Bun's chunked rejection is racy (a 413 or a reset, and a 502/proxy log line or none), so only the
  // accepted/rejected outcome is compared and the log is not.
  ...both("body-cap-chunked", G, () => ({
    env: { SPROUTBOAT_EDGE_MAX_BODY_BYTES: "1024" },
    logs: "off",
    run: async (ctx) => {
      const outcome = async (chunks: Uint8Array[]) => {
        const res = await ctx.quiet({ method: "POST", path: "/upload", chunks });
        return res.status === 200 && !res.error ? "accepted" : "rejected";
      };
      ctx.note("chunked 1024", await outcome([bytes(512), bytes(512)]));
      ctx.note("chunked 1025", await outcome([bytes(512), bytes(513)]));
      ctx.note("chunked 4000", await outcome([bytes(1000), bytes(1000), bytes(2000)]));
      await get(ctx, "GET after", "/hello");
    },
  })),
  ...both("body-cap-env-invalid", G, () => ({
    env: { SPROUTBOAT_EDGE_MAX_BODY_BYTES: "0" },
    run: async (ctx) => {
      await ctx.req("zero means default", { method: "POST", path: "/upload", body: bytes(4000) });
    },
  })),
  ...both("body-cap-env-garbage", G, () => ({
    env: { SPROUTBOAT_EDGE_MAX_BODY_BYTES: "12abc" },
    run: async (ctx) => {
      await ctx.req("garbage means default", { method: "POST", path: "/upload", body: bytes(4000) });
    },
  })),
];

// ---- timeouts, down backends, hang-up ----

const failures: Case[] = [
  ...both("timeout-504", G, () => ({
    env: { SPROUTBOAT_REQUEST_TIMEOUT_MS: "300" },
    run: async (ctx) => {
      await get(ctx, "fast", "/hello");
      await get(ctx, "slow past the deadline", "/slow?ms=1500");
      await get(ctx, "never answers", "/hang");
      await get(ctx, "fast again", "/hello");
    },
  })),
  ...both("timeout-mid-body", G, () => ({
    env: { SPROUTBOAT_REQUEST_TIMEOUT_MS: "300" },
    run: async (ctx) => {
      await get(ctx, "headers then a stall past the deadline", "/stall?ms=1200", { loose: { body: true } });
      await get(ctx, "alive after", "/hello");
    },
  })),
  ...both("timeout-env-invalid", G, () => ({
    env: { SPROUTBOAT_REQUEST_TIMEOUT_MS: "soon" },
    run: async (ctx) => {
      await get(ctx, "default deadline, fast request", "/slow?ms=200");
    },
  })),
  {
    id: "client-hangup-during-cold-start.sup",
    group: G,
    run: async (ctx) => {
      await get(ctx, "hang up while the sprout is still starting", "/hang", { hangUpAfterMs: 15 });
      await ctx.sleep(400);
      await get(ctx, "alive after", "/hello");
    },
  },
  // The requester leaves while the sprout (20 ms: the sidecar itself) is still starting. The next
  // requests must join the same start, and the hang-up is logged as a 499 with the cold-start fields.
  ...([20, 300] as const).map((ms): Case => ({
    id: `client-hangup-during-slow-cold-start-${ms}ms.sup`,
    group: G,
    setup: async (fx) => [
      await supRoute(fx, "app.test", "slowboot", {
        script: `#!/bin/sh\nexport APP_NAME=slowboot\nexec sh -c 'sleep 1; exec bun ${join(import.meta.dir, "fake-app.ts")}'\n`,
      }),
    ],
    timeoutMs: 40_000,
    run: async (ctx) => {
      await get(ctx, "hang up while the sprout is still booting", "/hello", { hangUpAfterMs: ms });
      await get(ctx, "second request joins the same start", "/hello", { timeoutMs: 15_000 });
      await get(ctx, "third request", "/hello", { timeoutMs: 5000 });
    },
  })),
  ...both("client-hangup-499", G, () => ({
    run: async (ctx) => {
      await get(ctx, "warm up", "/hello");
      await get(ctx, "hang up while the app is busy", "/hang", { hangUpAfterMs: 200 });
      await ctx.sleep(150);
      await get(ctx, "alive after", "/hello");
    },
  })),
  {
    id: "backend-down.sproutd",
    group: G,
    setup: async (fx) => {
      const port = await fx.closedPort();
      return [
        {
          hostname: "app.test",
          sproutPath: join(fx.dir, "x/sprout"),
          backend: { kind: "sproutd", url: `http://127.0.0.1:${port}` },
        },
      ];
    },
    run: async (ctx) => {
      await get(ctx, "connection refused", "/x");
      await ctx.req("POST to a dead backend", { method: "POST", path: "/x", body: "abc" });
      await get(ctx, "websocket upgrade to a dead backend", "/ws", {
        headers: hdrs(
          ["connection", "Upgrade"],
          ["upgrade", "websocket"],
          ["sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="],
          ["sec-websocket-version", "13"],
        ),
      });
    },
  },
  {
    id: "backend-localhost-url.sproutd",
    group: G,
    setup: async (fx) => [
      {
        hostname: "app.test",
        sproutPath: join(fx.dir, "x/sprout"),
        backend: { kind: "sproutd", url: "http://localhost:1" },
      },
      {
        hostname: "v6.test",
        sproutPath: join(fx.dir, "x/sprout"),
        backend: { kind: "sproutd", url: "http://[::1]:1", extra: true },
      },
    ],
    run: async (ctx) => {
      await get(ctx, "localhost backend (nothing listens)", "/x");
      await get(ctx, "[::1] backend (nothing listens)", "/x", { host: "v6.test" });
    },
  },
  {
    id: "sprout-crash.sup",
    group: G,
    run: async (ctx) => {
      await get(ctx, "warm", "/hello");
      await get(ctx, "sprout drops the connection", "/crash");
      await get(ctx, "after", "/hello");
    },
  },
  {
    id: "sprout-exits-immediately.sup",
    group: G,
    setup: async (fx) => [await supRoute(fx, "app.test", "dead", { script: "#!/bin/sh\nexit 1\n" })],
    timeoutMs: 40_000,
    run: async (ctx) => {
      await get(ctx, "sprout that never listens", "/x", { timeoutMs: 20_000 });
      await get(ctx, "pool counters", "/__sb/pool");
    },
  },
  {
    id: "sprout-missing-file.sup",
    group: G,
    setup: async (fx) => [await supRoute(fx, "app.test", "gone", { missing: true })],
    timeoutMs: 40_000,
    run: async (ctx) => {
      await get(ctx, "sprout executable does not exist", "/x", { timeoutMs: 20_000 });
      await get(ctx, "pool counters", "/__sb/pool");
    },
  },
  {
    id: "sprout-not-executable.sup",
    group: G,
    setup: async (fx) => {
      const route = await supRoute(fx, "app.test", "noexec", { script: "#!/bin/sh\nexit 0\n" });
      (await import("node:fs")).chmodSync(route.sproutPath, 0o644);
      return [route];
    },
    timeoutMs: 40_000,
    run: async (ctx) => {
      await get(ctx, "sprout file is not executable", "/x", { timeoutMs: 20_000 });
    },
  },
];

// ---- cold start ----

const cold: Case[] = [
  {
    id: "cold-start-fields.sup",
    group: G,
    run: async (ctx) => {
      await get(ctx, "first request (cold start)", "/hello");
      await get(ctx, "second request", "/hello");
      await get(ctx, "third request", "/hello");
      await get(ctx, "pool", "/__sb/pool");
    },
  },
  {
    id: "cold-start-no-startup-file.sup",
    group: G,
    setup: async (fx) => [
      await supRoute(fx, "app.test", "nostartup", {
        script: `#!/bin/sh\nexport APP_NAME=nostartup\nexport NO_STARTUP_FILE=1\nexec bun ${join(import.meta.dir, "fake-app.ts")}\n`,
      }),
    ],
    run: async (ctx) => {
      await get(ctx, "cold start, sprout does not report boot", "/hello");
      await get(ctx, "warm", "/hello");
    },
  },
  {
    id: "cold-start-post.sup",
    group: G,
    run: async (ctx) => {
      await ctx.req("first request is a POST with a body", { method: "POST", path: "/upload", body: "abc" });
      await get(ctx, "second", "/hello");
    },
  },
  {
    id: "no-cold-start-fields.sproutd",
    group: G,
    setup: async (fx) => [await backendRoute(fx)],
    run: async (ctx) => {
      await get(ctx, "first", "/hello");
      await get(ctx, "second", "/hello");
    },
  },
  {
    id: "two-hosts-two-sprouts.sup",
    group: G,
    setup: async (fx) => [await supRoute(fx, "a.test", "a"), await supRoute(fx, "b.test", "b")],
    run: async (ctx) => {
      await get(ctx, "a", "/who", { host: "a.test" });
      await get(ctx, "b", "/who", { host: "b.test" });
      await get(ctx, "a again", "/who", { host: "a.test" });
      await get(ctx, "pool", "/__sb/pool");
    },
  },
];

// ---- route snapshot validation at startup ----

const startup = (
  id: string,
  routes: string | ((fx: import("./lib").Fixture) => Promise<string | Json[]> | string | Json[]),
  expectFailure: boolean,
): Case => ({
  id,
  group: "routes-file",
  expectStartFailure: expectFailure,
  setup: async (fx) => (routes instanceof Function ? routes(fx) : routes),
  run: async (ctx) => {
    await get(ctx, "request after a startup that was accepted", "/x");
  },
});

const bad =
  (v: Json) =>
  async (fx: import("./lib").Fixture): Promise<Json[]> => [
    { hostname: "app.test", sproutPath: join(fx.dir, "x/sprout"), backend: v },
  ];

const routeFiles: Case[] = [
  startup("routes-valid-empty-array", "[]", false),
  startup("routes-not-an-array", '{"hostname":"app.test"}', true),
  startup("routes-not-json", "this is not json", true),
  startup("routes-empty-file", "", true),
  startup("routes-null", "null", true),
  startup("routes-entry-null", "[null]", true),
  startup("routes-entry-array", "[[]]", true),
  startup("routes-hostname-uppercase", '[{"hostname":"App.Test","sproutPath":"/x/sprout"}]', true),
  startup("routes-hostname-underscore", '[{"hostname":"a_b.test","sproutPath":"/x/sprout"}]', true),
  startup("routes-hostname-empty", '[{"hostname":"","sproutPath":"/x/sprout"}]', true),
  startup("routes-hostname-number", '[{"hostname":1,"sproutPath":"/x/sprout"}]', true),
  startup("routes-sproutpath-relative", '[{"hostname":"app.test","sproutPath":"x/sprout"}]', true),
  startup("routes-sproutpath-missing", '[{"hostname":"app.test"}]', true),
  startup(
    "routes-backend-without-sproutpath",
    '[{"hostname":"app.test","backend":{"kind":"sproutd","url":"http://127.0.0.1:1"}}]',
    true,
  ),
  startup(
    "routes-one-bad-entry-poisons-all",
    '[{"hostname":"ok.test","sproutPath":"/x/sprout"},{"hostname":"BAD","sproutPath":"/x/sprout"}]',
    true,
  ),
  startup("routes-backend-null", bad(null), true),
  startup("routes-backend-string", bad("http://127.0.0.1:1"), true),
  startup("routes-backend-array", bad([]), true),
  startup("routes-backend-wrong-kind", bad({ kind: "other", url: "http://127.0.0.1:1" }), true),
  startup("routes-backend-no-kind", bad({ url: "http://127.0.0.1:1" }), true),
  startup("routes-backend-non-loopback", bad({ kind: "sproutd", url: "http://10.0.0.5:8600" }), true),
  startup("routes-backend-with-path", bad({ kind: "sproutd", url: "http://127.0.0.1:8600/path" }), true),
  startup("routes-backend-https", bad({ kind: "sproutd", url: "https://127.0.0.1:8600" }), true),
  startup("routes-backend-evil-suffix", bad({ kind: "sproutd", url: "http://127.0.0.1.evil.test:80" }), true),
  startup("routes-backend-no-port", bad({ kind: "sproutd", url: "http://127.0.0.1" }), true),
  startup("routes-backend-six-digit-port", bad({ kind: "sproutd", url: "http://127.0.0.1:123456" }), true),
  startup("routes-backend-trailing-slash", bad({ kind: "sproutd", url: "http://127.0.0.1:8600/" }), true),
  startup("routes-backend-uppercase-localhost", bad({ kind: "sproutd", url: "http://LOCALHOST:8600" }), true),
  startup("routes-backend-port-zero-ok", bad({ kind: "sproutd", url: "http://127.0.0.1:0" }), false),
  startup("routes-backend-ipv6-ok", bad({ kind: "sproutd", url: "http://[::1]:8600" }), false),
  startup("routes-backend-extra-fields-ok", bad({ kind: "sproutd", url: "http://127.0.0.1:8600", weight: 3 }), false),
  startup(
    "routes-extra-fields-ignored",
    async (fx) => [
      {
        hostname: "app.test",
        sproutPath: await fx.makeSprout("app"),
        secretsPath: "/nonexistent/secrets.json",
        secretsHash: "abc",
        services: { GOOD: "other.test", bad: "x", ALSO_BAD: 5, "9NOPE": "y.test" },
        ownerId: "a".repeat(300),
        r2ResourceIds: ["r2_" + "a".repeat(24), "nope", 5],
        doStoreId: "do_" + "b".repeat(24),
        somethingElse: { nested: [1, 2, 3] },
      },
    ],
    false,
  ),
  startup(
    "routes-duplicate-hostname-last-wins",
    async (fx) => [await supRoute(fx, "app.test", "first"), await supRoute(fx, "app.test", "second")],
    false,
  ),
];

export const coreCases: Case[] = [...routing, ...forwarding, ...uncaught, ...caps, ...failures, ...cold, ...routeFiles];

void kindRoute;
