# kitchen-sink

One Sproutboat app that drives **every binding**, with an **Astro** browser UI
and an end-to-end harness that runs against this repo's own platform code
(`tools/compile.ts`, `services/broker`, `tools/assets.ts`).

```
src/index.js     the Sproutboat worker (routes + DO class + scheduled/queue)
web/             the Astro UI  ->  built to web/dist, published as env.ASSETS
harness.ts       headless end-to-end check (18 assertions)
serve.ts         same, but stays up for the browser
```

| Binding | Where in the app | UI section |
| --- | --- | --- |
| `vars` | `env.SITE_NAME` (page title), `env.QUOTE_URL` | — |
| static assets | Astro `web/dist` served via `env.ASSETS.fetch(request)` (`run_sprout_first: true`), SPA fallback for unknown paths | the page + `/about.html` |
| `secrets` | `env.ADMIN_TOKEN` gates `GET /admin/stats` | **Admin** tab (demo password `s3cr3t-admin`) |
| KV | `env.SESSIONS` — `put` on `/login`, `get` on `/whoami`, `list`+`delete` in cron | header **Log in** button |
| D1 | `env.DB` — `notes`, `email_log`, `heartbeat` tables | **Notes** tab |
| R2 | `env.UPLOADS` — `put` on attach (≤ ~900 KB in the demo — see `baronunread/sproutboat#56`), `get`, `list` | **Notes** tab + **Attachments** tab |
| Queues | `env.EMAILS.send()` on `POST /notes`; a `queue(batch)` handler logs to D1 | **Admin** (emails processed) |
| Durable Objects | `env.VIEWS` / `class ViewCounter` — atomic per-note view count | **Notes** (open a note) |
| Analytics Engine | `env.METRICS.writeDataPoint()` every request; `env.METRICS.query()` feeds the dashboard | **Admin** (points + recent events) |
| outbound `fetch` | `fetch(env.QUOTE_URL)`, host must be in `outbound` | **Outbound fetch** tab |
| cron | `*/1 * * * *` → `scheduled(event)` prunes sessions + writes a heartbeat | **Admin** (heartbeats) |

## Run it

```sh
cd examples/kitchen-sink
bun run dev      # serve.ts — stays up; open http://127.0.0.1:8787
bun run test     # harness.ts — 18 headless checks, one per binding
bun run deploy   # astro build + sproutboat deploy --api-url <your control plane>
```

`dev` / `test` build the Astro UI in `web/`, compile the worker with Porffor,
start a `services/broker/src/broker.ts` instance, publish `web/dist`, and boot
the binary — the same shape `services/supervisor/src/run.ts` spawns per
deployment on a real node.

`deploy` is `bun run build && bunx sproutboat deploy`. Sproutboat only *copies*
`assets.directory` (`web/dist`), so the site build runs first.
