const VERSION = "__VERSION__";

const secret = (name) => {
  try {
    return env[name] ?? null;
  } catch {
    return null;
  }
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    // What the app sees, so the e2e can compare secrets byte for byte.
    if (url.pathname === "/secrets") return Response.json({ TOKEN: secret("TOKEN"), GREETING: secret("GREETING") });
    if (url.pathname === "/host") return new Response(request.headers.get("host") ?? "");
    if (url.pathname === "/post") return new Response(`${VERSION}:${(await request.text()).length}`);
    return new Response(`phase1 ${VERSION}\n`, { headers: { "x-app-version": VERSION } });
  },
};
