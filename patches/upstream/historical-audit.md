# Platform upstream audit at alpha-6

This is the platform's status snapshot from 2026-09-16, checked against Porffor
alpha-6 (`038f415e`). It is historical, not a current compatibility report.
The compiler pin and source patches had moved to `@sproutboat/toolchain`,
shared by the CLI and platform. WHATWG surface shims had moved to
`@sproutboat/runtime`.

At that time, the plan for [WHATWG fetch globals](whatwg-fetch-globals.md) was
one issue covering `URLSearchParams` and static `Response.json`. The
[port note](runtime-port.md) was held because the wider question was how
handlers should access their environment. See the
[retracted environment-access finding](environment-access.md) for the later
correction. The promise resolution livelock had been fixed upstream, and the
two prematurely filed native fetch reports were retained as history.

| Gap                                              | Alpha-6 finding                                  | Filing status at the time                                                 |
| ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------- |
| `URLSearchParams` / `URL.prototype.searchParams` | Missing; shimmed in `@sproutboat/runtime`        | Draft A                                                                   |
| Static `Response.json(data, init)`               | Missing; instance `json()` existed               | Draft A                                                                   |
| Class declaration visibility                     | Failed in interpreter and native builds          | Draft B                                                                   |
| Non-ISO `Date` string parsing                    | Diverged from V8 on implementation-defined input | Draft D needed a stronger real-world input                                |
| `Date` timezone offsets                          | Ignored or applied with the wrong sign           | Draft E filed as [#387](https://github.com/CanadaHonk/porffor/issues/387) |

These entries record investigation and filing status. Reproduce against
current Porffor before treating any draft as an open gap.
