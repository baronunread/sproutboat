# Class declarations not hoisted into scope (Draft B)

**Title:** class declaration is not visible before its position in source

alpha-5 (`1f4ae4a`). Fails in both the interpreter and `native`.

```js
class A {
  get x() {
    return new B();
  }
}
class B {
  constructor() {
    this.ok = true;
  }
}
console.log(new A().x.ok); // expected: true
```

```
Uncaught ReferenceError: B is not defined
```

Declaring `B` before `A` works. Per spec, `class` declarations are hoisted to the
top of their scope (in TDZ); by the time `A`'s getter body runs, `B` is
initialised, so source order should not matter. Found this while adding a
`new URLSearchParams()` call inside a `URL` getter in `fetch-globals.js`; we had to
move the class above `URL`.
