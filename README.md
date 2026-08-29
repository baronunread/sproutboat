# Sproutboat

Host small JavaScript functions, compiled locally with
[Porffor](https://porffor.dev/), on **one Linux VPS you control**. Upload only
the finished native artifact — the server never sees your source. Stable HTTPS
endpoint, immutable versions, rollback, logs.

This repo is the **single-machine, single-admin** deployment: control API,
edge runtime, dashboard, and the `install.sh` provisioner. Multi-tenant fleet
hosting is a separate project (`sproutboat-cloud`); the CLI is its own MIT repo
([`sproutboat-cli`](https://github.com/baronunread/sproutboat-cli)) and targets
either.

## Deploy to a VPS

SSH into a fresh Linux box (Debian/Ubuntu or RHEL-family, x86-64) and:

```sh
curl -fsSL https://raw.githubusercontent.com/baronunread/sproutboat/main/install.sh | sudo bash
# from a checkout instead:  sudo ./install.sh
```

It asks 3–4 questions (domain, email, admin name), then runs unattended:
user namespaces, Caddy + bubblewrap, a default-deny firewall, the dashboard
build, one admin identity, and the services. No Docker — the server only runs
worker artifacts, it never builds them. It pauses once to let you add a single
wildcard DNS record and waits for it to resolve. See
[infra/README.md](infra/README.md).

## Deploying to it

Building and uploading worker artifacts is the [`@sproutboat/cli`](https://github.com/baronunread/sproutboat-cli)'s
job — MIT, its own repo, targets any control plane. It cross-compiles the
handler with Porffor + Zig (no Docker) and ships only the finished native
binary; the server never sees your source.

```sh
bunx @sproutboat/cli init hello
bunx @sproutboat/cli login --api-url https://control.<your-domain>
bunx @sproutboat/cli deploy
```

`build`, `deploy --dry-run`, `deploy --artifact`, `tail`, `versions list`,
`rollback`, and `delete --yes` are also available.

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

In another terminal, create, authorize, and deploy a project with the CLI:

```sh
bunx @sproutboat/cli init hello
bunx @sproutboat/cli login --api-url https://control.sproutboat.localhost
# approve in the dashboard, then:
bunx @sproutboat/cli deploy
open https://hello.andrea.sproutboat.localhost
bunx @sproutboat/cli versions list
bunx @sproutboat/cli tail hello
```

The dashboard is at `https://dashboard.sproutboat.localhost/dashboard`. Control
is API-only; it has no user-facing dashboard.

### Reset local state

Stop the launcher with `Ctrl-C`, then remove local state and saved CLI
credentials before starting it again:

```sh
rm -rf .local/sproutboat
rm -rf ~/.config/sproutboat
bun run dev:local
```

Portless certificates remain intact.

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

- `tests/porffor/capabilities/`: 31 import-free handlers comprising the accepted
  Porffor capability suite, using the frozen Workers-style contract.
- `tools/refserve.ts`: Bun reference implementation.
- `tools/compile.ts`: Porffor native compiler wrapper.
- `tools/shim.js`: stdin/stdout JSON ABI used by compiled probes.
- `tools/diff.ts`: three-probe differential runner.
- `tools/report.ts`: compatibility matrix and threshold decision.

Generated binaries and wrapped sources live under `.phase0/` and are ignored
by Git.
