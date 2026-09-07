# Agent instructions

## Writing: no em dashes

Do not use em dashes (`—`) in anything you write here: site copy, docs,
READMEs, code comments, commit messages, issues. Use a colon when what follows
explains what came before, a semicolon when two clauses are balanced, a full
stop when the second half can stand alone, or commas for an aside.

An em dash is almost always one of those three doing a worse job, and a page of
them reads as machine-written. A lone `—` as a table cell meaning "not
applicable" is a symbol, not punctuation, and is fine.

## Browser work: use agent-browser

Drive the browser with the **agent-browser** skill: navigating, clicking,
filling forms, screenshots, console/network inspection, dogfooding the
dashboard. Do not write ad-hoc Playwright scripts for it.

The Playwright suite in `e2e/` is the exception: it is the project's test
suite, run with `bun run e2e`, and stays as it is. Agent-driven browsing is
not the same thing as the test suite, so keep them separate.

## Local stack

`bun run dev:local` brings up control, edge, dashboard, and the GitHub
emulator; `bun run seed --reset --e2e` fills it with demo accounts, projects,
storage resources, secrets, and edge traffic.

If portless cannot bind :443 (no sudo), it falls back to :1355 and the public
URLs carry that port. In that case set, for anything that talks to the stack:

    SPROUTBOAT_CONTROL_URL=http://127.0.0.1:<control port>   # Bun does not resolve *.localhost
    SPROUTBOAT_DASHBOARD_URL=https://dashboard.sproutboat.localhost:1355
    BETTER_AUTH_URL=https://dashboard.sproutboat.localhost:1355

`SPROUTBOAT_CONTROL_URL` is also what the dashboard's Vite dev server proxies
`/api` to, so it must point at the control plane's real address.
