// Kitchen-sink Sproutboat app — exercises every binding.
//
//   vars      SITE_NAME
//   secret    ADMIN_TOKEN          (x-admin-token header gate)
//   KV        SESSIONS             login tokens, pruned by cron
//   D1        DB                   notes + email_log + heartbeat
//   R2        UPLOADS              note attachments
//   queue     EMAILS               notification jobs -> queue() handler
//   DO        VIEWS (ViewCounter)  atomic per-note view count
//   analytics METRICS              one data point per request
//   fetch     api.quotable.local   outbound, allowlisted
//   cron      */1 * * * *          -> scheduled(): prune sessions + heartbeat
//   assets    ASSETS (public/)     UI served via env.ASSETS.fetch(request)

export class ViewCounter {
  constructor(state) {
    this.state = state;
  }
  // sync: state.storage.* are blocking calls, so no async needed (http-sync-v0)
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/incr") {
      const n = (this.state.storage.get("n") || 0) + 1;
      this.state.storage.put("n", n);
      return new Response(String(n));
    }
    return new Response(String(this.state.storage.get("n") || 0));
  }
}

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { "content-type": "application/json" } });
}

function ensureSchema(env) {
  env.DB.exec(
    "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, attachment TEXT, created TEXT);" +
    "CREATE TABLE IF NOT EXISTS email_log (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER, sent_at TEXT);" +
    "CREATE TABLE IF NOT EXISTS heartbeat (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, cron TEXT)",
  );
}

export default {
  fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    ensureSchema(env);

    // analytics: one point per request
    env.METRICS.writeDataPoint({ blobs: [request.method, path], indexes: [path], doubles: [1] });

    // POST /login -> a session token in KV, value carries its own expiry
    if (path === "/login" && request.method === "POST") {
      const token = crypto.randomUUID();
      const expires = Date.now() + 60 * 60 * 1000;
      env.SESSIONS.put(token, JSON.stringify({ user: "demo", expires }));
      return json({ token, expires });
    }

    // GET /whoami -> resolve a session token
    if (path === "/whoami") {
      const token = request.headers.get("authorization") || "";
      const raw = env.SESSIONS.get(token.replace(/^Bearer\s+/i, ""));
      if (!raw) return json({ error: "no session" }, 401);
      return json(JSON.parse(raw));
    }

    // POST /notes {title, body}
    if (path === "/notes" && request.method === "POST") {
      const input = JSON.parse(request.body || "{}");
      const res = env.DB.prepare("INSERT INTO notes (title, body, created) VALUES (?, ?, ?)")
        .bind(String(input.title || "untitled"), String(input.body || ""), new Date().toISOString())
        .run();
      const id = res.meta.last_row_id;
      env.EMAILS.send({ noteId: id }); // notify asynchronously
      return json({ id }, 201);
    }

    // GET /notes
    if (path === "/notes" && request.method === "GET") {
      return json(env.DB.prepare("SELECT id, title, created, attachment FROM notes ORDER BY id DESC").all().results);
    }

    // GET /notes/:id  -> note + a fresh view count from the Durable Object
    const noteMatch = /^\/notes\/(\d+)$/.exec(path);
    if (noteMatch && request.method === "GET") {
      const id = noteMatch[1];
      const note = env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first();
      if (!note) return json({ error: "not found" }, 404);
      const stub = env.VIEWS.get(env.VIEWS.idFromName("note:" + id));
      const views = Number(stub.fetch("https://do/incr", { method: "POST" }).text());
      return json({ note, views });
    }

    // POST /notes/:id/attach  (raw body is the file)
    const attachMatch = /^\/notes\/(\d+)\/attach$/.exec(path);
    if (attachMatch && request.method === "POST") {
      const id = attachMatch[1];
      const body = request.body || "";
      // The native-fetch server caps an inbound request body at 1 MiB, so that —
      // not the broker frame — is the real upload ceiling. Large-object R2
      // (chunked put / streaming get) is tracked in baronunread/sproutboat#56.
      if (body.length > 900 * 1024) return json({ error: "file too large — demo R2 upload cap is ~900 KB (see issue #56)" }, 413);
      const key = "note-" + id + "-" + Date.now() + ".txt";
      try {
        env.UPLOADS.put(key, body, { customMetadata: { noteId: id } });
      } catch (e) {
        return json({ error: "R2 put failed: " + (e && e.message || e) }, 502);
      }
      env.DB.prepare("UPDATE notes SET attachment = ? WHERE id = ?").bind(key, id).run();
      return json({ key });
    }

    // GET /attach/:key
    const fileMatch = /^\/attach\/(.+)$/.exec(path);
    if (fileMatch && request.method === "GET") {
      const obj = env.UPLOADS.get(decodeURIComponent(fileMatch[1]));
      if (!obj) return json({ error: "not found" }, 404);
      return new Response(obj.text(), { headers: { "content-type": "text/plain", etag: obj.httpEtag } });
    }

    // GET /attachments -> R2 list (every object in the bucket)
    if (path === "/attachments" && request.method === "GET") {
      const list = env.UPLOADS.list();
      return json(list.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded, httpEtag: o.httpEtag })));
    }

    // GET /quote -> outbound fetch (host from env.QUOTE_URL must be allowlisted)
    if (path === "/quote") {
      const r = fetch(env.QUOTE_URL);
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }

    // GET /admin/stats -> secret-gated dashboard feed: one number per binding
    if (path === "/admin/stats") {
      if (request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) return json({ error: "forbidden" }, 403);
      const metrics = env.METRICS.query({ limit: 8 });
      return json({
        site: env.SITE_NAME,
        kv_sessions: env.SESSIONS.list("").length,
        d1_notes: env.DB.prepare("SELECT count(*) AS n FROM notes").first("n"),
        r2_objects: env.UPLOADS.list().objects.length,
        queue_emails_processed: env.DB.prepare("SELECT count(*) AS n FROM email_log").first("n"),
        cron_heartbeats: env.DB.prepare("SELECT count(*) AS n FROM heartbeat").first("n"),
        analytics_points: metrics.count,
        analytics_recent: metrics.rows.map((r) => ({ at: r.timestamp, method: r.blobs[0], path: r.blobs[1] })),
        last_heartbeat: env.DB.prepare("SELECT at, cron FROM heartbeat ORDER BY id DESC LIMIT 1").first(),
      });
    }

    // Anything else GET -> static assets (env.ASSETS), so `/` serves the UI and
    // `/app.js` etc. resolve. run_sprout_first:true routes every path here first.
    if (request.method === "GET") return env.ASSETS.fetch(request);
    return json({ error: "not found", path }, 404);
  },

  // cron */1: prune expired sessions, record a heartbeat
  scheduled(event) {
    ensureSchema(env);
    const now = Date.now();
    const keys = env.SESSIONS.list("");
    for (let i = 0; i < keys.length; i++) {
      const raw = env.SESSIONS.get(keys[i]);
      if (raw) {
        const s = JSON.parse(raw);
        if (!s.expires || s.expires < now) env.SESSIONS.delete(keys[i]);
      }
    }
    env.DB.prepare("INSERT INTO heartbeat (at, cron) VALUES (?, ?)").bind(new Date(event.scheduledTime).toISOString(), event.cron).run();
  },

  // queue consumer for EMAILS: pretend to send, log to D1
  queue(batch) {
    ensureSchema(env);
    for (let i = 0; i < batch.messages.length; i++) {
      const m = batch.messages[i];
      env.DB.prepare("INSERT INTO email_log (note_id, sent_at) VALUES (?, ?)")
        .bind(Number(m.body && m.body.noteId) || 0, new Date().toISOString())
        .run();
      m.ack();
    }
  },
};
