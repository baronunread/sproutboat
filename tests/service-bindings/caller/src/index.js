// The caller of the service-binding suite. GET /case/NAME runs one case against env.PEER
// and answers with what it observed, as JSON; the driver compares workerd and the platform.
// Reliability is measured from outside (timing, concurrency, aborts) through /call/*.
// oxlint-disable unicorn/no-invalid-fetch-options -- cases send bodies with Requests whose method the rule cannot see, and check that GET and HEAD refuse one.
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
// What a step did: its value, or the class and message of what it threw.
const attempt = async (step) => {
  try {
    return { threw: false, value: await step() };
  } catch (error) {
    return {
      threw: true,
      name: (error && error.name) || "Error",
      typeError: error instanceof TypeError,
      message: String((error && error.message) || error).slice(0, 160),
    };
  }
};
const textStream = (...parts) =>
  new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(new TextEncoder().encode(p));
      c.close();
    },
  });
// The parts of a Request that Fetch defines, as a caller sees them without reading the body.
const describe = (req) => ({
  url: req.url,
  method: req.method,
  headers: [...req.headers],
  redirect: req.redirect,
  bodyUsed: req.bodyUsed,
  hasBody: req.body !== null,
  hasSignal: req.signal != null,
  aborted: req.signal != null ? req.signal.aborted : null,
});

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
  // Request fidelity: fetch(Request), fetch(Request, init) and new Request(request, init).
  requestDefaultContentType: async (env) =>
    echo(await env.PEER.fetch(new Request("https://peer/echo", { method: "POST", body: "plain" }))),
  requestBodyKinds: async () => {
    const kinds = {
      string: "s",
      bytes: new Uint8Array([1, 2]),
      buffer: new ArrayBuffer(2),
      params: new URLSearchParams("a=1&b=2"),
      blob: new Blob(["b"], { type: "text/x-blob" }),
      blobNoType: new Blob(["b"]),
    };
    const out = {};
    for (const [k, body] of Object.entries(kinds)) {
      const req = new Request("https://peer/echo", { method: "POST", body });
      out[k] = { contentType: req.headers.get("content-type"), text: await req.text() };
    }
    return out;
  },
  requestPlusInitBody: async (env) =>
    echo(
      await env.PEER.fetch(
        new Request("https://peer/echo", {
          method: "PUT",
          headers: { "x-from": "request", "content-type": "text/x-req" },
          body: "req body",
        }),
        { body: "init body" },
      ),
    ),
  requestPlusInitHeadersOnly: async (env) =>
    echo(
      await env.PEER.fetch(
        new Request("https://peer/echo", { method: "POST", headers: { "x-from": "request" }, body: "kept" }),
        { headers: { "x-init": "1" } },
      ),
    ),
  requestBodyUsedByFetch: async (env) => {
    const req = new Request("https://peer/echo", { method: "POST", body: "once" });
    const first = await echo(await env.PEER.fetch(req));
    const again = await attempt(() => env.PEER.fetch(req).then((r) => r.status));
    return { first, bodyUsed: req.bodyUsed, again };
  },
  requestBodylessReusable: async (env) => {
    const req = new Request("https://peer/echo?twice=1", { headers: { "x-n": "1" } });
    const a = await echo(await env.PEER.fetch(req));
    const b = await echo(await env.PEER.fetch(req));
    return { a, b, bodyUsed: req.bodyUsed };
  },
  requestUsedBodyThrows: async (env) => {
    const req = new Request("https://peer/echo", { method: "POST", body: "used" });
    const text = await req.text();
    return {
      text,
      bodyUsed: req.bodyUsed,
      readAgain: await attempt(() => req.text()),
      construct: await attempt(() => describe(new Request(req))),
      constructWithBody: await attempt(async () => {
        const fresh = new Request(req, { body: "fresh" });
        return { ...describe(fresh), text: await fresh.text() };
      }),
      clone: await attempt(() => describe(req.clone())),
      fetch: await attempt(() => env.PEER.fetch(req).then((r) => r.status)),
      fetchWithBody: await attempt(() => env.PEER.fetch(req, { body: "fresh" }).then(echo)),
    };
  },
  requestFromRequest: async () => {
    const a = new Request("https://peer/echo?a=1", {
      method: "POST",
      headers: { "x-a": "1", "content-type": "text/x-a" },
      body: "abc",
      redirect: "manual",
    });
    const b = new Request(a);
    b.headers.set("x-b", "2");
    return {
      a: describe(a),
      b: describe(b),
      sameHeaders: a.headers === b.headers,
      bText: await b.text(),
      aRead: await attempt(() => a.text()),
    };
  },
  requestMergeInit: async () => {
    const a = new Request("https://peer/echo?m=1", {
      method: "POST",
      headers: { "x-a": "1", "content-type": "text/x-a" },
      body: "abc",
      redirect: "manual",
    });
    const b = new Request(a, { method: "PUT", headers: { "x-b": "2" } });
    return { a: describe(a), b: describe(b), bText: await b.text() };
  },
  requestMergeInitBody: async () => {
    const a = new Request("https://peer/echo", { method: "POST", headers: { "x-a": "1" }, body: "abc" });
    const b = new Request(a, { body: new Uint8Array([104, 105]), redirect: "manual" });
    return { a: describe(a), b: describe(b), bText: await b.text(), aText: await attempt(() => a.text()) };
  },
  requestAsInit: async (env) => {
    const init = new Request("https://other/", {
      method: "POST",
      headers: { "x-from": "init-request" },
      body: "init req",
    });
    const res = await echo(await env.PEER.fetch("https://peer/echo?asinit=1", init));
    return { ...res, initUsed: init.bodyUsed };
  },
  requestRedirectFromRequest: async (env) => ({
    viaRequest: await summary(await env.PEER.fetch(new Request("https://peer/redirect", { redirect: "manual" }))),
    viaCopy: await summary(
      await env.PEER.fetch(new Request(new Request("https://peer/redirect", { redirect: "manual" }))),
    ),
    initOverrides: await summary(
      await env.PEER.fetch(new Request("https://peer/redirect", { redirect: "manual" }), { redirect: "follow" }),
    ),
    errorMode: await attempt(() =>
      env.PEER.fetch(new Request("https://peer/redirect", { redirect: "error" })).then((r) => r.status),
    ),
    invalid: await attempt(() => describe(new Request("https://peer/", { redirect: "bogus" }))),
  }),
  requestSignal: async (env) => {
    const ac = new AbortController();
    const req = new Request("https://peer/slow?ms=2000", { signal: ac.signal });
    const copy = new Request(req);
    const pending = attempt(() => env.PEER.fetch(copy).then((r) => r.status));
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    const result = await pending;
    return { result, early: Date.now() - t0 < 1500, reqAborted: req.signal.aborted, copyAborted: copy.signal.aborted };
  },
  requestSignalAlreadyAborted: async (env) => ({
    viaRequest: await attempt(() =>
      env.PEER.fetch(new Request("https://peer/echo", { signal: AbortSignal.abort() })).then((r) => r.status),
    ),
    initOverrides: await attempt(() =>
      env.PEER.fetch(new Request("https://peer/echo", { signal: AbortSignal.abort() }), {
        signal: new AbortController().signal,
      }).then((r) => r.status),
    ),
  }),
  requestGetHeadBody: async (env) => ({
    getBody: await attempt(() => describe(new Request("https://peer/", { body: "x" }))),
    headBody: await attempt(() => describe(new Request("https://peer/", { method: "HEAD", body: "x" }))),
    getEmptyBody: await attempt(() => describe(new Request("https://peer/", { body: "" }))),
    getNullBody: await attempt(() => describe(new Request("https://peer/", { body: null }))),
    inheritedBodyToGet: await attempt(() =>
      describe(new Request(new Request("https://peer/", { method: "POST", body: "x" }), { method: "GET" })),
    ),
    fetchGetBody: await attempt(() => env.PEER.fetch("https://peer/echo", { body: "x" }).then((r) => r.status)),
    fetchRequestToGet: await attempt(() =>
      env.PEER.fetch(new Request("https://peer/echo", { method: "POST", body: "x" }), { method: "GET" }).then(
        (r) => r.status,
      ),
    ),
  }),
  requestStreamBody: async (env) => {
    const req = new Request("https://peer/echo", {
      method: "POST",
      body: textStream("stream ", "in a request"),
      duplex: "half",
    });
    return echo(await env.PEER.fetch(req));
  },
  requestStreamBodyCopied: async (env) => {
    const a = new Request("https://peer/echo", {
      method: "POST",
      body: textStream("copied ", "stream"),
      duplex: "half",
    });
    const b = new Request(a, { headers: { "x-copy": "1" } });
    return { aUsed: a.bodyUsed, res: await echo(await env.PEER.fetch(b)), bUsed: b.bodyUsed };
  },
  requestClone: async () => {
    const a = new Request("https://peer/echo", { method: "POST", headers: { "x-a": "1" }, body: "clone me" });
    const b = a.clone();
    b.headers.set("x-b", "2");
    const aText = await a.text();
    return { a: describe(a), b: describe(b), aText, bText: await b.text() };
  },
  requestCloneStream: async (env) => {
    const a = new Request("https://peer/echo", { method: "POST", body: textStream("tee ", "me"), duplex: "half" });
    const b = a.clone();
    return { bText: await b.text(), res: await echo(await env.PEER.fetch(a)) };
  },
  requestCloneIncoming: async (env, request) => {
    const copy = request.clone();
    return {
      sameUrl: copy.url === request.url,
      method: copy.method,
      hasBody: request.body !== null,
      copyHasBody: copy.body !== null,
      text: await copy.text(),
    };
  },
  requestUrl: async () => {
    const urls = [
      "HTTPS://Peer.Example:443/a/./b/../c?q=1#frag",
      "http://peer:80/x y?z=a b",
      "https://peer",
      "https://peer/café",
      "https://user:pw@peer/",
      "https://peer:8443/",
      "/relative",
      "not a url",
    ];
    const out = {};
    for (const u of urls) out[u] = await attempt(() => new Request(u).url);
    out.urlObject = new Request(new URL("https://peer/obj?x=1")).url;
    return out;
  },
  requestMethod: async () => {
    const out = {};
    const methods = [
      "get",
      "post",
      "patch",
      "Delete",
      "options",
      "head",
      "put",
      "PROPFIND",
      "custom",
      "CONNECT",
      "trace",
      "bad method",
    ];
    methods.push("purge", "copy", "lock", "mkcol", "move", "proppatch", "search", "unlock", "acl", "report");
    methods.push(
      "mkactivity",
      "checkout",
      "merge",
      "m-search",
      "msearch",
      "notify",
      "subscribe",
      "unsubscribe",
      "query",
      "track",
    );
    for (const m of methods) out[m] = await attempt(() => new Request("https://peer/", { method: m }).method);
    return out;
  },
  headersImmutability: async (env, request) => {
    const res = await env.PEER.fetch("https://peer/status/200");
    await res.text();
    return {
      incomingRequest: await attempt(() => request.headers.set("x-test", "1")),
      fetchedResponse: await attempt(() => res.headers.set("x-test", "1")),
      ownRequest: await attempt(() => new Request("https://peer/").headers.set("x-test", "1")),
      copiedIncoming: await attempt(() => new Request(request).headers.set("x-test", "1")),
      ownResponse: await attempt(() => new Response("x").headers.set("x-test", "1")),
      copiedResponse: await attempt(() => new Response(null, res).headers.set("x-test", "1")),
      redirectResponse: await attempt(() => Response.redirect("https://peer/").headers.set("x-test", "1")),
    };
  },
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
