# Native Unicode HTTP input: ingress, JSON, and TextEncoder

Local investigation from the Node/workerd/Sproutboat comparison, 2026-09-27.
No issue has been filed upstream. Porffor pin: alpha-9, `de4eb588264885b3a1596f75010e371a2052033f`;
CLI 0.11.13; installed runtime 0.12.1. Native host build on macOS arm64.

## Reproduce

From the sibling `sproutboat-cli` checkout:

```sh
bun examples/runtime-comparison/repro-ingress.ts
bun examples/runtime-comparison/local-runtime.ts --repro
```

The first uses the installed runtime. The second makes a temporary CLI copy
and links the local packages/runtime checkout without changing installed
packages. Both retain `repro.json` under the comparison's ignored results
folder. The local variant asserts decoded UTF-16 code units, independently of
JSON serialization of the displayed text.

The diagnostic posts short JSON bodies with ASCII, Latin-1 text (`caffè`), an
astral character (`🚤`), and both together. It records raw bytes, decoded code
units, TextEncoder output bytes, and JSON parse/serialize results.

## Sproutboat ingress defect

Native HTTP request.body contains one character per raw UTF-8 byte. The
installed Request.text() does not decode that representation. Re-encoding
its return value through TextEncoder changes the bytes and invalidates HMAC.
The local runtime fix decodes lazily with __sbFromUtf8 when text()/json() are
called, without changing request.body. In the compiled repro, decoded code
units match Bun for all four input bodies, including the surrogate pair
`55357, 56996` for 🚤.

## Separate compiler limits exposed after ingress decoding

1. `compiler/builtins/json.ts`: JSON.parse and its recursive helpers type the
   input as bytestring. Parsed strings allocate byte buffers and use
   Porffor.bytestring.appendChar, including Unicode escapes. JSON.stringify
   writes string code units into byte buffers. This cannot preserve arbitrary
   UTF-16 strings. The decoded astral JSON input fails parsing; serializing a
   string with the correct surrogate pair displays the low-byte characters
   `=¤` instead of the original character.
2. `runtime/fetch-globals.js`: TextEncoder.encode counts and emits each code
   unit as up to three bytes. It does not combine surrogate pairs into a
   four-byte UTF-8 sequence. For 🚤 it emits `ed a0 bd ed ba a4`, while Bun and
   Node emit `f0 9f 9a a4`. Its TextDecoder.decode similarly lacks a four-byte
   branch, explaining why the initial adapter-level workaround also failed.

The local ingress fix therefore does not make the Unicode order/HMAC fixture
pass. Node and workerd still pass the complete unchanged corpus, while
Sproutboat stays at 15/17. Native numeric code-unit checks are necessary:
ordinary Bun tests of the prelude cannot expose compiler built-in limitations.

## Scope

Keep the ingress correction separate from a compiler JSON/encoding change.
A compiler fix needs native vectors for BMP/astral strings, escaped surrogate
pairs, lone surrogates, nested JSON, stringify buffer growth, malformed JSON,
and encoding boundaries. Performance results for the affected fixture remain
blocked by correctness. No general Unicode compatibility claim is established
by this investigation.

## Local resolution

The sibling packages repository now has a local toolchain patch in
`packages/toolchain/src/unicode.ts`. It preserves UTF-16 code units in JSON
buffers and accepts either native string representation during parsing. It
also escapes lone surrogates and object keys when serializing, and rejects
trailing JSON input. The builtin table is regenerated after source patching.

TextEncoder and the native HTTP response writer now combine surrogate pairs
into four-byte UTF-8 sequences and replace lone surrogates during encoding.
encodeInto stops before a character that will not fit and reports consumed
UTF-16 units accurately. This work does not change TextDecoder's other limits.

Together with the ingress correction, these patches passed the unchanged
17-check comparison. The expanded corpus, including delayed upstream calls,
passed 23/23 on Node, workerd and the locally patched Sproutboat app. These
are unreleased local patches, not claims about the installed runtime release.
The native regression includes BMP and astral text, escaped surrogate pairs,
nested JSON, quoted keys, lone surrogates, buffer growth, malformed JSON,
and bounded encodeInto destinations.

JSON now uses two-byte buffers rather than truncating values into bytes. Its
memory and throughput costs must be measured again on Linux before publishing
new footprint or speed figures. The comparison records hashes for the runtime
prelude, toolchain patch modules, compiler sources and precompiled builtin table.
No upstream issue or release has been created by this work.
