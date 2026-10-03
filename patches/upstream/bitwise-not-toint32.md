# Draft: unary `~` saturates instead of applying ToInt32

**Not filed.** Investigation notes for review (see the [README](README.md)).
Patched locally in `@sproutboat/toolchain` 0.4.22 (`BITNOT_MARKER`), part of
baronunread/sproutboat#238.

Tested alpha-13 (`547c7815`), unpatched, interpreted and native.

## Repro

```js
let x = 4023233417,
  y = Infinity;
console.log(~x, ~~x, ~y);
```

|         | output                               |
| ------- | ------------------------------------ |
| Node    | `271733878 -271733879 -1`            |
| Porffor | `-2147483648 2147483647 -2147483648` |

Constant operands (`~4023233417`) are folded correctly, as are small values.
`~~x`, the common truncation idiom, is wrong for any `|x| >= 2^31`.

## Cause

`compiler/codegen.js` compiles `~` as `Un('~', T.i32, Convert(T.i32, ...))`, and
`Convert` from f64 without range knowledge saturates. The binary bitwise
operators already wrap correctly through `toUint32`.

## Suggested fix

```diff
-      return Box(Convert(T.f64, Un('~', T.i32, Convert(T.i32, numValue(toNumeric())))), Const(T.i32, TYPES.number));
+      return Box(Convert(T.f64, Un('~', T.i32, Convert(T.i32, toUint32(scope, numValue(toNumeric())), CONVERT_RANGE_KNOWN | CONVERT_SIGNED))), Const(T.i32, TYPES.number));
```

Impact: uuid's SHA-1 computes `x & y ^ ~x & z` on words above 2^31, so every
v5 UUID was wrong.
