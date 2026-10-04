# Unicode contribution handoff

Local technical material, prepared with Codex. Not issue or PR submission text.
The TextEncoder fix is now [Porffor PR #395](https://github.com/CanadaHonk/porffor/pull/395).
The response, JSON and request-ingress candidates remain local.

## Recommended split

1. TextEncoder: combine surrogate pairs, replace lone surrogates, and keep
   encodeInto from writing a partial character. Submitted as PR #395.
2. Native HTTP response encoder: equivalent scalar conversion in generated C.
   Small second PR; validate native output bytes and allocation boundaries.
3. JSON: report the reduced failures first, then agree on the representation
   approach before proposing the broader parser/serializer patch.
4. Request ingress: investigate independently. The Sproutboat decoding fix is
   in its own runtime and cannot be pasted into Porffor unchanged.

The local TextEncoder and response patch candidates are direct diffs against inspected upstream
commit 08ac7ee1077c05da2bec18dcca15197051e87b62. They remove the need to submit
Sproutboat's string-replacement machinery. They retain local marker comments;
a contributor should remove those and review style before submission.
These are candidate patches, not fully validated upstream PRs.

## Reproducers

Each file in repros/ contains one native HTTP handler, without Sproutboat APIs.
The expressions are reduced from the executed matrix. The standalone wrappers
are newly prepared and have not themselves been compiled or executed yet.
Run one server at a time, because all use port 18082.

From the inspected Porffor checkout, using an absolute path to a repro:

```sh
bun runtime/index.js native /absolute/path/to/encoder-astral.js -o /tmp/encoder-repro -s
/tmp/encoder-repro
```

From another terminal:

```sh
curl --max-time 2 http://127.0.0.1:18082/
```

For response encoding, inspect raw bytes, rather than a rendered emoji:

```sh
curl --max-time 2 -s http://127.0.0.1:18082/ | od -An -tx1
```

The repro handlers do not include the loopback source restriction used in the
executed harness; use a private test environment. Stop each process afterward.

| Probe            | Expected                                 | Observed in both inspected snapshots     |
| ---------------- | ---------------------------------------- | ---------------------------------------- |
| encoder-bmp      | [99,97,102,102,195,168]                  | Matches control                          |
| encoder-astral   | [240,159,154,164]                        | [237,160,189,237,186,164]                |
| encoder-lone     | [239,191,189]                            | [237,160,128]                            |
| encodeinto-short | read 0, written 0, untouched destination | read 2, written 3                        |
| response-astral  | f0 9f 9a a4                              | ed a0 bd ed ba a4                        |
| json-unicode     | UTF-16 units 55357,56996                 | Uncaught parser exception; process exits |
| json-quoted-key  | Escaped quotation mark in key            | Invalid serialized object                |
| json-lone        | Escaped lone surrogate                   | Quotation mark, NUL, quotation mark      |
| json-trailing    | SyntaxError                              | Trailing non-whitespace accepted         |

Evidence.json contains expectations, exact sources and all three fresh-process
repetitions for each of the two immutable compiler snapshots. It is a subset of
the previously executed 45-probe matrix, not a new test run.

## Why JSON is not a small PR

The local patch converts JSON buffers from bytes to UTF-16, accepts both input
string representations, fixes key escaping and lone-surrogate serialization,
and rejects trailing input. It also changes pointer strides, buffer bounds,
length accounting and requires builtin precompilation.

Porffor intentionally uses compact byte strings for Latin-1. A universal UTF-16
buffer is a correctness solution locally, but may sacrifice upstream's compact
representation and performance goals. Agree on preserving a byte-string fast
path or promoting only when needed. Separate unrelated escaping and trailing
input fixes where possible. Check Test262 JSON results before and after, plus
native regression vectors and memory/allocation boundaries.

Local implementation: sibling sproutboat-packages repository,
packages/toolchain/src/unicode.ts. Tests: unicode.test.ts and
unicode-native.test.ts in the same directory. The native test exercises the
full locally patched Sproutboat integration, not these two diffs in isolation.

## Contribution policy

https://github.com/CanadaHonk/porffor/blob/main/AI_POLICY.md requires disclosure
of AI use and human-authored submission prose. A human contributor should
understand and own the change, write the issue/PR description, and disclose
Codex's role in investigation, patch generation and testing.

Before a PR: check the current branch and existing issues/PRs for overlap,
compile these standalone repros, apply each patch independently, validate
expected results, and run the appropriate upstream tests. This handoff does
not establish that no duplicate issue exists or that the patches fit future
upstream revisions.

## Handoff verification

- Both candidate diffs pass git apply --check against the inspected upstream snapshot.
- Encoder unit tests: 3 passed, 100 assertions.
- Locally patched native integration regression: 1 passed, 10 assertions.
- The remaining response candidate has not yet been tested independently against upstream.

## Published alpha-10 verification

The alpha-10 tag and npm metadata resolve to
08ac7ee1077c05da2bec18dcca15197051e87b62, the same immutable upstream snapshot
already tested in the Linux matrix. The official darwin-arm64 npm archive was
verified against its registry SHA-512 integrity. Its binary reports alpha 10
(08ac7ee 2026-09-27).

A fresh release-binary check compiled alpha-10-probes.js and ran each of the
nine selected probes in a separate native process on macOS arm64, without
Sproutboat patches. The accented-text control passed; all eight targeted
failing cases remained failures. The JSON escaped-emoji probe exited with code

1. Results are in alpha-10-release-results.json. This is a confirmation of
   these selected defects, not an overall compatibility score.

To repeat: compile alpha-10-probes.js with the verified release binary to
all-unicode in a private test directory. Save the official platform package
metadata there as platform-metadata.json, then run:

```sh
PORFFOR_ALPHA10_TEST_DIR=/absolute/path/to/private-test-dir python3 verify-alpha-10.py
```

The runner requires port 18082 to be unused, stops each native process, and
rewrites the local release-results artifact. The native listener is not
restricted to loopback by a source patch in this release-binary check.
