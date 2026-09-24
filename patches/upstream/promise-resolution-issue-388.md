# Archived: #388 promise-resolve livelock

**Resolved upstream in alpha-6.** The report remains only as historical
reproduction evidence and is not an active dependency.

**Filed: [CanadaHonk/porffor#388](https://github.com/CanadaHonk/porffor/issues/388).**

**Title:** resolving a promise with a plain object can infinite-loop in the `.then` duck-type check

Tested alpha-5 (`1f4ae4ae`), plain `porf native`.

## Repro

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
    return inner(request); // no .then() chaining; the documented-safe pattern
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
variant), consistent with allocator/pool reuse rather than a fixed trigger.
A sync-only route (nothing ever resolves a promise) never spins no matter
how many times it's hit.

## Root cause (debug build, lldb, symbols via `-d`)

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
(`TYPES.object`), a jsval that reads as "a valid object living at address 0"
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
values. This is a true spin, not slow forward progress.

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

## Impact

Any handler whose `fetch` returns (directly or via `await`) a promise
resolved with a plain object, the overwhelmingly common shape for a JSON API
response, can spin the whole process. `native-fetch` serves one request at
a time on a single uWS loop, so once it spins, every other in-flight and
future connection dies with it; only a process restart recovers. This is
worse than a slow leak: it looks like an app bug (a specific route "just
hangs"), the onset is allocator-dependent so it evades small test suites,
and there's no error or log line; the process is burning 100% CPU and
producing nothing.

Not shimmable from a prelude: this is in the object/promise runtime
internals (`compiler/builtins/promise.ts`, `compiler/builtins/_internal_object.ts`),
not something a userland polyfill can reach.
