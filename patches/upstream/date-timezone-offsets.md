# Date ignores timezone offsets and folds them into milliseconds (Draft E)

**Filed: [CanadaHonk/porffor#387](https://github.com/CanadaHonk/porffor/issues/387).**

**Title:** native-fetch: ISO 8601 timezone offsets are ignored (and leak into ms)

alpha-5 (`1f4ae4a`), `porf native` and `porf run` alike: still reproduces
identically (same three wrong outputs below), re-verified after the
alpha-4 -> alpha-5 bump, not just carried over from the original filing.

Distinct from [Draft D](date-noniso-parsing.md): that one is about _non-ISO_ strings, where the grammar is
implementation-defined. This is a fully ISO 8601 input with a numeric offset,
where the correct instant is specified.

```js
new Date("2024-01-02T03:04:05+02:00").toISOString();
// V8 / Bun / Deno: "2024-01-02T01:04:05.000Z"
// Porffor:         "2024-01-02T03:04:05.002Z"   <- offset ignored; "02" became 2ms

new Date("2024-01-02T03:04:05-05:00").toISOString();
// V8:      "2024-01-02T08:04:05.000Z"
// Porffor: "2024-01-02T03:04:05.005Z"

new Date("2024-01-02T03:04:05.250+01:00").toISOString();
// V8:      "2024-01-02T02:04:05.250Z"
// Porffor: "2024-01-02T04:04:05.250Z"   <- offset applied with the wrong sign
```

Two bugs in one: the offset is not subtracted to reach UTC, and when there is no
fractional-seconds component the offset's digits are consumed as milliseconds.
With a fractional part present the offset is applied, but inverted.

Impact is quiet: the result is a valid `Date`, not `Invalid Date`, so a handler
cannot detect it. Any handler parsing a timestamp from an API response, a
webhook, or a `Date:` header gets a wrong instant, off by the offset or off by
double it.

Not shimmable from a prelude: assigning `Date.parse = …` makes the compiler emit
a call with the wrong arity (`too few arguments to function call, expected 3,
have 1`) and the C build fails. It has to be fixed in `compiler/builtins`.

Covered by `tests/porffor/capabilities/32-date-offset.js`.

Sproutboat patches `compiler/builtins/date.ts` in `@sproutboat/toolchain@0.4.13`.
The alpha-9 capability comparison now passes `32-date-offset.js`; the upstream
Porffor issue remains open.
