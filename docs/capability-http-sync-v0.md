# http-sync-v0

`http-sync-v0` is the accepted local handler profile. A handler must
default-export an object with `fetch(request)` and return a `Response`, or a
promise of one (see [Async handlers](#async-handlers)). It has no dynamic
bindings, no outbound network access by default, and no Node or Bun API
contract. The accepted fixtures live in `tests/porffor/capabilities/`.

**Imports (#89).** The entry point may import: relative modules across the
project, and bare specifiers resolved from the project's own `node_modules`.
The CLI bundles the handler into one module before Porffor sees it, so the
compiler receives a single self-contained file in this build path. The capability
rules below are enforced against that _bundled_ output, which means a
dependency reaching for `process` or `node:fs` fails exactly as hand-written
code would — a package is not a way around the profile. Dynamic `import()` is
not supported, since nothing can be resolved at build time.

Unsupported syntax and API fixtures belong in `tests/porffor/rejected/`; they
are validated by the CLI `check` command before a build can begin.

## Async handlers

`fetch(request)` may return a `Response` or a promise of one. The promise has
to be the object the handler itself returns: a promise chained off it with
`.then()` is never resolved by the runtime and the request hangs. So
`return handle(request)`, where `handle` is `async`, works;
`return handle(request).then(addHeader)` does not. A route that needs `await`
stays isolated: keep `fetch` itself synchronous and `return` the async call
for that one branch.

An async response carries no `x-sb-cpu-ms` header. Per-invocation CPU time is
measured only on the synchronous path, where the handler returns before the
entry shim reads the clock.

`crypto.subtle.digest`, `sign` and `verify` are async in signature only. Their
bodies are synchronous inline C with no host round-trip, so hashing per request
costs a promise allocation, not I/O: there is no reason to vendor a pure-JS
SHA-256 to keep a handler synchronous.

## `ctx.waitUntil` (issue #57, #171)

`fetch`, `scheduled`, and `queue` all take a second argument, `ctx`, with
`waitUntil(promise)`: work that must run but that the handler's own return
shouldn't wait on.

```js
export default {
  fetch(request, ctx) {
    ctx.waitUntil(env.LOG.put(requestId, "seen")); // not awaited
    return new Response("ok");
  },
};
```

Registered promises are drained, in-process and sequentially, once the
handler's own return value is ready — this still routes through the
async-handler rules above, so a `fetch` response drained this way carries no
`x-sb-cpu-ms`. The drain is capped at 25s for the whole batch (under the
edge's own 30s `SPROUTBOAT_REQUEST_TIMEOUT_MS`, so the sprout still gets to
answer); a task still running past the cap keeps running, it just stops
holding up the response. A rejected task is swallowed rather than failing the
response.

`scheduled` and `queue` used to be fire-and-forget regardless of `ctx`: an
async handler's own promise was dropped the moment the reply went out, so any
`ack()`/`retry()` a `queue` handler made after its first `await` never counted
— the default "everything not explicitly handled is acked" pass ran before
that `await` finished. Both are now awaited properly, on every delivery path
(broker-dispatched, and the embedded standalone binary's own local timers).

`DurableObjectState.waitUntil` works the same way, scoped to the instance
(drained after `fetch`/`alarm` returns) — including the embedded transport's
own local alarm timer, which used to bypass this entirely.

## `env` — build-time variables (issue #8)

Non-secret `vars` from `sproutboat.jsonc` are available as a module-scoped `env`
binding:

```jsonc
// sproutboat.jsonc
{
  "name": "hello",
  "main": "src/index.js",
  "compatibility_date": "2026-08-26",
  "vars": { "GREETING": "hej", "API_BASE": "https://example.test" },
}
```

```js
export default {
  fetch(request) {
    return new Response(env.GREETING); // -> "hej"
  },
};
```

- Keys are `UPPER_SNAKE_CASE`; values are strings.
- `env` is a module binding, **not** a `fetch` parameter — Porffor's native-fetch
  runtime calls `fetch(request)` with one argument. Do not also declare `env` as
  a parameter (it would shadow the binding with `undefined`).
- Values are **baked into the compiled binary at build time** and are part of the
  immutable artifact. Do not put secrets here — encrypted, runtime-injected
  secrets and dynamic bindings (KV, R2, D1, outbound `fetch`) are tracked under
  the bindings umbrella (#37) and need a Porffor host-call primitive first.
