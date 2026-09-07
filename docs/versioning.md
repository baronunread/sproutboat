# Versioning and releases

Sproutboat uses SemVer for self-hosted platform tags. The platform is pre-1.0:

- A `0.x` minor release may contain breaking changes.
- A patch release must remain backward compatible within its minor line.
- Every breaking change or required operator action must appear under
  **Breaking and operator actions** in `CHANGELOG.md`.

`main` is the development line. A tag is a tested checkpoint that operators can
pin with `SB_REF=vX.Y.Z`. `sbctl update` follows the newest release unless the
installation is pinned.

## Frozen contracts

The CLI repository's `CONTRACTS.md` defines the artifact manifest, binding
sidecars, broker storage, and wire contracts that a platform release must
continue to accept. Golden fixtures and contract tests enforce those formats.
Dashboard layout, internal module boundaries, and undocumented control-plane
details may change during 0.x development.

When a frozen contract must change:

1. Add its replacement without removing the old form.
2. Support both forms for at least two minor platform releases.
3. Announce the removal schedule in the changelog.
4. Remove the old form only in a minor release, never a patch release.

Runtime behavior that would change an already deployed handler must be gated by
its compiled `compatibility_date`. Record the date beside the behavior and in
the changelog. Do not apply the change unconditionally.

## CLI compatibility

The CLI and control plane update independently. Every API response advertises
the control version and `MIN_CLI_VERSION`; older clients receive an upgrade
warning. Raising `MIN_CLI_VERSION` is a deliberate compatibility change and
requires a changelog entry.

When a platform change needs new CLI behavior:

1. Publish and test the CLI release.
2. Update the platform's pinned CLI dependency.
3. Review `MIN_CLI_VERSION`; raise it only when older clients cannot safely use
   the new control plane.
4. Tag the platform after the pinned dependency and compatibility checks pass.

## Release checklist

- [ ] Confirm the worktree contains only intended release changes.
- [ ] Fetch tags and confirm the newest local and remote `vX.Y.Z` tag.
- [ ] Review every commit since that tag and choose the SemVer bump.
- [ ] Move Unreleased notes into the dated version section; leave a fresh
      Unreleased section.
- [ ] Put every breaking change and operator action in its named section.
- [ ] Confirm `MIN_CLI_VERSION` is intentional.
- [ ] Confirm the platform pins the intended published CLI version.
- [ ] Run `bun run validate`.
- [ ] Run the CLI unit suite, broker and standalone conformance harnesses, and
      all examples against the pinned CLI version.
- [ ] Install on a clean supported Linux VPS and complete login, deploy, request,
      rollback, storage, and deletion smoke tests.
- [ ] Upgrade an existing installation with binding data; verify ownership,
      permissions, and KV export.
- [ ] Create a backup, restore it, and verify routes and binding data.
- [ ] Build and browser-check the dashboard at desktop and mobile widths.
- [ ] Commit the release notes, then request explicit approval before tagging
      and pushing.
- [ ] Create an annotated tag and GitHub Release from the changelog section.
