# Private class fields are enumerable own properties

**Not filed.** Worked around in `@sproutboat/toolchain` (`patchPrivateFieldsHidden`,
baronunread/sproutboat#286).

Tested alpha-17 (`731f1b2a`) and alpha-18 (`deda4945`), unpatched.

## Repro

```js
class A {
  #s = 1;
  pub = 2;
  static #t = 3;
  get s() {
    return this.#s;
  }
}
console.log(JSON.stringify(Object.keys(new A())), JSON.stringify(new A()), JSON.stringify(Object.keys(A)));
```

Expected `["pub"] {"pub":2} []`; Porffor prints `["__#s","pub"] {"__#s":1,"pub":2}`,
and the static `#t` shows up the same way.

## Cause

A private name lowers to the string key `"__#" + name` (`privateIDName` in
`codegen.js`), and class fields install it with `__Porffor_object_class_value`, the
enumerable path used for public fields.

## Workaround and its limit

Install private fields with `__Porffor_object_class_method` (writable, configurable,
not enumerable). That hides them from `Object.keys`, `Object.entries`, `for...in` and
`JSON.stringify`. `Object.getOwnPropertyNames`, `Reflect.ownKeys` and `"__#s" in obj`
still see the internal name; a real fix keeps private names out of the property table.
