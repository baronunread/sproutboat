# Promise resolution livelock: original investigation

This records the original investigation and local patch (`patchPromiseTs` in
`@sproutboat/toolchain`'s `patch.ts`, applied to `compiler/builtins/promise.ts`).
The root cause was not `Date`-specific; see the correction below and the
[CLI standalone guide](https://github.com/baronunread/sproutboat-cli/blob/main/docs/standalone.md).
`__Porffor_promise_resolve`'s `.then` duck-type probe spun on a
prototype-chain fixed point instead of terminating. The patch adds the same
`lastProto` guard `_internal_object.ts`'s own prototype walks already use.
Verified against the pinned checkout: the repro below (and the plain-object
variant in the correction) survive hundreds of sequential hammered requests
post-patch where they wedged within a handful before it. The report was later
filed as [Porffor #388](https://github.com/CanadaHonk/porffor/issues/388).
The [filed report history](promise-resolution-issue-388.md) records the
debugger-confirmed root cause and its resolution upstream in alpha-6.

**Version:** `alpha-5` @ `1f4ae4ae`, `porf native`, native-fetch standalone build,
darwin-arm64 host target. Tracked downstream as
[sproutboat#168](https://github.com/baronunread/sproutboat/issues/168), confirmed
reproducing against the pinned commit 2026-09-12.

## Problem

An `async` handler that calls `.toISOString()` on a `Date` after resuming from
an `await` pins the process at 100% CPU forever after a handful of requests
(3-13 in local runs; every subsequent connection times out, `CLOSE_WAIT`
sockets pile up). No error, no log line, no crash: the process just stops
dispatching.

Bisected one ingredient at a time against a 40-line repro (async session-gate
handler, cookie parsing, JSON response, one `await`, one `console.error` log
line per request). Everything below passes 30-200x hammered:

microtask count, nesting depth, D1 writes, allocation volume, `console.error`
alone, `JSON.stringify` alone, `headers.get` alone, `new URL`, env bindings
passed through async functions, ratelimit ops, tight `await`/HMAC churn,
`Date.now()`. Swapping the log line's `new Date().toISOString()` for
`Date.now()` (epoch millis) is the only change that turns a reliably-wedging
build into a reliably-clean one.

So the fault is specific to `Date.prototype.toISOString` (or the `Date`
formatting path underneath it, shared by `toJSON`/`toUTCString`) called from a
handler frame that has already resumed once; sync-only handlers calling the
same method never wedge.

## Repro

```js
async function inner(request) {
  return new Response("ok");
}
async function outer(request) {
  const res = await inner(request); // <- resume point
  console.error(JSON.stringify({ time: new Date().toISOString() }));
  return res;
}
export default { fetch: (request) => outer(request) };
```

```
porf native handler.js -o handler && PORT=8080 ./handler
# hammer it: curl loop wedges the process within ~10 requests, 100% CPU, no output
```

## Related, found during the same isolation pass (filing separately or noting here)

- An `async` function that does a bare `return somePromise` (no `await`) never
  resolves the outer call; every async helper has to resolve to a plain value
  before returning, promise adoption doesn't happen.
- `sproutboat build` still emits a binary when the source has a duplicate
  `const` declaration (a hard `SyntaxError` everywhere else); it prints the
  redeclaration error and writes `dist/` output anyway.

## Harness note

Reproduce with a _sequential_ request loop (`for` + `curl`, one connection at a
time) against a standalone/native-fetch build, not `porf run`/dev mode: the
wedge is specific to the compiled native-fetch server's resumed-continuation
path. Needs a fresh data dir and process per attempt; a stale process from an
earlier build will happily answer and mask the result.
