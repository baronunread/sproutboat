---
name: release
description: Cut a tagged sproutboat platform release by choosing the next SemVer version from changes since the last tag, updating CHANGELOG.md, validating the repository, and creating a GitHub Release. Use when the user asks to release, cut a release, tag a checkpoint, or choose the next platform version.
---

# Release sproutboat (the platform monorepo)

This is **not** the CLI's release model: there is no `npm publish`, no
`release.yml`, no `package.json` version (`"private": true`, no `version`
field). `main` is continuously deployed directly. A release tag records what
shipped, provides a rollback reference, and gets matching GitHub Release notes;
it does not publish a package or trigger a deployment. The platform's existing
release line starts at `v0.1.0` and uses SemVer.

## 1. Orient

```bash
git status --short                          # must be clean
git branch --show-current
git fetch origin
git log --oneline -1 origin/main
```

Checkpoints belong on `main`. If the current branch isn't `main` and isn't a
superset of it, say so and ask whether to tag from here anyway or wait.

```bash
last_tag=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
```

If `$last_tag` is empty, stop and ask which commit should establish the release
baseline. Do not silently reconstruct the repository's entire history.

## 2. Gather what's unreleased

```bash
git log --reverse --pretty="%H %s" ${last_tag:+$last_tag..}HEAD
```

Read every commit: subject and, for anything non-obvious, `git show
--stat`/body. Drop pure noise: merge commits, and anything a later commit's
own message already summarizes.

Bucket each real commit:

- **Added**: a new capability, endpoint, page, or command.
- **Fixed**: something broken now isn't. State the user-visible symptom when
  the commit body has one, not just the internal cause.
- **Changed**: behavior changed but nothing was strictly added or fixed.
- **Performance**: same behavior, measurably cheaper.
- **Removed**: a capability taken away.

## 3. Pick the version

Compute the next version from the latest `vX.Y.Z` tag:

- **Patch** for fixes, internal maintenance, dependency pin updates, and visual
  changes that preserve platform behavior.
- **Minor** for a new endpoint, binding capability, dashboard capability, or
  other backward-compatible platform feature.
- **Major** only for an intentional compatibility break that requires operators
  or CLI clients to migrate.

When a range contains both feature work and fixes, use the highest applicable
bump. Before proposing it, confirm that no newer matching tag exists remotely:

```bash
git tag --list 'v*' --sort=-version:refname | head
```

Confirm the version with the user before writing anything, even
when there is only one sensible option. State which unreleased change sets the
bump level.

## 4. Draft the CHANGELOG entry

If `CHANGELOG.md` does not exist, create it with a short header explaining that
these are platform releases, not npm package releases.

Dated `## [X.Y.Z] - YYYY-MM-DD` heading, bucket headings
from step 2 in order, one bullet per commit or small related group, written
for a reader who wants to know what changed and why it matters, not a copy of
the commit subject. Move any existing `## [Unreleased]` content into the new
section; leave a fresh empty `## [Unreleased]` at the top.

Show the drafted section to the user as a normal message before touching any
file.

## 5. Apply, once the draft is approved

```bash
bun run typecheck
bun run lint
bun run test
```

All three must pass. This repo's `ci.yml` already gates typecheck/lint/test
on every PR, but a checkpoint tag should never mark a commit that wasn't
actually green.

```bash
git add CHANGELOG.md
git commit -m "release: vX.Y.Z (<one-line summary>)"
```

## 6. Stop

Report the commit, and ask explicitly: tag and push now, or hold it. A prior
"looks good" on the version or the draft doesn't carry through to this step;
ask again, here, specifically.

## 7. Tag and record it

Only after explicit confirmation:

```bash
git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Then create a GitHub Release with that section's notes, so the tag isn't bare:

```bash
gh release create vX.Y.Z --repo baronunread/sproutboat \
  --title "vX.Y.Z" --notes-file <(sed -n '/^## \[X.Y.Z\]/,/^## \[/p' CHANGELOG.md | sed '$d')
```

(Extract just that entry's section between its heading and the next `## [`:
don't hand the whole file to `--notes-file`.)
