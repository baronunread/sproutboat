# Native fetch runtime port draft

This draft was checked against `alpha-5` @ `1f4ae4ae`, which was the pin at the
time. The issue search at that point found no report covering runtime port
selection. Recheck current Porffor before filing.

Porffor's `AI_POLICY` asks that AI use is disclosed and that LLM prose is not
pasted. Rewrite the below in your own words before filing, and file it as an
**issue**, not a PR: the maintainer may prefer a general environment binding
over a `PORT` special case. The later
[environment-access finding](environment-access.md) corrected one claim in
this draft: handler code can call `getenv` through `Porffor.c`.

---

**Title:** native-fetch: a compiled server cannot be told its port

**Version:** `alpha-5` @ `1f4ae4ae`, `porf native`, `export default { fetch }`.

## Problem

The listen port is fixed at compile time. `compiler/render.js:1521`:

```c
f64 porf_native_fetch_get_port(void) {
  return __porffor_native_fetch_port.val;
}
```

That value comes from the `port:` field on the handler object, read while
bundling and rendered into the C as a constant. Nothing at runtime can change
it.

The native fetch entry point also omits process arguments:
`porf_native_fetch_runtime_init()` calls `porf_init(0, NULL)`
(`render.js:1481`), so `porf_argc` / `porf_argv` are empty for every
native-fetch build, while the regular native entry point passes `main`'s
through. The two paths disagree. C code can still read environment variables
with `getenv`, but this port getter does not do so.

So an unpatched compiled `export default { fetch }` server cannot select its
listen port at startup, and Porffor's argument array cannot supply a config
path.

## Why it matters

Running more than one compiled handler on a host means assigning each a port at
spawn time. With the unpatched alpha-5 getter that is impossible, so every handler has to be recompiled per
port, and "compile once, run anywhere" becomes "compile once per port". Any
supervisor, container platform or PaaS hits this immediately, since $PORT is
the near-universal convention.

## Repro

```js
// handler.js
export default {
  port: 3000,
  fetch() {
    return new Response("ok");
  },
};
```

```
$ porf native handler.js -o handler
$ PORT=8080 ./handler
Porffor native fetch server listening on http://127.0.0.1:3000
```

Expected: some runtime input selects the port. Actual: always the compiled
value.

## Two possible fixes

1. Smallest: have `porf_native_fetch_get_port()` read `getenv("PORT")` first
   and fall back to the compiled `port:`. Matches workerd, `wrangler dev` and
   most PaaS runtimes.
2. More general, and fixes both halves: pass the real `argc` / `argv` into
   `porf_init` from the native-fetch entry point, so a compiled server can take
   arguments like any other program. That covers config paths too, not just the
   port.

Happy to send either as a PR if one of the shapes is acceptable.
