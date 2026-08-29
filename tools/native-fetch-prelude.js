// Prepended to every handler by tools/compile.ts, before Porffor's native-fetch
// esbuild bundle. alpha-3's runtime/fetch-globals.js defines URL and Response but
// is missing URLSearchParams / URL.prototype.searchParams and static
// Response.json — this adds them additively. Tracked upstream (patches/UPSTREAM.md);
// delete when Porffor ships them.
//
// Declared before it is referenced: a getter body that names a later top-level
// class throws ReferenceError in alpha-3 (see patches/UPSTREAM.md draft B).

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
