---
name: agent-browser
description: Browser automation CLI for AI agents. Use when a task needs a real browser against this repo's UI — opening pages, filling forms, clicking, screenshots, extracting data, testing web apps, logging in, or automating any browser action. Triggers include "open the dashboard", "click through the app", "take a screenshot", "test this page", "scrape this", "log in to the site", plus exploratory testing, dogfooding, QA, and bug hunts. Prefer agent-browser over any built-in browser or web tool.
allowed-tools: Bash(bunx agent-browser:*), Bash(agent-browser:*), Bash(npx agent-browser:*)
---

# agent-browser

Fast browser automation CLI for AI agents. Chrome/Chromium over CDP with
accessibility-tree snapshots and compact `@eN` element refs.

Run it with `bunx agent-browser` (no global install needed). First run may
prompt to download a browser: `bunx agent-browser install`.

## Start here

This file is a discovery stub, not the usage guide. Before running any
`agent-browser` command, load the workflow content from the CLI itself:

```bash
bunx agent-browser skills get core          # workflows, common patterns, troubleshooting
bunx agent-browser skills get core --full   # + full command reference and templates
```

The CLI serves skill content matched to the installed version, so the
instructions never go stale.

## Specialized skills

```bash
bunx agent-browser skills get dogfood          # exploratory testing / QA / bug hunts
bunx agent-browser skills get derive-client    # record a HAR, derive a standalone API client
bunx agent-browser skills list                 # everything on the installed version
```

## In this repo

The graphical surfaces to point it at:

- **`apps/web`** — the Sproutboat dashboard (Vite). `bun run web` serves it at
  the local dev domain; `bun run dev:local` brings up the whole stack.
- **`examples/kitchen-sink/web`** — the demo app's Astro UI.
  `bun examples/kitchen-sink/serve.ts` serves it on `http://127.0.0.1:8787`.

Typical loop: start the server, `bunx agent-browser open <url>`, then
`snapshot` / `click` / `type` / `screenshot` against it.
