# Draft: TypedArray.prototype.set(source) with no offset copies to a NaN address

**Not filed.** Investigation notes for review (see the [README](README.md)).
Patched locally in `@sproutboat/toolchain` 0.4.22 (`TA_SET_OFFSET_MARKER`),
part of baronunread/sproutboat#238.

Tested alpha-13 (`547c7815`), unpatched, interpreted and native.

## Repro

```js
const p = new Uint8Array(4);
p.set(new Uint8Array([7, 8]));
console.log(Array.from(p).join(","));
```

Node prints `7,8,0,0`; Porffor prints `0,0,0,0`. With an explicit offset, or
with a plain-array source, it works.

## Cause

`__${name}_prototype_set` in `compiler/builtins/typedarray.js` starts with
`offset = Math.trunc(offset)`, which is NaN for an omitted offset. The plain-array
path happens to coerce it to 0 (`let i: i32 = offset`), but the same-type fast
path computes the copy address as `base + 4 + NaN * BYTES_PER_ELEMENT`, so
nothing lands at index 0 and the bytes are written somewhere else.

## Suggested fix

ECMA-262 uses ToIntegerOrInfinity, which maps undefined and NaN to 0 (and
`subarray`, right below, already uses it):

```diff
-  offset = Math.trunc(offset);
+  offset = ecma262.ToIntegerOrInfinity(offset);
```

Impact: @noble/hashes' HMAC does `pad.set(key)`, so the key was dropped (wrong
digest) and the stray write killed the process shortly after.
