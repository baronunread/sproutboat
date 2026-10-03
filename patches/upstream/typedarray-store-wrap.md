# Draft: integer typed-array stores saturate instead of wrapping

**Not filed.** Investigation notes for review; filing at `CanadaHonk/porffor`
needs explicit human approval and a contributor-written description (see the
[README](README.md)). Patched locally in `@sproutboat/toolchain` 0.4.21
(`TA_STORE_MARKER`), part of baronunread/sproutboat#238.

Tested alpha-13 (`547c7815`), unpatched, interpreted and native.

## Repro

```js
const u32 = new Uint32Array(1),
  i32 = new Int32Array(1),
  u16 = new Uint16Array(1);
let a = 2000000000,
  b = 2000000000;
u32[0] = (a + b) | 0;
i32[0] = a + b;
u16[0] = (a + b) | 0;
const f = new Uint32Array(1);
f.fill(-1);
console.log(u32[0], i32[0], u16[0], f[0]);
```

|         | output                                   |
| ------- | ---------------------------------------- |
| Node    | `4000000000 -294967296 10240 4294967295` |
| Porffor | `0 2147483647 0 0`                       |

A constant store (`u32[0] = -5`) is folded correctly; computed values are not.
`fill`, `set` and `from` show the same bug because the builtins are compiled
with the same codegen.

## Cause

`taSet` in `compiler/codegen.js` converts the value with `Convert(T.u32, f, 0)` /
`Convert(T.i32, f)`. Without range knowledge that renders as
`porf_f64_to_u32` / `porf_f64_to_i32`, which saturate (trunc_sat). ECMA-262
IntegerIndexedElementSet converts with ToUint32 / ToInt32 / ToUint16 ..., which
wrap modulo 2^n.

## Suggested fix

Route the stored value through the modular `toUint32` that the bitwise
operators already use, reinterpreting it as signed for `Int*Array`. Narrower
stores keep the low bits, which is exactly the modular result:

```diff
-      stmt(scope, Store(ctype, addr, 4, ctype === 'f64' || ctype === 'f32' ? f : signed ? Convert(T.i32, f) : Convert(T.u32, f, 0)));
+      stmt(scope, Store(ctype, addr, 4, ctype === 'f64' || ctype === 'f32' ? f : signed ? Convert(T.i32, toUint32(scope, f), CONVERT_RANGE_KNOWN | CONVERT_SIGNED) : toUint32(scope, f)));
```

Impact: @noble/hashes' SHA-256 stores `x | 0` into a `Uint32Array` message
schedule, so every negative word was zeroed and the digest was wrong.
