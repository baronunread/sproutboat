import { DurableObject } from "cloudflare:workers";
// Lean SQLite storage on workerd: one Durable Object (SQLite-backed) owns the database and answers raw/run over RPC.
export class Db extends DurableObject {
  raw(sql, params) {
    return this.ctx.storage.sql
      .exec(sql, ...params)
      .raw()
      .toArray();
  }
  run(sql, params) {
    const s = this.ctx.storage.sql;
    s.exec(sql, ...params).toArray();
    return s.exec("SELECT changes()").raw().toArray()[0][0];
  }
}
// A stub belongs to the request that made it, so each call gets its own (cheap).
function db(ns) {
  const stub = () => ns.get(ns.idFromName("feed"));
  return {
    prepare(sql) {
      let p = [];
      return {
        bind(...a) {
          p = a;
          return this;
        },
        raw() {
          return stub().raw(sql, p);
        },
        run() {
          return stub()
            .run(sql, p)
            .then((changes) => ({ meta: { changes } }));
        },
      };
    },
  };
}
let env;
// $12 Server Challenge feed API (SPEC.md) as a Sproutboat handler.
// env.DB is the challenge's SQLite file (start.sh links $SQLITE_PATH into the data dir).

const POST_SQL =
  "SELECT p.id, p.body, p.created_at, u.username, (SELECT count(*) FROM likes l WHERE l.post_id = p.id) FROM posts p JOIN users u ON u.id = p.user_id";
const FEED_SQL = POST_SQL + " ORDER BY p.created_at DESC, p.id DESC LIMIT 20";
const ONE_SQL = POST_SQL + " WHERE p.id = ?";
const INSERT_POST_SQL = "INSERT INTO posts (user_id, body) VALUES (?, ?) RETURNING id, created_at";
const INSERT_LIKE_SQL = "INSERT INTO likes (user_id, post_id) VALUES (?, ?) ON CONFLICT (user_id, post_id) DO NOTHING";
const EXISTS_SQL = "SELECT 1 FROM posts WHERE id = ?";

const started = Date.now();
const HEADERS = { "content-type": "application/json" };
let hmacKey = null;

function send(status, body) {
  return new Response(body, { status, headers: HEADERS });
}
function error(status, message) {
  return send(status, '{"error":"' + message + '"}');
}
function postJson(r) {
  return (
    '{"id":' +
    r[0] +
    ',"body":' +
    JSON.stringify(r[1]) +
    ',"created_at":"' +
    r[2] +
    '","author":' +
    JSON.stringify(r[3]) +
    ',"like_count":' +
    r[4] +
    "}"
  );
}

// "123" -> 123; anything that isn't a positive decimal integer -> 0.
function parseId(s) {
  if (s.length === 0 || s.length > 15) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return 0;
    n = n * 10 + c;
  }
  return n;
}

function b64urlBytes(s) {
  let b = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Returns { id, username } or a Response with the 401.
async function authenticate(request) {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return error(401, "missing bearer token");
  const token = header.slice(7);
  const dot1 = token.indexOf(".");
  const dot2 = dot1 < 0 ? -1 : token.indexOf(".", dot1 + 1);
  if (dot1 < 0 || dot2 < 0 || token.indexOf(".", dot2 + 1) >= 0) return error(401, "invalid or expired token");
  let head, payload, sig;
  try {
    head = JSON.parse(
      atob(
        token
          .slice(0, dot1)
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(Math.ceil(dot1 / 4) * 4, "="),
      ),
    );
    sig = b64urlBytes(token.slice(dot2 + 1));
    const p = token.slice(dot1 + 1, dot2);
    payload = JSON.parse(
      atob(
        p
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(Math.ceil(p.length / 4) * 4, "="),
      ),
    );
  } catch {
    return error(401, "invalid or expired token");
  }
  if (head === null || typeof head !== "object" || head.alg !== "HS256" || sig.length !== 32)
    return error(401, "invalid or expired token");
  if (hmacKey === null) {
    hmacKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }
  const ok = await crypto.subtle.verify("HMAC", hmacKey, sig, new TextEncoder().encode(token.slice(0, dot2)));
  if (!ok || payload === null || typeof payload !== "object") return error(401, "invalid or expired token");
  if (typeof payload.exp !== "number" || payload.exp <= Date.now() / 1000)
    return error(401, "invalid or expired token");
  const id = typeof payload.sub === "string" ? parseId(payload.sub) : 0;
  if (id === 0 || typeof payload.username !== "string") return error(401, "invalid token payload");
  return { id, username: payload.username };
}

async function createPost(request) {
  const user = await authenticate(request);
  if (user instanceof Response) return user;
  let data;
  try {
    data = JSON.parse(await request.text());
  } catch {
    return error(400, "malformed JSON body");
  }
  let body = data !== null && typeof data === "object" ? data.body : undefined;
  if (typeof body !== "string" || (body = body.trim()).length === 0) return error(400, "body is required");
  // "characters" = code points, as the reference implementations count them.
  if (body.length > 500 && Array.from(body).length > 500) return error(400, "body must be at most 500 characters");
  const row = (await env.DB.prepare(INSERT_POST_SQL).bind(user.id, body).raw())[0];
  return send(201, '{"post":' + postJson([row[0], body, row[1], user.username, 0]) + "}");
}

async function like(request, rawId) {
  const user = await authenticate(request);
  if (user instanceof Response) return user;
  const id = parseId(rawId);
  if (id === 0) return error(400, "invalid post id");
  if ((await env.DB.prepare(EXISTS_SQL).bind(id).raw()).length === 0) return error(404, "post not found");
  const changes = (await env.DB.prepare(INSERT_LIKE_SQL).bind(user.id, id).run()).meta.changes;
  return send(
    changes ? 201 : 200,
    '{"liked":true,"already_liked":' + (changes ? "false" : "true") + ',"post_id":' + id + "}",
  );
}

async function route(request) {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf("//") + 2);
  let end = url.indexOf("?", start);
  if (end < 0) end = url.length;
  const path = url.slice(start, end);
  const method = request.method;

  if (method === "GET") {
    if (path === "/feed") {
      const rows = await env.DB.prepare(FEED_SQL).raw();
      let out = '{"posts":[';
      for (let i = 0; i < rows.length; i++) out += (i ? "," : "") + postJson(rows[i]);
      return send(200, out + "]}");
    }
    if (path.startsWith("/posts/") && path.indexOf("/", 7) < 0) {
      const id = parseId(path.slice(7));
      if (id === 0) return error(400, "invalid post id");
      const rows = await env.DB.prepare(ONE_SQL).bind(id).raw();
      if (rows.length === 0) return error(404, "post not found");
      return send(200, '{"post":' + postJson(rows[0]) + "}");
    }
    if (path === "/health") {
      try {
        await env.DB.prepare("SELECT 1").raw();
      } catch (e) {
        return send(503, '{"status":"degraded","db":"unreachable","error":' + JSON.stringify(String(e)) + "}");
      }
      return send(200, '{"status":"ok","db":"ok","uptime_s":' + Math.floor((Date.now() - started) / 1000) + "}");
    }
  } else if (method === "POST") {
    if (path === "/posts") return createPost(request);
    if (path.startsWith("/posts/") && path.endsWith("/like")) {
      const rawId = path.slice(7, path.length - 5);
      if (rawId.indexOf("/") < 0) return like(request, rawId);
    }
  }
  return error(404, "not found");
}

export default {
  async fetch(request, e) {
    env = { JWT_SECRET: e.JWT_SECRET, DB: db(e.DBDO) };
    try {
      return await route(request);
    } catch (e) {
      console.error(String(e));
      return error(500, "internal server error");
    }
  },
};
