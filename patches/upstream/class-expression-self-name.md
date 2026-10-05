# Draft: a named class expression's own name is a different object inside a function

**Not filed.** Investigation notes for review (see the [README](README.md)).
Worked around in `@sproutboat/toolchain` by a parse-time rewrite
(`CLASS_SELF_MARKER`, baronunread/sproutboat#256).

Tested alpha-13 (`547c7815`) and alpha-15 (`72d048d7`), unpatched.

## Repro

```js
function f() {
  var H = class l {
    run() {
      return 1;
    }
    static make() {
      return new l();
    }
    same() {
      return l === H;
    }
  };
  return [new H().same(), typeof H.make().run];
}
var T = class m {
  same() {
    return m === T;
  }
};
console.log(f(), new T().same());
```

Node prints `[ true, 'function' ] true`. Porffor prints `[false, undefined] true`:
inside a function, the class's own name `l` seen from its methods is not the
class, and `new l()` builds an object with none of the class's methods. A
constructor that reads a variable declared later in the function sees
`undefined` through the same path. At top level both work.

Minified bundles hit this constantly. Bundlers emit
`var R = class l { static lex(e, t) { return new l(t).lex(e); } }` for any class
whose static members refer to it; marked's `Lexer.lex` fails with
`TypeError: value is not a constructor` as soon as the bundle runs inside a
function.

## Cause

`semantic.js` (around line 608 in alpha-15) marks a self-reference as
`_selfAware` for function declarations and expressions but skips class
expressions, and the capture step (`variable.scope?.type !== 'ClassExpression'`)
never turns the inner name into a captured variable. In `codegen.js`,
`generateIdent` then resolves the name through `resolveNamedFunction` and
`materializeFunctionValue`, which, inside a function, allocates a new function
object rather than returning the class value `generateClass` built and wired
to its prototype. Alpha-15's `d5dbfc5` / `91d6cc1` fixed the same shape for
function expressions by making the self-name a real local; class expressions
need the equivalent.

## Workaround

Rewriting `class l { ... }` (inside a function, when the body uses `l`) to
`(() => { const l = class { ... }; return l; })()` before semantic analysis
gives the right results, since an ordinary `const` is captured correctly.
