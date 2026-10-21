// The caller of the service-binding suite. GET /case/NAME runs one case against env.PEER
// and answers with what it observed, as JSON; the driver compares workerd and the platform.
// Reliability is measured from outside (timing, concurrency, aborts) through /call/*.
const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
const bytes256 = () => {
  const b = new Uint8Array(256);
  for (let i = 0; i < 256; i++) b[i] = i;
  return b;
};
const summary = async (res) => {
  const body = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    headers: [...res.headers].filter(([k]) => k.startsWith("x-") || k === "content-type" || k === "location"),
    setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : null,
    bodyLength: body.length,
    bodySha256: hex(await crypto.subtle.digest("SHA-256", body)),
    bodyText: body.length <= 200 ? new TextDecoder().decode(body) : null,
  };
};
const echo = async (res) => ({ status: res.status, echo: await res.json() });

const CASES = {
  get: async (env) => echo(await env.PEER.fetch("https://peer/echo?x=1")),
  urlObject: async (env) => echo(await env.PEER.fetch(new URL("https://peer/echo?y=2"))),
  postText: async (env) =>
    echo(
      await env.PEER.fetch("https://peer/echo", {
        method: "POST",
        body: "hello é",
        headers: { "content-type": "text/plain" },
      }),
    ),
  postBinary: async (env) => echo(await env.PEER.fetch("https://peer/echo", { method: "POST", body: bytes256() })),
  postStream: async (env) =>
    echo(
      await env.PEER.fetch("https://peer/echo", {
        method: "POST",
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("streamed "));
            c.enqueue(new TextEncoder().encode("body"));
            c.close();
          },
        }),
        duplex: "half",
      }),
    ),
  requestObject: async (env) =>
    echo(
      await env.PEER.fetch(
        new Request("https://peer/echo?r=1", { method: "PUT", headers: { "x-from": "request" }, body: "req body" }),
      ),
    ),
  requestPlusInit: async (env) =>
    echo(
      await env.PEER.fetch(
        new Request("https://peer/echo", { method: "PUT", headers: { "x-from": "request" }, body: "req body" }),
        { method: "PATCH", headers: { "x-from": "init" } },
      ),
    ),
  repeatedRequestHeaders: async (env) => {
    const headers = new Headers();
    headers.append("x-multi", "a");
    headers.append("x-multi", "b");
    return echo(await env.PEER.fetch("https://peer/echo", { headers }));
  },
  forwardIncoming: async (env, request) =>
    echo(
      await env.PEER.fetch("https://peer/echo?forwarded=1", {
        method: "POST",
        body: request.body,
        headers: request.headers,
        duplex: "half",
      }),
    ),
  status201: async (env) => summary(await env.PEER.fetch("https://peer/status/201")),
  status404: async (env) => summary(await env.PEER.fetch("https://peer/status/404")),
  status503: async (env) => summary(await env.PEER.fetch("https://peer/status/503")),
  binaryResponse: async (env) => summary(await env.PEER.fetch("https://peer/binary?n=4")),
  bigResponse: async (env) => summary(await env.PEER.fetch("https://peer/big?mb=12")),
  cookies: async (env) => summary(await env.PEER.fetch("https://peer/cookies")),
  redirectDefault: async (env) => summary(await env.PEER.fetch("https://peer/redirect")),
  redirectManual: async (env) => summary(await env.PEER.fetch("https://peer/redirect", { redirect: "manual" })),
  calleeThrows: async (env) => summary(await env.PEER.fetch("https://peer/throw")),
  streamResponse: async (env) => summary(await env.PEER.fetch("https://peer/stream")),
  streamResponseReader: async (env) => {
    const res = await env.PEER.fetch("https://peer/stream");
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
    return { status: res.status, text: chunks.join("") };
  },
  // Streaming, judged by timing rather than content (which a buffered body also gets
  // right): the first of four chunks 300 ms apart arrives early, and a request body
  // sent in two parts 500 ms apart reaches the callee in two parts.
  streamFirstChunk: async (env) => {
    const t0 = Date.now();
    const res = await env.PEER.fetch("https://peer/drip?n=4&gap=300");
    const reader = res.body.getReader();
    const chunks = [];
    let firstMs = -1;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstMs < 0) firstMs = Date.now() - t0;
      chunks.push(new TextDecoder().decode(value));
    }
    return { status: res.status, firstChunkEarly: firstMs >= 0 && firstMs < 250, text: chunks.join("") };
  },
  streamRequestBody: async (env) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode("first "));
        await new Promise((r) => setTimeout(r, 500));
        controller.enqueue(encoder.encode("second"));
        controller.close();
      },
    });
    const res = await env.PEER.fetch("https://peer/bodytiming", { method: "POST", body, duplex: "half" });
    const seen = await res.json();
    return { status: res.status, text: seen.text, arrivedInParts: seen.gapMs > 300 };
  },
  // RPC: methods of the callee's WorkerEntrypoint, called on the binding.
  rpcAdd: async (env) => ({ sum: await env.PEER.add(2, 3) }),
  rpcAsync: async (env) => {
    const pending = env.PEER.slowAdd(4, 5);
    // workerd returns a thenable (JsRpcPromise), not a Promise: compare what callers rely on.
    return { thenable: pending != null && pending.then instanceof Function, sum: await pending };
  },
  rpcRoundTrip: async (env) => {
    const sent = {
      text: "héllo",
      nested: [1, { a: null, b: [true, false] }],
      date: new Date(86400000),
      bytes: new Uint8Array([1, 2, 255]),
      map: new Map([["k", 1]]),
      set: new Set(["x"]),
      missing: undefined,
      nan: NaN,
      negZero: -0,
    };
    const r = await env.PEER.roundTrip(sent);
    return {
      text: r.text,
      nested: r.nested,
      date: r.date instanceof Date ? r.date.getTime() : String(r.date),
      bytes: r.bytes instanceof Uint8Array ? [...r.bytes] : String(r.bytes),
      map: r.map instanceof Map ? [...r.map] : String(r.map),
      set: r.set instanceof Set ? [...r.set] : String(r.set),
      missing: "missing" in r && r.missing === undefined,
      nan: Number.isNaN(r.nan),
      negZero: Object.is(r.negZero, -0),
    };
  },
  rpcThrows: async (env) => {
    try {
      await env.PEER.fail("nope");
      return { threw: false };
    } catch (e) {
      return { threw: true, name: e.name, message: e.message, isRangeError: e instanceof RangeError };
    }
  },
  rpcUnknownMethod: async (env) => {
    try {
      await env.PEER.noSuchMethod();
      return { threw: false };
    } catch (e) {
      return { threw: true, name: e.name, message: e.message };
    }
  },
  rpcThisContext: async (env) => env.PEER.whoAmI(),
  promise: async (env) => {
    const pending = env.PEER.fetch("https://peer/status/200");
    return { isPromise: pending instanceof Promise, status: (await pending).status };
  },
  unboundBinding: async (env) => ({ hasMissing: env.MISSING !== undefined }),
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return new Response("pong");
    if (url.pathname === "/cases") return Response.json(Object.keys(CASES));
    const match = /^\/case\/(\w+)$/.exec(url.pathname);
    if (match) {
      const run = CASES[match[1]];
      if (!run) return new Response("no case " + match[1], { status: 404 });
      try {
        return Response.json({ ok: true, value: await run(env, request) });
      } catch (error) {
        return Response.json({
          ok: false,
          error: (error && error.name) || "Error",
          message: String((error && error.message) || error).slice(0, 200),
        });
      }
    }
    // For the external reliability checks: one call to a callee route, timed by the driver.
    if (url.pathname.startsWith("/call/")) {
      const target = url.pathname.slice(5) + url.search;
      try {
        const res = await env.PEER.fetch("https://peer" + target);
        return new Response(await res.text(), { status: res.status });
      } catch (error) {
        return new Response("call failed: " + ((error && error.message) || error), { status: 502 });
      }
    }
    // Self-recursion through a binding to this same app (SELF): each level calls the next.
    if (url.pathname === "/self") {
      const depth = Number(url.searchParams.get("depth") || 0);
      if (depth >= 50) return new Response("bottom " + depth);
      try {
        const res = await env.SELF.fetch("https://self/self?depth=" + (depth + 1));
        return new Response(await res.text(), { status: res.status });
      } catch (error) {
        return new Response("self failed at " + depth + ": " + ((error && error.message) || error), { status: 508 });
      }
    }
    if (url.pathname === "/mutual") return env.PEER.fetch("https://peer/back");
    return new Response("caller: no route " + url.pathname, { status: 404 });
  },
};
