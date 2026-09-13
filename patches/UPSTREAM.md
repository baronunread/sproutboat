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

| Gap                                                          | alpha-5                                                                 | Action              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------- |
| `URLSearchParams` / `URL.prototype.searchParams`             | still missing (shimmed in `@sproutboat/runtime`)                        | Draft A stands      |
| static `Response.json(data, init)`                           | still missing (instance `json()` only; shimmed)                         | Draft A stands      |
| class declaration not hoisted into scope                     | still throws in interpreter and native                                  | Draft B stands      |
| `Date` non-ISO string parse (`15-date-iso`, `16-date-parts`) | parses positionally, unlike V8: implementation-defined but a divergence | Draft D             |
| `Date` timezone offsets (`32-date-offset`)                   | ignored, folded into ms: a real bug on valid ISO 8601 input             | Draft E (issue #90) |
| compat suite                                                 | 32/32 compile, 29/32 match; the 3 misses are the Date rows above        | GO holds            |

The `$PORT` and remaining patches now live in `@sproutboat/toolchain`
(`ensurePorfforPatched`), not this repo. The drafts below still apply. Bump
their version line to `alpha-5 (1f4ae4a)` and rewrite the prose before filing.

---

## Draft A — missing WHATWG surface in native-fetch

**Title:** native-fetch: `URLSearchParams` and static `Response.json` missing

alpha-3 (`03b6b54`), `porf native`, `export default { fetch }`.

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

alpha-3 (`03b6b54`). Fails in both the interpreter and `native`.

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
new Date("3,5,8").toISOString();
// V8 / Bun / Deno: "2008-03-04T23:00:00.000Z"  (M/D/YY, local tz)
// Porffor native:  "0003-05-08T00:00:00.000Z"
```

Impact: any handler doing `new Date(userSuppliedString)` on non-ISO input gets a
silently wrong date rather than a matching one (or `Invalid Date`). Our harness
sees this on `15-date-iso` / `16-date-parts` with a comma-separated probe value.

Not shimmed locally — replicating V8's full lenient date grammar in a prelude is
disproportionate. Filing so it can be fixed in `compiler/builtins`.

## Draft E — `Date` ignores timezone offsets, and folds them into milliseconds

**Title:** native-fetch: ISO 8601 timezone offsets are ignored (and leak into ms)

alpha-4 (`a415d19`), `porf native` and `porf run` alike.

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

**Title:** resolving a promise with a plain object can infinite-loop in the `.then` duck-type check

alpha-5 (`1f4ae4ae`), plain `porf native` — verified with no sproutboat, no
CLI, no bindings involved, so this is squarely in shared promise/object
runtime internals.

### Repro (verified — no sproutboat-cli, no bindings)

```js
// src/index.js
function readCookies(header) {
  const out = {};
  const parts = String(header || '').split(';');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const index = part.indexOf('=');
    if (index < 0) {
      const name = part.trim();
      if (name) out[name] = '';
    } else {
      const name = part.slice(0, index).trim();
      if (name) out[name] = part.slice(index + 1).trim();
    }
  }
  return out;
}
async function readSession(request) {
  const cookies = readCookies(request.headers.get('cookie'));
  const token = cookies['session'] || '';
  if (!token) return null;
  return { token };
}
function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
async function inner(request) {
  const session = await readSession(request);
  if (!session) return json({ error: 'sign in required' }, 401); // <- the branch that wedges
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

Confirmed the trigger is specifically the object-literal branch
(`json({ error: ... }, 401)`, a fresh object each call): a version of this
same repro that instead returns the *found-session* branch (`{ token }`, also
a plain object, also promise-resolved) ran 60 requests clean in our testing —
so onset depends on which allocation this particular object's bytes land on,
not merely "any resolved plain object." Onset is nondeterministic anyway
(6-8 requests in our runs, 2-6 in an earlier variant) — consistent with a
stale byte surviving allocator/pool reuse rather than a fresh-heap value,
which is also why a sync-only route (nothing ever resolves a promise) never
wedges no matter how many times it's hit.

### Root cause (debug build, lldb, symbols via `-d`)

The wedge is `__Porffor_promise_resolve`'s duck-typing check for a `.then`
(`compiler/builtins/promise.ts`), which walks the value's prototype chain:

```ts
let probe: any = value;
while (Porffor.type(probe) == Porffor.TYPES.object) {
  if (Porffor.object.lookup(probe, 'then', thenHash) != 0) break;
  probe = __Porffor_object_getPrototype(probe);
}
```

A breakpoint on `__Porffor_object_getPrototype` during the wedge fires
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

Best guess (not confirmed against the allocator): the object's prototype slot
is read via `Porffor.IR.loadU8(obj, 5)` for its type tag and
`Porffor.IR.loadI32(obj, 8)` for its value, and a plain object literal that
never calls `__Porffor_object_setPrototype` relies on those bytes defaulting
to zero (`TYPES.number`-ish/unset, not `TYPES.object` = `7`) to signal "no
explicit prototype, fall back to the hidden one." If the allocator hands back
reused memory without zeroing that byte, a stale `7` from a previous
allocation's unrelated field turns "no prototype" into "prototype is the
bogus object at address 0," which itself reads back the same way — a
self-sustaining fixed point.

### Impact

Any handler whose `fetch` returns (directly or via `await`) a promise
resolved with a plain object — the overwhelmingly common shape for a JSON API
response — can wedge the whole process. `native-fetch` serves one request at
a time on a single uWS loop, so once it spins, every other in-flight and
future connection dies with it; only a process restart recovers. This is
worse than a slow leak: it looks like an app bug (a specific route "just
hangs"), the onset is allocator-dependent so it evades small test suites,
and there's no error or log line — the process is burning 100% CPU and
producing nothing.

Not shimmable from a prelude — this is in the object/promise runtime
internals (`compiler/builtins/promise.ts`, `compiler/builtins/_internal_object.ts`),
not something a userland polyfill can reach.
