runtime/fetch: fix `TextEncoder` surrogate pairs and `encodeInto` counts

`encode` walks UTF-16 code units, so an astral character is encoded as two
separate 3-byte sequences instead of one 4-byte one, and a lone surrogate is
encoded rather than replaced. `encodeInto` encodes the whole string and copies
`min(bytes.length, destination.length)` bytes, so a short buffer gets a partial
character, and it always reports `read` as the full source length.

```js
new TextEncoder().encode("🚤");
// [240, 159, 154, 164], currently [237, 160, 189, 237, 186, 164]

new TextEncoder().encode("\ud800");
// [239, 191, 189] (U+FFFD), currently [237, 160, 128]

new TextEncoder().encodeInto("abc", new Uint8Array(1));
// { read: 1, written: 1 }, currently { read: 3, written: 1 }

new TextEncoder().encodeInto("caffè", new Uint8Array(5));
// { read: 4, written: 4 }, currently { read: 5, written: 5 } with the buffer
// left as [99, 97, 102, 102, 195], one byte of a 2-byte character
```

`encode` combines surrogate pairs into one code point, maps unpaired surrogates
to U+FFFD, and gains the 4-byte output case. `encodeInto` clamps to the buffer,
backs off to a character boundary, and counts code units from the bytes it
copies. The UTF-8 loop stays in `encode`, so replacing `encodeInto` on an
instance does not change what `encode` returns.

test262 does not cover `TextEncoder`. I checked this against Bun over 123
vectors: all inputs above plus BMP, bytestring and mixed cases, each with
`encodeInto` destinations from 0 to 10 bytes. 123/123 match, up from 34/123.
`TextDecoder.decode` has the mirror gap and still cannot decode 4-byte
sequences; I'd rather fix that separately than widen this.

AI disclosure: <!-- Edit this before posting. It must be true and it must be
yours. Keep only what you actually did. Precedent: PR #358. -->
