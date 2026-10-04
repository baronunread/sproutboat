# Prepared TextEncoder PR

Status update, 2026-09-28: the TextEncoder fix is open upstream as [Porffor PR #395](https://github.com/CanadaHonk/porffor/pull/395). The preparation and checkout details below record the state before that PR was opened.

Base: Porffor alpha-10, commit 08ac7ee1077c05da2bec18dcca15197051e87b62.

## Contents

- `PR.md`: title and body drafted in upstream's house style. The AI disclosure
  line is deliberately left as a placeholder; see "Before posting" below.
- `text-encoder.patch`: the runtime change only, `runtime/fetch-globals.js`.
- `check-native.ts`: the 123-vector regression runner. A local verification
  artifact, **not** part of the proposed patch.
- `baseline-results.json`, `patched-results.json`, `fork-patched-results.json`:
  native results with Bun as the oracle. Baseline 34/123, patched 123/123.
  Targeted vectors, not an overall compatibility percentage.
- `verification.json`, `selfhost-*.log`: self-host and harness outcomes.
- `full-test262-*.json`: summaries of full-corpus runs from an earlier
  revision; the raw per-test dumps (3.7 MB each) are not kept. See "Test262"
  below before citing any of it.

Apply and verify:

```sh
cd <clean checkout of the base>
git apply /absolute/path/to/text-encoder.patch
cp /absolute/path/to/check-native.ts runtime/tests/text-encoder.ts
bun runtime/tests/text-encoder.ts
```

The runner compiles a native handler, compares byte arrays and `encodeInto`
counts against Bun, and cleans up its process and temporary files. It needs
Bun, a native compiler, compiler cache access and a free local port. Run it in
a private test environment. No Sproutboat prelude or other patches are
involved.

## Why the test file is not in the patch

Upstream has no unit test directory. alpha-10 ships `test262/` and `bench/`
only, and `.github/workflows/ci.yaml` runs `./selfhost verify` plus
`test262/selfhost.js harness`. A new `runtime/tests/` directory would introduce
a convention that nothing in CI executes, and this runner additionally needs
Bun, a C compiler and a bound localhost port. Merged PRs in this repo evidence
their changes in the description instead, with a `new passes` list for test262
work. `PR.md` follows that pattern with a repro block and the vector counts.
If upstream wants the runner, that is a separate conversation rather than a
rider on a bug fix.

## Revision history

The candidate has been rewritten three times. Only the third is current.

1. Codex's draft: `encode` allocated the buffer and called the **public**
   `encodeInto` to fill it, so replacing `encodeInto` on an instance broke
   `encode`. It also replaced the `Porffor.TYPES.bytestring` check in `encode`
   with a plain `String(input)`, dropping the bytestring fast path.
2. GPT-6 Sol's cleanup: removed the standalone helper and the extra
   `_encodeInto` method, and restored a single encoding loop.
3. This review: `encode` kept as the sole owner of the UTF-8 loop.
   `encodeInto` rewritten. It previously re-derived each character's length
   from its lead byte, a second copy of the size table that partially decoded
   the UTF-8 it had just produced. It now clamps to `destination.length`, backs
   off while the cut lands on a continuation byte, and counts `read` from the
   same one-bit test. No helpers, no new observable methods, one size table in
   the file.

`String.prototype.codePointAt` would have removed the duplicated surrogate-pair
test across `encode`'s two passes, but it is broken upstream; see Follow-ups.

Revision 3 passes the same 123/123 native vectors. The patch is confirmed to
apply cleanly to a pristine alpha-10 extracted from the release tarball;
`runtime/fetch-globals.js` is blob `251cb5da` in both pristine alpha-10 and the
review branch's base.

## Checkouts

The review branch `fix/text-encoder` is at `/private/tmp/porffor-encoder-fork-review`,
based on `aa80008c`, two Proxy-trap commits above alpha-10. Those commits do not
touch `runtime/fetch-globals.js`, which is why the patch is still valid against
upstream, but the PR should be opened from a branch off alpha-10 itself rather
than off the Proxy work. No commit, push or PR was created.
`/Users/andreabruno/Code/OSS/Porffor` remains clean.

`/private/tmp/porffor-alpha10-source` is **not** a pristine base. It has
revision 1 already applied, marked `sb_text_encoder_scalar_v1`. Use the
tarball, `/private/tmp/porffor-alpha10-08ac7ee.tar.gz`, as the reference.

## Test262

test262 does not cover `TextEncoder`, which is a Web API, so these vectors are
a native runtime regression rather than language tests.

The full-corpus runs recorded here were made against an earlier revision and
should not be cited as validation of revision 3. They are kept because of what
they show about the harness: three isolated fork copies ran the pinned
53,404-file corpus with TinyCC and eight workers, no filters, and the two
**unchanged** baselines differed on 21 individual test outcomes (34,210 vs
34,200 passes, 30 vs 42 timeouts). Full-run classification varies under
identical source and settings, so a small delta between a baseline and a
patched run carries no signal. The one `String.replaceAll` failure that
appeared only in the patched full run passed in both unchanged full runs and in
three focused reruns on each build.

Details: `full-test262-comparison.json`, `full-test262-repeat-control.json`,
and `full-test262-environment.json` for the test262 revision, toolchain commit,
command, patch hash and counts. Test262 revision
6eec1ac9ee144dafd8f344d73a21f36bfc9f6755, matching CI.

CI-equivalent semantic checks passed on the fork: self-host verify including
all 11 case comparisons and stage-2 generated-C parity, and the selfhost
harness at `--threads=4 --expect-passes=107`. A host harness baseline
comparison had identical per-test outcomes in both copies: 107 pass, 5 fail,
3 runtime errors, 1 native compile error. No new harness regressions. These
ran on macOS with a clang `-O0` self-host build, not the Linux release
pipeline.

## Before posting

`AI_POLICY.md` requires disclosure of AI usage and its extent, and states that
LLM-generated PR descriptions will be closed without review. Every revision of
the code and of `PR.md` in this directory was written by a model. Read the
patch, satisfy yourself that you understand and own it, then write the
disclosure line yourself. Merged PR #358 is the precedent for the form:
first-person, naming the tool and the extent, and claiming ownership. Do not
paste a disclosure that overstates what you did.

## Follow-ups

- `compiler/builtins/string.ts:252`, `__String_prototype_codePointAt`: the
  bounds check `if (index + 1 >= len)` compares an already-doubled byte index
  against the undoubled length, so a surrogate pair anywhere but the start of a
  string returns the lone lead surrogate. `'x🚤'.codePointAt(1)` gives 0xD83D.
  Smaller and cleaner than this PR, and a compiler bug rather than a Web API
  gap. Worth filing separately.
- `runtime/fetch-globals.js`, `TextDecoder.decode`: no 4-byte branch, so
  `decode(encode('🚤'))` does not round-trip. Flagged in `PR.md` as a
  deliberate follow-up so a reviewer does not read it as an oversight.
- The Sproutboat toolchain's older local encoder patch still calls the public
  `encodeInto` from `encode`, the revision 1 flaw. Port revision 3 back before
  releasing those local Unicode changes. This directory touches only the
  candidate and temporary copies.
