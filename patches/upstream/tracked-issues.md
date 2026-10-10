# Upstream issues we depend on

Filed and tracked at `CanadaHonk/porffor`. None of these are things to fix
locally: each is a language or platform gap that only makes sense in the
compiler. Recorded here so the next person checks the issue before writing a
workaround.

| #                                                        | What            | Why it matters here                                    |
| -------------------------------------------------------- | --------------- | ------------------------------------------------------ |
| [#145](https://github.com/CanadaHonk/porffor/issues/145) | `Proxy` support | Resolved in alpha-16; native regression coverage added |
| [#347](https://github.com/CanadaHonk/porffor/issues/347) | Web Crypto      | no `crypto.*` at all; blocks any auth library          |
| [#349](https://github.com/CanadaHonk/porffor/issues/349) | Streams         | a response body is one whole string                    |

## Proxy support (#145), resolved in alpha-16

The alpha-16 compiler implements Proxy traps and revocation. Toolchain 0.6.0
pins that release, and runtime 0.15.0 removes the source validation ban.
Native regressions compare object traps, enumeration, calls, construction,
revocation and a frozen-property invariant with Bun. These operations work;
full Proxy conformance is not established by this small regression suite.

Proxy-dependent packages need individual probes. qs 6.16.0 nested query
parse/stringify and tRPC 11.19.0's basic server caller pass. itty-router 5.0.24
IttyRouter passes GET parameters, Unicode POST and a 404 fallback after adding
live URLSearchParams iteration to the runtime. Standard Router still fails
around labelled iterator breaks. Better Auth's crypto and framework requirements
remain a separate evaluation.

See the complete [alpha-16 audit](https://github.com/baronunread/sproutboat-packages/blob/main/packages/toolchain/PORFFOR_ALPHA16.md).

## Web Crypto (#347), and what we ship meanwhile

Upstream provides `globalThis.crypto = {}` in `runtime/fetch-globals.js` and
nothing on it. The issue is labelled `C-wintercg`, so server-side web APIs are
in scope upstream; this is not a case of us filling in something the compiler
considers out of bounds.

The prelude shims `crypto.getRandomValues`, `crypto.randomUUID`, and, as of
#133, a `crypto.subtle` subset: `digest` (SHA-256/384/512) and HMAC
`importKey` / `sign` / `verify`. Enough for JWTs and hand-rolled sessions; no
ECDSA, no AES, no key wrapping. better-auth still needs more.

Backed by ~300 lines of reference SHA-2 as inline C, **not** BearSSL. BearSSL is
linked only in `--standalone` builds, and the prelude's inline C is shared with
the broker transport, so a link dependency would break `sproutboat build`
without `--standalone`. Pure C is transport-independent and also lets a handler
drop a vendored pure-JS SHA-256. Verified against NIST vectors on both
transports. Keep the surface exactly standard so it deletes when upstream lands
Web Crypto.
