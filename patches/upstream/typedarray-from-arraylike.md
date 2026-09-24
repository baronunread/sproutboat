# Draft: `TypedArray.from` returns an empty array for array-like input

This is a Porffor built-in bug, separate from Sproutboat's native crypto byte
bridge. Sproutboat patches its pinned compiler in
`@sproutboat/toolchain`'s `patchTypedArrayFrom` and regenerates
`builtins_precompiled.js`. The behavior belongs upstream; the patching and
regeneration steps are how we ship it while pinned to Porffor source.

Porffor `main` at `8f01541498d6d61c0cbbf8a71be152330888be7e` still has
the iterable branch without an array-like fallback in
`compiler/builtins/typedarray.js`. The same commit is our alpha-7 pin. The
standalone native build exposed the bug with an HMAC key made by
`Uint8Array.from({ length: 16 }, (_, i) => i + 1)`: the key was empty.
Porffor's open [PR #383](https://github.com/CanadaHonk/porffor/pull/383)
also edits `typedarray.js`, but its diff does not change `TypedArray.from`.

The notes below follow the short version/reproducer/expected/actual pattern
used in [#387](https://github.com/CanadaHonk/porffor/issues/387),
[#392](https://github.com/CanadaHonk/porffor/issues/392), and recent Porffor
PRs. They are a draft for a human to verify and rewrite, not text to paste
unchanged. Porffor's `AI_POLICY` requires disclosure of AI use and says PR
descriptions and comments must be written by the contributor. As of
2026-09-24, GitHub also shows issue creation as restricted in this repo.

**Title:** `TypedArray.from` ignores array-like objects

**Version:** `main` / alpha-7 at `8f015414`, native build.

## Reproducer

```js
const bytes = Uint8Array.from({ length: 4 }, (_, i) => i + 1);
console.log(bytes.length);
console.log(bytes[0]);
```

Build with `./porf native repro.js -o repro` and run `./repro`. Delete `repro`
before each compile to avoid reading output from a stale binary if compilation
fails. The equivalent Sproutboat standalone build used the 16-byte form above.

## Expected / actual

- JavaScript engines produce length `4` and first byte `1`.
- The pinned Porffor native build produced an empty typed array. Its
  `__${name}_from` implementation sets `len` only for the supported iterable
  types, so a plain object falls through to `arr.length = 0`.

## Upstream change to consider

Add the array-like path to the generated `TypedArray.from` builtin, including
length conversion, indexed reads, mapper validation, and mapper calls. Cover
plain array-like input with and without a mapper, plus a non-callable mapper,
in Porffor's tests. Port the behavior rather than copying Sproutboat's
marker-based patch: upstream should regenerate `builtins_precompiled.js` as
part of the source change, without our build-time patch step. Check the
`typedarray.js` diff against PR #383 before proposing a change, since both
touch the same file.

**Verification still needed before filing:** run the minimal reproducer on
Porffor's current `main` in both regular and native modes and record the exact
output. The source was inspected at `8f015414`, while the confirmed runtime
failure came from Sproutboat's standalone build using that pinned commit.
