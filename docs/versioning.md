# Versioning and releases

Sproutboat Community uses [SemVer](https://semver.org) for platform tags (`vMAJOR.MINOR.PATCH`). 1.0 is the first stable release; from there:

- A **patch** release fixes bugs and security problems. It never breaks anything and adds no migration that the previous patch cannot tolerate.
- A **minor** release adds features. It does not break the public surface below. It may deprecate something, with a changelog entry and a removal schedule.
- A **major** release may break the public surface. Every breaking change and every required operator action appears under **Breaking and operator actions** in `CHANGELOG.md`.

`main` is the development line. A tag is a tested checkpoint that operators can pin with `SB_REF=vX.Y.Z`. `sbctl update` follows the newest stable release unless you pin the installation.

## What counts as breaking

The public surface of Community is what an operator, the CLI or a deployed app depends on:

- **Artifacts and runtime behavior.** The artifact manifest, binding sidecars, broker storage and wire contracts (see Frozen contracts below), and the behavior of an already deployed handler (gated by its `compatibility_date`).
- **The control API.** The `/api` routes and response shapes the CLI uses, the `x-sproutboat-control` and `x-sproutboat-min-cli` headers, and the webhook payloads and signature format. New fields and new Activity event types are additive; removing or renaming one is breaking.
- **The operator surface.** `sbctl` commands and flags; `install.sh` options (`SB_*` variables and `--homelab`); the files in `/etc/sproutboat`, including the keys in `install.env`, `engine.env` and `update.env` and the setting names read from the `*.local.env` files; the systemd unit names; the directory layout under `/var/lib/sproutboat`; and the backup archive format (a newer release must restore an older archive).
- **Supported platforms.** Dropping a supported distribution family, architecture or init system is breaking.
- **The database.** Schema changes in a patch or minor release are additive only, so the previous release keeps working on a migrated database and `sbctl rollback` stays safe. Dropping or rewriting data happens only in a major release.

Not breaking: the dashboard's layout and styling, the module structure, undocumented endpoints and files, the choice and internals of the edge engine, log line formats, the version of a bundled dependency that does not change documented behavior, and the pinned Bun and Caddy versions.

## Pre-releases

Release candidates use a pre-release tag (`v1.0.0-rc.1`) and a GitHub pre-release. They follow SemVer precedence (`1.0.0-rc.1` is below `1.0.0`) and are not supported for security fixes.

`sbctl update` and the installer pick only plain `vX.Y.Z` tags, so a pre-release never installs itself and an existing box stays on its stable release. To try one, ask for it by name:

```sh
sudo SB_REF=v1.0.0-rc.1 sbctl update --check   # shows that release's changelog; changes nothing
sudo SB_REF=v1.0.0-rc.1 sbctl update
```

Three things to know:

- **`SB_REF` becomes a pin.** The installer records it as `SPROUTBOAT_UPDATE_REF` in `/etc/sproutboat/update.env`, and later plain `sbctl update` runs stay on it. Remove that line to follow stable releases again; the next `sbctl update` then moves to the newest stable tag.
- **Only a plain `vX.Y.Z` tag gets the Rust engines.** For a pre-release the installer finds no published engine binaries, so it keeps the engines already installed or, on a fresh box, falls back to the Bun edge and egress (it says which). Pass `SB_ENGINE_DIR=<dir>` (the two binaries and `SHA256SUMS` from the release) to install the Rust engines anyway.
- **Rolling back works as for any update.** `sbctl rollback` returns to the previous release; the database changes in a release candidate are additive, like any other.

## Maintenance mode

After 1.0 the 1.x line is in maintenance mode. Community is a complete single-machine product; the work from here is keeping it safe and working, not growing it.

What 1.x gets:

- **Security fixes**, including the pinned Bun and Caddy binaries and the Rust engines' dependencies.
- **Compatibility fixes** for the runtime and toolchain packages (`@sproutboat/{runtime,wire,toolchain}`), so the CLI and the platform keep working together.
- **Fixes for data loss and for broken installs, updates, backups and restores.**
- **Small features** when they are cheap and carry no migration risk.

What it does not get: new subsystems, new bindings, multi-machine features (those belong to Sproutboat Cloud), or backports to older minor lines.

The newest 1.x release is the only supported one. Because minor releases do not break, the supported way to take a fix is `sbctl update`. Security fixes ship as a patch of the newest 1.x (see `SECURITY.md`). If Community ever stops getting maintenance, we will announce it in the changelog and the README first.

## Frozen contracts

The CLI repository's `CONTRACTS.md` defines the artifact manifest, binding sidecars, broker storage, and wire contracts that a platform release must continue to accept. Golden fixtures and contract tests enforce those formats.

When a frozen contract must change:

1. Add its replacement without removing the old form.
2. Support both forms for at least two minor platform releases.
3. Announce the removal schedule in the changelog.
4. Remove the old form only in a major release.

Gate any runtime behavior that would change an already deployed handler by its compiled `compatibility_date`. Record the date beside the behavior and in the changelog. Never apply such a change unconditionally.

## CLI compatibility

The CLI and control plane update independently. Every API response advertises the control version and `MIN_CLI_VERSION`; older clients receive an upgrade warning. Raising `MIN_CLI_VERSION` is a deliberate compatibility change and requires a changelog entry.

When a platform change needs new CLI behavior:

1. Publish and test the CLI release.
2. Update the platform's pinned CLI dependency.
3. Review `MIN_CLI_VERSION`; raise it only when older clients cannot safely use the new control plane.
4. Tag the platform after the pinned dependency and compatibility checks pass.

## Release checklist

- [ ] Confirm the worktree contains only intended release changes.
- [ ] Fetch tags and confirm the newest local and remote `vX.Y.Z` tag.
- [ ] Review every commit since that tag and choose the SemVer bump against "What counts as breaking".
- [ ] Move Unreleased notes into the dated version section; leave a fresh Unreleased section.
- [ ] Put every breaking change and operator action in its named section.
- [ ] Confirm `MIN_CLI_VERSION` is intentional.
- [ ] Confirm the platform pins the intended published CLI version.
- [ ] Run `bun test apps/ services/ tests/`, `bun run typecheck`, `bun run lint`, `bun run fmt:check`, and `bun run validate` (the capability harness).
- [ ] Run the CLI unit suite, broker and standalone conformance harnesses, and all examples against the pinned CLI version.
- [ ] Install the previous stable release on a clean supported Linux box, then `sbctl update` to the release candidate with data in place: check ownership, permissions, the health gate, and that a forced failure rolls back.
- [ ] Install the candidate on a clean box and complete login, deploy, request, rollback, storage, and deletion smoke tests, in public mode and in homelab mode.
- [ ] Create a backup, restore it on a fresh box, and verify routes, binding data, and the admin login; copy `backup.key` off the box first.
- [ ] Build and browser-check the dashboard at desktop and mobile widths.
- [ ] Commit the release notes, then request explicit approval before tagging and pushing.
- [ ] Create an annotated tag. The release workflow builds the Rust engines for the tag and attaches `sproutboat-edge-linux-x64`, `sproutboat-egress-linux-x64` and `SHA256SUMS` to the GitHub Release; check that all three are there, and mark release candidates as pre-releases.
- [ ] Write the GitHub Release from the changelog section.
