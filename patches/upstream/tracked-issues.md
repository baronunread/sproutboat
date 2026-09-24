# Upstream issues we depend on

Filed and tracked at `CanadaHonk/porffor`. None of these are things to fix
locally: each is a language or platform gap that only makes sense in the
compiler. Recorded here so the next person checks the issue before writing a
workaround.

| #                                                        | What                                                 | Why it matters here                                  |
| -------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| [#145](https://github.com/CanadaHonk/porffor/issues/145) | `Proxy` support                                      | `new Proxy` compiles and silently ignores every trap |
| [#347](https://github.com/CanadaHonk/porffor/issues/347) | Web Crypto                                           | no `crypto.*` at all; blocks any auth library        |
| [#349](https://github.com/CanadaHonk/porffor/issues/349) | Streams                                              | a response body is one whole string                  |
| [#350](https://github.com/CanadaHonk/porffor/issues/350) | Coroutine stack corruption on native fetch exception | an async handler that throws                         |

## Proxy support (#145), and why we reject it at build time

`compiler/builtins/object.ts` validates the two arguments and returns the
target. No trap ever runs, so a program using a Proxy reads wrong values rather
than failing: `p.a` returns the target's `a`, and `p.b = 5` is discarded. Of
337 Proxy tests in test262, the 14 that pass are argument-validation tests the
stub satisfies by accident.

**We cannot shim this.** A JavaScript-level Proxy shim can only intercept
properties it can enumerate at construction time, using `defineProperty`
getters, which is the one case where the caller did not need a Proxy. Google's
`proxy-polyfill` has the same limitation for the same reason: intercepting a
read of a key nobody knew about needs the engine.

So `src/source.ts` rejects `new Proxy` at build time instead. That is the whole
of the local fix, and it is the right one: it converts a silent wrong answer
into a build error naming the cause. It is why itty-router and other
Proxy-based routers do not work, and why better-auth does not build (its env
shim is a Proxy).

## Web Crypto (#347), and what we ship meanwhile

Upstream provides `globalThis.crypto = {}` in `runtime/fetch-globals.js` and
nothing on it. The issue is labelled `C-wintercg`, so server-side web APIs are
in scope upstream; this is not a case of us filling in something the compiler
considers out of bounds.

The prelude shims `crypto.getRandomValues`, `crypto.randomUUID`, and, as of
#133, a `crypto.subtle` subset: `digest` (SHA-256/384/512) and HMAC
`importKey` / `sign` / `verify`. Enough for JWTs and hand-rolled sessions; no
ECDSA, no AES, no key wrapping. better-auth still needs more (and is blocked by
the [zod init crash](zod-module-init.md) regardless).

Backed by ~300 lines of reference SHA-2 as inline C, **not** BearSSL. BearSSL is
linked only in `--standalone` builds, and the prelude's inline C is shared with
the broker transport, so a link dependency would break `sproutboat build`
without `--standalone`. Pure C is transport-independent and also lets a handler
drop a vendored pure-JS SHA-256. Verified against NIST vectors on both
transports. Keep the surface exactly standard so it deletes when upstream lands
Web Crypto.
