# PortableJS as a conformance corpus

Run on 2026-10-29. [PortableJS](https://github.com/portablejs/portable) (MIT, created 2026-10-20) is about 40 small `@portable/*` ESM packages built only on web-standard APIs, with no polyfills and no `nodejs_compat`, and every package is checked in workerd. This page scores its conformance tests on sproutboat and lists what they expose.

## Method

- **Corpus.** Every `packages/*/test/*.conformance.ts` file (about 5,800 tests across 41 packages), without the `*.fuzz.conformance.ts` files (fast-check), the `*.oracle.test.ts` files (Node-only comparison libraries) and the browser tests. Left out as not applicable: `@portable/smtp` and `@portable/sockets` (need `connect()`, covered by the TCP sockets spike), and `charset/examples.conformance.ts` (builds functions with the `AsyncFunction` constructor, which workerd forbids too).
- **Harness.** PortableJS's own workerd check (`tools/workers`) only calls each package once, and its conformance tests run on Vitest, which has no workerd pool yet. So each package's tests are bundled with Vite (the repo's `src` export condition) against a small vitest-compatible runner (`describe`, `test`, `test.each/for`, `expect` with `resolves/rejects` and asymmetric matchers, `vi.fn/spyOn/stubGlobal`, and a fake clock for `vi.useFakeTimers`), wrapped in a Workers-style `fetch` handler: `GET /files` lists test files, `GET /run?file=...` runs one file and returns pass/fail JSON. One file per request, so a crash costs one file.
- **sproutboat.** `sproutboat build --target host --standalone` (CLI 0.42.0, runtime 0.35.0, toolchain 0.20.0, Porffor alpha-19) on an arm64 Mac, then the handler is called over HTTP. Compile time is the cold `sproutboat build` wall time under the Mac build lock, without lock wait. sproutd was not run: a bench sproutd instance needs othello, and the standalone binary runs the same prelude and toolchain patches.
- **workerd.** The same bundle in Miniflare (workerd, compatibility date 2026-07-01), as the reference.
- **After PRs.** The "with PRs" column is the same bundle built with a CLI whose runtime and toolchain come from the three branches listed below, for the packages those branches touch.

Harness artifacts, so the numbers are not worse than they are:

- Test files read fixtures with `import.meta.glob('?url&inline')` and `fetch(dataUrl)`. `fetch()` of a `data:` URL is unsupported in sproutboat (`unsupported protocol: data:`), so the harness decodes data URLs itself.
- `png` and `web-push` tests use top-level `await` in test utilities, which Porffor rejects. `png` was rewritten to decode its fixtures synchronously; `web-push` ran without the two of its four test files that need it (45 tests). Under workerd, `web-push` ran the same subset.
- `sproutboat check` greps the bundled text for `Buffer.`, `process.` and the `node:` prefix. `@portable/bytes` (every other package depends on it) legitimately feature-detects `typeof Buffer !== "undefined" ? Buffer.isBuffer`, and its comments and error templates mention `node:vm` and `Buffer.from(`. The validator rejects the unmodified bundle ("Node, Bun, and Deno APIs are not supported"), so the harness rewrites those strings. This is a real finding, listed as gap 11.
- Workerd itself fails 27 of 6,034 tests (27 failures: `BroadcastChannel` missing in `rpc`, `MaxBufferedError` in `websockets` through Miniflare's `WebSocketPair`, a few fake-clock cases in `timers`, Wycheproof ECDSA vectors in `web-crypto`, Error equality in `png`). They count against the reference column and are not sproutboat gaps.
- The fake clock replaces `globalThis.Date` and `performance.now`, which Porffor does not honor (gap 4), so `queue`, `rate-limit`, `timers` and `rdap` lose tests to the harness mechanism as much as to the API; they are scored anyway because libraries that wrap `Date` break the same way.

## Results

Columns: compiles; cold compile time; sproutboat passed/total (total is the workerd count); the same with the PR branches; workerd passed/total; top failure cause. A package that does not compile scores 0.

| Package | Compiles | Cold compile | sproutboat | with PRs | workerd | Top failure cause |
| --- | --- | --- | --- | --- | --- | --- |
| arc | yes | 343 s | 106/322 |  | 322/322 | crypto.subtle: only HMAC and digest; no RSA, Ed25519, jwk/spki/pkcs8 import |
| base64 | yes | 88 s | 158/158 |  | 158/158 | - |
| binary | yes | 86 s | 97/100 |  | 100/100 | Porffor: `BigInt.asIntN(64, ...)` and signed 64-bit reads lose the sign |
| bytes | yes | 86 s | 59/59 |  | 59/59 | - |
| charset | yes | 70 s | 129/171 | 133/171 | 171/171 | TextDecoder: only UTF-8 (needs the other WHATWG tables) |
| compress | yes | 91 s | 40/131 (1 file crash) | 86/131 | 130/131 | DecompressionStream inflates only at close: invalid data reads as truncated, no early stop |
| csv | yes | 71 s | 271/277 | 277/277 | 276/277 | TextDecoder labels (UTF-16LE, windows-1252) |
| dkim | yes | 75 s | 0/273 |  | 273/273 | crypto.subtle: no RSA or Ed25519 import |
| dmarc | yes | 24 s | 136/138 |  | 138/138 | String.prototype.normalize is a no-op (IDNA) |
| dns | yes | 28 s | 84/84 |  | 84/84 | - |
| dns-packet | yes | 92 s | 76/76 |  | 76/76 | - |
| errors | yes | 22 s | 14/15 | 15/15 | 15/15 | Response.url is undefined, not "" |
| exif | no | n/a | n/a |  | 214/214 | Porffor compile: C codegen error in the PNG `paeth` filter (f64 assigned from jsval) |
| idna | yes | 26 s | 116/124 | 116/124 | 124/124 | String.prototype.normalize is a no-op; `toUpperCase` lacks special casing |
| image-size | yes | 70 s | 124/124 |  | 124/124 | - |
| ip | yes | 85 s | 77/77 |  | 77/77 | - |
| json-stream | yes | 87 s | 231/231 |  | 231/231 | - |
| jsonl | yes | 83 s | 50/50 |  | 50/50 | - |
| lines | yes | 167 s | 43/44 | 44/44 | 44/44 | TextDecoder label latin1 |
| log | yes | 26 s | 35/35 |  | 35/35 | - |
| mail | yes | 114 s | 165/174 | 171/174 | 172/174 | Blob.stream missing; normalize (IDNA) |
| mail-auth | yes | 358 s | 28/59 |  | 59/59 | crypto.subtle: no RSA or Ed25519 import |
| mime-headers | yes | 95 s | 445/456 | 446/456 | 456/456 | TextDecoder: only UTF-8; empty TypeError in byte-input tests (not isolated) |
| mime-stream | yes | 90 s | 97/97 |  | 97/97 | - |
| oauth1 | yes | 27 s | 80/84 |  | 84/84 | crypto.subtle: no RSA PEM import |
| password | yes | 86 s | 32/125 |  | 125/125 | crypto.subtle: no PBKDF2 |
| png | no | n/a | n/a |  | 240/241 | Porffor compile: same `paeth` C codegen error as exif (also: top-level await in test utils) |
| queue | yes | 25 s | 103/128 | 114/128 | 128/128 | DOMException missing; globalThis.Date reassignment ignored (fake clock) |
| quoted-printable | yes | 86 s | 134/135 | 134/135 | 135/135 | TextDecoder label windows-1251 |
| random | yes | 25 s | 96/114 | 114/114 | 114/114 | crypto.getRandomValues filled only the low byte of wide views |
| rate-limit | yes | 37 s | 58/73 |  | 73/73 | globalThis.Date reassignment ignored (fake clock) |
| rdap | yes | 25 s | 44/56 |  | 56/56 | fake clock (Date) and event dates read as undefined (not isolated) |
| rpc | yes | 26 s | 56/101 | 58/101 | 99/101 | MessageChannel / BroadcastChannel not constructible |
| spf | yes | 35 s | 395/395 |  | 395/395 | - |
| sse | yes | 90 s | 215/220 | 217/220 | 220/220 | DOMException missing; TextDecoder streaming |
| streams | yes | 139 s | 237/275 (1 file crash) | 272/275 | 273/275 | TextDecoder UTF-16; one empty TypeError (not isolated) |
| timers | yes | 25 s | 103/207 (2 file crash) | 111/207 | 203/207 | DOMException missing; globalThis.Date and performance fake clock |
| web-crypto | yes | 88 s | 0/152 |  | 150/152 | Porffor: per-iteration loop binding captured by an inner closure ("namedCurve is not defined" at start); crypto.subtle |
| web-push | yes | 89 s | 23/45 |  | 45/45 | crypto.subtle: no ECDH, ECDSA, AES-GCM, HKDF (2 of 4 test files dropped: top-level await) |
| webhooks | yes | 92 s | 111/111 |  | 111/111 | - |
| websockets | yes | 84 s | 23/83 (1 file crash) | 83/83 | 71/83 | DOMException missing (kills the process) |

Totals: sproutboat passes 4,291 of the 5,579 tests in the 39 packages that compile (77%); workerd passes 6,007 of 6,034. 12 packages pass everything (base64, bytes, dns, dns-packet, image-size, ip, json-stream, jsonl, log, mime-stream, spf, webhooks), and 5 more do with the PRs (csv, errors, lines, websockets, random). Packages that do not compile: exif and png (Porffor). `web-crypto` compiles but does not start.

Cold compile time is 22 to 105 s for 0.1 to 12 MB bundles (fixtures dominate the large ones, 5.8 MB of runtime is the floor); `arc` and `mail-auth` took 340 to 360 s once while another job held the CPU.

## Gaps, ranked by packages broken

"Packages" counts packages that lose tests to the gap on sproutboat and not on workerd.

| # | Gap | Class | Packages | Status |
| --- | --- | --- | --- | --- |
| 1 | `crypto.subtle` supports only digest and HMAC with raw keys. No PBKDF2, HKDF, AES, ECDSA, ECDH, Ed25519 or RSA; `importKey`/`exportKey` only `raw`, no `jwk`, `spki` or `pkcs8`; no `generateKey` except HMAC | missing Web API | 7: arc, dkim, mail-auth, oauth1, password, web-crypto, web-push (about 450 tests) | open, not cheap (needs BearSSL work) |
| 2 | `TextDecoder` accepts only UTF-8 labels | missing Web API | 7: charset, csv, lines, mime-headers, quoted-printable, sse, streams | PR 2 adds UTF-16LE/BE and windows-1252/latin1; ISO-8859-x, windows-125x, Shift_JIS, EUC, GBK, Big5, ISO-2022-JP still open (charset, mime-headers, quoted-printable) |
| 3 | `DOMException` is a stub: `typeof` is "function" but `new DOMException(...)` throws, and the process dies on an uncaught `ReferenceError` in some paths | missing Web API | 5: queue, rpc, sse, timers, websockets | PR 1 |
| 4 | `globalThis.Date = X` is ignored by `Date.now()` and `new Date()` (Porffor resolves them as builtins); `setTimeout`, `performance.now` reassignment works | Porffor semantics | 4: queue, rate-limit, rdap, timers | open; repro below |
| 5 | `String.prototype.normalize` returns its input (NFC, NFD, NFKC all no-ops) and `'ß'.toUpperCase()` is "ß" | Porffor/runtime | 4: dmarc, idna, mail, mail-auth | open |
| 6 | Porffor C codegen: `assigning to 'f64' from incompatible type 'jsval'` for `pc = pa + pb` in the PNG `paeth` filter | Porffor compile bug | 2: exif, png | open; not minimized (see below) |
| 7 | `Blob.prototype.stream` missing | missing Web API | 2: mail, streams | PR 2 |
| 8 | `DecompressionStream` inflates only when its input closes: corrupt data surfaces at close and reads as truncated, a zip bomb is not stopped early, errors carry an empty message | Web API semantics | 1: compress (66 tests) | open |
| 9 | `MessageChannel` and `BroadcastChannel` report `typeof` "function" but are not defined | missing Web API | 1: rpc (36 tests) | open |
| 10 | `crypto.getRandomValues` filled only the low byte of each element of a wider view | incorrect Web API | 1: random (18 tests; also any `getRandomValues(new Uint32Array(1))` caller) | PR 3 |
| 11 | The source validator rejects the bundle of any app that imports `@portable/bytes` (feature detection of `Buffer`, and `node:` or `Buffer.from(` inside comments and strings) | sproutboat validator false positive | every package (all depend on bytes) | open, harness works around it |
| 12 | Porffor: a per-iteration `for...of` binding captured by an arrow, used from two levels of nested arrows, is "not defined" | Porffor semantics bug | 1: web-crypto (does not start) | open; minimal repro below |
| 13 | `BigInt.asIntN(64, 1n << 63n)` and `DataView.setBigInt64` of -2^63 return the positive value | Porffor semantics bug | 1: binary (3 tests) | open |
| 14 | `Response.url` is `undefined` for a constructed response (spec: empty string); `redirected` missing | incorrect Web API | 1: errors | PR 2 |
| 15 | `Date.parse('2026-10-29T10:00:00')` reads local time as UTC | Porffor semantics | 0 failing on a UTC host | open |
| 16 | Unclassified: an empty-message `TypeError` in mime-headers byte-input tests and one streams test; arc's "Cannot set property of undefined" (79 tests, after the crypto failures are removed); rdap event dates come back `undefined`; `RangeError: Source is too large` in a streams test; mime-headers `__proto__` parameters | not isolated | 4: arc, mime-headers, rdap, streams | needs a bisect per case |
| 17 | `URLPattern`, `WebSocketPair` (before the compatibility date), `fetch(data:)` absent | missing Web API | 0 (harness works around them) | note only |

### Minimal Porffor repros

Gap 12 (prints `a`, `b` in Bun and Node; sproutboat's Porffor throws `ReferenceError: v is not defined`):

```js
const run = (f) => f();
run(() => {
  for (const v of ['a', 'b']) {
    const convert = () => v;
    run(() => { run(() => { console.log(convert()); }); });
  }
});
```

Gap 4 (prints 42; Porffor prints the real clock):

```js
const R = Date;
globalThis.Date = class extends R { static now() { return 42; } };
console.log(Date.now());
```

Gap 13: `console.log(BigInt.asIntN(64, 1n << 63n))` prints `9223372036854775808` instead of `-9223372036854775808`.

Gap 6: the generated C declares `f64 pc` and assigns the boxed result of `pa + pb` to it. The function compiles when it is alone in a file (with and without typed callers), so the trigger is something about the surrounding module. Reproduce with `sproutboat build --target host` on the `exif` bundle from the PortableJS harness (`@portable/exif` imports the PNG decoder). No Porffor issue is filed.

## PRs

All open, none merged. The runtime and toolchain run in sproutd, so each needs `requalify.sh --tier prelude --repro` and the 1,000-app density gate (1,536M, two trials interleaved against main) before landing. They were not run: the requalify disk guard refused to start (24.6 GiB free, 25 needed).

- sproutboat-packages, `feat/dom-exception`: a constructible `DOMException` (gap 3).
- sproutboat-packages, `feat/text-decoder-encodings`: TextDecoder UTF-16 and windows-1252, `Blob.stream`, `Response.url` (gaps 2, 7, 14).
- sproutboat-packages, `fix/get-random-values-wide-views`: `getRandomValues` fills whole views (gap 10).

Each PR carries a native test compared with Bun (`native-domexception.ts`, `native-textdecoder-encodings.ts`, `native-getrandomvalues.ts`) and a changeset. Before and after, for the packages they touch: websockets 23 to 83 of 83, csv 271 to 277 of 277, errors 14 to 15 of 15, lines 43 to 44 of 44, random 96 to 114 of 114, streams 237 to 272 of 275, timers 103 to 111 (remaining failures are the fake clock), queue 103 to 114 of 128, mail 165 to 171 of 174.

## Reproducing

The harness lives outside the repositories (`shim.js`, `build.mjs`, `run-sprout.mjs`, `run-workerd.mjs`). It is about 600 lines and was not committed; ask for it if you want to rerun the corpus.
