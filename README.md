# Sproutboat POC

This repository contains both the Phase 0 compatibility harness and the first
Sproutboat POC: a locally compiled Linux artifact, an artifact-only control API,
an isolated edge runtime, and provider-neutral VPS configuration.

## POC quick start

Requirements: Bun, Docker, and a local Linux/amd64 Sproutboat build image. Build
the image once from the repository root. The CLI reads the Docker image digest
automatically and records that immutable identity in each artifact:

```sh
docker build --platform linux/amd64 -t sproutboat/build:dev -f build-image/Dockerfile .
```

```sh
bun run sproutboat -- init hello
bun run sproutboat -- dev hello --port 8788
curl -H 'Host: hello.localhost' http://127.0.0.1:8788/
```

`sproutboat build`, `deploy --dry-run`, `deploy --artifact`, `tail`, `versions
list`, `rollback`, and `delete --yes` are available. The real-domain VPS flow
is documented in [infra/README.md](infra/README.md).

## Local end-to-end test

Install dependencies and start the complete local stack. It starts Portless,
the GitHub emulator, Control, Edge, and the React dashboard.

```sh
bun install
bun run dev:local
```

On Portless's first run, trust its local certificate authority. Open
`https://dashboard.sproutboat.localhost/`, select **Sign in with GitHub**, use the
seeded `andrea` account, and reserve the `andrea` namespace.

In another terminal, create and authorize a project:

```sh
bun run sproutboat -- init hello
bun run sproutboat -- login --api-url https://control.sproutboat.localhost
```

The login command opens the dashboard. Select **Approve CLI login**, then
deploy and verify the result:

```sh
bun run sproutboat -- deploy hello
open https://hello.andrea.sproutboat.localhost
bun run sproutboat -- versions list hello
bun run sproutboat -- tail hello
```

The dashboard is at `https://dashboard.sproutboat.localhost/dashboard`. Control
is API-only; it has no user-facing dashboard.

### Reset local state

Stop the launcher with `Ctrl-C`, then remove local state and saved CLI
credentials before starting it again:

```sh
rm -rf .local/sproutboat
rm -rf /Users/andreabruno/.config/sproutboat
bun run dev:local
```

Portless certificates and the Docker build image remain intact.

## Compatibility harness

The harness answers one question: **does the installed Porffor version correctly
run enough simple webhook-style handlers to justify the supported capability
profile?**

The frozen threshold is at least 40% of capability handlers matching Bun on all
three probes. Compilation alone does not count; behavior must match.

## Retest a new Porffor release

Requirements: Bun, macOS or Linux, and a C compiler (`clang` or `gcc`). Do not
use npm in this repository.

From the repository root:

```sh
bun add --dev porffor@latest
bun run retest
```

To test a specific release instead:

```sh
bun add --dev porffor@0.70.0
bun run retest
```

To test an official compiler release that is not published to npm, point the
harness at its `porf` launcher and provide the exact release identity:

```sh
PORFFOR_BIN=/path/to/porf \
PORFFOR_VERSION='alpha 2 (20383ef 2026-08-26)' \
PORFFOR_MODE=native-fetch \
bun run retest
```

The first command updates both `package.json` and `bun.lock`. The retest takes
roughly one to two minutes and overwrites two tracked artifacts:

- `report.json`: machine-readable results for every handler.
- `COMPAT.md`: the human-readable matrix and **GO** or **NO-GO** decision.

Commit the dependency files and both generated artifacts together when keeping
an npm result. By default the report records the version installed in
`node_modules`; non-npm runs record the explicit `PORFFOR_VERSION` identity.

## Commands

```sh
bun run check   # validate tools, capability-suite shape, and all Bun reference probes
bun run diff    # compile and compare every handler; write report.json
bun run report  # regenerate COMPAT.md from an existing report.json
bun run retest  # run all three steps in order
```

The harness continues past individual Porffor failures so one unsupported
handler cannot prevent the report from being generated. Native compilation is
limited to 30 seconds per handler and binary execution to 5 seconds, so a
compiler or program hang is recorded as a failure instead of stalling the run.

## Reading a result

`COMPAT.md` starts with the installed compiler version, compile and match
counts, median binary size, and the decision. It also groups failures into:

- **compile**: Porffor could not produce a native binary;
- **runtime**: the binary compiled but crashed or emitted invalid output;
- **output mismatch**: the native response differed from Bun.

If nearly every handler suddenly fails with the same compiler/CLI error, treat
that as a likely harness integration change and inspect the first error before
using the decision. Normal compatibility regressions usually affect particular
language or Web API features rather than every file identically.

## Repository map

- `tests/porffor/capabilities/`: 30 import-free handlers comprising the first
  accepted Porffor capability suite, using the frozen Workers-style contract.
- `tools/refserve.ts`: Bun reference implementation.
- `tools/compile.ts`: Porffor native compiler wrapper.
- `tools/shim.js`: stdin/stdout JSON ABI used by compiled probes.
- `tools/diff.ts`: three-probe differential runner.
- `tools/report.ts`: compatibility matrix and threshold decision.

Generated binaries and wrapped sources live under `.phase0/` and are ignored
by Git.
