# Porffor: local patch + upstream notes

**Local state:** one patch, `patches/porffor-render.patch` — 11 lines, honours
`$PORT` at runtime in the generated native-fetch server. The two missing WHATWG
globals (`URLSearchParams`, static `Response.json`) are handled in our own
prepended prelude (`tools/native-fetch-prelude.js`), not by patching Porffor.

**Upstream plan** (see issue #25): file the two `fetch-globals.js` gaps as **one
issue**, not PRs — the maintainer may want `URL`/`URLSearchParams` as real
builtins under `compiler/builtins/`, so ask first. Hold `$PORT`; the better
framing is "handlers can't read env at all". If Porffor ships the two globals,
delete the corresponding lines from `native-fetch-prelude.js`.

Porffor's AI_POLICY: **disclose AI use** (name the tool), and **do not paste
LLM-written prose** — rewrite the drafts below in your own words before filing.

---

## Draft A — missing WHATWG surface in native-fetch

**Title:** native-fetch: `URLSearchParams` and static `Response.json` missing

alpha-3 (`03b6b54`), `porf native`, `export default { fetch }`.

### 1. no `URLSearchParams` / `URL.prototype.searchParams`

`runtime/fetch-globals.js`'s `URL` has `href`/`origin`/`pathname`/`search`/`toString`
but no `searchParams` and no `URLSearchParams` class.

```js
export default { port: 3000, fetch(request) {
  return new Response(new URL(request.url).searchParams.get("q") ?? "none");
} };
```
```
$ ./handler & curl 'localhost:3000/?q=hi'
Uncaught ReferenceError: URLSearchParams is not defined
```

### 2. no static `Response.json`

Instance `Response.prototype.json()` exists; the static builder
`Response.json(data, init)` (WHATWG / workerd / Bun / Deno) does not.

```js
export default { port: 3000, fetch() { return Response.json({ ok: true }); } };
```
→ `Uncaught TypeError`

### notes

- Query params and JSON responses are core to any handler; without these the
  native-fetch surface can't match "write a Worker".
- We have local polyfills for both (matching the `Porffor.array` / `Porffor.type`
  idioms in the file). `URLSearchParams` is a read-mostly subset:
  `get`/`getAll`/`has`/`forEach`/`toString`; no `set`/`append`/`delete`/`sort`/
  iterator/`size`/live write-back to `url.search`.
- Happy to PR into `fetch-globals.js`, or leave it if you want these as builtins.

---

## Draft B — class declarations not hoisted into scope (separate, optional)

**Title:** class declaration is not visible before its position in source

alpha-3 (`03b6b54`). Fails in both the interpreter and `native`.

```js
class A { get x() { return new B(); } }
class B { constructor() { this.ok = true; } }
console.log(new A().x.ok);   // expected: true
```
```
Uncaught ReferenceError: B is not defined
```

Declaring `B` before `A` works. Per spec, `class` declarations are hoisted to the
top of their scope (in TDZ); by the time `A`'s getter body runs, `B` is
initialised, so source order should not matter. Found this while adding a
`new URLSearchParams()` call inside a `URL` getter in `fetch-globals.js` — had to
move the class above `URL`.

---

## Draft C — env access for handlers (hold ~a month, then raise)

Not "please special-case `PORT`". The real gap: **native-fetch handler JS has no
way to read the process environment.** With a `Porffor.env(name)` (or exposing
`getenv`), the port case is solved in userland:

```js
export default { port: Number(Porffor.env("PORT")) || 3000, fetch() { … } };
```

and env-driven config works generally. Alternatives the maintainer may prefer: a
`--port` compile flag, or a `--port` argv flag on the produced binary (workerd
convention). Our local `patches/porffor-render.patch` hardcodes a `getenv("PORT")`
branch in `porf_native_fetch_get_port()` — fine for us, not the right upstream shape.
