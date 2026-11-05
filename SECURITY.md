# Security policy

This policy covers Sproutboat Community, the code in this repository: the control API, the dashboard, the edge, the egress service, the supervisor and sandbox launcher, the installer, `sbctl` and the update, backup and restore tooling. The CLI has its own repository, [sproutboat-cli](https://github.com/baronunread/sproutboat-cli); report CLI problems the same way, naming that repository. Sproutboat Cloud is a separate, closed product and is not covered here.

## Supported versions

| Version                         | Security fixes                                     |
| ------------------------------- | -------------------------------------------------- |
| Newest 1.x release              | Yes                                                |
| Older 1.x minor and patch lines | No: update to the newest 1.x (minors do not break) |
| 1.0.0 release candidates        | No: move to the stable release                     |
| 0.x                             | No: update to 1.x                                  |
| `main` between releases         | Fixed in `main`, shipped in the next release       |

From 1.0 the 1.x line is in maintenance mode (see [docs/versioning.md](docs/versioning.md)). Security fixes ship as a patch release of the newest 1.x, with a note under **Breaking and operator actions** in [CHANGELOG.md](CHANGELOG.md) when you must do something besides `sbctl update`. Fixes to the pinned third-party binaries (Bun, Caddy) ship the same way, by bumping the pinned version and its checksum.

## Reporting a vulnerability

Please report privately and do not open a public issue.

1. **Preferred:** use GitHub private vulnerability reporting: [report a vulnerability](https://github.com/baronunread/sproutboat/security/advisories/new) (the repository's **Security** tab, then **Report a vulnerability**).
2. **Email:** `<SECURITY-CONTACT-EMAIL: PLACEHOLDER, the maintainer must fill this in before release>`.

Include the version (`grep '"version"' /opt/sproutboat/package.json`, or the commit), the install mode (`sbctl mode`), what you did, what you expected and what happened, and a proof of concept if you have one. Do not include real secrets or other people's data.

What to expect: we acknowledge a report within 7 days, then assess it, give you a rough timeline and coordinate disclosure with you. When a fix ships, we publish a GitHub security advisory (with a CVE where it warrants one) and credit you unless you ask us not to. This project runs on a best-effort basis: severe issues come first, and the fix date depends on the issue.

Please give us a reasonable chance to fix a problem before you disclose it, and do not test against systems you do not own. A throwaway install on your own machine is the right place.

## The security model

Community runs your own code on a box you own. The security model follows from that.

**Who can do what.** The installer seeds one admin, who holds the bootstrap token (also the dashboard password). The admin creates the other accounts; nobody can sign up publicly (`POST /api/auth/sign-up` returns 403, and GitHub sign-in only logs in an account that already exists). An account that can deploy can run native code on the box, inside the sandbox below. Treat deploy permission as code execution permission.

**The sandbox.** Every deployment (a "sprout") runs under [bubblewrap](https://github.com/containers/bubblewrap), started by `infra/sandbox/sprout-sandbox.sh`:

- its own user, PID, IPC, UTS and cgroup namespaces, as an unprivileged uid inside the user namespace;
- a mount namespace holding a read-only view of the system libraries and that deployment's own artifact directory, and nothing else of the host;
- a cleared environment (the sprout never sees the egress token or the edge's variables), and `--die-with-parent`;
- no route off the box: the edge unit sets `IPAddressDeny=any` with `IPAddressAllow=localhost`, which every sprout it starts inherits. A sprout's `fetch()` leaves through the egress service, which needs a token the sprout does not have (its broker holds it), resolves each target, refuses private, loopback, link-local, metadata, CGNAT and multicast addresses, and connects only to the address it vetted. `SB_EGRESS_ALLOW` in `egress.local.env` is the operator's opt-in for specific private addresses;
- bindings (KV, D1, R2, queues, secrets, Durable Objects) run in a separate broker per deployment, itself under bubblewrap, with only that deployment's state directory, its own resource files and its owner's R2 objects mounted, and a per-app credential that the edge checks on every cross-app call.

**What the sandbox is not.** It is defence in depth for code you trust, not a boundary against hostile code:

- All sprouts share one kernel, and so one kernel attack surface. The seccomp syscall filter is optional: the unit points at `/etc/sproutboat/worker-seccomp.bpf`, the installer does not ship one, and without the file sprouts start without it (`SPROUTBOAT_SPROUT_SECCOMP_REQUIRED=1` refuses instead).
- All sprouts share the host's loopback interface (the network namespace is not unshared, because the edge reaches each sprout over loopback). A sprout can open connections to other loopback services: control's unauthenticated endpoints, the edge, other sprouts' ports. Services that need a token still ask for one.
- Resource limits are aggregate. The edge unit has a memory cap, CPU quota and task limit for every sprout and broker together; per-sprout cgroup limits are off by default (`SPROUTBOAT_SPROUT_CGROUP=off`). One runaway sprout can starve the others or get the edge killed.
- A homelab install with `SB_BIND_HOST` set to a non-loopback address adds the listed ranges to the edge's `IPAddressAllow`, for the edge **and every sprout**. That is a deliberate, documented trade-off (docs/homelab.md).

**What we protect.** Secrets sit in AES-256-GCM at rest, with `secrets.key` in the state directory. Backups encrypt by default with `/etc/sproutboat/backup.key`, which you keep off the box. Control signs webhooks with HMAC-SHA256 over the timestamp and body, and sends them only through the egress service. The installer and updater verify the checksum of the Bun, Caddy and Rust engine binaries they download. The optional Caddy build with the Cloudflare DNS module comes from caddyserver.com's build service, which cannot pin a checksum, and the installer warns about it.

**Exposure.** In public mode only Caddy listens on 80 and 443; control and the edge listen on loopback and `ufw` denies everything else inbound except SSH. Control's `/internal/health` and `/internal/tls/allow` answer on the public control hostname: the first is a liveness check, the second says whether a hostname is an active route and counts against the certificate issuance cap. In homelab mode you own the proxy and the network, and should block `/internal/` there if the proxy is reachable from untrusted networks.

## Scope

**In scope**

- Authentication or authorisation bypass in the control API or dashboard, including one account reading or changing another account's projects, secrets, storage, webhooks, tokens or backups.
- Disclosure of secrets, tokens, the backup key or backup contents.
- Injection, remote code execution or privilege escalation in control, the edge, the egress service, the supervisor, `install.sh`, `sbctl` or the update, backup and restore scripts.
- Escapes from the documented sandbox layers: a sprout reading files outside its artifact directory, reaching a host user's files, or leaving the box other than through the egress service.
- A private or reserved address that the egress policy fails to refuse, or a way around its token.
- Flaws in webhook signing, the on-demand TLS gate, or the checksum verification of downloaded binaries.
- Backups, restores or updates that corrupt data or silently weaken a protection.

**Out of scope**

- **Hostile multi-tenant use.** Community is not designed for running code from parties who do not trust each other, or for offering it to the public. The shared kernel, shared loopback and aggregate limits above are known properties, not vulnerabilities. If you need that, you need a different product (see Sproutboat Cloud in the README).
- Resource exhaustion or denial of service by an account with deploy permission, or by the admin.
- Anything that needs root, the admin token, or write access to `/etc/sproutboat` or the state directory on the box.
- Weaknesses in third-party components themselves (Porffor, Bun, Caddy, bubblewrap, SQLite, the kernel). Report those upstream; do tell us if our configuration makes one exploitable.
- Operator misconfiguration: exposing control or the edge without a proxy, widening `SB_BIND_HOST`, allowing private egress addresses with `SB_EGRESS_ALLOW`, running another service on the same box, losing `backup.key`.
- Missing hardening that has no demonstrable impact, and findings from automated scanners with no proof of concept.
- Vulnerabilities in Sproutboat Cloud or in sites you deploy.

If you are unsure whether something is in scope, report it anyway.
