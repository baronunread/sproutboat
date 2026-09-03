---
name: release
description: Tag a checkpoint on sproutboat — pick a date-based version from what actually changed since the last tag, update CHANGELOG.md, and tag it. Use when the user asks to release, cut a release, tag a checkpoint, or asks what the next version should be.
---

# Release sproutboat (the platform monorepo)

This is **not** the CLI's release model — there is no `npm publish`, no
`release.yml`, no `package.json` version (`"private": true`, no `version`
field), and as of the first run of this skill, **no tag has ever existed on
this repo**. `main` is continuously deployed directly; a tag here is a
checkpoint for traceability (what shipped, when, a rollback reference point),
not a publish trigger. Nothing fires when you push one — the confirmation gate
below exists because pushing a tag is still a visible, shared action worth a
deliberate yes, not because anything downstream depends on it the way the
CLI's npm publish does.

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

If `$last_tag` is empty, this is the first checkpoint this repo has ever had.
Don't silently reconstruct a CHANGELOG for the repo's entire history — that's
a much bigger, separately-scoped task. Ask the user: start the changelog from
today (scope = every commit on `main`, which could be a lot) or from a
specific point they name.

## 2. Gather what's unreleased

```bash
git log --reverse --pretty="%H %s" ${last_tag:+$last_tag..}HEAD
```

Read every commit — subject and, for anything non-obvious, `git show
--stat`/body. Drop pure noise: merge commits, and anything a later commit's
own message already summarizes.

Bucket each real commit:

- **Added** — a new capability, endpoint, page, or command.
- **Fixed** — something broken now isn't. State the user-visible symptom when
  the commit body has one, not just the internal cause.
- **Changed** — behavior changed but nothing was strictly added or fixed.
- **Performance** — same behavior, measurably cheaper.
- **Removed** — a capability taken away.

## 3. Pick the version

No `package.json` version to reconcile against, no SemVer bump logic — this
repo has no public API contract to version against, just a deploy history.
Use a date-based scheme: `YYYY.MM.DD`, or `YYYY.MM.DD.N` if a checkpoint
already exists for today (`N` starting at 2). Compute today's date from the
actual system clock, not by guessing from context.

Confirm the version with `AskUserQuestion` before writing anything — even
though there's usually only one sane date-based option, this is where a human
gets the last look before it's committed. If there were two real candidates
(e.g. today's date vs. picking up a scope the user described differently in
step 1), offer both.

## 4. Draft the CHANGELOG entry

If `CHANGELOG.md` doesn't exist yet, create it with a short header (repo name,
"checkpoints, not package releases — see `.claude/skills/release`") before the
first entry.

Dated `## [YYYY.MM.DD] — <same date, human readable>` heading, bucket headings
from step 2 in order, one bullet per commit or small related group, written
for a reader who wants to know what changed and why it matters — not a copy of
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

All three must pass — this repo's `ci.yml` already gates typecheck/lint/test
on every PR, but a checkpoint tag should never mark a commit that wasn't
actually green.

```bash
git add CHANGELOG.md
git commit -m "checkpoint: YYYY.MM.DD (<one-line summary>)"
```

## 6. Stop

Report the commit, and ask explicitly: tag and push now, or hold it. A prior
"looks good" on the version or the draft doesn't carry through to this step —
ask again, here, specifically.

## 7. Tag and record it

Only after explicit confirmation:

```bash
git push origin main
git tag vYYYY.MM.DD
git push origin vYYYY.MM.DD
```

Then create a GitHub Release with that section's notes, so the tag isn't bare:

```bash
gh release create vYYYY.MM.DD --repo baronunread/sproutboat \
  --title "YYYY.MM.DD" --notes-file <(sed -n '/^## \[YYYY.MM.DD\]/,/^## \[/p' CHANGELOG.md | sed '$d')
```

(Extract just that entry's section between its heading and the next `## [` —
don't hand the whole file to `--notes-file`.)
