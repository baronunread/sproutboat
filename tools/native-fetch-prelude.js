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
// so Worker code (request ids, cache keys, idempotency keys) runs.
// ponytail: Math.random() is NOT cryptographically strong. Swap for a real
// CSPRNG the moment Porffor exposes one — do not use these for tokens/secrets.
if (globalThis.crypto == null) globalThis.crypto = {};
if (globalThis.crypto.getRandomValues == null) {
  globalThis.crypto.getRandomValues = function (view) {
    for (let i = 0; i < view.length; i++) view[i] = Math.floor(Math.random() * 256);
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
