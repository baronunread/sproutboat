# Draft: typed-array element reads and writes have no bounds check

**Not filed.** Investigation notes for review (see the [README](README.md)).
Patched locally in `@sproutboat/toolchain`: reads in 0.4.22 (`TA_GET_MARKER`,
baronunread/sproutboat#238), writes in sproutboat-packages#71
(`TA_SET_BOUNDS_MARKER`, baronunread/sproutboat#241).

Tested alpha-13 (`547c7815`), unpatched.

## Repro

```js
const a = new Uint32Array(2);
const b = new Uint32Array(2).fill(7);
const read = String(a[3]);
for (let i = 2; i < 8; i++) a[i] = 99;
console.log(read, b.length, Array.from(b).join(","));
```

Node prints `undefined 2 7,7`. Porffor prints `2 99 6845543,0,1024,...`: the
out-of-range read returns the next allocation's header, and the out-of-range
writes overwrite `b`'s length, after which `b` exposes 99 elements of unrelated
memory. `a[-1]` and `a[1.5]` misbehave too; a negative index saturates to 0, so
`a[-1] = x` writes `a[0]`.

## Cause

`taGet` / `taSet` in `compiler/codegen.js` load and store at
`base + index * size` with no check. Plain arrays already guard their fast path
with `denseArrayIndexKey`.

## Suggested fix

Check `denseArrayIndexKey(scope, prop).valid && idx < length` (length is at
offset 0) and return `undefined` / skip the store otherwise.

One wrinkle: the `TypedArray` constructor builtin stores its elements before it
writes the length, so a guard on stores inside builtins drops them. The local
patch applies both checks to user code only (`!globalThis.precompile`); upstream
could instead set the length before the element loop. Applying the read check
inside builtins also broke typed-array `join` / `toString`, which is worth
understanding before enabling it there.

Impact: uuid's SHA-1 reads past its padded buffer (JavaScript's `undefined << 24`
is 0), so v5 UUIDs changed from run to run. Out-of-range writes are a
memory-safety problem in any program.
