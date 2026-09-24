# Open finding: zod compiles, then dies at module init

Tracked as baronunread/sproutboat#175 (independently re-reproduced there,
2026-09-13, past the capability-check fix in #132). Not filed upstream at
Porffor yet: the reproducer below is small and reliable but has not been
reduced to a language construct, and #145's own thread shows the maintainer
would rather have the construct than a library.

**Still reproduces on alpha-5** (`1f4ae4ae`), unchanged: the reduced
`$constructor` snippet below builds and then dies with the same
`Uncaught TypeError: Cannot read property of undefined` at init, server never
binds. alpha-5's slot-based closure-env rewrite and loop-capture fixes did not
touch it. So bumping the pin does not unblock zod / better-auth.

zod matters more than any one library: `better-auth`, and a large slice of
everything else, depends on it. It is the gate in front of most of npm.

## What happens

```sh
# handler.js: import { z } from "zod"; export default { fetch(){ … } }
COMPILED in 21s, 2.1 MB           # 145 KB of bundled zod, compiles fine
$ PORT=8791 ./out.bin
Uncaught TypeError: Cannot read property of undefined
```

The crash is at module initialisation, before the server listens, and is
deterministic (6/6 runs of one binary). Moving the schema construction inside
the handler does not help, so it is zod's own top-level setup.

## Reduced to

```js
import { $constructor } from "zod/v4/core/core.js";
// Importing core.js and never calling this: fine.
// Calling it once, with no Parent and a trivial initializer: crash.
const C = $constructor("C", (inst) => {
  inst._zod ??= {};
});
```

`$constructor` is ~40 lines (`zod/v4/core/core.js`). Something it runs _when
called_ is the trigger.

## Ruled out

Each verified individually as a compiled sprout that serves a request:

- `new WeakSet([Object.prototype, Error.prototype])`
- `class D extends P` where `P` is a runtime value (`Object` and `Error`)
- `Object.defineProperty(fn, "name", …)` and `fn.prototype = obj` before `new`
- `Object.getOwnPropertyDescriptor` over `for…in` keys, including a getter
- optional chaining on an undefined argument or omitted parameter
- `"captureStackTrace" in Error`
- the `node()` helper from `errors.js`, in isolation

## A separate bug found on the way

`Symbol.hasInstance` is ignored. `instanceof` does not consult it:

```js
function f() {}
Object.defineProperty(f, Symbol.hasInstance, { value: () => true });
({}) instanceof f; // false on Porffor, true everywhere else
```

Same shape as #145: a silent wrong answer rather than an error. Worth filing on
its own once confirmed against `main`; zod uses exactly this to make
`instanceof` work across its class hierarchy.

## Harness note for whoever picks this up

Reduce with a runner that deletes the binary before each compile and binds port
0 to pick a free port. An earlier pass here reported false passes both ways: a
stale `out.bin` answered for a compile that had failed to bundle, and a random
port collided with a server left over from a previous case. Two rounds of
conclusions had to be thrown away.
