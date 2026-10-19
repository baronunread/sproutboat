# `Map.groupBy` is missing

**Not filed.** Worked around in `@sproutboat/toolchain` by adding the builtin
(`patchMapGroupBy`, baronunread/sproutboat#286).

Tested alpha-17 (`731f1b2a`) and alpha-18 (`deda4945`), unpatched. `Object.groupBy`
exists; `Map.groupBy` does not.

## Repro

```js
const m = Map.groupBy([1, 2, 3, 4], (x) => (x % 2 ? "odd" : "even"));
console.log(JSON.stringify([...m]));
```

Expected `[["odd",[1,3]],["even",[2,4]]]`; Porffor throws `TypeError`.

## Fix shape

The same loop as `__Object_groupBy`, collecting into a Map
(`__Porffor_hashtableNew(true)` plus `__Map_prototype_has/set/get`), which keys by
SameValueZero, so `NaN` and object keys group correctly.
