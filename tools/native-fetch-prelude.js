// Prepended to every handler by tools/compile.ts, before Porffor's native-fetch
// esbuild bundle. Porffor's runtime/fetch-globals.js (checked through alpha-4)
// gives URL (href/origin/pathname/search only) and Response without a static
// json(). This adds, additively, the rest of the WHATWG surface Worker code
// expects: URLSearchParams (read + write), URL.prototype.searchParams and the
// protocol/host/hostname/port/hash accessors, static Response.json,
// crypto.randomUUID / crypto.getRandomValues, and structuredClone. Each is
// feature-detected; delete a block once Porffor ships that global.
// Tracked upstream in patches/UPSTREAM.md.
//
// Declared before it is referenced: a getter body that names a later top-level
// class throws ReferenceError in Porffor (see patches/UPSTREAM.md draft B).

// #41 — cold-start phase marker. Runs as the first thing in the bundle: writes
// the current wall-clock ms to $SB_STARTUP_FILE so the supervisor can split
// cold-start into "spawn -> JS starts" (process + runtime bootstrap) and
// "JS starts -> listening" (module eval + server bind). No-op when unset.
function __sbStartupMark() {
  Porffor.c`
    const char* __f = getenv("SB_STARTUP_FILE");
    if (__f) {
      struct timespec __ts;
      clock_gettime(CLOCK_REALTIME, &__ts);
      double __ms = (double)__ts.tv_sec * 1000.0 + (double)__ts.tv_nsec / 1000000.0;
      char __buf[32];
      int __n = snprintf(__buf, sizeof(__buf), "%.0f", __ms);
      int __fd = open(__f, O_WRONLY | O_CREAT | O_TRUNC, 0600);
      if (__fd >= 0) { write(__fd, __buf, (size_t)__n); close(__fd); }
    }
  `;
}
__sbStartupMark();

class __SproutboatURLSearchParams {
  constructor(init) {
    this._keys = [];
    this._vals = [];
    let raw = init == null ? '' : String(init);
    if (raw.charCodeAt(0) === 63) raw = raw.slice(1); // strip a leading '?'
    if (raw.length === 0) return;
    const pairs = raw.split('&');
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      if (pair.length === 0) continue;
      const eq = pair.indexOf('=');
      const k = eq === -1 ? pair : pair.slice(0, eq);
      const v = eq === -1 ? '' : pair.slice(eq + 1);
      this._keys.push(decodeURIComponent(k.split('+').join(' ')));
      this._vals.push(decodeURIComponent(v.split('+').join(' ')));
    }
  }
  get(name) { for (let i = 0; i < this._keys.length; i++) if (this._keys[i] === name) return this._vals[i]; return null; }
  getAll(name) { const out = []; for (let i = 0; i < this._keys.length; i++) if (this._keys[i] === name) out.push(this._vals[i]); return out; }
  has(name) { for (let i = 0; i < this._keys.length; i++) if (this._keys[i] === name) return true; return false; }
  forEach(cb) { for (let i = 0; i < this._keys.length; i++) cb(this._vals[i], this._keys[i], this); }
  // Mutators: standalone `new URLSearchParams()` building works. They do NOT
  // write back into a URL's `search` (Porffor's URL has no setter) — build the
  // string with toString() and assign it yourself.
  append(name, value) { this._keys.push(String(name)); this._vals.push(String(value)); }
  set(name, value) {
    let found = false;
    for (let i = 0; i < this._keys.length; i++) {
      if (this._keys[i] !== name) continue;
      if (found) { this._keys.splice(i, 1); this._vals.splice(i, 1); i--; }
      else { this._vals[i] = String(value); found = true; }
    }
    if (!found) this.append(name, value);
  }
  delete(name) {
    for (let i = 0; i < this._keys.length; i++) if (this._keys[i] === name) { this._keys.splice(i, 1); this._vals.splice(i, 1); i--; }
  }
  sort() {
    const idx = this._keys.map((_, i) => i).sort((a, b) => (this._keys[a] < this._keys[b] ? -1 : this._keys[a] > this._keys[b] ? 1 : 0));
    this._keys = idx.map((i) => this._keys[i]);
    this._vals = idx.map((i) => this._vals[i]);
  }
  keys() { return this._keys.slice(); }
  values() { return this._vals.slice(); }
  get size() { return this._keys.length; }
  toString() {
    let out = '';
    for (let i = 0; i < this._keys.length; i++) {
      if (i > 0) out += '&';
      out += encodeURIComponent(this._keys[i]) + '=' + encodeURIComponent(this._vals[i]);
    }
    return out;
  }
}

// URL and Response are always defined by Porffor's fetch-globals.js banner.
if (globalThis.URLSearchParams == null) globalThis.URLSearchParams = __SproutboatURLSearchParams;

if (!('searchParams' in URL.prototype)) {
  Object.defineProperty(URL.prototype, 'searchParams', {
    configurable: true,
    get() {
      if (this.__sbSearchParams == null) this.__sbSearchParams = new __SproutboatURLSearchParams(this.search);
      return this.__sbSearchParams;
    },
  });
}

if (Response.json == null) {
  Response.json = function (data, init) {
    const response = new Response(JSON.stringify(data), init);
    if (!response.headers.has('content-type')) response.headers.set('content-type', 'application/json;charset=utf-8');
    return response;
  };
}

// Porffor's URL exposes href / origin / pathname / search only. Add the rest of
// the WHATWG read surface, derived from `origin` (scheme://host[:port]).
// `hash` is always '' server-side — browsers strip the fragment before the
// request, so there is nothing to recover. Tracked upstream (patches/UPSTREAM.md).
function __sbDefineURLAccessor(name, get) {
  if (!(name in URL.prototype)) Object.defineProperty(URL.prototype, name, { configurable: true, get });
}
__sbDefineURLAccessor('protocol', function () {
  const i = this.origin.indexOf('://');
  return i === -1 ? '' : this.origin.slice(0, i + 1);
});
__sbDefineURLAccessor('host', function () {
  const i = this.origin.indexOf('://');
  return i === -1 ? '' : this.origin.slice(i + 3);
});
__sbDefineURLAccessor('hostname', function () {
  const h = this.host;
  const c = h.indexOf(':');
  return c === -1 ? h : h.slice(0, c);
});
__sbDefineURLAccessor('port', function () {
  const h = this.host;
  const c = h.indexOf(':');
  return c === -1 ? '' : h.slice(c + 1);
});
__sbDefineURLAccessor('hash', function () { return ''; });
__sbDefineURLAccessor('username', function () { return ''; });
__sbDefineURLAccessor('password', function () { return ''; });

// crypto.randomUUID / getRandomValues are absent in native-fetch. Provide them
// backed by the OS CSPRNG (`__sbRandomBytes` -> inline C -> /dev/urandom), so
// tokens, idempotency keys and UUIDs are unpredictable. Deliberately no insecure
// fallback — a silent downgrade to a weak source is worse than throwing.
if (globalThis.crypto == null) globalThis.crypto = {};
if (globalThis.crypto.getRandomValues == null) {
  globalThis.crypto.getRandomValues = function (view) {
    const n = view.length >>> 0;
    // WebCrypto caps a single call at 65536 bytes.
    if (n > 65536) throw new RangeError("crypto.getRandomValues: byte length exceeds 65536");
    if (n === 0) return view;
    // One CSPRNG byte per element. Correct for Uint8Array (and randomUUID); a
    // wider view gets its low byte filled, matching the previous polyfill's shape.
    const bytes = __sbRandomBytes(String(n));
    if (bytes.length !== n) throw new Error("crypto.getRandomValues: OS entropy source unavailable");
    for (let i = 0; i < n; i++) view[i] = bytes.charCodeAt(i) & 0xff;
    return view;
  };
}
// structuredClone: JSON round-trip. Lossy (no Map/Set/Date/typed arrays), but
// covers the common "deep-copy a plain object" case Worker code relies on.
if (globalThis.structuredClone == null) {
  // The suggested fix (use structuredClone) is circular — this IS the polyfill,
  // and Porffor exposes no other deep-clone primitive.
  // react-doctor-disable-next-line react-doctor/no-json-parse-stringify-clone
  globalThis.structuredClone = function (value) { return JSON.parse(JSON.stringify(value)); };
}

if (globalThis.crypto.randomUUID == null) {
  globalThis.crypto.randomUUID = function () {
    const b = new Uint8Array(16);
    globalThis.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [];
    for (let i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
  };
}

// ---------------------------------------------------------------------------
// Bindings: env.<KV>, env.<SECRET>, env.<D1>, env.<R2>, and globalThis.fetch,
// backed by a Bun broker on a loopback TCP port. The transport is inline C —
// blocking write/read per call over ONE long-lived connection (http-sync-v0: one
// worker event-loop turn per request, so a blocking roundtrip is acceptable).
// Wire frame:
//   [u32 LE len][ <token> "\n" <json> ]   reply: [u32 LE len][ <json> ]
// SB_BROKER_PORT / SB_BROKER_TOKEN are set by the supervisor next to $PORT.
// If SB_BROKER_PORT is unset the shims below are never installed (compile.ts
// only emits the __sbInstallBindings call when the project declares bindings),
// so a plain worker is byte-for-byte unchanged.
// ponytail: text values only; still AF_INET loopback, not AF_UNIX. A failed
// exchange reconnects and resends once — a broker crash between "request applied"
// and "reply read" can double-apply a non-idempotent op (queue.send, INSERT);
// the old fresh-connection-per-call path just failed the call there instead.
// Binary values + AF_UNIX = v2.

Porffor.c`
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <signal.h>
#include <unistd.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <fcntl.h>
#include <errno.h>
#include <time.h>

u32 porf_native_fetch_alloc_bytestring(const char* input, size_t len);
int porf_native_fetch_read_value(jsval value, const char** out_buf, size_t* out_len, char** out_owned);

// Fill buf with n bytes from the OS CSPRNG. /dev/urandom is present on Linux and
// macOS and inside the bubblewrap sandbox; blocking is not a concern after the
// pool is seeded. Returns 0, or -1 if the source could not be read in full.
static int sb_os_random(unsigned char* buf, size_t n) {
  int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  size_t off = 0;
  while (off < n) {
    long r = read(fd, buf + off, n - off);
    if (r <= 0) {
      if (r < 0 && errno == EINTR) continue;
      close(fd);
      return -1;
    }
    off += (size_t)r;
  }
  close(fd);
  return 0;
}

static int sb_io_all(int fd, unsigned char* buf, size_t len, int writing) {
  size_t done = 0;
  while (done < len) {
    long n = writing ? write(fd, buf + done, len - done) : read(fd, buf + done, len - done);
    if (n <= 0) {
      if (n < 0 && errno == EINTR) continue;
      return -1;
    }
    done += (size_t)n;
  }
  return 0;
}

// One long-lived loopback connection to the broker, reused across every binding
// call. The broker frames each request/reply independently and keeps the socket
// open, so the steady-state per-call cost is just write + read — no socket(),
// connect() handshake or close() each time. -1 = not connected.
static int sb_broker_fd = -1;

static int sb_broker_connect(void) {
  const char* port_s = getenv("SB_BROKER_PORT");
  if (!port_s) return -10;
  signal(SIGPIPE, SIG_IGN); // a dead broker must yield EPIPE, not kill the worker
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons((unsigned short)atoi(port_s));
  addr.sin_addr.s_addr = htonl(0x7f000001u); // 127.0.0.1
  if (connect(fd, (struct sockaddr*)&addr, sizeof(addr)) != 0) { close(fd); return -2; }
  sb_broker_fd = fd;
  return 0;
}

// Send one framed request, read one framed reply, on the persistent fd.
static int sb_broker_exchange(const char* req, size_t req_len, char** resp_out, size_t* resp_len_out) {
  const char* tok = getenv("SB_BROKER_TOKEN");
  size_t tok_len = tok ? strlen(tok) : 0;

  // frame body: token "\n" json
  size_t body_len = tok_len + 1 + req_len;
  unsigned char* frame = (unsigned char*)malloc(4 + body_len);
  if (!frame) return -5;
  frame[0] = (unsigned char)(body_len & 0xff);
  frame[1] = (unsigned char)((body_len >> 8) & 0xff);
  frame[2] = (unsigned char)((body_len >> 16) & 0xff);
  frame[3] = (unsigned char)((body_len >> 24) & 0xff);
  if (tok_len) memcpy(frame + 4, tok, tok_len);
  frame[4 + tok_len] = '\n';
  if (req_len) memcpy(frame + 4 + tok_len + 1, req, req_len);
  int wr = sb_io_all(sb_broker_fd, frame, 4 + body_len, 1);
  free(frame);
  if (wr != 0) return -3;

  unsigned char rhdr[4];
  if (sb_io_all(sb_broker_fd, rhdr, 4, 0) != 0) return -4;
  size_t rlen = (size_t)rhdr[0] | ((size_t)rhdr[1] << 8) | ((size_t)rhdr[2] << 16) | ((size_t)rhdr[3] << 24);

  char* buf = (char*)malloc(rlen ? rlen : 1);
  if (!buf) return -5;
  if (rlen && sb_io_all(sb_broker_fd, (unsigned char*)buf, rlen, 0) != 0) { free(buf); return -6; }

  *resp_out = buf;
  *resp_len_out = rlen;
  return 0;
}

static int sb_broker_roundtrip(const char* req, size_t req_len, char** resp_out, size_t* resp_len_out) {
  *resp_out = NULL;
  *resp_len_out = 0;
  // Two tries: a broker restart (or an idle-closed socket) invalidates the fd,
  // so a failed exchange drops the connection and reconnects once before failing.
  for (int attempt = 0; attempt < 2; attempt++) {
    if (sb_broker_fd < 0) {
      int rc = sb_broker_connect();
      if (rc != 0) return rc;
    }
    int rc = sb_broker_exchange(req, req_len, resp_out, resp_len_out);
    if (rc == 0) return 0;
    close(sb_broker_fd);
    sb_broker_fd = -1;
  }
  return -3;
}
`;

// One request string in, one reply string out. `reqJson` is a parameter, so the
// generated C names it directly in the RawC block below.
function __sbCall(reqJson) {
  let res = '';
  Porffor.c`
    const char* __req; size_t __reqlen; char* __reqowned = 0;
    porf_native_fetch_read_value(reqJson, &__req, &__reqlen, &__reqowned);
    char* __resp = 0; size_t __resplen = 0;
    int __rc = sb_broker_roundtrip(__req, __reqlen, &__resp, &__resplen);
    if (__reqowned) free(__reqowned);
    if (__rc == 0) {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__resp, __resplen), 195);
      free(__resp);
    } else {
      char __e[40];
      int __n = snprintf(__e, sizeof(__e), "{\"ok\":false,\"error\":\"broker rc %d\"}", __rc);
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__e, (size_t)__n), 195);
    }
  `;
  return res;
}

// `nStr` is the decimal byte count as a string (same string-param pattern as
// __sbEnv). Returns a bytestring of that many CSPRNG bytes, or '' on failure.
function __sbRandomBytes(nStr) {
  let out = '';
  Porffor.c`
    const char* __ns; size_t __nsl; char* __nso = 0;
    porf_native_fetch_read_value(nStr, &__ns, &__nsl, &__nso);
    char __nb[16];
    size_t __k = __nsl < 15 ? __nsl : 15;
    memcpy(__nb, __ns, __k); __nb[__k] = 0;
    if (__nso) free(__nso);
    long __n = atol(__nb);
    if (__n > 0 && __n <= 65536) {
      unsigned char* __b = (unsigned char*)malloc((size_t)__n);
      if (__b) {
        if (sb_os_random(__b, (size_t)__n) == 0)
          out = porf_box((f64)porf_native_fetch_alloc_bytestring((const char*)__b, (size_t)__n), 195);
        free(__b);
      }
    }
  `;
  return out;
}

function __sbRpc(op, extra) {
  const req = { op };
  if (extra) for (const k in extra) req[k] = extra[k];
  const reply = JSON.parse(__sbCall(JSON.stringify(req)));
  if (reply && reply.ok === false) throw new Error(`sproutboat ${op}: ${reply.error || 'failed'}`);
  return reply;
}

// D1: a Cloudflare-shaped `env.<DB>` (prepare / bind / all / run / raw / first,
// plus batch and exec). Every call is one broker roundtrip.
function __sbMakeD1(dbName) {
  function stmt(sql, params) {
    const s = {
      __sql: sql,
      __params: params,
      bind() { return stmt(sql, Array.prototype.slice.call(arguments)); },
      all() {
        const r = __sbRpc('d1.query', { db: dbName, sql, params });
        return { results: r.results || [], success: true, meta: r.meta || {} };
      },
      run() { return s.all(); },
      raw() {
        const rows = s.all().results;
        const out = [];
        for (let i = 0; i < rows.length; i++) {
          const cols = [];
          for (const k in rows[i]) cols.push(rows[i][k]);
          out.push(cols);
        }
        return out;
      },
      first(column) {
        const rows = s.all().results;
        if (rows.length === 0) return null;
        return column == null ? rows[0] : rows[0][column];
      },
    };
    return s;
  }
  return {
    prepare(sql) { return stmt(String(sql), []); },
    batch(statements) {
      const list = [];
      for (let i = 0; i < (statements || []).length; i++) list.push({ sql: statements[i].__sql, params: statements[i].__params });
      const r = __sbRpc('d1.batch', { db: dbName, statements: list });
      const out = [];
      for (let i = 0; i < (r.results || []).length; i++) out.push({ results: r.results[i].results || [], success: true, meta: r.results[i].meta || {} });
      return out;
    },
    exec(sql) {
      __sbRpc('d1.exec', { db: dbName, sql: String(sql) });
      return { count: (String(sql).match(/;/g) || []).length, duration: 0 };
    },
  };
}

// R2: a Cloudflare-shaped object. When `body` is present the sync accessors
// mirror R2ObjectBody's async ones (a worker may `await` them harmlessly).
function __sbR2Object(meta, body) {
  const obj = {
    key: meta.key,
    size: meta.size,
    etag: meta.etag,
    httpEtag: '"' + meta.etag + '"',
    uploaded: meta.uploaded,
    httpMetadata: meta.httpMetadata || {},
    customMetadata: meta.customMetadata || {},
  };
  if (body != null) {
    obj.body = body;
    obj.text = function () { return body; };
    obj.json = function () { return JSON.parse(body); };
  }
  return obj;
}

// Installed only when the project declares bindings. `env` is the module-scoped
// object from compile.ts (a `const`, but mutable); we add the binding accessors
// to it in place. compile.ts emits `__sbInstallBindings(env, {...})` right after
// the `const env = {...}` line.
globalThis.__sbInstallBindings = function (target, bindings) {
  if (!target) return;

  for (let i = 0; i < (bindings.kv || []).length; i++) {
    const ns = bindings.kv[i];
    target[ns] = {
      get(key) {
        const r = __sbRpc('kv.get', { ns, key: String(key) });
        return r.found ? r.value : null;
      },
      put(key, value) {
        __sbRpc('kv.put', { ns, key: String(key), value: String(value) });
      },
      delete(key) {
        __sbRpc('kv.delete', { ns, key: String(key) });
      },
      list(prefix) {
        return __sbRpc('kv.list', { ns, prefix: prefix == null ? '' : String(prefix) }).keys || [];
      },
    };
  }

  for (let i = 0; i < (bindings.secrets || []).length; i++) {
    const name = bindings.secrets[i];
    // Fetch lazily, then freeze as a data property: a secret is process-lifetime
    // immutable (a new value means a redeploy = a new process), so one broker
    // round-trip on first read, zero after. A getter that RPCs on every access
    // turns `'Bearer ' + env.KEY` in a loop into a syscall storm.
    Object.defineProperty(target, name, {
      configurable: true,
      get() {
        const value = __sbRpc('secret.get', { name }).value;
        Object.defineProperty(target, name, { value, configurable: true, enumerable: true });
        return value;
      },
    });
  }

  for (let i = 0; i < (bindings.d1 || []).length; i++) {
    const name = bindings.d1[i];
    target[name] = __sbMakeD1(name);
  }

  for (let i = 0; i < (bindings.r2 || []).length; i++) {
    const name = bindings.r2[i];
    target[name] = {
      put(key, value, options) {
        const o = options || {};
        return __sbRpc('r2.put', {
          bucket: name,
          key: String(key),
          body: value == null ? '' : String(value),
          httpMetadata: o.httpMetadata || {},
          customMetadata: o.customMetadata || {},
        }).object;
      },
      get(key) {
        const r = __sbRpc('r2.get', { bucket: name, key: String(key) });
        return r.found ? __sbR2Object(r.object, r.body == null ? '' : r.body) : null;
      },
      head(key) {
        const r = __sbRpc('r2.head', { bucket: name, key: String(key) });
        return r.found ? __sbR2Object(r.object, null) : null;
      },
      delete(key) {
        __sbRpc('r2.delete', { bucket: name, key: String(key) });
      },
      list(options) {
        const o = options || {};
        const r = __sbRpc('r2.list', {
          bucket: name,
          prefix: o.prefix == null ? '' : String(o.prefix),
          cursor: o.cursor == null ? '' : String(o.cursor),
          limit: o.limit == null ? 1000 : o.limit,
        });
        const objects = [];
        for (let j = 0; j < (r.objects || []).length; j++) objects.push(__sbR2Object(r.objects[j], null));
        return { objects, truncated: !!r.truncated, cursor: r.cursor || undefined };
      },
    };
  }

  for (let i = 0; i < (bindings.queues || []).length; i++) {
    const name = bindings.queues[i];
    target[name] = {
      send(body, options) {
        const o = options || {};
        __sbRpc('queue.send', { queue: name, body: typeof body === 'string' ? body : JSON.stringify(body), delaySeconds: o.delaySeconds || 0 });
      },
      sendBatch(messages) {
        const list = [];
        for (let j = 0; j < (messages || []).length; j++) {
          const m = messages[j];
          list.push({ body: typeof m.body === 'string' ? m.body : JSON.stringify(m.body), delaySeconds: (m.delaySeconds || 0) });
        }
        __sbRpc('queue.send_batch', { queue: name, messages: list });
      },
    };
  }

  for (let i = 0; i < (bindings.analytics || []).length; i++) {
    const name = bindings.analytics[i];
    target[name] = {
      writeDataPoint(event) {
        const e = event || {};
        __sbRpc('ae.write', {
          dataset: name,
          indexes: e.indexes || [],
          blobs: e.blobs || [],
          doubles: e.doubles || [],
        });
      },
      // Sproutboat extension (Cloudflare AE is write-only from a Worker — you
      // query it via the SQL API). Returns { count, rows }.
      query(options) {
        const o = options || {};
        return __sbRpc('ae.query', { dataset: name, limit: o.limit || 20 });
      },
    };
  }

  for (let i = 0; i < (bindings.do || []).length; i++) {
    const b = bindings.do[i];
    target[b.binding] = __sbMakeDONamespace(b.binding, b.className);
  }

  // Static assets: env.<ASSETS>.fetch(request) -> broker `assets.get`. The edge
  // already serves matching files directly; the worker only calls this for paths
  // it wants to own (SPA fallback, auth-gated files). Text assets only — binary
  // files go through the edge (the broker frame is UTF-8 JSON).
  if (bindings.assets) {
    target[bindings.assets] = {
      fetch(input) {
        let path = typeof input === 'string' ? input : String(input && input.url || '/');
        try { path = new URL(path, 'http://a').pathname; } catch (_e) { /* use as-is */ }
        const r = __sbRpc('assets.get', { path });
        const headers = {};
        if (r.type) headers['content-type'] = r.type;
        if (r.found) headers['etag'] = '"' + r.hash + '"';
        return new Response(r.body == null ? '' : r.body, { status: r.status || (r.found ? 200 : 404), headers });
      },
    };
  }

  if ((bindings.outbound || []).length > 0) {
    globalThis.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : String(input.url);
      const opts = init || {};
      const headers = [];
      if (opts.headers) {
        if (typeof opts.headers.forEach === 'function') opts.headers.forEach((v, k) => headers.push([k, v]));
        else for (const k in opts.headers) headers.push([k, opts.headers[k]]);
      }
      const r = __sbRpc('fetch', {
        url,
        method: opts.method || 'GET',
        headers,
        body: opts.body == null ? null : String(opts.body),
      });
      const respHeaders = new Headers();
      for (let j = 0; j < (r.headers || []).length; j++) respHeaders.set(r.headers[j][0], r.headers[j][1]);
      return new Response(r.body == null ? '' : r.body, { status: r.status || 502, headers: respHeaders });
    };
  }
};

// ---------------------------------------------------------------------------
// Durable Objects. The class runs here in the sandboxed worker. There is exactly
// one worker process per deployment (the supervisor model) and the native-fetch
// runtime processes one turn at a time, so calls to a given object id are
// already serialized — `env.<NS>.get(id).fetch()` invokes the instance directly,
// no round-trip. Only `state.storage.*` goes to the broker (so object state
// outlives a worker restart), scoped to (class, id).
// ponytail: serialization relies on the single worker process; a multi-worker
// deployment needs the broker to hold a per-id lock (cloud). Storage ops are one
// key at a time; blockConcurrencyWhile just runs the fn.

function __sbMakeDONamespace(binding, className) {
  return {
    idFromName(name) { return { toString() { return 'name:' + String(name); }, name: String(name) }; },
    idFromString(hex) { return { toString() { return String(hex); } }; },
    newUniqueId() {
      return { toString() { return 'uid:' + crypto.randomUUID(); } };
    },
    get(id) {
      const idStr = typeof id === 'string' ? id : id.toString();
      return {
        fetch(input, init) {
          let req;
          if (input && typeof input === 'object' && typeof input.url === 'string' && !init) {
            req = input;
          } else {
            const url = typeof input === 'string' ? input : String((input && input.url) || 'https://do/');
            const opts = init || {};
            const headers = new Headers();
            if (opts.headers) {
              if (typeof opts.headers.forEach === 'function') opts.headers.forEach((v, k) => headers.set(k, v));
              else for (const k in opts.headers) headers.set(k, opts.headers[k]);
            }
            req = new Request(url, { method: opts.method || 'GET', headers });
            if (opts.body != null) req.body = String(opts.body);
          }
          return __sbGetDOInstance(className, idStr).fetch(req);
        },
      };
    },
  };
}

const __sbDOClasses = {};
const __sbDOInstances = {};
globalThis.__sbRegisterDO = function (map) {
  for (const k in map) __sbDOClasses[k] = map[k];
};

function __sbGetDOInstance(cls, id) {
  const Ctor = __sbDOClasses[cls];
  if (!Ctor) throw new Error('no such Durable Object class: ' + cls);
  const cacheKey = cls + ' ' + id;
  let inst = __sbDOInstances[cacheKey];
  if (!inst) {
    const state = {
      id: { toString() { return id; } },
      storage: __sbDOStorage(cls, id),
      blockConcurrencyWhile(fn) { return fn(); },
      waitUntil() {},
    };
    inst = new Ctor(state, globalThis.env);
    __sbDOInstances[cacheKey] = inst;
  }
  return inst;
}

function __sbDOStorage(cls, id) {
  return {
    get(key) {
      if (Array.isArray(key)) {
        const out = new Map();
        for (let i = 0; i < key.length; i++) {
          const r = __sbRpc('do.storage.get', { cls, id, key: String(key[i]) });
          if (r.found) out.set(key[i], JSON.parse(r.value));
        }
        return out;
      }
      const r = __sbRpc('do.storage.get', { cls, id, key: String(key) });
      return r.found ? JSON.parse(r.value) : undefined;
    },
    put(key, value) {
      if (key != null && typeof key === 'object') {
        for (const k in key) __sbRpc('do.storage.put', { cls, id, key: String(k), value: JSON.stringify(key[k]) });
        return;
      }
      __sbRpc('do.storage.put', { cls, id, key: String(key), value: JSON.stringify(value) });
    },
    delete(key) {
      if (Array.isArray(key)) {
        let n = 0;
        for (let i = 0; i < key.length; i++) n += __sbRpc('do.storage.delete', { cls, id, key: String(key[i]) }).deleted ? 1 : 0;
        return n;
      }
      return !!__sbRpc('do.storage.delete', { cls, id, key: String(key) }).deleted;
    },
    deleteAll() { __sbRpc('do.storage.delete_all', { cls, id }); },
    list(options) {
      const o = options || {};
      const r = __sbRpc('do.storage.list', { cls, id, prefix: o.prefix == null ? '' : String(o.prefix), limit: o.limit == null ? 1000 : o.limit });
      const out = new Map();
      for (let i = 0; i < (r.entries || []).length; i++) out.set(r.entries[i][0], JSON.parse(r.entries[i][1]));
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Trigger dispatch. The compiled server only ever calls `fetch(request)`; this
// routes the internal `x-sb-trigger` requests (sent by the broker, authenticated
// with SB_BROKER_TOKEN) to the right user handler, and everything else to
// `handlers.fetch`.

function __sbEnv(name) {
  let res = '';
  Porffor.c`
    const char* __n; size_t __nl; char* __no = 0;
    porf_native_fetch_read_value(name, &__n, &__nl, &__no);
    char __key[128];
    size_t __kn = __nl < 127 ? __nl : 127;
    memcpy(__key, __n, __kn); __key[__kn] = 0;
    if (__no) free(__no);
    const char* __v = getenv(__key);
    if (__v) res = porf_box((f64)porf_native_fetch_alloc_bytestring(__v, strlen(__v)), 195);
  `;
  return res;
}

function __sbTriggerAuthed(request) {
  const want = __sbEnv('SB_BROKER_TOKEN');
  if (!want) return true; // no token configured (local/dev)
  return request.headers.get('x-sb-token') === want;
}

globalThis.__sbEntry = function (handlers, request) {
  const trigger = request.headers.get('x-sb-trigger');
  if (!trigger) return handlers.fetch(request);
  if (!__sbTriggerAuthed(request)) return new Response('forbidden', { status: 403 });

  if (trigger === 'scheduled') {
    if (typeof handlers.scheduled !== 'function') return new Response('no scheduled handler', { status: 404 });
    const body = __sbReadJson(request);
    handlers.scheduled({ cron: body.cron || '', scheduledTime: body.scheduledTime || Date.now(), noRetry() {} });
    return new Response('', { status: 204 });
  }

  if (trigger === 'queue') {
    if (typeof handlers.queue !== 'function') return new Response('no queue handler', { status: 404 });
    const body = __sbReadJson(request);
    const acked = [];
    const retried = [];
    const raw = body.messages || [];
    const messages = [];
    for (let i = 0; i < raw.length; i++) {
      const m = raw[i];
      const msg = {
        id: m.id,
        timestamp: m.timestamp,
        attempts: m.attempts || 1,
        body: __sbTryParse(m.body),
        ack() { if (acked.indexOf(m.id) === -1) acked.push(m.id); },
        retry() { if (retried.indexOf(m.id) === -1) retried.push(m.id); },
      };
      messages.push(msg);
    }
    const batch = {
      queue: body.queue || '',
      messages,
      ackAll() { for (let i = 0; i < messages.length; i++) messages[i].ack(); },
      retryAll() { for (let i = 0; i < messages.length; i++) messages[i].retry(); },
    };
    handlers.queue(batch);
    // default: any message neither acked nor retried is treated as acked
    for (let i = 0; i < messages.length; i++) {
      if (acked.indexOf(messages[i].id) === -1 && retried.indexOf(messages[i].id) === -1) acked.push(messages[i].id);
    }
    return new Response(JSON.stringify({ ack: acked, retry: retried }), { headers: { 'content-type': 'application/json' } });
  }

  
  return new Response('unknown trigger', { status: 400 });
};

function __sbReadJson(request) {
  try { return JSON.parse(request.body == null ? '{}' : String(request.body)); } catch (e) { return {}; }
}
function __sbTryParse(s) {
  try { return JSON.parse(s); } catch (e) { return s; }
}
