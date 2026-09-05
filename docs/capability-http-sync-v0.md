# http-sync-v0

`http-sync-v0` is the accepted local handler profile. A handler must
default-export an object with `fetch(request)` and return a `Response`. It has
no dynamic bindings, no outbound network access by default, and no Node or Bun
API contract. The accepted fixtures live in `tests/porffor/capabilities/`.

**Imports (#89).** The entry point may import: relative modules across the
project, and bare specifiers resolved from the project's own `node_modules`.
The CLI bundles the handler into one module before Porffor sees it, so the
compiler still only ever gets a single self-contained file. The capability
rules below are enforced against that _bundled_ output, which means a
dependency reaching for `process` or `node:fs` fails exactly as hand-written
code would — a package is not a way around the profile. Dynamic `import()` is
not supported, since nothing can be resolved at build time.

Unsupported syntax and API fixtures belong in `tests/porffor/rejected/`; they
are validated by the CLI `check` command before a build can begin.

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
