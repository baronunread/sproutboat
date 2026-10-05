# Porffor upstream notes

This directory is the shared home for Sproutboat's Porffor findings, upstream
reports, and patch notes. The compiler pin and source patches live in
`@sproutboat/toolchain`; runtime shims live in `@sproutboat/runtime`. The CLI
and platform both use those packages.

Some notes were written against older Porffor pins. Check the version in each
file and reproduce a finding on current `main` before filing it. Porffor's
[`AI_POLICY`](https://github.com/CanadaHonk/porffor/blob/main/AI_POLICY.md)
requires disclosure of AI use and contributor-written PR descriptions and
comments. These drafts are investigation notes for review, not ready-to-post
text. Filing an issue on `CanadaHonk/porffor` requires explicit human approval.

| Note                                                        | Contents                                               |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| [TypedArray.from](typedarray-from-arraylike.md)             | Array-like input draft                                 |
| [Runtime port](runtime-port.md)                             | Native fetch listener port draft                       |
| [Status lines](status-lines.md)                             | Unlisted HTTP status codes (#156)                      |
| [Console output](console-output.md)                         | Buffered handler output (#165)                         |
| [Remote address](remote-address.md)                         | Client address exposure (#163)                         |
| [UTF-8 wire encoding](utf8-wire-encoding.md)                | Response bytestring encoding (#172)                    |
| [WHATWG fetch globals](whatwg-fetch-globals.md)             | URLSearchParams and Response.json draft                |
| [Class declaration scope](class-declaration-scope.md)       | Class visibility draft                                 |
| [Environment access](environment-access.md)                 | Retracted environment-access finding                   |
| [Non-ISO Date parsing](date-noniso-parsing.md)              | Web compatibility draft                                |
| [Date timezone offsets](date-timezone-offsets.md)           | Filed as Porffor #387                                  |
| [Zod module init](zod-module-init.md)                       | Resolved on alpha-13; reduced startup failure          |
| [Request streaming](request-streaming.md)                   | Standalone ingress draft                               |
| [Promise resolution](promise-resolution-livelock.md)        | Original resumed async turn investigation              |
| [Porffor #388 history](promise-resolution-issue-388.md)     | Archived promise resolution report                     |
| [Promise resolve null](promise-resolve-null.md)             | Unfiled draft: null resolution rejects (#168)          |
| [Typed-array store wrap](typedarray-store-wrap.md)          | Fixed upstream in alpha-14 (#238)                      |
| [TypedArray set offset](typedarray-set-offset.md)           | Unfiled draft: set() without offset (#238)             |
| [Bitwise NOT](bitwise-not-toint32.md)                       | Fixed upstream in alpha-14 (#238)                      |
| [Typed-array bounds](typedarray-bounds.md)                  | Unfiled draft: unchecked reads and writes (#238, #241) |
| [Class expression self-name](class-expression-self-name.md) | Filed as Porffor #400                                  |
| [Porffor #386 history](request-body-report-386.md)          | Retracted byte body report                             |
| [Tracked issues](tracked-issues.md)                         | Proxy and Web Crypto gaps                              |
| [Local patches](local-patches.md)                           | Historical patch inventory and source pin rationale    |
| [Alpha-6 audit](historical-audit.md)                        | Historical platform status snapshot                    |

## Research snapshots (alpha-9/alpha-10, September 2026)

These predate the alpha-13 pin. Re-check a finding against the current pin before citing it.

- [Limitation analysis](../../docs/porffor-limitations-analysis.md), 2026-09-27: 45 native HTTP probes, three fresh processes each, alpha-9 pin against alpha-10. It separates missing APIs, protocol bugs, silent wrong results and fatal exceptions. It is not a compatibility score.
- [Runtime comparison plan](../../docs/runtime-comparison-plan.md): a proposed Node, workerd and Sproutboat benchmark. Not yet run.
- [Native Unicode input](native-unicode-json.md) and [Unicode handoff](unicode-handoff/README.md): reproducers and candidate patches for TextEncoder, native response encoding and JSON.
- [TextEncoder PR notes](text-encoder-pr/README.md): the fix is open upstream as [Porffor PR #395](https://github.com/CanadaHonk/porffor/pull/395). Native regression vectors went from 34/123 to 123/123.
