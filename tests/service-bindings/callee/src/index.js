// The callee of the service-binding suite: an echo service plus routes that answer in
// specific ways. It runs unchanged on workerd and on the platform; the suite compares.
const encoder = new TextEncoder();
const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
let calls = 0;

export default {
  async fetch(request, env) {
    calls++;
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/echo") {
      const body = new Uint8Array(await request.arrayBuffer());
      return Response.json({
        method: request.method,
        url: request.url,
        path: url.pathname + url.search,
        headers: [...request.headers].filter(([k]) => k.startsWith("x-") || k === "content-type"),
        bodyLength: body.length,
        bodySha256: hex(await crypto.subtle.digest("SHA-256", body)),
        bodyText: body.length <= 64 ? new TextDecoder().decode(body) : null,
      });
    }
    if (path.startsWith("/status/")) return new Response("status " + path.slice(8), { status: Number(path.slice(8)) });
    if (path === "/binary") {
      const out = new Uint8Array(256 * Number(url.searchParams.get("n") || 1));
      for (let i = 0; i < out.length; i++) out[i] = i & 255;
      return new Response(out, { headers: { "content-type": "application/octet-stream" } });
    }
    if (path === "/big") {
      const size = Math.round(Number(url.searchParams.get("mb") || 1) * 1048576);
      return new Response(new Uint8Array(size).fill(120));
    }
    if (path === "/cookies") {
      const headers = new Headers({ "x-one": "1" });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      headers.append("x-multi", "first");
      headers.append("x-multi", "second");
      return new Response("cookies", { headers });
    }
    if (path === "/redirect") return Response.redirect("https://peer/echo?redirected=1", 302);
    if (path === "/throw") throw new Error("callee failed on purpose");
    if (path === "/slow") {
      await new Promise((resolve) => setTimeout(resolve, Number(url.searchParams.get("ms") || 1000)));
      return new Response("slow done");
    }
    if (path === "/stream") {
      const parts = ["one ", "two ", "three"];
      return new Response(
        new ReadableStream({
          async start(controller) {
            for (const p of parts) {
              controller.enqueue(encoder.encode(p));
              await new Promise((r) => setTimeout(r, 50));
            }
            controller.close();
          },
        }),
      );
    }
    if (path === "/calls") return new Response(String(calls));
    // Mutual recursion: the callee calls the caller back (it binds CALLER).
    if (path === "/back")
      return env.CALLER ? env.CALLER.fetch("https://caller/ping") : new Response("no CALLER binding", { status: 500 });
    return new Response("callee: no route " + path, { status: 404 });
  },
};
