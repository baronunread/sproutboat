# Staged activation

Deployments are staged before their route changes. Control writes an immutable
command into `activation/requests`, owned by `sproutboat-control`; edge reads
it, starts the exact artifact and runtime context, and proves only that its
listener accepts TCP. It never calls a user HTTP handler as a readiness probe.

The candidate broker starts with dispatch disabled. Edge promotes it with a
local signal only after control has atomically selected the candidate and
rewritten `routes.json`. Cron, queue and alarm delivery therefore cannot run
from a candidate before it is active.

`activation/responses` is edge-owned. Control waits a bounded time for its
matching reply. Interrupted `starting` and `ready` rows become `failed` at the
next single-control-host startup, while the last active row remains routed.

This requires a Sproutboat CLI runtime containing broker
`--dispatch-disabled` and its SIGUSR1 promotion handler. Platform currently
does not pin that unreleased runtime: release the broker change first, then
advance the normal package version.

Rolling back code selects and stages an older artifact by the same path. It
does not undo database, queue, object-storage, or other side effects written by
the newer version.
