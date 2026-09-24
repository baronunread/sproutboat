# Archived: #386 byte-body report

**Closed after retraction.** This is not an active dependency or release
blocker; retain the report only to avoid repeating the premature filing.

**Filed: [CanadaHonk/porffor#386](https://github.com/CanadaHonk/porffor/issues/386).**

**Title:** native-fetch: `new Response(uint8Array)` / `new Request(..., {body: uint8Array})` don't work; the body is stored raw and `.text()`/`.json()` fall through to `String(bytes)`

alpha-5 (`1f4ae4a`), `porf native`. Disclosure: found while debugging live
mojibake on sproutboat.com, with help from Claude Code (Anthropic), including
catching a wrong first draft of this same report (below) before it was filed.
Repro and analysis are our own, written up by hand per the AI policy.

## Why the first draft was wrong

An earlier version of this report claimed `Response.prototype.text()` failed
to UTF-8-decode a body. The repro built a JS _string_ holding raw UTF-8 bytes
(one code unit per byte) and passed that string to `new Response(...)`. That
is not a Porffor bug: per the Fetch spec, a _string_ body is UTF-8-**encoded**
at construction and decoded back by `.text()`, so encoding a string and then
decoding it is a lossless round trip regardless of content; V8 reproduces
the exact same "corruption" for that repro (checked in Node):

```js
const utf8 = new TextEncoder().encode("héllo · wörld");
let raw = "";
for (const b of utf8) raw += String.fromCharCode(b);
new Response(raw).text(); // -> "hÃ©llo Â· wÃ¶rld" in V8 too; expected
```

The real gap is one level down: Porffor's `Response`/`Request` never accept a
genuine **bytes** body (`Uint8Array`/`ArrayBuffer`) in the first place, which
is a real, spec-mandated case with no workaround.

## Repro

```js
export default {
  port: 3000,
  async fetch(request) {
    const bytes = new TextEncoder().encode("héllo");
    const r = new Response(bytes);
    return new Response(JSON.stringify(await r.text()));
  },
};
```

```
$ curl localhost:3000/
"héllo"                      # V8 / Bun / Deno
"onv, Bi,ber,rot,to ,a t"    # Porffor native; not even a stable/predictable
                              # mangling; varies by build, reads like raw
                              # memory reinterpreted as characters
```

## Root cause

`runtime/fetch-globals.js`'s constructors store the body exactly as given
(`this.body = body`) with no branch for a byte source, and every read method
does `(Porffor.type(body) | 0b10000000) == Porffor.TYPES.bytestring ? body :
String(body)`: a `Uint8Array` is never a `bytestring`, so it always falls to
`String(body)`, which is undefined/garbage behavior for a typed array rather
than a UTF-8 decode.

## Impact

Any handler that builds a `Request`/`Response` from real bytes, such as a hash
digest, a file read as an `ArrayBuffer`, or bytes from another binding, instead
of a string gets silent, unpredictable garbage back from `.text()`/`.json()`,
not an error. This also blocks a clean fix for a related, narrower internal
issue we hit: sproutboat's own runtime passes already-decoded-off-disk bytes
into `Response` as a `bytestring` string (Porffor's Latin-1-range string
representation, one byte per code unit) to keep them wire-safe for `#176`,
and has to work around `.text()`/`.json()` not decoding that case itself
(`@sproutboat/runtime`, not Porffor; see `baronunread/sproutboat#181`)
because Porffor has no real byte-body type to hand it instead. Real
`Uint8Array`/`ArrayBuffer` support in `Request`/`Response`: UTF-8-encode a
string body at construction (already correct), accept and store bytes
as-is for a byte-typed body, and have `.text()`/`.json()` UTF-8-decode
whichever kind is stored, would close both gaps at once, including the
`Response.arrayBuffer()`/`.blob()` methods that currently call `this.text()`
internally and would need to read the stored bytes directly instead once
`text()` starts decoding.

Not shimmable from a prelude: `Response.prototype.text`/the constructor
aren't assignable the way `Date.parse` isn't ([Draft E](date-timezone-offsets.md)); it has to be fixed in
`runtime/fetch-globals.js` itself.
