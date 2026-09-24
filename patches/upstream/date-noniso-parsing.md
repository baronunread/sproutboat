# Non-ISO Date parsing diverges from V8 (Draft D)

**Title:** native-fetch: `new Date("<legacy/non-ISO string>")` doesn't match the format every other engine converges on

alpha-5 (`1f4ae4a`), `porf native`. Framing note: non-ISO date parsing is
explicitly implementation-defined by spec, so this isn't a correctness bug;
it's a web-compatibility gap, on the same footing as any other "every engine
agrees on more than the spec requires" divergence.

Realistic inputs a handler plausibly receives (a form field, a header, a
third-party API's date string), not a synthetic probe value:

```js
new Date("3/5/2008").toISOString();
// V8 / Bun / Deno: "2008-03-04T23:00:00.000Z"  (M/D/YYYY, local tz)
// Porffor native:  "0008-10-28T00:00:00.000Z"

new Date("March 5, 2008").toISOString();
// V8 / Bun / Deno: "2008-03-04T23:00:00.000Z"
// Porffor native:  throws "Invalid time value": RangeError, not a parse
```

Impact: a handler doing `new Date(userSuppliedString)` on anything but a
strict ISO 8601 string either gets a silently wrong date or an unexpected
throw, on input every other engine accepts identically. Verified against a
real `porf native` build, not just the interpreter.

Not shimmed locally: replicating V8's full lenient date grammar in a prelude
is disproportionate. Filing as a web-compat gap so it can be addressed in
`compiler/builtins` if the maintainer wants engine parity here (their call;
this is a "here's the gap" report, not "this must be fixed").
