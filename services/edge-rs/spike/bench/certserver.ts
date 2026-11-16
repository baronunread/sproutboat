// Stand-in for a platform cert endpoint, Caddy's `get_certificate http` contract:
// GET /cert?server_name=<sni> answers a PEM chain followed by the PEM key (200), or 404.
import { readFileSync, existsSync } from "node:fs";
const dir = process.argv[2], port = Number(process.argv[3] ?? 28700);
Bun.serve({
  hostname: "127.0.0.1", port,
  fetch(req) {
    const name = new URL(req.url).searchParams.get("server_name") ?? "";
    const m = /^[a-z0-9-]+\.(acct-\d{5})\.sproutboat\.app$/.exec(name);
    if (!m) return new Response("no", { status: 404 });
    const d = `${dir}/${m[1]}`;
    if (!existsSync(`${d}/fullchain.pem`)) return new Response("no", { status: 404 });
    return new Response(readFileSync(`${d}/fullchain.pem`, "utf8") + readFileSync(`${d}/privkey.pem`, "utf8"));
  },
});
