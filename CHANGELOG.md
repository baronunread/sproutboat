# Changelog

Changes to the self-hosted Sproutboat platform are recorded here. Read the
**Breaking and operator actions** section before upgrading.

## [Unreleased]

## [1.0.0-rc.4] - 2026-11-09

Adopts `@sproutboat/runtime` 0.43.0, `@sproutboat/wire` 0.22.3 and `@sproutboat/toolchain` 0.24.2 (from 0.41.0, 0.21.4 and 0.21.3), the versions CLI 0.53.0 builds with. Update with `sudo SB_REF=v1.0.0-rc.4 sbctl update`; a release candidate is not picked up by plain `sbctl update`.

### Breaking and operator actions

- **Rebuild your apps with CLI 0.53.0** to get the runtime fixes below; they are in the compiled app, so deployed apps keep running as built. There are no migrations, new units, env files or secrets.
- **Security: bytes written right after `socket.startTls()` could leave unencrypted** (runtime 0.42.2). Apps built before it can send such a write in plaintext; rebuild any app that uses `connect()` with `secureTransport: "starttls"`.
- `MIN_CLI_VERSION` stays `0.0.0`: the control API gained no routes. `sproutboat tail --file`, `sproutboat run` and the new `dev` secret rules are CLI-side and need CLI 0.53.0.

### Added

- **Runtime 0.42.0 to 0.43.0, through the dependency pins:** `connect()` from `cloudflare:sockets` from compatibility date 2026-11-17; `TCP_NODELAY` on outbound sockets (about 44 ms off every fresh HTTPS `fetch()`); more reserved address ranges refused by `fetch()` and `connect()`; and, off by default, `SB_LOG=json`, which makes a standalone binary write one JSON line per request and per uncaught error to stderr (`sproutboat tail --file` follows it).
- Backend mode: `SPROUTBOAT_EDGE_APPS_DOMAIN` (off when unset) turns on a cross-account cookie guard for Cloud app hosts `<app>.<account>.<apps domain>`: a `Set-Cookie` whose `Domain` is wider than its own account (`<account>.<apps domain>`) or names another account is dropped, and the log line counts them as `cookiesStripped`. Cookies set by page script (`document.cookie`) are not covered.
- `sproutboat-edge` backend mode, for Sproutboat Cloud: with `SPROUTBOAT_EDGE_BACKEND=http://127.0.0.1:<port>` the Rust edge serves static assets from a route snapshot (ETag, Cache-Control, Range, precompressed variants, `_headers`, `_redirects`, a 404 page or SPA fallback, a bounded in-memory cache set by `SPROUTBOAT_ASSET_CACHE_BYTES` and `SPROUTBOAT_ASSET_CACHE_ENTRY_BYTES`) and forwards everything else, WebSockets included, to the backend. Off unless the variable is set; self-hosted installs are unchanged.
- Backend mode: snapshot entries may carry a `path` prefix (`/docs`), so several apps share one hostname; the longest matching prefix picks the app's manifest, the bare hostname is the catch-all, and a path with no match is forwarded. Community mode is unchanged.

### Changed

- The toolchain pin moves to 0.24.2, which adds the Porffor alpha 22 channel and four miscompile fixes in its patch chain. The platform's own tools (`tools/compile.ts`, `bun run check`) still use the default channel.
- The open design system `@sproutboat/ikada` moved to its own repository, [baronunread/ikada](https://github.com/baronunread/ikada) (history preserved). The dashboard depends on a pinned commit of it until the package is on npm. `packages/ikada` and its publish workflow are gone from this repo.

## [1.0.0-rc.3] - 2026-11-05

Replaces rc.2, whose first start on an install from before 0.14 could fail part-way through moving artifacts. Update with `sudo SB_REF=v1.0.0-rc.3 sbctl update`. Ships as 0.14.2 for the 0.14 line.

### Breaking and operator actions

- **The move to per-account artifact directories now happens in the installer**, as root, with control and the edge stopped, right before the services start, instead of inside control on its first start. The update log shows one `layout:` line per moved entry. Control checks the layout at boot and refuses to start (exit 78, one line in its journal, no restart loop) while a deployment still uses `artifacts/<digest>`; re-running `sudo sbctl update` or `sudo bash /opt/sproutboat/install.sh` finishes the move. `sbctl rollback` to 0.14.0, rc.1 or older puts the layout back, binding data included. `sbctl restore` of an older archive migrates it. See "Updating and rolling back" in `infra/README.md`.
- `logs/sprouts` is now created and kept as `sproutboat-edge:sproutboat` 2770, like `brokers` and `resources`; the installer normalises it on existing installs.

### Fixed

- Everything in rc.2 (below).

## [1.0.0-rc.2] - 2026-11-05 (superseded)

Hardening release. Everything below also ships as 0.14.1 for the 0.14 line. Update with `sudo SB_REF=v1.0.0-rc.2 sbctl update`.

### Breaking and operator actions

- **Caddy's admin API now listens on a root-only unix socket** (`/run/caddy-admin.sock`, mode 0600) instead of `127.0.0.1:2019`. `systemctl reload caddy` and `sbctl` keep working; anything of yours that talked to port 2019 must use the socket as root (`curl --unix-socket /run/caddy-admin.sock http://x/config/`). Drop-ins in `/etc/sproutboat/caddy.d` are unaffected.
- **Artifacts, broker state and sprout logs are now kept per account.** The first start after the update moves `artifacts/<digest>` to `artifacts/<account>/<digest>`, `brokers/<digest>` to `brokers/<account>-<digest>` and `logs/sprouts/<digest>.log` alongside, one copy per account that uses the digest, and regenerates `routes.json`. Nothing to do; the log shows one line per moved item. The first redeploy of an unchanged project after the update records a new version instead of reporting "unchanged", because `manifest.json` is now part of the artifact digest.
- **API keys are no longer browser sessions.** A CLI key still works for every CLI route, but routes that need an interactive session (credential management, CLI approval, account deletion) refuse it, and disabling a member (`ban`) now revokes their keys.
- **Tighter file modes.** `control.env` and `control.local.env` are root-only (0600); `backup.key` belongs to the control service (0400); the control database and the `backups` directory are no longer group-readable. Restoring a plaintext backup on a box that has a backup key needs `--allow-plain`.
- **Request and connection bounds.** Control refuses non-upload bodies over 1 MiB and JSON bodies over 64 KiB; Caddy caps `/api` bodies at 100 MB; the edge caps WebSocket messages at 4 MiB (was 32 MiB) and open sockets at 2048; the egress and edge bound concurrent connections and the units set `LimitNOFILE`.
- **Control refuses state-changing requests that arrive with a cookie from another origin.** Browser clients must send the dashboard `Origin` (the dashboard does). Clients using `x-api-key` are unaffected. The session cookie is `SameSite=Strict`.
- **Rate limits use the socket address.** Behind your own proxy (`SB_PROXY=external`) set `SPROUTBOAT_TRUSTED_PROXIES` in `control.local.env` to the proxy's address so `X-Forwarded-For` is honoured; loopback (Caddy) is trusted by default.
- **Your settings now live in `*.local.env` files, and `sbctl update` no longer wipes them.** The installer rewrites `control.env`, `egress.env`, `sproutboat.env` and `caddy.env` on every run, so any key you added to them (S3 backup settings, `SPROUTBOAT_BACKUP_ENCRYPT=off`, the limit knobs, `SB_EGRESS_ALLOW`) was lost at the next update. The matching `control.local.env`, `egress.local.env`, `sproutboat.local.env` and `caddy.local.env` are read right after them by the units, win over them, and are never rewritten. See "Where settings live" in `infra/README.md`.
- **The first update moves your existing settings for you.** Any key it finds in a generated file that the installer does not write goes to the matching local file, and the old file is kept as `<name>.env.bak-<UTC time>` (mode 0600; it holds the token, so delete it once you have checked). It prints key names only. A second update changes nothing. Settings an earlier update already dropped are gone: set them again in the local file. Where to set things, from now on: S3 backup and `SPROUTBOAT_BACKUP_ENCRYPT` and the limits in `control.local.env`, `SB_EGRESS_ALLOW` in `egress.local.env`.
- Rolling back the update that did the move (`sbctl rollback`) restores the generated files from before it, with your old keys still in them, so it works with the release that does not know the local files. Updating again moves them again; the installer drops a key that the local file already holds with the same value instead of repeating it.

### Fixed

- The supervisor only trusts a sprout, broker or transfer port once the listening socket belongs to the process it started; a port held by anything else is logged and retried on a fresh one (`/__sb/pool` reports `foreignListeners`). Each sprout runs with an open-file limit (`SPROUTBOAT_SPROUT_NOFILE`, default 1024).
- Tenant SQL in the bindings broker is screened: `ATTACH`, `DETACH`, `VACUUM INTO` and PRAGMAs outside D1's list are refused, and `trusted_schema` is off.
- `/internal/tls/allow` answers only to Caddy's own on-demand check on loopback; the public control and dashboard hostnames return 404 for `/internal/tls/*` (`/internal/health` still answers).
- The certificate-issuance ceiling could be passed by an immediate retry of a refused hostname.
- A deploy that failed part-way left its upload on disk; uploads are now removed on every path and abandoned ones swept at start. Asset files not listed in `assets.json` are refused.
- Unverified custom-domain claims expire after 24 hours and a TXT proof by another account supersedes them.
- The edge drops the `Domain` attribute from cookies a sprout sets and never forwards platform session cookies; `/__sb/pool` ignores requests that carry proxy headers.
- The egress service enforces its header-read timeout, bounds request-head buffering, concurrent connections and name lookups (5 s, 64 at once).
- Secrets no longer appear on the sandbox launcher's command line: bubblewrap reads its options from a descriptor and the broker gets its token in the environment.
- **`sbctl update` kept losing operator settings in `control.env`** (found by the 1.0.0-rc.1 end-to-end test). Same for `egress.env` (anything but `SB_EGRESS_ALLOW`), `sproutboat.env` and `caddy.env`, where a changed `XDG_DATA_HOME` would have sent Caddy's certificates to a new directory.
- **GitHub sign-in turned itself off at an update** that was not given `SB_GITHUB_CLIENT_ID` and `SB_GITHUB_CLIENT_SECRET` again. The installer now reads them back like the other secrets.
- **A box that updates from a fork or mirror went back to the default repository** after one update, because `update.env` was rewritten with the default. The recorded repository is kept.
- **`sbctl` ran `control.env` as shell** (`backup`, `restore`) instead of reading it as data, so an S3 secret containing `&` or `$` would break the command or run as shell. It parses the files now, the way systemd reads them, and loads `control.local.env` too.

### Changed

- **Documentation for 1.0.** The README now says what Community is and is not (one machine, the supervisor runtime, homelab first, Activity and webhooks), links Sproutboat Cloud for production and scale, and covers install, upgrade, backups (including copying `/etc/sproutboat/backup.key` off the box) and limits. New `SECURITY.md` (supported versions, private reporting, the sandbox model and its scope). `docs/versioning.md` is rewritten for 1.x: SemVer, what counts as breaking, pre-releases and how `sbctl update` treats them, and the maintenance-mode policy.

## [1.0.0-rc.1] - 2026-11-05

The first release candidate of Sproutboat Community 1.0: the single-machine, self-hosted edition. Three things are new: a homelab install mode, an Activity history with webhooks, and the dashboard rebuilt on the open design system `@sproutboat/ikada`.

### Breaking and operator actions

- **A release candidate is not picked up by `sbctl update`.** The updater follows the newest `vX.Y.Z` tag, and `1.0.0-rc.1` is a pre-release, so an existing box stays on 0.14.0 until you ask for it: `sudo SB_REF=v1.0.0-rc.1 sbctl update` (give the variable to `sudo`, not to the shell: sudo resets the environment by default). `sbctl update --check` with the same `SB_REF` shows this entry first. Rolling back is `sudo sbctl rollback`; the database changes below are additive and 0.14.0 ignores them.
- **Database: three new tables** (`events`, `webhooks`, `webhook_deliveries`), created at the first start. Nothing existing is altered. Backups include them; a 0.14.0 restore of a 1.0.0-rc.1 archive is refused by the version gate as before (`--allow-newer` overrides).
- **The control unit now reads `/etc/sproutboat/egress.env`** (`EnvironmentFile`) and starts after the egress service, so webhook deliveries can leave through the egress service. `sbctl update` writes the unit; no action needed.
- **`/etc/sproutboat/install.env` is new** and records the install mode (`SB_MODE`, `SB_PROXY`, `SB_FIREWALL`, `SB_SSH_PORT`, `SB_SCHEME`, `SB_BIND_HOST`, `SB_BIND_ALLOW`, `SB_ACME_STAGING`). An existing box becomes `public` with Caddy and ufw managed as before; a box that was installed with `SB_ACME_STAGING=1` keeps staging (the installer reads the old Caddyfile once). `sbctl mode` prints the file.
- **The installer refuses a reserved admin username** (`admin`, `www`, `api`, `status`, `docs`, `support`, `cli`, `dashboard`, `sproutboat`): control reserves those namespaces, so an install with one of them had an admin token that never authenticated. Existing installs are not re-validated.
- **Dashboard:** the namespace claim flow and the `/profile` claim form are gone (accounts are created by the admin, who reserves the namespace). The admin Users page no longer shows ban reasons, ban expiry or per-user sessions; disable and enable remain. "Usage and limits" is now "Limits".

### Added

- **Homelab install mode** (#353): `install.sh --homelab` (or `SB_MODE=homelab`) for a box behind your own reverse proxy, on a LAN, or over Tailscale. Caddy and ufw become optional (`SB_PROXY=external`, `SB_FIREWALL=off`), no public IPv4 is assumed, control serves the dashboard itself, the health gate, `sbctl`, backups, restore and rollback all work without Caddy, and `sbctl update` keeps the mode. `SB_BIND_HOST` can widen the listen address with an explicit `IPAddressAllow` list. DNS-01 through Cloudflare (`SB_CF_TOKEN`) stays optional and is now remembered across updates. Recipes for nginx, Traefik, Caddy elsewhere, LAN-only with local DNS, Tailscale and DNS-01 are in `docs/homelab.md`.
- **Activity events** (#354): control records deploys (started, succeeded, failed), activations and rollbacks, version and project deletes, project creation, secrets set or deleted (names only, never values), domains added, verified or removed, API tokens created or revoked, members created, disabled or enabled, backups created or failed. `GET /api/activity` lists them with filters by project, type (`deploy.*`), time window and cursor; `GET /api/activity/types` lists the vocabulary. Retention: `SPROUTBOAT_EVENTS_KEEP_DAYS` (365) and `SPROUTBOAT_EVENTS_MAX_ROWS` (50000).
- **Webhooks** (#354): per-account endpoints with a type filter and a generic JSON or Discord format (`/api/webhooks`). Every payload is signed (`x-sproutboat-signature: t=<unix>,v1=<hex HMAC-SHA256>`), retried with backoff (30 s, 2 min, 10 min, 1 h) and logged per delivery. Deliveries leave only through the egress service, so a webhook that resolves to a private or reserved address is refused unless the operator allows it with `SB_EGRESS_ALLOW`. Cap: `SPROUTBOAT_MAX_WEBHOOKS_PER_ACCOUNT` (10).
- **Dashboard on ikada** (#355, #357, #358): every screen now uses `@sproutboat/ikada` components and tokens (dark and light, Figtree and JetBrains Mono): shell with sidebar and command palette, login and CLI authorization, overview, sprouts, project overview, deployments with rollback, metrics, logs and live tail, bindings, triggers, settings (secrets, names only), storage, account settings, API tokens, limits, admin System, Users and Backups, the new **Activity** page (account-wide and per project) and **Webhooks** settings. ikada gained a router-link adapter, Avatar, SegmentedControl, RadioGroup, SensitiveInput, DescriptionList, Pagination and CodeBlock; the Cloud-only RuntimeChip, FallbackPill and TrafficSplitBar left the open package.
- Playwright end-to-end tests run in CI against the real local stack (`SPROUTBOAT_E2E_PLAIN=1` in `tools/dev-local.ts`).

### Fixed

- `SB_ADMIN=admin` (and the other reserved names) no longer produce an install whose admin token cannot authenticate (#356).
- `SB_CF_TOKEN` and `SB_ACME_STAGING` survive `sbctl update`; before, an update without them silently switched Caddy back to HTTP-01 and production ACME.

## [0.14.0] - 2026-11-05

### Added

- `packages/ikada` (#341): the open design system foundations (tokens, inventory, P0 primitives) the next dashboard
  builds on. Not shipped to a box: the dashboard is unchanged in this release.
- **Release workflow** (`.github/workflows/release.yml`): a `v*` tag builds the Rust edge and egress (musl, x86-64) and attaches them and `SHA256SUMS` to the GitHub Release.
- **Engines:** `sbctl engine` shows and switches the edge and egress between Rust and Bun; the choice lives in `/etc/sproutboat/engine.env`. `SB_ENGINE_DIR` installs unreleased binaries. See `infra/README.md`, Engines.

### Changed

- **The Rust edge and egress are the default engines.** Behaviour differences are in `services/edge-rs/DEVIATIONS.md`. The two that matter for safety: `/__sb/pool` only answers on loopback with a loopback `Host` (it used to answer through Caddy on any host), and a bad `routes.json` on SIGHUP no longer kills the edge.

### Breaking and operator actions

- **`sbctl update` now takes a backup first, keeps the previous release, and rolls itself back.** It runs and
  verifies a backup (stops with nothing changed if that fails), copies the running release to
  `/opt/sproutboat-prev` (needs about the size of `/opt/sproutboat` plus 200 MiB free on `/opt`), and after the
  restart checks the whole host; if the check fails it restores the previous release and exits 1. The first update
  to this release still runs the old bootstrapper on the box, which is fine: every new step lives in the installer
  it fetches. `SB_SKIP_BACKUP=1` and `SB_NO_ROLLBACK=1` turn the parts off. See "Updating and rolling back" in
  `infra/README.md`.
- **Backups v2: copy `/etc/sproutboat/backup.key` off the box.** `sbctl update` creates it, and new backups are
  encrypted with it (`.tar.gz.enc`). Without the key they cannot be restored. Old `.tar.gz` archives still restore.
  Restoring onto a box that lacks the key needs `sbctl restore <archive> --key FILE`. Set
  `SPROUTBOAT_BACKUP_ENCRYPT=off` in `control.env` to keep plain archives. Backups now also contain `/etc/sproutboat`
  and Caddy's data (certificates), staged by a root step; a dashboard backup has config as of the last nightly run or
  update.
- **Log rotation and a journal cap are now installed.** `sbctl update` adds `logrotate` (package), `/etc/logrotate.d/sproutboat` and `/etc/systemd/journald.conf.d/sproutboat.conf`, and restarts `systemd-journald` once. The journal is capped at 256M and one month for the whole host. Local overrides: see "Logs" in `infra/README.md`.
- **The update downloads two binaries** (`sproutboat-edge`, `sproutboat-egress`) from the GitHub Release of the tag, verifies them against `SHA256SUMS` and installs them in `/usr/local/lib/sproutboat/bin`. If that fails the installer warns and keeps what it has (or uses Bun on a fresh install). `sudo sbctl engine bun` switches back to the Bun engines. The egress memory cap is `128M` on Rust (`512M` on Bun).
- **Sproutboat Community is single machine and supervisor only.** The optional per-project `sproutd` runtime that
  0.13.0 introduced (private, off unless configured) is gone from this repository. Removed: the runtime endpoint
  (`/api/projects/:name/runtime`), `POST /api/admin/sproutd/reconcile`, the `module` and `sproutdRefusal` upload fields
  (an upload that still sends them is accepted and the fields are ignored), the route `backend` entry in
  `routes.json`, the `SPROUTBOAT_SPROUTD_*` settings, and `tools/sproutd-staging.sh` and `tools/sproutd-e2e.sh`.
  Nothing in `install.sh`, `sbctl` or the shipped units ever used them, so a normal install is unaffected.
- **Database migration, automatic at the next start:** the columns `projects.runtime`, `projects.runtime_limits`,
  `deployments.sproutd_vid` and `deployments.fallback_reason` are dropped. Rolling back to 0.13.x re-adds them.
  A database that holds a project set to sproutd, or a version sproutd loaded, keeps the columns and logs a warning:
  Community cannot serve those, so redeploy them on the supervisor.
- **Bindings brokers now run in their own sandbox (Linux).** Update with `sbctl update` and restart the edge
  (`sbctl update` does). Take a backup first. No new units, env files or secrets, and apps do not need a rebuild.
  The first start of each account's broker moves that account's R2 object bodies from `resources/r2-blobs/` and
  `resources/r2-parts/` into `resources/owners/<owner>/`; it is a rename per object, so a very large store adds a
  moment to that first start. The R2 quota ledger is now one file per account in the same place (a fresh ledger: only
  in-flight upload reservations are lost). `D1 backup()` for a resource-backed database now writes to
  `brokers/<deployment>/d1-backups/` instead of the platform `backups/` directory. Keep `bwrap` installed, as for
  sprouts. **Rollback** to the previous release is safe for data: older brokers look for bodies in `resources/r2-blobs/`,
  so move `resources/owners/*/r2-blobs/*` back first (`mv`, same filesystem) or those objects read as missing.
- **Optional: Caddy drop-ins.** `sbctl update` now creates `/etc/sproutboat/caddy.d` and imports its `*.caddy` files
  into the generated Caddyfile. The new Caddyfile is validated before it replaces the live one, so a broken drop-in
  stops the update instead of Caddy. Nothing to do unless you want a `www` redirect: see "Customising Caddy" in
  `infra/README.md`.
- **Bun and Caddy are pinned and verified; the next `sbctl update` replaces both.** Bun goes 1.4.0 -> 1.4.4 and Caddy
  becomes 2.11.9, each downloaded from its GitHub release and checked against a pinned hash. Caddy is restarted (not
  reloaded) when its binary changed, so expect a brief TLS blip. With `SB_CF_TOKEN` the Cloudflare Caddy build is
  still fetched unverified, and the installer warns. See "Pinned dependencies" in `infra/README.md`.
- **Every unit now has a memory cap; the edge cap is computed from RAM.** On a 4 GiB box the edge goes from 2500M to
  1920M (half of RAM, in 64 MiB steps). If a box ran close to the old cap, raise it with a later drop-in or
  `SB_EDGE_MEMORY_MAX=<MiB> sbctl update` (see "Memory budget" in `infra/README.md`). `sbctl update` also refuses to
  build when less memory is available than the 1200M build cap; stop the backup timer or wait, or set
  `SB_SKIP_MEMCHECK=1`.

### Changed

- `sbctl update` and `install.sh` exit non-zero on any failure (backup, verify, disk, memory, build, validation,
  health, rollback), and a fresh install exits 1 when a unit is not active. Before, a stopped unit only warned.
- Memory caps on every unit: control 384M, egress 128M on Rust (512M on Bun), caddy 256M, backup 512M (niced, idle I/O), each with a
  `MemoryHigh`. The edge cap is now computed from RAM at install time instead of a fixed 2500M.
- Control, edge and egress keep retrying every 2 s after crashes (`StartLimitIntervalSec=0`).
- Bun on the box is 1.4.4 (was 1.4.0), matching CI and development. `install.sh` no longer pipes `bun.sh/install`
  into bash, and an existing install is upgraded when the pinned version changes.
- Caddy is pinned to 2.11.9 (security fix release) and verified with SHA-512 instead of downloading the latest
  unverified build.
- Backup archives are now `sproutboat-<date>.tar.gz.enc` (AES-256-GCM) by default.

### Fixed

- **Restore left the dashboard password and the CLI token different.** `sbctl restore` now resets the admin password to
  the token in `control.env`, restores `/etc/sproutboat` and Caddy's data from the archive, and refuses an archive
  from a newer platform version (`--allow-newer` overrides).
- Sprout log files are opened in append mode, so rotating them no longer leaves a sparse file full of NUL bytes.
- **Security: a broker could reach other accounts' data and impersonate the edge.** The per-app Bun broker ran outside
  the sandbox as the edge's user, with the edge's whole environment, the edge secret for service bindings and the
  shared `resources/` directory. It now runs under bubblewrap and sees only its deployment's state, the resource
  files its app is bound to, its own account's R2 bodies, and loopback. The shared edge secret is gone: a broker that
  calls another app holds a credential of its own, valid for that app's declared service hostnames and revoked when
  the broker exits.

### Added

- `sbctl update --check` (installed vs target release and the changelog between them), `sbctl health [--json]`
  and `sbctl rollback [--yes]`.
- `sbctl memory`: MemTotal, MemAvailable, and each unit's cap and current use.
- The update build (`bun install`, dashboard build, auth migration) runs in a 1200M capped scope
  (`SB_BUILD_MEMORY_MAX`).
- `/etc/sproutboat/caddy.d/*.caddy`: operator Caddy site blocks that survive updates, with a www-to-apex redirect
  example (`infra/caddy/caddy.d/www-redirect.caddy.example`).
- `sbctl backup now|list|verify`. `verify` checks an archive (add `--full` for hashes and SQLite integrity); every
  backup is verified as it is written and a failure fails the unit. Backups carry a `manifest.json`.
- Log rotation: the request log and control log rotate at 64 MiB (5 kept), sprout logs at 16 MiB (1 kept).
- Documentation for `connect()` from `cloudflare:sockets` (compatibility date 2026-11-17), with the Postgres and Redis
  driver results (`docs/compat/tcp-sockets.md`, `docs/compat/db-clients.md`). Docs only: the platform's pinned runtime
  (0.41.0) does not have it yet, so it reaches deployed apps with the release that adopts `@sproutboat/runtime` 0.42.0.

## [0.13.1] - 2026-11-02

### Breaking and operator actions

- Update with `sbctl update`. Only the control service changes: no new units, env files, secrets, migrations or
  dependency versions, and apps do not need a rebuild. Take a backup first (`sudo systemctl start sproutboat-backup`)
  and copy it off the box.
- **Platform rollback.** `SB_REF=v0.13.0 sbctl update` is safe: nothing here changes stored data or the log format.

### Fixed

- Requests to a project's custom domains now appear in its Request logs, Live tail (`/logs`, `/logs/recent`,
  `/logs/tail`, `/tail`), traffic charts and Sprouts list counts. The readers filtered the edge request log by the
  project's generated hostname only, so a project served mostly on its own domain showed almost nothing. They now
  match every hostname routed to the project, and only that project's. Tail events carry the host the request
  arrived on.
- A 404 that the app answered itself is no longer labelled "no route" in the Request logs. That label now means only
  that the edge had no route for the host (errorKind `no-route`). The log line format is unchanged.

## [0.13.0] - 2026-11-02

Adopts `@sproutboat/runtime` 0.41.0, `@sproutboat/toolchain` 0.21.3 and `@sproutboat/wire` 0.21.4 (from 0.35.0, 0.20.1
and 0.20.2). CLI 0.50.0 builds with runtime 0.41.0 and wire 0.21.4 (and toolchain 0.22.0); it is the release tested
with this platform version.

### Breaking and operator actions

- Update with `sbctl update`. There are no new units, env files, secrets or migrations for the existing services.
  Take a backup first (`sudo systemctl start sproutboat-backup`) and copy it off the box.
- **Rebuild your apps with CLI 0.50.0** to get the fixes and features below. They are in the compiled app, so
  deployed apps keep running as built (checked: apps built with CLI 0.43.0 at compatibility dates 2026-10-20 and
  2026-10-29 kept their KV, D1, R2 and Durable Object data and answered unchanged after the update).
- Behaviour changes are gated by the compiled `compatibility_date`, so an app only sees them when you rebuild it
  with a later date:
  - `2026-11-03` D1, `2026-11-04` Durable Objects, `2026-11-05` Queues: closer to workerd (see Added).
  - `2026-11-06` `crypto.subtle` beyond digests (RSA, ECDSA, ECDH, AES and more).
  - `2026-11-07` secrets from the environment decode as UTF-8 on a standalone binary.
  - `2026-11-15` database clients that need only `fetch` or WebSocket (`@libsql/client` and similar) run unmodified.
  - `2026-11-16` `fetch()` on a standalone binary runs off the event loop.
- **A garbage-collector crash (SIGBUS) when an object grew is fixed** (toolchain 0.21.3, sproutboat-packages #226).
  An app built before it can crash in that case; rebuild to be covered.
- **Platform rollback.** `SB_REF=v0.12.1 sbctl update` is safe: tested from this release with KV, D1, R2 and
  Durable Object data (data intact, control schema identical, apps built by the newer CLI keep serving) and rolled
  forward again. An explicit `SB_REF` is persisted as the installation pin, so after a downgrade `sbctl update` stays
  on that tag until you run `SB_REF=<newer tag> sbctl update`. The downgraded runtime is 0.35.0, so build new apps
  with CLI 0.43.0 while it runs.
- **Durable Object storage is asynchronous from compatibility date `2026-10-28`** (not new in 0.13.0, but apps
  rebuilt on a newer date meet it): `storage.get()` returns a Promise, as on Workers. Code that adds to the result
  without `await` computes `[object Promise]1`, the same result as on workerd.
- `MIN_CLI_VERSION` stays `0.0.0`: the control API only gained routes. Older CLIs keep working; `sproutboat tail`
  live streaming needs CLI 0.45.0 or later.

### Added

- **Runtime 0.36.0 to 0.41.0, through the dependency pins (#319, #323, #326, #327, #328, #329):**
  - `AsyncLocalStorage` from `node:async_hooks` and a per-request `x-sb-cpu-ms` when requests interleave in one
    process.
  - `crypto.subtle` like workerd from 2026-11-06; ES256 signs 2.2x and verifies 3.1x faster than BearSSL 0.6.
  - D1, Durable Objects and Queues parity with workerd from 2026-11-03, 11-04 and 11-05. Against miniflare
    4.20260730 on the broker: D1 111/116, Durable Objects 254/261 (RPC 18/18), Queues 105/112.
  - Database clients that need only `fetch` or WebSocket from 2026-11-15; `fetch()` returns a promise from
    2026-10-22 and runs off the event loop on a standalone binary from 2026-11-16.
  - `DOMException` constructible, `TextDecoder` UTF-16 and windows-1252, `Blob.prototype.stream()`.
- Documentation: database clients on standalone (#322), Web Crypto tracked issues (#321), the API-challenge app on
  workerd, sproutd and standalone (#318).
- **A per-project `runtime`: `supervisor` (default) or `sproutd` (private, off unless configured).** Design 05,
  phase 1. `PUT /api/projects/:name/runtime` chooses it before the first deploy; a sproutd project is deployed with a
  hand-built `app.so` (`module` field of `POST .../deployments`), rolled back with the existing activate call, and routed
  by the edge to sproutd's frontend through a new route `backend` entry. Secrets and per-project limits are mapped onto
  sproutd's own, and control reconciles sproutd at startup and after route changes. Existing projects, routes and API
  shapes are unchanged. Not installed by `install.sh` and not touched by `sbctl update`; see `infra/README.md`.
- **Live tail for one app: `GET /api/projects/:name/tail`.** A Server-Sent Events stream in the shape of a
  Workers tail event (`scriptName`, `outcome`, `eventTimestamp`, `event.request`/`response`, `cpuTime`,
  `wallTime`, `logs`, `exceptions`). It merges the edge request log (status, CPU ms, wall ms, outcome from the
  failure class) with the sprout's console output and uncaught exceptions. Server-side filters: `status`
  (`ok`, `error`, `500`, `5xx`; repeatable), `method` (repeatable), `sampling-rate` (0 to 1), `search`
  (substring over URL, console text and exception text) and `outcome`. Same authentication and ownership checks
  as the other log routes. It tails only data written after connect, reads at most 256 KiB per source per
  second, stops after ten minutes, and sends at most 50 events a second, reporting the rest in a `dropped`
  frame. The existing `/logs`, `/logs/tail`, `/logs/recent` and `/logs/sprout` routes are unchanged.
  Console lines are separate events and are never attached to a request: concurrent requests share one process,
  the runtime does not tag a line with a request id, and the sprout's output file has no timestamps.
  The runtime also writes `console.log`, `warn` and `error` to one stream without a level, so only an uncaught
  exception (`Uncaught (in fetch) ...`) is recognised as an error. Needs CLI with `sproutboat tail` live
  streaming (the CLI change ships separately); older CLIs keep working against `/logs/recent`.
- **The dashboard's live tail uses it.** The logs page has a Live tail panel with status, method, sampling and
  search filters, pause and resume, clear, and a 500 row bound, with console lines and exceptions inline.
- The edge request log gained two optional fields, `path` (the request pathname, never the query string) and
  `uncaught` (the handler threw: the runtime's bare 500, recognised by its signature or by `x-sb-uncaught`), which feed
  the tail. Older lines without them
  still read; their events show the host without a path and outcome `ok`.

### Fixed

- The object-growth collector crash above, a second collector crash (a minor collection scanning the entries block an
  array left behind), `crypto.getRandomValues` filling every byte of a wider view, a fetched 204, 205 or 304
  response throwing, and a `Uint8Array` subclass that redefines a builtin method.

### Known differences (not regressions)

- The median compiled binary in the compatibility run is 4.00 MB (0.12.1: 3.70 MB, +8%), from the larger runtime. The
  compatibility result is unchanged: 32/32 compile, 3/32 match (the 29 differ only in `Content-Type`).

## [0.12.1] - 2026-10-29

Adopts `@sproutboat/runtime` 0.35.0 and `@sproutboat/toolchain` 0.20.1 (from 0.34.2 and 0.19.2), the versions CLI 0.43.0 builds with.

### Breaking and operator actions

- Update with `sbctl update`. There are no new units, env files, secrets or
  migrations. Take a backup first (`sudo systemctl start sproutboat-backup`)
  and copy it off the box.
- **Rebuild your apps with CLI 0.43.0** to get the fixes and the speed-ups
  below. They are in the compiled app, so deployed apps keep running as built.
  The garbage-collection fix matters most: an app built before it can, rarely
  and silently, read back a changed string or array after an `await`.
- **A standalone binary opens its SQLite databases in EXCLUSIVE locking mode by
  default** (CLI 0.42.0). While the binary runs, no other process can open its
  databases, so the `sqlite3` shell and `sproutboat kv|d1 --local --data-dir`
  are locked out. Set `SB_SQLITE_EXCLUSIVE=0` to keep shared locking. The
  platform's broker and sproutd are unchanged.
- **Platform rollback.** `SB_REF=v0.12.0 sbctl update` is safe: nothing here
  changes stored data or a frozen contract.
- `MIN_CLI_VERSION` stays `0.0.0`: the control API is unchanged. CLI 0.43.0 is
  the release tested with this platform version.

### Fixed

- **A collection no longer frees Promise's pending-rejections array (CLI
  0.43.0, toolchain 0.20.1).** Once enough rejections had grown that array
  past its static capacity, the collector skipped it as malformed and freed its
  entries at every collection. The next rejection then wrote into memory that
  belonged to another object, so a string or array of a request suspended at an
  `await` could change silently. A standalone binary showed it in about 1
  fresh process in 5 under interleaved requests; sproutd's concurrent smoke
  failed 4 runs in 16. The regression test failed 60 of 60 runs before the fix
  and passes 60 of 60.
- **A chunked upload's end reaches the worker** when sproutd's window was full
  as the last chunk arrived, so a large `ws` or HTTP upload no longer loses its
  connection at the end.

### Performance

- **JWT verification in C (CLI 0.40.0).** `atob`, `TextEncoder.encode`, the
  `ArrayBuffer` copy of `crypto.subtle.sign` and `digest`, and the
  constant-time compare behind `verify` no longer run as JavaScript loops: a
  typical `authenticate()` goes from 21.5 to 7 µs.
- **`JSON.stringify` and `atob` read characters directly** and return an
  8-bit string when they can (CLI 0.39.0 and 0.41.0).
- **D1 is cheaper in standalone builds.** Calls skip the JSON text hop around
  the in-process dispatch, strict rows are built as JS arrays in C with their
  text in one arena, and a strict query takes a direct lane with no statement
  closures. No 88 KiB `mmap` per statement that builds a temporary table
  (`INSERT ... RETURNING`, sorts).
- **The client address is folded once per distinct address**, not on every
  request.
- **A standalone binary collects every 8 requests** and after about 50 ms of
  quiet, instead of after every response (`SB_GC_EVERY=<n>`; `1` restores the
  old behaviour). It costs about 2 MiB more resident memory. sproutd's collector
  and density are untouched.
- **A request's fixed cost drops its text round trips**, regular expressions and
  repeated lookups, and a response's ASCII headers and body are written straight
  from the heap (CLI 0.42.0).
- Together, on the API-challenge mix on one pinned x86 core, CLI 0.41.0 held
  3,200 req/s or more at the bar (p95 under 500 ms, p99 under 1 s, errors under
  1%) where the release before it held 2,800. sproutd still keeps 1,000 apps in
  1,536 MiB.

### Changed

- Adopt `@sproutboat/runtime` ^0.35.0 and `@sproutboat/toolchain` ^0.20.1
  (`@sproutboat/wire` ^0.20.2). `COMPAT.md` and `report.json` are regenerated: 32/32 compile, 3/32 match as
  before (the 29 differ only in `Content-Type`). The median binary is 3.68 MB → 3.70 MB.

## [0.12.0] - 2026-10-27

Adopts `@sproutboat/runtime` 0.34.2 and `@sproutboat/toolchain` 0.19.2, the versions CLI 0.38.0 builds with.

### Breaking and operator actions

- Update with `sbctl update`. There are no new units, env files, secrets or
  migrations. Take a backup first (`sudo systemctl start sproutboat-backup`)
  and copy it off the box.
- Everything except the edge's WebSocket proxy reaches an app only when it is
  rebuilt with CLI 0.32.0 or later, and most of it only at a later
  compatibility date (see Added and Changed). Deployed apps keep running as
  built.
- **Platform rollback.** `SB_REF=v0.11.0 sbctl update` stays safe for apps built
  before `2026-10-28`. The 0.11.0 limits for apps built at `2026-10-28` or
  later still apply (see 0.11.0). An app built at `2026-11-01` that accepts a
  WebSocket loses it on v0.11.0, whose edge does not proxy upgrades.
- `MIN_CLI_VERSION` stays `0.0.0`: the control API is unchanged. CLI 0.38.0 is
  the release tested with this platform version.

### Added

- **WebSockets through the edge (#306).** The edge proxies a client's upgrade
  request to the sprout: it opens the sprout's socket first, so a refusal is a
  plain HTTP error, then upgrades the client and relays text and binary
  messages and closes both ways, with the subprotocol the sprout chose. It
  keeps the sprout warm while a socket is open. Messages up to 32 MiB. Apps
  need CLI 0.36.0 or later at compatibility date `2026-11-01`; before that
  date a 101 answers 501. From `2026-10-30` (CLI 0.34.0) a socket pair whose
  two ends both stay in the app, such as a Worker and its Durable Object,
  works on the platform. Outbound sockets and hibernation (`2026-11-01`) run
  on standalone executables and sproutd; the platform's broker transport
  rejects `fetch` upgrades for now.
- Streamed request uploads from compatibility date `2026-10-27` (sproutd).
- Background work: cron, queue and Durable Object alarm triggers, including
  Workers that export only `scheduled()` or `queue()` (CLI 0.32.0).
- Versions and rollback: deployments keep their versions and
  `sproutboat rollback` returns to an earlier one.

### Changed

- **Queues like Cloudflare's from compatibility date `2026-10-31`**: queue
  conformance goes from 17/46 to 41/46 (CLI 0.33.0). `send()`, `sendBatch()` and
  `metrics()` return Promises, bodies keep their content type, messages carry
  `timestamp` and `retry({ delaySeconds })`, the first of `ack()` and `retry()`
  wins, and a message is retried at most 3 times by default.
- **Faster string building** in compiled apps (toolchain 0.18.0): about 43% more
  heavy-workload throughput on sproutd. Apps rebuild once.
- **A request costs about a quarter of the CPU** (toolchain 0.19.2, CLI 0.38.0).
  Porffor's `globalThis` no longer rebuilds the whole global object on every
  read: a 404 from a standalone binary costs about 89 µs of CPU instead of 319.
- **Memory:** 1,000 apps fit in 1,536 MiB (runtime 0.34.x).
- Adopt `@sproutboat/runtime` ^0.34.2 and `@sproutboat/toolchain` ^0.19.2
  (`@sproutboat/wire` ^0.20.2, `@sproutboat/config` ^0.6.0). `COMPAT.md` and
  `report.json` are regenerated: 32/32 compile, 3/32 match as before (the 29 differ
  only in `Content-Type`). The median binary is 3.23 MB → 3.68 MB.

### Fixed

- **A failed binding call you do not await no longer ends the process.** An
  unhandled rejection (D1, KV, R2 and the other bindings) is logged as
  `Uncaught (in promise) ...`, fires `unhandledrejection` when the app listens
  for it, and the process and other requests keep going, as on Workers (CLI
  0.37.0).

## [0.11.0] - 2026-10-24

### Breaking and operator actions

- Update with `sbctl update`. There are no new units, env files, secrets or
  migrations. Take a backup first (`sudo systemctl start sproutboat-backup`)
  and copy it off the box.
- Deployed apps get two broker changes without a rebuild, at every
  compatibility date:
  - A Durable Object `storage.list({ prefix })` matches the prefix exactly, as
    in Workers. It used SQL `LIKE`, which ignored case and read `_` and `%` as
    wildcards: the prefix `item:a_` also listed `item:ab`. An app that relied
    on that can list fewer keys than before.
  - The broker accepts the `do.sql` op. Only apps built with CLI 0.31.0 at
    `2026-10-29` or later send it.
- Everything else reaches an app only when it is rebuilt with CLI 0.30.0 or
  later, and most of it only at a later compatibility date (see Changed).
- **Platform rollback limit.** `SB_REF=v0.10.0 sbctl update` is safe only while
  no app has been rebuilt at compatibility date `2026-10-28` or later. No data
  is lost, but on v0.10.0 (wire 0.17) such an app loses features. An app
  built at `2026-10-29` or later loses:
  - `ctx.storage.sql`: every `exec()`, `databaseSize` and `transactionSync()`
    throws `sproutboat do.sql: unknown op: do.sql`, and the request fails
    unless the app catches it. The databases stay on disk under
    `resources/<store>.do-sql/` and are reachable again after updating back to
    0.11.0 (checked in a VM);
  - `storage.list({ reverse: true })`: keys come back in ascending order, and
    with `limit` they are the wrong keys.

  Measured in a VM, do.js at `2026-10-29` goes from 93/105 on 0.11.0 to 81/105
  on v0.10.0: those 12 cases, nothing else. An app built at `2026-10-28` loses
  only `reverse`. Durable Object key-value data, alarms, the 64-hex ids, RPC
  and the input gate run in the app's own build, so they keep working, as do
  the `start`, `startAfter` and `end` ranges and exact prefixes, which that
  build filters itself. Apps built before `2026-10-28` go back to `LIKE`
  prefix matching. The command also pins the install to v0.10.0: remove
  `SPROUTBOAT_UPDATE_REF` from `/etc/sproutboat/update.env` to follow
  releases again.

- **App rollback limit (any platform version).** The first time an app built at
  `2026-10-29` creates an object named with `idFromName`, it moves that
  object's keys and alarm from the old `name:NAME` id to the new 64-hex id.
  After that, `sproutboat rollback` to a deployment built at an earlier date
  finds the object empty, because its data is under the new id. Nothing is
  lost: rolling forward again shows the data. But keys the older build writes
  while it is active replace the same keys when the newer build comes back
  (checked in a VM). Roll forward instead of back, or restore a backup taken
  before the move.
- `MIN_CLI_VERSION` stays `0.0.0`: the control API is unchanged. CLI 0.31.0 is
  the release tested with this platform version.

### Added

- Durable Objects `ctx.storage.sql` for apps built with CLI 0.31.0 at
  compatibility date `2026-10-29` (`@sproutboat/wire` 0.19.0, `do.sql`). Each
  object has its own SQLite database in
  `resources/<store>.do-sql/CLASS/<id>.sqlite`, beside the project's Durable
  Object store, so it survives redeploys. Backups already archive these files
  and `sbctl restore` brings them back writable by the edge; tests now cover
  both. One broker keeps at most 64 of these databases open and closes the
  least recently used. That bounds its file descriptors at about 200. It
  also bounds memory, but not tightly: in a Linux VM, 64 open databases
  added about 40 MB to the broker when small and about 175 MB when each held
  4 MB and was read in full (SQLite's page cache per connection). That memory
  counts against the edge unit's `MemoryMax`. The platform runs one broker
  per deployment and no shared SQL pool, so the uncapped pool path in wire
  0.19 is not used.

### Changed

- Adopt `@sproutboat/runtime` 0.30.0, `@sproutboat/wire` 0.19.0 and
  `@sproutboat/toolchain` 0.15.0, the versions CLI 0.31.0 builds with.
- New behaviour, gated by each app's compiled `compatibility_date` as before:

  | From date    | Behaviour                                                                                                                                                                                                         |
  | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `2026-10-28` | Durable Objects: an input gate (concurrent read-then-write updates are no longer lost), Promise storage, `transaction()`, `sync()`, typed values, `list()` ranges; `sendBatch({ delaySeconds })` delays the batch |
  | `2026-10-29` | Durable Objects: RPC on stubs, 64-hex ids with `equals()`, `getByName`, `ctx.storage.sql`; an exception in the object rejects `stub.fetch()` instead of returning a 500                                           |

- Durable Object data written at an earlier date survives the move to
  `2026-10-29`: objects named with `idFromName` move to their new id on first
  use, and `idFromString` still accepts the old `name:` and `uid:` ids.
- The compatibility suite still reads 32/32 compile, 3/32 match. The median
  sprout binary grows from 2.90 MB to 3.23 MB with the new prelude.

### Fixed

- Queues: a consumer whose `queue()` handler throws gets every message it did
  not ack or retry redelivered, as on Workers. Before, the broker transport
  delivered such a batch once and dropped it. This applies at every
  compatibility date, once the app is rebuilt with CLI 0.30.0 or later.
  (`sendBatch()` bodies arriving as `"[object Object]"` affected only
  standalone executables and sproutd, not the platform.)
- The control version in `x-sproutboat-control` reads `0.11.0`.

## [0.10.0] - 2026-10-23

### Breaking and operator actions

- Update with `sbctl update`. It reinstalls the edge unit with the new
  response limit and restarts the services. No new units, env files or
  secrets. If you set `SPROUTBOAT_RESPONSE_MAX_BYTES` yourself, your value
  still applies.
- Deployed apps get the KV and R2 `list()` prefix fix (see Fixed) without a
  rebuild, at every compatibility date. An app that passes a prefix containing
  uppercase letters, `_` or `%` can list fewer keys than before.
- When a broker first opens a KV or R2 store after the update, it adds a
  `metadata` column to KV and an `md5` column to R2. Existing values, objects,
  etags and D1 rows are unchanged, and v0.9.2 reads the migrated stores as
  before, so rolling back keeps the data.
- A D1 statement that only reads now reports `meta.changes` as 0, at every
  date. It repeated the previous write's count.
- A client that disconnects now stops the sprout's request. The edge logs it as
  499 with `errorKind: "client-closed"`. Before, the request ran to the end.
- The edge removes `x-sb-edge-secret`, `x-sb-edge-token`, `x-sb-binding-call`
  and `x-sb-url` from every incoming request, and `x-sb-uncaught` from every
  response a client receives.
- Roll back with `SB_REF=v0.9.2 sbctl update` only before apps are rebuilt at
  compatibility date `2026-10-25` or later. On v0.9.2 such an app's KV `list()`
  returns no keys and its metadata reads `null`, without an error. The command
  also pins the install to v0.9.2: remove `SPROUTBOAT_UPDATE_REF` from
  `/etc/sproutboat/update.env` to follow releases again.
- Restore a backup with `sudo sbctl restore <archive> --force` (see Fixed). The
  restore runbook in `infra/README.md` used before this release can lose control
  data.
- `MIN_CLI_VERSION` stays `0.0.0`: the control API is unchanged, and older CLIs
  keep working. CLI 0.28.0 is the release tested with this platform version.

### Added

- Service-binding calls are vouched for by the edge (#295). With a sprout built
  by CLI 0.20.0 or later, the callee sees the caller's URL as `request.url`, and
  a callee that throws makes the caller's `fetch()` reject with its error, as in
  workerd. Brokers get a per-boot edge secret and each sprout its own token.
  Clients can forge neither.
- `tests/service-bindings`: a service-binding conformance and reliability suite
  compared against workerd, including streaming, Workers RPC and Request
  fidelity cases (#293, #298, #301).
- `tools/with-local-packages.ts` runs one command against a local
  `sproutboat-packages` checkout (#300).
- `sbctl restore <archive> [--force]` stops control, the edge and the backup
  timer, then restores a backup. It gives each service its files back with the
  owners and modes `install.sh` sets, then starts the services again.

### Changed

- Adopt `@sproutboat/runtime` 0.28.0, `@sproutboat/toolchain` 0.14.0 (Porffor
  Alpha 19) and `@sproutboat/wire` 0.17.0 (#288 to #303). The broker can stream
  `fetch()` and service-binding responses and request bodies, honours aborts,
  and no longer resends a call it may already have run. It falls back to whole
  bodies for sprouts that don't ask for streaming.
- New behaviour is gated by each app's compiled `compatibility_date`. A deployed
  sprout carries the runtime it was built with, so existing deployments keep
  their behaviour until they are rebuilt with a newer CLI at a later date:

  | From date    | Behaviour                                                                                                                              |
  | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
  | `2026-10-21` | `Request.body` and `Response.body` are `ReadableStream`s; `fetch()` and service-binding responses stream                               |
  | `2026-10-22` | `fetch()` and binding calls return Promises and run off the event loop; redirects follow Fetch; opt-in LTX capture (`SB_LTX_ENABLE=1`) |
  | `2026-10-23` | `fetch(Request)` and `new Request(request, init)` follow workerd (GET and HEAD refuse a body, immutable headers)                       |
  | `2026-10-24` | D1 returns Promises and follows workerd's rules (types, parameter counts, foreign keys, errors)                                        |
  | `2026-10-25` | KV follows the Workers API (Promises, types, metadata, expirations, errors)                                                            |
  | `2026-10-26` | R2 follows the Workers API (Promises, MD5 etags, ranges, conditionals, `uploadPart()` bodies)                                          |
  | `2026-10-27` | Request bodies stream; `SB_REQUEST_BODY_MAX` defaults to 100 MiB (1 MiB before)                                                        |

- The compatibility suite reads 32/32 compile, 3/32 match. Every handler's
  status and body match Bun, including the two date-parsing cases that failed
  in 0.9.2. The 29 mismatches are `Content-Type` alone: since runtime 0.17.0,
  string bodies default to `text/plain;charset=UTF-8` and `Response.json` sets
  `application/json`, as in the Fetch spec and workerd, where Bun differs. This
  reaches an app only when it is rebuilt with CLI 0.18.0 or later, at any
  compatibility date.
- The edge's per-response safety limit is 512 MiB instead of 10 MiB. Responses
  stream through the edge, and the limit applies to service-binding calls too
  (#296).
- Edge connections stay open 5 seconds past the request deadline, up to Bun's
  maximum of 255 seconds, so a slow sprout gets the edge's 504 instead of a
  dropped connection after 10 seconds (#294).

### Fixed

- KV and R2 `list()` prefixes match exactly, as in Workers (`@sproutboat/wire`
  0.15.0 and 0.16.0). They used SQL `LIKE`, which ignored case and read `_` and
  `%` as wildcards: the prefix `a` also listed `AB`, and `a_` also listed `ab`.
  The dashboard and the KV export already matched exactly.
- Restoring a backup brings back the backed-up control data. The restore left
  the target install's `sproutboat.sqlite-wal` beside the restored database,
  and SQLite replayed it over the restored file. Control came back with the new
  install's users and no projects. The restore now deletes each restored
  database's `-wal`, `-shm` and `-journal` files first. It refuses archive
  members outside the state dir, keeps the install's directories, and leaves
  binding data writable by the edge, which had failed with `EACCES` (#139).
- At narrow widths, a long dashboard breadcrumb is cut off with an ellipsis
  instead of pushing the account menu off-screen.
- The Admin › Backups page names everything a backup holds, including binding
  data, and gives the `sbctl restore` command.
- A sprout no longer fails to start with "Is port N in use?" when another local
  address holds the port. The supervisor checks the wildcard address too, and
  tries each port in the range at most once (#300).
- The control version in `x-sproutboat-control` reads `0.10.0`. It had read
  `0.5.3` since v0.5.3.

## [0.9.2] - 2026-10-11

### Changed

- Adopt toolchain 0.7.0, runtime 0.16.0 and wire 0.12.2 with Porffor Alpha 17.
  Native handlers gain in-memory Web Streams and global timers, with compiler
  fixes for Better Auth's model resolver and base64 signatures. HTTP remains
  buffered; AES/JWE stateless sessions remain unsupported.

## [0.9.1] - 2026-10-10

### Changed

- Shared runtime and compiler dependencies move to runtime 0.15.0, toolchain
  0.6.0 and wire 0.12.1. Porffor alpha-16 implements Proxy and collection
  iterators; the runtime adds live URLSearchParams and FormData iterators.
  All 32 compatibility handlers compile and 30 match Bun. The two existing
  non-ISO date parsing mismatches remain.

## [0.9.0] - 2026-10-05

### Added

- Backups now include binding data: every KV, D1, R2, queue and Durable
  Object store under `resources/` and `brokers/`, each snapshotted with
  `VACUUM INTO` so writes in flight are captured. Before this, a restore
  brought projects back with empty storage (#139).
- `bun apps/control/src/backups.ts restore <archive>` restores a backup onto
  an empty install. It checks the whole archive first, refuses a state dir
  that already has a control database unless `--force`, and warns when the
  secrets key is missing. `infra/README.md` has the runbook.

### Changed

- A new version only goes live once it starts. Control asks the edge to start
  each deploy or rollback target first; if it exits or doesn't listen within
  10 s, the deploy fails with 409 and the current version keeps serving. Its
  cron, queue and alarm timers stay off until its route is active (#141).

### Fixed

- Per-deployment broker state (`/var/lib/sproutboat/brokers/<digest>/`) is
  removed when its version is pruned or its project deleted. It used to stay
  forever, one copy per deploy, and ride along in every backup. Control clears
  the existing leftovers when it starts.

### Breaking and operator actions

- Update with `sbctl update`: it creates `/var/lib/sproutboat/activation` and
  installs the units that point control and the edge at it.

## [0.8.1] - 2026-10-05

### Fixed

- The deployment page's "Compare against" picker shows "Choose a version…"
  instead of an empty box (#255).

### Changed

- The compatibility suite and tools build with `@sproutboat/toolchain` 0.5.0
  (Porffor alpha-15): 32/32 compile, 30/32 match, unchanged. Sprouts are built
  by the CLI, so the class-expression (#256) and date-offset fixes reach them
  through CLI 0.15.0.

### Breaking and operator actions

- None. `sbctl update` is sufficient.

## [0.8.0] - 2026-10-05

### Added

- `sproutboat-egress.service`: deployed `fetch()` reaches the internet on the
  systemd install. Brokers hand each request to this token-gated loopback
  service, which runs outside the edge's network deny and refuses private and
  reserved addresses itself (`@sproutboat/wire` 0.12.0, #252).

### Breaking and operator actions

- `sbctl update` installs and starts the new unit and generates
  `/etc/sproutboat/egress.env`. `SB_EGRESS_ALLOW` now goes in that file.

## [0.7.0] - 2026-10-04

### Changed

- Brokers refuse private and reserved addresses for `fetch()`, checking the
  resolved address at connect; the `outbound` allowlist is gone
  (`@sproutboat/wire` 0.11.0, #174).
- The dashboard no longer lists outbound hosts.

### Fixed

- The deployment page's version compare loads on selection, and rollback always
  clears its busy state.

### Breaking and operator actions

- To let sprouts reach a private address, such as a database on the same host,
  set `SB_EGRESS_ALLOW` (`*` or exact addresses) in the supervisor's
  environment; brokers inherit it.
- The edge unit's `IPAddressDeny=any` still blocks all off-box egress on the
  systemd install, so `fetch()` reaches nothing outside the host there.
  `sbctl update` is sufficient.

## [0.6.0] - 2026-10-04

### Added

- The edge applies an asset directory's `_redirects` and `_headers`
  (Cloudflare Pages format), read from `assets.json`. Redirects answer before
  any file lookup; header rules apply to edge-served files and can override
  `Cache-Control` or unset a header. Needs sprouts built with CLI 0.13.0 (#61).

### Fixed

- Durable Object storage and alarms survive redeploys. They now live in one
  database per owner and project instead of the per-deployment state (#207).

### Changed

- `@sproutboat/wire` 0.10.0.

### Breaking and operator actions

- Durable Object data written before this release is not carried over: the
  first deploy after upgrading starts from empty storage, as every redeploy
  did before. `sbctl update` is sufficient.

## [0.5.9] - 2026-10-04

### Fixed

- Typed-array writes past the end are ignored instead of overwriting
  neighbouring memory (#241).
- Typed-array `join()` and `toString()` work; `Uint8Array.join` returned
  garbage and `Uint16Array.join` could kill the sprout (#242).
- KV stores binary values. The broker's KV tables gain a `binary` column on
  first use, and `get(key, type)` supports `"text"`, `"json"` and
  `"arrayBuffer"` (#233).
- Binary `fetch()` and service-binding request bodies reach the upstream as
  their exact bytes (#232).

### Changed

- Sprouts build with `@sproutboat/toolchain` 0.4.24, `@sproutboat/runtime`
  0.13.5 and `@sproutboat/wire` 0.9.3. Sprouts built before this release keep
  their previous KV and fetch behaviour.

## [0.5.8] - 2026-10-03

### Fixed

- `String.prototype.replaceAll` is linear instead of quadratic: a 2.1 MB
  replacement went from about 42 s to 71 ms (#237).
- uuid and @noble/hashes work in sprouts. Integer typed-array stores now wrap
  instead of clamping; `typedArray.set(source)` with no offset copies to the
  start instead of the wrong memory; `~x` wraps for large values; out-of-range
  typed-array reads return `undefined`; and a handler's own top-level `URL` no
  longer replaces the runtime's `URL` class at startup (#238).

### Changed

- Sprouts build with `@sproutboat/toolchain` 0.4.22 and `@sproutboat/runtime`
  0.13.4. The median compatibility-suite binary is 1.02 MB, up from 0.98 MB.

## [0.5.7] - 2026-10-02

### Fixed

- Floating-point results on arm64 now match JavaScript: builds use
  `-ffp-contract=off`, so `a * b + c` rounds twice as JavaScript requires
  instead of once in a fused instruction (#235).
- Standalone binaries accept HTTP/1.0 requests instead of answering 505, so
  they work behind nginx's default `proxy_http_version 1.0` (#236).
- Binary responses from outbound `fetch()` and service bindings arrive intact.
  The broker (`@sproutboat/wire` 0.9.2) now sends them as raw bytes to sprouts
  built with runtime 0.13.3 or later; older sprouts are served exactly as before
  (#232).

## [0.5.6] - 2026-10-02

### Fixed

- Async handlers no longer start failing on every request after a few
  requests. An async function returning `null` was rejected with
  `TypeError: Cannot get property of null` once a `toISOString()` call had
  run, and the deployment never recovered. Sprouts now build with
  `@sproutboat/toolchain` 0.4.17, which patches the Porffor bug behind it
  (#168).
- Non-ASCII text read back from bindings is no longer garbled: D1 rows, KV
  values, cached bodies and error messages returned "café" as "cafÃ©"
  (`@sproutboat/runtime` 0.13.2, #189).
- Uncaught handler exceptions are logged to the sprout log instead of being
  swallowed behind a bare 500.

## [0.5.5] - 2026-10-01

### Changed

- Sprouts build with Porffor alpha-13 (`@sproutboat/toolchain` 0.4.16, up
  from 0.4.13 on alpha-9) and `@sproutboat/runtime` 0.13, matching CLI
  v0.12.3. This includes the coroutine-stack fix for #178, which stopped
  large async handlers from crashing with SIGBUS. Compatibility is unchanged
  at 32/32 compile, 30/32 match.

## [0.5.4] - 2026-09-30

### Fixed

- The installer's closing instructions told you to run
  `bunx @sproutboat/cli login`, an old 0.1.0 package. They now print
  `npx sproutboat login --api-url https://control.<domain> --token <token>`.

## [0.5.3] - 2026-09-26

### Added

- Deployment history now shows compile time and binary size, with a binary-size
  trend across retained versions. Existing sizes are recovered from available
  artifact manifests.
- A dedicated CLI authorization page for device login.

### Changed

- The edge serves static asset bodies through `Bun.file()` rather than reading
  the complete file into memory per request.
- Updated the Porffor alpha 9 toolchain to `@sproutboat/toolchain@^0.4.13`
  and the artifact manifest contract to `@sproutboat/artifact@^0.3.0`.
- The control API now reports the platform tag version in its version header.
  CLI v0.11.13 is the release tested with this platform version.

### Fixed

- Updated the native runtime for repeated HMAC signing with raw digest bytes.

### Breaking and operator actions

- None. Existing artifacts remain valid, and `sbctl update` is sufficient.

## [0.5.2] - 2026-09-18

### Fixed

- `@sproutboat/toolchain` bumped to `^0.4.10`, pinning Porffor to the
  `alpha-7` tag. All local patches (render.js, uwebsockets.js) verified
  against the real alpha-7 source — no anchor drift, and the full test
  suite (153 tests) passes.

## [0.5.1] - 2026-09-17

### Fixed

- `@sproutboat/toolchain` bumped to `^0.4.9` and `@sproutboat/runtime` to
  `^0.9.6`. `0.4.6`/`0.4.7` shipped a native R2 size-gating feature
  (baronunread/sproutboat#202) with a misplaced `#endif` in the generated
  C++ guard, breaking every R2-free native build with a compiler error.
  The fix landed as `0.4.8`, but that version got stuck permanently
  conflicted on npm after an interrupted trusted-publish attempt — so
  `0.4.9`/`0.9.6` instead revert #202 outright: R2 transfer support is
  native code again, always compiled in with 404 stubs where unused, the
  pre-#202 shape. The size gate saved ~11KB of `__text` (~1.3% of a typical
  binary) and didn't even change the shipped file size on macOS, since
  `__TEXT` is page-aligned there — not worth the guard-placement bug class
  it introduced.

### Breaking and operator actions

- None. `sbctl update` is sufficient.

## [0.5.0] - 2026-09-15

### Added

- R2 object browser in the dashboard (`/r2/:id`): read-only list, prefix
  filter, download — same authenticated/resource-ownership/audit-logged
  posture as the existing KV explorer (baronunread/sproutboat#183).

### Fixed

- The 100% CPU livelock on a `fetch` handler that resolves a promise with a
  plain object (baronunread/sproutboat#168), and `new Response(r2Object.body)`
  corrupting binary R2 content (baronunread/sproutboat#177) — both picked up
  via `@sproutboat/toolchain` `^0.3.2` → `^0.4.1` and `@sproutboat/runtime`
  `^0.6.5` → `^0.7.1`. The runtime bump also carries R2's file-backed blob
  storage rework (baronunread/sproutboat#56) and a raw-bytes `put()` fix
  (baronunread/sproutboat#184).

### Breaking and operator actions

- None. `sbctl update` is sufficient.

## [0.4.3] - 2026-09-14

### Fixed

- `@sproutboat/runtime` bumped to `^0.6.6`. `__sbEntry` called
  `handlers.fetch()` (and the `scheduled`/`queue`/`alarm` trigger paths)
  with no try/catch at all: any synchronous throw, or a rejected async
  handler promise, propagated all the way up and crashed the whole process,
  taking down every other in-flight and future request on that sprout until
  whatever supervised it restarted the binary (baronunread/sproutboat#179).
  A throwing/rejecting `fetch()` now returns a 500 instead. `scheduled()`/
  `alarm()` still reply 204 either way (no
  failure signal existed before this either); a throwing `queue()` falls
  through to the existing default-ack pass, same as a handler that never
  calls `ack()`/`retry()` on every message.

### Breaking and operator actions

- None. `sbctl update` is sufficient.

## [0.4.2] - 2026-09-14

### Fixed

- `@sproutboat/runtime` bumped to `^0.6.5`, which windows the byte encoder
  behind `crypto.subtle`. `0.6.4` fixed that encoder for large inputs and
  regressed it badly for small ones: an app hashing ~150-byte values on every
  request lost 64% of its throughput, tripled its p50 and grew 41% in RSS
  (baronunread/sproutboat#181). `0.6.5` keeps the large-input fix from #180
  without that cost, by only reaching for an array once 512 bytes have
  accumulated. This platform never ran `0.6.4`; the pin moves straight from
  `^0.6.3` to `^0.6.5`.

### Breaking and operator actions

- None. `sbctl update` is sufficient.

## [0.4.1] - 2026-09-14

### Fixed

- Static assets no longer force a network round trip on every request.
  Fingerprinted build output (Vite, Astro, webpack/CRA, Next.js, Nuxt,
  SvelteKit -- detected by filename shape, not a hardcoded framework
  directory) is now cached for a year as immutable; everything else with a
  stable name (fonts, favicon, OG images) gets a bounded day-long cache.
  Previously every asset was sent `max-age=0, must-revalidate`, so nothing
  was ever actually cached -- visible as content popping in a beat late
  once page response times got fast enough to expose the round trip.
- `@sproutboat/runtime` bumped to `^0.6.3`: a handler calling `.text()`/
  `.json()` on a `Response` built from raw wire bytes (the assets binding,
  outbound `fetch()`, service bindings) got the bytes back undecoded
  instead of as real UTF-8 text (mojibake on any non-ASCII content), and
  that same decode built its result with `O(n^2)` string concatenation,
  making a ~43KB page take 2.6s+ of real CPU time per request.

## [0.4.0] - 2026-09-11

### Added

- Deploys compile against the `@sproutboat/{runtime,wire}` 0.5.0 surface:
  `env.<NAME>.limit({ key })` now returns `{ success, resetAt }`. `resetAt` is
  epoch milliseconds for when the fixed window rolls, so a throttled request
  can be answered with an accurate `Retry-After`
  (`Math.ceil((resetAt - Date.now()) / 1000)`). Handlers reading only
  `success` are unaffected.

### Changed

- `@sproutboat/runtime` and `@sproutboat/wire` pinned to `^0.5.0`.
- `docs/capability-http-sync-v0.md` documents async handlers: `fetch` may
  return a promise the handler itself creates (a `.then()`-chained one hangs),
  such a response omits `x-sb-cpu-ms`, and `crypto.subtle` digest/sign/verify
  are async in signature only over synchronous inline C.

### Breaking and operator actions

- None. `sudo sbctl update` picks up the new runtime; existing deployments keep
  working and gain the field on their next deploy.

## [0.3.1] - 2026-09-11

### Fixed

- `sbctl update` no longer installs `node_modules` and the built dashboard
  root-only. The bootstrapper kept a restrictive umask while running the
  release installer, so a dependency change left the service users unable to
  read `@sproutboat/*` and both control and edge crash-looped
  (`Cannot find module`). The installer now normalises those trees to
  world-readable, and the bootstrapper resets its umask before the handoff.

### Breaking and operator actions

- None. If a `sudo sbctl update` to 0.3.0 left control or edge failing, this
  release fixes it; re-run `sudo sbctl update` (or
  `chmod -R a+rX /opt/sproutboat/node_modules && sudo sbctl restart`).

## [0.3.0] - 2026-09-11

### Added

- Deploys now compile against the `@sproutboat/{runtime,wire}` 0.4.0 surface, so
  a handler gains:
  - **Rate limiting**: `ratelimiters` in `sproutboat.jsonc` gives
    `env.<NAME>.limit({ key }) -> { success }`, a fixed-window counter served by
    the deployment's broker.
  - A **`crypto.subtle`** subset: `digest` (SHA-256/384/512) and HMAC
    `sign` / `verify`; plus `crypto.scryptVerify` for migrating password hashes.
  - **`env.<D1>.backup()`**: an online, integrity-checked D1 snapshot via
    `VACUUM INTO`.
  - **`request.cf.clientIp`**: the connection's remote address.

### Changed

- Config parsing, the artifact manifest, the binding broker and the native-fetch
  runtime now come from published `@sproutboat/*` packages instead of a
  `github:` dependency on the CLI. The Porffor pin and its source patches moved
  to `@sproutboat/toolchain`. No wire change beyond the two new broker ops
  above.
- Porffor pinned alpha-4 -> alpha-5 (`1f4ae4ae`) for the compile path. Deployed
  artifacts are immutable and unaffected; new deploys pick it up. The Porffor
  compatibility suite holds at 32/32 compile, 29/32 match.

### Fixed

- A completed `sbctl update` restarts the active control and edge processes
  after replacing their source, so the new runtime actually activates.
- The edge retains still-active timed dispatchers across a candidate handoff
  instead of dropping them.
- The shared edge response cache is tightened to anonymous `GET` requests whose
  response is `Cache-Control: public` with a finite lifetime. Anything carrying
  `Authorization`, `Cookie`, `Set-Cookie`, `Vary` or a revalidation directive
  bypasses it, so one deployment's dynamic response can never be served for
  another's request.

### Breaking and operator actions

- None. Upgrade once with `sudo sbctl update`.

## [0.2.1] - 2026-09-08

### Fixed

- Updates now restart active control and edge processes after replacing their
  source, so a completed upgrade actually activates its new runtime.

## [0.2.2] - 2026-09-08

### Fixed

- Dynamic responses now return the measured Sprout CPU header, while cached
  entries continue to omit the per-request value.

## [0.2.1] - 2026-09-08

### Breaking and operator actions

- No known breaking API or runtime changes. Upgrade once with `sudo sbctl update`.
  Later updates stage a fresh release before running its installer.

### Fixed

- Upgrades now create and normalize both `brokers` and `resources` state
  directories before restarting the edge, so binding-backed Sprouts can start.
- Existing admin tokens are no longer printed during an upgrade.
- Staged updates normalize destination modes before synchronizing code, so the
  edge can traverse the application tree and execute Bun.

### Added

- A root-owned update bootstrapper stages a fresh source tree outside the
  active installation, serializes concurrent updates, and records the target
  commit and update pin in `/etc/sproutboat/update.env`.

## [0.2.0] - 2026-09-07

### Breaking and operator actions

- No known breaking API or runtime changes.
- Run the installer or `sbctl update` when upgrading. The KV administration API
  requires updated systemd units and shared group permissions for
  `/var/lib/sproutboat/resources`.
- Publish and pin the matching CLI release before tagging the platform. The new
  control endpoints are consumed by `sproutboat kv key`, `kv bulk`, and
  `kv export`.

### Added

- Authenticated, owner-scoped KV key listing, individual key operations,
  bounded bulk transfer, and paginated export support.
- Safe KV audit events containing actor, resource ID, operation, status, and
  counts without keys or values.
- Service bindings between active deployments owned by the same account.
- Refined dashboard navigation, resource forms, and account fixtures.

### Fixed

- Shared binding data now lives outside the log directory and remains writable
  by the edge and control services during KV administration.
- Deployed static assets preserve binary bytes when fetched through an assets
  binding.
- Failed KV exports remove their temporary file and never leave an apparently
  complete destination.

## [0.1.0] - 2026-09-01

First tagged self-hosted platform checkpoint.

[Unreleased]: https://github.com/baronunread/sproutboat/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/baronunread/sproutboat/compare/v0.8.1...v0.9.0
[0.5.9]: https://github.com/baronunread/sproutboat/compare/v0.5.8...v0.5.9
[0.5.8]: https://github.com/baronunread/sproutboat/compare/v0.5.7...v0.5.8
[0.5.7]: https://github.com/baronunread/sproutboat/compare/v0.5.6...v0.5.7
[0.5.6]: https://github.com/baronunread/sproutboat/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/baronunread/sproutboat/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/baronunread/sproutboat/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/baronunread/sproutboat/compare/v0.5.2...v0.5.3
[0.4.3]: https://github.com/baronunread/sproutboat/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/baronunread/sproutboat/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/baronunread/sproutboat/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/baronunread/sproutboat/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/baronunread/sproutboat/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/baronunread/sproutboat/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/baronunread/sproutboat/compare/v0.2.0...v0.2.1
[0.2.2]: https://github.com/baronunread/sproutboat/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/baronunread/sproutboat/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/baronunread/sproutboat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/baronunread/sproutboat/releases/tag/v0.1.0
