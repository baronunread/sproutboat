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
