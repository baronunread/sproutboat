# Porffor: local patch + upstream notes

**Local state:** one patch, `patches/porffor-render.patch` — 11 lines, honours
`$PORT` at runtime in the generated native-fetch server. Missing WHATWG surface
is handled in our own prepended prelude (`tools/native-fetch-prelude.js`), not by
patching Porffor: `URLSearchParams` (read + write), `URL.prototype.searchParams`
and the `protocol`/`host`/`hostname`/`port`/`hash` accessors, static
`Response.json`, `crypto.randomUUID` / `crypto.getRandomValues` (Math.random —
NOT crypto-strong), and `structuredClone` (JSON round-trip).

**Upstream plan** (see issue #25): file the two `fetch-globals.js` gaps as **one
issue**, not PRs — the maintainer may want `URL`/`URLSearchParams` as real
builtins under `compiler/builtins/`, so ask first. Hold `$PORT`; the better
framing is "handlers can't read env at all". If Porffor ships the two globals,
delete the corresponding lines from `native-fetch-prelude.js`.

Porffor's AI_POLICY: **disclose AI use** (name the tool), and **do not paste
LLM-written prose** — rewrite the drafts below in your own words before filing.

**alpha-4 checked (2026-08-29, `a415d19`).** Nothing relevant changed:

| Gap | alpha-4 | Action |
| --- | --- | --- |
| `URLSearchParams` / `URL.prototype.searchParams` | still missing (`runtime/fetch-globals.js:204`) | keep prelude; Draft A stands |
| static `Response.json(data, init)` | still missing (`fetch-globals.js:326`, instance `json()` only) | keep prelude; Draft A stands |
| class declaration not hoisted into scope | still throws in interpreter **and** native | Draft B stands |
| env access / `$PORT` | no `Porffor.env`; `porf_native_fetch_get_port` unchanged | keep `patches/porffor-render.patch` (applied clean to alpha-4) |
| compat suite | 30/30 compile, 28/30 match — identical to alpha-3 | GO holds |
| `Date` string parse (`15-date-iso`, `16-date-parts`) | non-ISO strings mis-parsed | **real Porffor bug — file it** (see Draft D) |
| `URL` accessors / `crypto.randomUUID` / `structuredClone` | absent | shimmed in the prelude (this session); fold into Draft A |

So the drafts below are still accurate — bump their version line from
`alpha-3 (03b6b54)` to `alpha-4 (a415d19)` before filing. Re-check on the next
release; the pin is now `#alpha-4` (still a moving tag — bun.lock records
`a415d19`).

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

---

## Draft D — non-ISO `Date` string parsing diverges from V8

**Title:** native-fetch: `new Date("<non-ISO string>")` parses positionally, unlike V8/JSC

alpha-4 (`a415d19`), `porf native`.

ISO 8601 strings parse correctly (`"2024-01-02T03:04:05Z"`, `"2008-03-04"`). But
a lenient/legacy string is read as `year, month, day` in source order rather than
the locale `month/day/year` V8, JSC (Bun) and Deno accept:

```js
new Date("3,5,8").toISOString()
// V8 / Bun / Deno: "2008-03-04T23:00:00.000Z"  (M/D/YY, local tz)
// Porffor native:  "0003-05-08T00:00:00.000Z"
```

Impact: any handler doing `new Date(userSuppliedString)` on non-ISO input gets a
silently wrong date rather than a matching one (or `Invalid Date`). Our harness
sees this on `15-date-iso` / `16-date-parts` with a comma-separated probe value.

Not shimmed locally — replicating V8's full lenient date grammar in a prelude is
disproportionate. Filing so it can be fixed in `compiler/builtins`.
