# Porffor: upstream notes

**Local patching moved out.** The pin and every Porffor source patch now live in
`@sproutboat/toolchain` (`ensurePorffor` + `ensurePorfforPatched`), shared with
`sproutboat-cli`; its `patches/UPSTREAM.md` is the current, complete list ($PORT,
request-body limit, status lines, console sink, remote address). The WHATWG
surface shims moved to `@sproutboat/runtime`'s prelude
(`URLSearchParams`, `URL` accessors, static `Response.json`, `crypto.randomUUID`
/ `getRandomValues`, `structuredClone`).

The drafts below are Porffor findings this repo raised that are **not** yet
covered there; keep them until filed.

**Upstream plan** (see issue #25): file the two `fetch-globals.js` gaps as **one
issue**, not PRs — the maintainer may want `URL`/`URLSearchParams` as real
builtins under `compiler/builtins/`, so ask first. Hold `$PORT`; the better
framing is "handlers can't read env at all". If Porffor ships the two globals,
delete the corresponding lines from `native-fetch-prelude.js`.

Porffor's AI_POLICY: **disclose AI use** (name the tool), and **do not paste
LLM-written prose** — rewrite the drafts below in your own words before filing.

**alpha-5 checked (2026-09-10, `1f4ae4a`).** Nothing relevant changed:

| Gap                                                                   | alpha-5                                                                                                       | Action                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `URLSearchParams` / `URL.prototype.searchParams`                      | still missing (shimmed in `@sproutboat/runtime`)                                                              | Draft A stands                                                                                                                                                                                            |
| static `Response.json(data, init)`                                    | still missing (instance `json()` only; shimmed)                                                               | Draft A stands                                                                                                                                                                                            |
| class declaration not hoisted into scope                              | still throws in interpreter and native                                                                        | Draft B stands                                                                                                                                                                                            |
| `Date` non-ISO string parse (`15-date-iso`, `16-date-parts`)          | parses positionally, unlike V8: implementation-defined, needs a realistic (not synthetic) input before filing | Draft D — needs revision, not yet filable                                                                                                                                                                 |
| `Date` timezone offsets (`32-date-offset`)                            | ignored, folded into ms: a real bug on valid ISO 8601 input                                                   | Draft E — filed as [#387](https://github.com/CanadaHonk/porffor/issues/387)                                                                                                                               |
| promise-resolve thenable probe can spin forever                       | reproduced with lldb; missing prototype-walk termination guard                                                | Draft F — filed as [#388](https://github.com/CanadaHonk/porffor/issues/388)                                                                                                                               |
| `Request`/`Response` accept no byte body (`Uint8Array`/`ArrayBuffer`) | `.text()`/`.json()` fall through to `String(bytes)`, garbage not a decode                                     | Draft G — [#386](https://github.com/CanadaHonk/porffor/issues/386) was filed and then retracted (filed without review before the filing step); not currently open, re-file by hand if still worth raising |

This table is our own filing status, not a Porffor compat number — it doesn't
belong to a "release readiness" metric and shouldn't grow one; see one below
per draft instead. The `$PORT` and remaining patches now live in
`@sproutboat/toolchain` (`ensurePorfforPatched`), not this repo. The drafts
below still apply. Bump their version line to `alpha-5 (1f4ae4a)` and rewrite
the prose before filing.

---

## Draft A — missing WHATWG surface in native-fetch

**Title:** native-fetch: `URLSearchParams` and static `Response.json` missing

alpha-5 (`1f4ae4a`), `porf native`, `export default { fetch }`.

### 1. no `URLSearchParams` / `URL.prototype.searchParams`

`runtime/fetch-globals.js`'s `URL` has `href`/`origin`/`pathname`/`search`/`toString`
but no `searchParams` and no `URLSearchParams` class.

```js
export default {
  port: 3000,
  fetch(request) {
    return new Response(new URL(request.url).searchParams.get("q") ?? "none");
  },
};
```

```
$ ./handler & curl 'localhost:3000/?q=hi'
Uncaught ReferenceError: URLSearchParams is not defined
```

### 2. no static `Response.json`

Instance `Response.prototype.json()` exists; the static builder
`Response.json(data, init)` (WHATWG / workerd / Bun / Deno) does not.

```js
export default {
  port: 3000,
  fetch() {
    return Response.json({ ok: true });
  },
};
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

alpha-5 (`1f4ae4a`). Fails in both the interpreter and `native`.

```js
class A {
  get x() {
    return new B();
  }
}
class B {
  constructor() {
    this.ok = true;
  }
}
console.log(new A().x.ok); // expected: true
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

**Draft C, formerly here ("env access for handlers"), cut.** Its premise —
"native-fetch handler JS has no way to read the process environment" — is
false: handler code can already call `getenv` today via an inline `Porffor.c`
block (the exact mechanism sproutboat's own bindings use), verified with a
real `porf native` build (`getenv("SB_TEST_ENV")` from handler-level
`Porffor.c` sees the process environment correctly). Not upstream's problem
to solve; if a nicer surface than raw `Porffor.c` is ever wanted, that's a
sproutboat-side helper, not a Porffor gap.

---

## Draft D — non-ISO `Date` string parsing diverges from V8 (web-compat, not a spec violation)

**Title:** native-fetch: `new Date("<legacy/non-ISO string>")` doesn't match the format every other engine converges on

alpha-5 (`1f4ae4a`), `porf native`. Framing note: non-ISO date parsing is
explicitly implementation-defined by spec, so this isn't a correctness bug —
it's a web-compatibility gap, on the same footing as any other "every engine
agrees on more than the spec requires" divergence.

Realistic inputs a handler plausibly receives (a form field, a header, a
third-party API's date string), not a synthetic probe value:

```js
new Date("3/5/2008").toISOString();
// V8 / Bun / Deno: "2008-03-04T23:00:00.000Z"  (M/D/YYYY, local tz)
// Porffor native:  "0008-10-28T00:00:00.000Z"

new Date("March 5, 2008").toISOString();
// V8 / Bun / Deno: "2008-03-04T23:00:00.000Z"
// Porffor native:  throws "Invalid time value" — RangeError, not a parse
```

Impact: a handler doing `new Date(userSuppliedString)` on anything but a
strict ISO 8601 string either gets a silently wrong date or an unexpected
throw, on input every other engine accepts identically. Verified against a
real `porf native` build, not just the interpreter.

Not shimmed locally — replicating V8's full lenient date grammar in a prelude
is disproportionate. Filing as a web-compat gap so it can be addressed in
`compiler/builtins` if the maintainer wants engine parity here (their call —
this is a "here's the gap" report, not "this must be fixed").

## Draft E — `Date` ignores timezone offsets, and folds them into milliseconds

**Filed: [CanadaHonk/porffor#387](https://github.com/CanadaHonk/porffor/issues/387).**

**Title:** native-fetch: ISO 8601 timezone offsets are ignored (and leak into ms)

alpha-5 (`1f4ae4a`), `porf native` and `porf run` alike — still reproduces
identically (same three wrong outputs below), re-verified after the
alpha-4 -> alpha-5 bump, not just carried over from the original filing.

Distinct from Draft D: that one is about _non-ISO_ strings, where the grammar is
implementation-defined. This is a fully ISO 8601 input with a numeric offset,
where the correct instant is specified.

```js
new Date("2024-01-02T03:04:05+02:00").toISOString();
// V8 / Bun / Deno: "2024-01-02T01:04:05.000Z"
// Porffor:         "2024-01-02T03:04:05.002Z"   <- offset ignored; "02" became 2ms

new Date("2024-01-02T03:04:05-05:00").toISOString();
// V8:      "2024-01-02T08:04:05.000Z"
// Porffor: "2024-01-02T03:04:05.005Z"

new Date("2024-01-02T03:04:05.250+01:00").toISOString();
// V8:      "2024-01-02T02:04:05.250Z"
// Porffor: "2024-01-02T04:04:05.250Z"   <- offset applied with the wrong sign
```

Two bugs in one: the offset is not subtracted to reach UTC, and when there is no
fractional-seconds component the offset's digits are consumed as milliseconds.
With a fractional part present the offset is applied, but inverted.

Impact is quiet: the result is a valid `Date`, not `Invalid Date`, so a handler
cannot detect it. Any handler parsing a timestamp from an API response, a
webhook, or a `Date:` header gets a wrong instant — off by the offset, or off by
double it.

Not shimmable from a prelude: assigning `Date.parse = …` makes the compiler emit
a call with the wrong arity (`too few arguments to function call, expected 3,
have 1`) and the C build fails. It has to be fixed in `compiler/builtins`.

Covered by `tests/porffor/capabilities/32-date-offset.js`.

## Draft F — promise-resolve's thenable probe can loop forever, livelocking the process

**Filed: [CanadaHonk/porffor#388](https://github.com/CanadaHonk/porffor/issues/388).**

**Title:** resolving a promise with a plain object can infinite-loop in the `.then` duck-type check

Tested alpha-5 (`1f4ae4ae`), plain `porf native`.

### Repro

```js
// src/index.js
function readCookies(header) {
  const out = {};
  const parts = String(header || "").split(";");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const index = part.indexOf("=");
    if (index < 0) {
      const name = part.trim();
      if (name) out[name] = "";
    } else {
      const name = part.slice(0, index).trim();
      if (name) out[name] = part.slice(index + 1).trim();
    }
  }
  return out;
}
async function readSession(request) {
  const cookies = readCookies(request.headers.get("cookie"));
  const token = cookies["session"] || "";
  if (!token) return null;
  return { token };
}
function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { "content-type": "application/json" } });
}
async function inner(request) {
  const session = await readSession(request);
  if (!session) return json({ error: "sign in required" }, 401); // <- it hangs here
  return json({ ok: true });
}
export default {
  fetch(request) {
    return inner(request); // no .then() chaining — the documented-safe pattern
  },
};
```

```sh
porf native src/index.js -o dist/repro   # esbuild must be on PATH; auto-detects native-fetch shape
PORT=8199 ./dist/repro &
for i in $(seq 1 40); do curl -s -m 3 -o /dev/null -w '%{http_code} ' http://127.0.0.1:8199/; done
# a handful of 401s, then every further connection times out; process pinned at 100% CPU forever
```

Onset is nondeterministic (6-8 requests in our runs, 2-6 in an earlier
variant) — consistent with allocator/pool reuse rather than a fixed trigger.
A sync-only route (nothing ever resolves a promise) never spins no matter
how many times it's hit.

### Root cause (debug build, lldb, symbols via `-d`)

The spin is `__Porffor_promise_resolve`'s duck-typing check for a `.then`
([compiler/builtins/promise.ts:166-187](https://github.com/CanadaHonk/porffor/blob/1f4ae4ae3e0a5f0a93b3bc084359e1a3a23391fd/compiler/builtins/promise.ts#L166-L187)),
which walks the value's prototype chain:

```ts
// compiler/builtins/promise.ts:183-187
let probe: any = value;
while (Porffor.type(probe) == Porffor.TYPES.object) {
  if (Porffor.object.lookup(probe, "then", thenHash) != 0) break;
  probe = __Porffor_object_getPrototype(probe);
}
```

A breakpoint on `__Porffor_object_getPrototype` during the spin fires
continuously with the same argument every time: `val = 0`, `type = 7`
(`TYPES.object`) — a jsval that reads as "a valid object living at address 0"
rather than the `undefined`/`null` that should terminate the walk. The chain
never bottoms out, so the loop spins forever recomputing the same fixed point.
Full backtrace at the breakpoint:

```
__Porffor_object_getPrototype (val=0, type=7)
__Porffor_promise_resolve + 704
porf_async_call_sync + 256
p67_inner (readSession's compiled body)
porf_invoke
porf_coro_call_thunk
porf_coro_bootstrap
porf_coro_enter
porf_coro_call_step
porf_coro_start
p68_outer (inner's compiled body)
... (call_dynamic / porf_invoke frames up through fetch and the native-fetch entry)
handle_request -> on_request -> uWS event loop -> main
```

Same PC on repeated samples seconds apart, same call stack, same register
values — this is a true spin, not slow forward progress.

The fix shape is already in the codebase, just not applied here:
`__Porffor_object_get`'s own prototype-chain walk
([compiler/builtins/_internal_object.ts:548-598](https://github.com/CanadaHonk/porffor/blob/1f4ae4ae3e0a5f0a93b3bc084359e1a3a23391fd/compiler/builtins/_internal_object.ts#L548-L598))
guards against exactly this failure mode. It calls `__Porffor_object_lookup`
([_internal_object.ts:496-523](https://github.com/CanadaHonk/porffor/blob/1f4ae4ae3e0a5f0a93b3bc084359e1a3a23391fd/compiler/builtins/_internal_object.ts#L496-L523),
a flat scan of one object's own entries, no loop, no `lastProto`) as its
single-object probe, but the walk around that call tracks `lastProto`
itself and breaks once the "next" prototype pointer stops changing
(`Porffor.IR.ptr(obj) == Porffor.IR.ptr(lastProto)`), terminating on a
self-referential or fixed-point chain instead of spinning:

```ts
// compiler/builtins/_internal_object.ts:585-598, inside __Porffor_object_get
let lastProto: any = obj;
while (true) {
  if ((entryPtr = __Porffor_object_lookup(obj, key, hash)) != 0) break;
  // ... advance obj to its prototype ...
  if (Porffor.fastOr(obj == null, Porffor.IR.ptr(obj) == Porffor.IR.ptr(lastProto))) break;
  lastProto = obj;
}
```

`__Porffor_promise_resolve`'s `.then` probe (quoted above) has no equivalent
guard, it's the same shape of walk with the termination check missing.

### Impact

Any handler whose `fetch` returns (directly or via `await`) a promise
resolved with a plain object, the overwhelmingly common shape for a JSON API
response, can spin the whole process. `native-fetch` serves one request at
a time on a single uWS loop, so once it spins, every other in-flight and
future connection dies with it; only a process restart recovers. This is
worse than a slow leak: it looks like an app bug (a specific route "just
hangs"), the onset is allocator-dependent so it evades small test suites,
and there's no error or log line — the process is burning 100% CPU and
producing nothing.

Not shimmable from a prelude — this is in the object/promise runtime
internals (`compiler/builtins/promise.ts`, `compiler/builtins/_internal_object.ts`),
not something a userland polyfill can reach.

## Draft G — `Request`/`Response` accept no byte body (`Uint8Array`/`ArrayBuffer`)

**Filed: [CanadaHonk/porffor#386](https://github.com/CanadaHonk/porffor/issues/386).**

**Title:** native-fetch: `new Response(uint8Array)` / `new Request(..., {body: uint8Array})` don't work — the body is stored raw and `.text()`/`.json()` fall through to `String(bytes)`

alpha-5 (`1f4ae4a`), `porf native`. Disclosure: found while debugging live
mojibake on sproutboat.com, with help from Claude Code (Anthropic) — including
catching a wrong first draft of this same report (below) before it was filed.
Repro and analysis are our own, written up by hand per the AI policy.

### First draft was wrong — worth recording why

An earlier version of this report claimed `Response.prototype.text()` failed
to UTF-8-decode a body. The repro built a JS _string_ holding raw UTF-8 bytes
(one code unit per byte) and passed that string to `new Response(...)`. That
is not a Porffor bug: per the Fetch spec, a _string_ body is UTF-8-**encoded**
at construction and decoded back by `.text()`, so encoding a string and then
decoding it is a lossless round trip regardless of content — V8 reproduces
the exact same "corruption" for that repro (checked in Node):

```js
const utf8 = new TextEncoder().encode("héllo · wörld");
let raw = "";
for (const b of utf8) raw += String.fromCharCode(b);
new Response(raw).text(); // -> "hÃ©llo Â· wÃ¶rld" in V8 too — not a bug, expected
```

The real gap is one level down: Porffor's `Response`/`Request` never accept a
genuine **bytes** body (`Uint8Array`/`ArrayBuffer`) in the first place, which
is a real, spec-mandated case with no workaround.

### Repro

```js
export default {
  port: 3000,
  async fetch(request) {
    const bytes = new TextEncoder().encode("héllo");
    const r = new Response(bytes);
    return new Response(JSON.stringify(await r.text()));
  },
};
```

```
$ curl localhost:3000/
"héllo"                      # V8 / Bun / Deno
"onv, Bi,ber,rot,to ,a t"    # Porffor native — not even a stable/predictable
                              # mangling; varies by build, reads like raw
                              # memory reinterpreted as characters
```

### Root cause

`runtime/fetch-globals.js`'s constructors store the body exactly as given
(`this.body = body`) with no branch for a byte source, and every read method
does `(Porffor.type(body) | 0b10000000) == Porffor.TYPES.bytestring ? body :
String(body)` — a `Uint8Array` is never a `bytestring`, so it always falls to
`String(body)`, which is undefined/garbage behavior for a typed array rather
than a UTF-8 decode.

### Impact

Any handler that builds a `Request`/`Response` from real bytes — a hash
digest, a file read as an `ArrayBuffer`, bytes from another binding — instead
of a string gets silent, unpredictable garbage back from `.text()`/`.json()`,
not an error. This also blocks a clean fix for a related, narrower internal
issue we hit: sproutboat's own runtime passes already-decoded-off-disk bytes
into `Response` as a `bytestring` string (Porffor's Latin-1-range string
representation, one byte per code unit) to keep them wire-safe for `#176`,
and has to work around `.text()`/`.json()` not decoding that case itself
(`@sproutboat/runtime`, not Porffor — see `baronunread/sproutboat#181`)
because Porffor has no real byte-body type to hand it instead. Real
`Uint8Array`/`ArrayBuffer` support in `Request`/`Response` — UTF-8-encode a
string body at construction (already correct), accept and store bytes
as-is for a byte-typed body, and have `.text()`/`.json()` UTF-8-decode
whichever kind is stored — would close both gaps at once, including the
`Response.arrayBuffer()`/`.blob()` methods that currently call `this.text()`
internally and would need to read the stored bytes directly instead once
`text()` starts decoding.

Not shimmable from a prelude: `Response.prototype.text`/the constructor
aren't assignable the way `Date.parse` isn't (Draft E) — has to be fixed in
`runtime/fetch-globals.js` itself.
