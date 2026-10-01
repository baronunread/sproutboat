# Draft: a promise resolved with null can reject (then-probe reads offset 0)

**Not filed.** Investigation notes for review; filing at `CanadaHonk/porffor`
needs explicit human approval and a contributor-written description (see the
[README](README.md)). Patched locally in `@sproutboat/toolchain` 0.4.17
(`PROMISE_NULL_MARKER` in `packages/toolchain/src/patch.ts`), which closed
baronunread/sproutboat#168.

Tested alpha-13 (`547c7815`), unpatched upstream source, native fetch build.

## Repro

```js
async function nothing() {
  return null;
}
async function outer() {
  await nothing();
  const t = new Date().toISOString();
  return new Response(t.length + "", { status: 401 });
}
export default {
  fetch(request) {
    return outer();
  },
};
```

```sh
node runtime/index.js native repro.js -o repro && ./repro &
for i in $(seq 1 60); do curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:3000/; done | sort | uniq -c
#   1 401
#  59 500
```

The rejection is `TypeError: Cannot get property of null`, raised by
`await nothing()`. It is permanent: every later request fails the same way.

Controls, all 60/60 `401`:

- `nothing()` returning `1`, `undefined`, `{ a: 1 }` or `'x'` instead of `null`.
- The same `outer()` without the `toISOString()` call.
- The same code as a plain program awaiting `outer()` 200 times in a loop, native or
  interpreted. The failure needs separate requests on the native fetch server.
- Disabling the native fetch server's idle collection
  (`porf_native_fetch_collect_normal`) does not help, so it is not the
  between-request GC.

## Cause

`__Porffor_promise_resolve` (`compiler/builtins/promise.ts`) runs its cheap
`then` probe whenever `Porffor.type(value) == Porffor.TYPES.object`. `null` is
object-typed with pointer 0, so it qualifies, and the first
`Porffor.object.lookup(probe, 'then', thenHash)` reads an object header at
memory offset 0. Whether that lookup "finds" `then` depends on whatever was last
written there. After `Date.prototype.toISOString` has run, it does: the probe
breaks out with `probe` still object-typed, the code evaluates
`(value as object).then`, which is a property read on null, and the promise is
rejected.

ECMA-262 Promise Resolve Functions step 8: only an Object can be a thenable;
`null` takes the FulfillPromise path.

## Suggested fix

```diff
-  if (Porffor.type(value) == Porffor.TYPES.object) {
+  if (Porffor.type(value) == Porffor.TYPES.object && value != null) {
     // cheap prototype-chain probe for 'then' before the expensive Get below, does not invoke getters
```

With this change (and the builtin table precompiled again), the minimal repro
serves 300 of 300 requests and the original #168 application repro serves 3000
of 3000.

Separately worth a look upstream: something writes bytes at offset 0 during
`toISOString`, and any other code that dereferences a null object pointer could
read them.
