/** The HTTP cases: the same request script goes to the Bun and the Rust egress. */
import {
  call,
  type Call,
  type Json,
  type Outcome,
  type Seen,
  type Service,
  type Upstream,
  type dnsStub,
  TOKEN,
} from "./lib";

export type Ctx = {
  up: Upstream;
  tlsUp: Upstream | null;
  dns: ReturnType<typeof dnsStub> | null;
};

export type Case = {
  id: string;
  suite: "default" | "loopback" | "tls" | "rebind";
  run: (svc: Service, ctx: Ctx) => Promise<Json>;
  /** Headers not compared (framing the two services legitimately differ on). */
  dropHeaders?: string[];
  /** Compare only these parts of the result, by key (the rest is recorded). */
  timeoutMs?: number;
};

export type Obs = { out: Outcome; seen: Seen[] };

async function observe(svc: Service, ctx: Ctx, c: Call, upstream: Upstream = ctx.up): Promise<Obs> {
  const before = upstream.seen.length;
  const out = await call(svc, c);
  return { out, seen: upstream.seen.slice(before) };
}

const cases: Case[] = [];
const add = (c: Case) => cases.push(c);
const at = (ctx: Ctx, path: string) => `http://127.0.0.1:${ctx.up.port}${path}`;

// --- refusals: every address class, as a literal in the URL --------------------------------

const REFUSED: Array<[string, string]> = [
  ["loopback", "127.0.0.1"],
  ["loopback-127.0.0.2", "127.0.0.2"],
  ["loopback-edge", "127.255.255.254"],
  ["private-10", "10.1.2.3"],
  ["private-172", "172.16.0.1"],
  ["private-172-top", "172.31.255.255"],
  ["private-192", "192.168.1.1"],
  ["cgnat", "100.64.0.1"],
  ["cgnat-top", "100.127.255.255"],
  ["metadata", "169.254.169.254"],
  ["link-local", "169.254.0.1"],
  ["this-network", "0.0.0.0"],
  ["this-network-1", "0.1.2.3"],
  ["broadcast", "255.255.255.255"],
  ["reserved-240", "240.0.0.1"],
  ["multicast", "224.0.0.1"],
  ["benchmark", "198.18.0.1"],
  ["test-net-1", "192.0.2.1"],
  ["test-net-2", "198.51.100.7"],
  ["test-net-3", "203.0.113.7"],
  ["ietf-protocol", "192.0.0.1"],
  ["v6-loopback", "[::1]"],
  ["v6-loopback-long", "[0:0:0:0:0:0:0:1]"],
  ["v6-unspecified", "[::]"],
  ["v6-ula", "[fd00::1]"],
  ["v6-ula-fc", "[fc00::1]"],
  ["v6-link-local", "[fe80::1]"],
  ["v6-site-local", "[fec0::1]"],
  ["v6-multicast", "[ff02::1]"],
  ["v6-mapped-loopback", "[::ffff:127.0.0.1]"],
  ["v6-mapped-loopback-hex", "[::ffff:7f00:1]"],
  ["v6-mapped-metadata", "[::ffff:a9fe:a9fe]"],
  ["v6-mapped-private", "[::ffff:10.0.0.1]"],
  ["v6-mapped-upper", "[::FFFF:C0A8:101]"],
  ["v6-compatible", "[::127.0.0.1]"],
  ["v6-compatible-public", "[::8.8.8.8]"],
  ["v6-nat64-loopback", "[64:ff9b::7f00:1]"],
  ["v6-nat64-dotted", "[64:ff9b::127.0.0.1]"],
  ["v6-nat64-metadata", "[64:ff9b::a9fe:a9fe]"],
  ["v6-nat64-local-use", "[64:ff9b:1::1]"],
  ["v6-6to4-loopback", "[2002:7f00:1::]"],
  ["v6-6to4-metadata", "[2002:a9fe:a9fe::1]"],
  ["v6-6to4-private", "[2002:c0a8:101::]"],
  ["v6-discard", "[100::1]"],
  ["v6-documentation", "[2001:db8::1]"],
  ["host-decimal", "2130706433"],
  ["host-hex", "0x7f000001"],
  ["host-hex-dotted", "0x7f.1"],
  ["host-octal", "0177.0.0.1"],
  ["host-short", "127.1"],
  ["host-octal-private", "012.0.0.1"],
  ["host-hex-private", "0xA.0.0.1"],
  ["host-decimal-metadata", "2852039166"],
  ["host-hex-metadata", "0xa9fea9fe"],
  ["host-percent", "%31%32%37.0.0.1"],
  ["host-fullwidth", "１２７.0.0.1"],
  ["host-ideographic-dots", "127。0。0。1"],
  ["host-mixed-octal-hex", "0x7f.0.0.01"],
  ["host-trailing-dot-ip", "127.0.0.1."],
  ["userinfo-trick", "evil.example@127.0.0.1"],
  ["fragment-trick", "127.0.0.1#@evil.example"],
  ["localhost", "localhost"],
  ["localhost-upper", "LOCALHOST"],
  ["localhost-dot", "localhost."],
];
for (const [label, host] of REFUSED) {
  add({
    id: `refuse/${label}`,
    suite: "default",
    run: async (svc, ctx) => observe(svc, ctx, { url: `http://${host}:${ctx.up.port}/x` }),
  });
}
add({
  id: "refuse/https-loopback",
  suite: "default",
  run: (svc, ctx) => observe(svc, ctx, { url: `https://127.0.0.1:${ctx.up.port}/` }),
});
add({
  id: "refuse/post-body-then-refused",
  suite: "default",
  run: (svc, ctx) => observe(svc, ctx, { method: "POST", body: "payload", url: `http://10.0.0.1/` }),
});
add({
  id: "refuse/backslash-host",
  suite: "default",
  run: (svc, ctx) => observe(svc, ctx, { url: `http://x.invalid\\@127.0.0.1:${ctx.up.port}/` }),
});
add({
  id: "resolve/nxdomain",
  suite: "default",
  run: (svc, ctx) => observe(svc, ctx, { url: `http://nonexistent.invalid/` }),
});

// --- the service's own errors ---------------------------------------------------------------

const BAD_URLS: Array<[string, string | null]> = [
  ["absent", null],
  ["empty", ""],
  ["relative", "/relative/path"],
  ["no-scheme", "example.com/x"],
  ["garbage", "nonsense"],
  ["ftp", "ftp://example.com/"],
  ["file", "file:///etc/passwd"],
  ["javascript", "javascript:alert(1)"],
  ["data", "data:text/plain,hi"],
  ["ws", "ws://127.0.0.1:1/"],
  ["wss", "wss://example.com/"],
  ["blob", "blob:http://example.com/uuid"],
  ["empty-host", "http://"],
  ["empty-host-path", "http:///x"],
  ["bad-port", "http://127.0.0.1:99999/"],
  ["space-in-host", "http://exa mple.com/"],
  ["bad-ipv6", "http://[::1/"],
  ["bad-ipv6-2", "http://[1:2:3]/"],
  ["bad-ipv4-octet", "http://256.256.256.256/"],
  ["percent-nul-host", "http://a%00b/"],
  ["caret-host", "http://a^b/"],
  ["scheme-only", "http:"],
  ["scheme-no-slashes", "http:127.0.0.1"],
  ["single-slash", "http:/127.0.0.1/"],
  ["padded", "  http://10.0.0.1/  "],
  ["upper-scheme", "HTTP://10.0.0.1/"],
  ["tab-inside", "http://10.0.\t0.1/"],
];
for (const [label, url] of BAD_URLS) {
  add({ id: `url/${label}`, suite: "default", run: (svc, ctx) => observe(svc, ctx, { url }) });
}
add({
  id: "auth/no-token",
  suite: "default",
  run: (svc, ctx) => observe(svc, ctx, { token: null, url: at(ctx, "/") }),
});
add({
  id: "auth/wrong-same-length",
  suite: "default",
  run: (svc, ctx) => observe(svc, ctx, { token: "x".repeat(TOKEN.length), url: at(ctx, "/") }),
});
add({
  id: "auth/wrong-short",
  suite: "default",
  run: (svc, ctx) => observe(svc, ctx, { token: "x", url: at(ctx, "/") }),
});
add({
  id: "auth/wrong-long",
  suite: "default",
  run: (svc, ctx) => observe(svc, ctx, { token: `${TOKEN}x`, url: at(ctx, "/") }),
});
add({
  id: "auth/empty-token",
  suite: "default",
  run: (svc, ctx) => observe(svc, ctx, { token: "", url: at(ctx, "/") }),
});
add({
  id: "auth/token-before-url-check",
  suite: "default",
  run: (svc, ctx) => observe(svc, ctx, { token: "x", url: null }),
});
add({
  id: "auth/path-ignored",
  suite: "loopback",
  run: (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/ok"), path: "/some/other/path?q=1" }),
});

// --- relaying (loopback allowed) ---------------------------------------------------------

const L = (id: string, run: Case["run"], extra: Partial<Case> = {}) =>
  add({ id: `relay/${id}`, suite: "loopback", run, ...extra });

L("get", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/ok") }));
L("get-no-path", (svc, ctx) => observe(svc, ctx, { url: `http://127.0.0.1:${ctx.up.port}` }));
L("get-query", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/a%20b/%7e?x=1&y=%7E&z=a+b#frag") }));
L("get-query-only", (svc, ctx) => observe(svc, ctx, { url: `http://127.0.0.1:${ctx.up.port}?x=1` }));
L("get-dot-segments", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/a/../b/./c") }));
L("get-upper-scheme", (svc, ctx) => observe(svc, ctx, { url: `HTTP://127.0.0.1:${ctx.up.port}/ok` }));
L("get-host-decimal-allowed", (svc, ctx) => observe(svc, ctx, { url: `http://2130706433:${ctx.up.port}/ok` }));
L("get-localhost", (svc, ctx) => observe(svc, ctx, { url: `http://localhost:${ctx.up.port}/ok` }));
L("get-with-headers", (svc, ctx) =>
  observe(svc, ctx, {
    url: at(ctx, "/ok"),
    headers: {
      "X-Custom": "Hi",
      Authorization: "Bearer abc",
      Cookie: "a=1; b=2",
      "Accept-Language": "it",
      Accept: "text/html",
      "User-Agent": "tester/1",
    },
  }),
);
L("get-no-accept-no-ua", (svc, ctx) =>
  observe(svc, ctx, { url: at(ctx, "/ok"), headers: { accept: "", "user-agent": "" } }),
);
L("get-host-header-ignored", (svc, ctx) =>
  observe(svc, ctx, { url: at(ctx, "/ok"), headers: { host: "evil.example" } }),
);
L("get-content-length-ignored", (svc, ctx) =>
  observe(svc, ctx, { url: at(ctx, "/ok"), headers: { "content-length": "999" } }),
);
L("get-body-dropped", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/ok"), method: "GET", body: "ignored" }));
L("get-forged-egress-headers", (svc, ctx) =>
  observe(svc, ctx, { url: at(ctx, "/ok"), headers: { "x-sb-egress-url-2": "x" } }),
);
L("get-connection-close", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/ok"), headers: { connection: "close" } }));
L("get-dup-request-headers", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/ok"), headers: { "x-multi": "a, b" } }));
L("get-userinfo", (svc, ctx) => observe(svc, ctx, { url: `http://user:pw@127.0.0.1:${ctx.up.port}/ok` }));
L("get-userinfo-percent", (svc, ctx) => observe(svc, ctx, { url: `http://us%40er:p%3Aw@127.0.0.1:${ctx.up.port}/ok` }));
L("get-userinfo-only-name", (svc, ctx) => observe(svc, ctx, { url: `http://user@127.0.0.1:${ctx.up.port}/ok` }));
L("get-userinfo-plus-auth-header", (svc, ctx) =>
  observe(svc, ctx, { url: `http://user:pw@127.0.0.1:${ctx.up.port}/ok`, headers: { authorization: "Bearer mine" } }),
);
for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
  L(`${m.toLowerCase()}-body`, (svc, ctx) =>
    observe(svc, ctx, { method: m, url: at(ctx, "/ok"), body: "payload", headers: { "content-type": "text/plain" } }),
  );
  L(`${m.toLowerCase()}-empty`, (svc, ctx) => observe(svc, ctx, { method: m, url: at(ctx, "/ok") }));
}
L("post-binary", (svc, ctx) =>
  observe(svc, ctx, {
    method: "POST",
    url: at(ctx, "/ok"),
    body: Uint8Array.from({ length: 70000 }, (_, i) => (i * 7) & 255),
    headers: { "content-type": "application/octet-stream" },
  }),
);
L("post-1mib", (svc, ctx) => observe(svc, ctx, { method: "POST", url: at(ctx, "/ok"), body: "x".repeat(1024 * 1024) }));
L("head", (svc, ctx) => observe(svc, ctx, { method: "HEAD", url: at(ctx, "/ok") }));
L("gzip-passthrough", (svc, ctx) =>
  observe(svc, ctx, { url: at(ctx, "/gzip"), headers: { "accept-encoding": "gzip" } }),
);
L("redirect-not-followed", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/redir") }));
L("status-204", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/204") }));
L("status-304", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/304") }));
L("status-404", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/404") }));
L("status-500-custom-reason", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/500") }));
L("empty-body", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/empty") }));
L("untyped-body-gets-octet-stream", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/untyped") }));
L("set-cookie-twice", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/cookies") }));
L("duplicate-response-headers", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/dup") }));
L("chunked-response", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/chunk") }), {
  dropHeaders: ["content-length", "transfer-encoding"],
});
L("close-delimited-response", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/close") }), {
  dropHeaders: ["content-length", "transfer-encoding"],
});
L("big-response-5mib", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/big") }), {
  dropHeaders: ["content-length", "transfer-encoding"],
});
L("truncated-upstream", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/trunc") }));
L("upstream-drops-connection", (svc, ctx) => observe(svc, ctx, { url: at(ctx, "/drop") }));
L("connection-refused", (svc, ctx) => observe(svc, ctx, { url: `http://127.0.0.1:1/` }));
L("connection-refused-localhost", (svc, ctx) => observe(svc, ctx, { url: `http://localhost:1/` }));
L("ipv6-refused-allowed", (svc, ctx) => observe(svc, ctx, { url: `http://[::1]:${ctx.up.port}/` }));
L("blocked-neighbour-still-blocked", (svc, ctx) => observe(svc, ctx, { url: `http://127.0.0.2:${ctx.up.port}/` }));
L("keepalive-reuse-sequence", async (svc, ctx) => {
  const steps: Obs[] = [];
  for (let i = 0; i < 5; i++)
    steps.push(
      await observe(svc, ctx, {
        method: i % 2 ? "POST" : "GET",
        url: at(ctx, `/ok?i=${i}`),
        body: i % 2 ? `n${i}` : undefined,
      }),
    );
  return steps;
});
L("concurrent-16", async (svc, ctx) => {
  const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => call(svc, { url: at(ctx, `/ok?c=${i}`) })));
  return rs.map((r) => [r.status, r.bodyText]);
});

// --- TLS ----------------------------------------------------------------------------------

const S = (id: string, run: Case["run"], extra: Partial<Case> = {}) =>
  add({ id: `tls/${id}`, suite: "tls", run, ...extra });
const tlsUrl = (ctx: Ctx, host: string, path = "/ok") => `https://${host}:${ctx.tlsUp!.port}${path}`;
S("verified-by-name", (svc, ctx) => observe(svc, ctx, { url: tlsUrl(ctx, "localhost") }, ctx.tlsUp!));
S("post-over-tls", (svc, ctx) =>
  observe(svc, ctx, { method: "POST", url: tlsUrl(ctx, "localhost"), body: "secret" }, ctx.tlsUp!),
);
S("name-mismatch-by-ip", (svc, ctx) => observe(svc, ctx, { url: tlsUrl(ctx, "127.0.0.1") }, ctx.tlsUp!));
S("plain-http-to-tls-port", (svc, ctx) =>
  observe(svc, ctx, { url: `http://localhost:${ctx.tlsUp!.port}/ok` }, ctx.tlsUp!),
);
S("https-to-plain-port", (svc, ctx) => observe(svc, ctx, { url: `https://localhost:${ctx.up.port}/ok` }));
S("keepalive-over-tls", async (svc, ctx) => {
  const steps: Obs[] = [];
  for (let i = 0; i < 3; i++)
    steps.push(await observe(svc, ctx, { url: tlsUrl(ctx, "localhost", `/ok?i=${i}`) }, ctx.tlsUp!));
  return steps;
});

// --- DNS rebinding and resolved forms (stub resolver) -------------------------------------

type DnsScript = { [name: string]: string[][] };
export const DNS_SCRIPT = {
  // first answer is allowed, every later one is private: a second lookup would be visible
  "rebind.test": [["127.0.0.1"], ["10.255.255.1"], ["169.254.169.254"]],
  // the reverse: private first, then allowed. Must be refused on the first lookup, and
  // a later request (second lookup) is the only one that may pass
  "rebind-reverse.test": [["10.255.255.1"], ["127.0.0.1"]],
  "mixed.test": [["10.0.0.5", "127.0.0.1", "169.254.169.254"]],
  "all-private.test": [["10.0.0.5", "192.168.0.1"]],
  "mapped.test": [["::ffff:7f00:1"]],
  "mapped-dotted.test": [["::ffff:127.0.0.1"]],
  "nat64.test": [["64:ff9b::7f00:1"]],
  "sixtofour.test": [["2002:7f00:1::"]],
  "ula.test": [["fd00::1"]],
  "linklocal6.test": [["fe80::1"]],
  "cgnat.test": [["100.64.0.1"]],
  "metadata.test": [["169.254.169.254"]],
  "unspec.test": [["0.0.0.0"]],
  "multicast.test": [["224.0.0.1"]],
  "compat.test": [["::7f00:1"]],
  "scoped.test": [["fe80::1%eth0"]],
  "garbage.test": [["not-an-address"]],
  "fallthrough.test": [["::1", "127.0.0.1"]],
  "refused-then-ok.test": [["127.0.0.1"]],
  "empty.test": [[]],
} satisfies DnsScript;
const R = (id: string, run: Case["run"], extra: Partial<Case> = {}) =>
  add({ id: `rebind/${id}`, suite: "rebind", run, ...extra });
const lookupsOf = (ctx: Ctx, name: string) => ctx.dns!.lookups[name] ?? 0;
R("one-lookup-per-request", async (svc, ctx) => {
  const a = await observe(svc, ctx, { url: `http://rebind.test:${ctx.up.port}/ok` });
  return { a, lookups: lookupsOf(ctx, "rebind.test") };
});
R("each-request-resolves-again-and-is-vetted-again", async (svc, ctx) => {
  const a = await observe(svc, ctx, { url: `http://rebind.test:${ctx.up.port}/ok` });
  const b = await observe(svc, ctx, { url: `http://rebind.test:${ctx.up.port}/ok` });
  const c = await observe(svc, ctx, { url: `http://rebind.test:${ctx.up.port}/ok` });
  return { a, b, c, lookups: lookupsOf(ctx, "rebind.test") };
});
R("private-first-refused-without-second-lookup", async (svc, ctx) => {
  const a = await observe(svc, ctx, { url: `http://rebind-reverse.test:${ctx.up.port}/ok` });
  return { a, lookups: lookupsOf(ctx, "rebind-reverse.test") };
});
R("redirect-is-not-followed-so-no-second-lookup", async (svc, ctx) => {
  const a = await observe(svc, ctx, { url: `http://rebind.test:${ctx.up.port}/redir` });
  return { a, lookups: lookupsOf(ctx, "rebind.test") };
});
R("host-header-keeps-the-name", (svc, ctx) => observe(svc, ctx, { url: `http://rebind.test:${ctx.up.port}/ok` }));
R("mixed-answers-only-vetted-used", async (svc, ctx) => ({
  a: await observe(svc, ctx, { url: `http://mixed.test:${ctx.up.port}/ok` }),
  lookups: lookupsOf(ctx, "mixed.test"),
}));
R("fall-through-to-next-address", async (svc, ctx) => ({
  a: await observe(svc, ctx, { url: `http://fallthrough.test:${ctx.up.port}/ok` }),
  lookups: lookupsOf(ctx, "fallthrough.test"),
}));
for (const name of [
  "all-private",
  "mapped",
  "mapped-dotted",
  "nat64",
  "sixtofour",
  "ula",
  "linklocal6",
  "cgnat",
  "metadata",
  "unspec",
  "multicast",
  "compat",
  "scoped",
  "garbage",
  "empty",
]) {
  R(`refused/${name}`, (svc, ctx) => observe(svc, ctx, { url: `http://${name}.test:${ctx.up.port}/ok` }));
}
R("unknown-name", (svc, ctx) => observe(svc, ctx, { url: `http://unknown.test:${ctx.up.port}/ok` }));

export { cases };
