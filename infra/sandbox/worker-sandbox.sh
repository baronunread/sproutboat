#!/usr/bin/env bash
#
# Sandboxed launcher for ONE native-fetch Porffor worker process (issues #23/#25).
#
# The supervisor (services/supervisor/src/run.ts) spawns this with the worker
# binary as $1 and PORT in the environment. The worker binds 127.0.0.1:$PORT and
# the edge reverse-proxies to it.
#
# Isolation (bubblewrap):
#   - private user, pid, mount, ipc, uts, cgroup namespaces
#   - runs as an unprivileged uid mapped inside the user namespace
#   - the only filesystem is a read-only view of the runtime libraries and the
#     one artifact directory; everything else does not exist in the mount ns
#   - --die-with-parent: the worker cannot outlive the supervisor
#   - optional seccomp syscall allowlist (SPROUTBOAT_WORKER_SECCOMP)
#
# Network: the worker must reach loopback so the edge can proxy to it, so this
# does NOT --unshare-net. Egress isolation instead comes from the edge service's
# `IPAddressDeny=any` / `IPAddressAllow=localhost` (sproutboat-edge.service),
# which every worker it spawns inherits: loopback only, no route to the host
# network, the control plane, or the metadata endpoint.
#
# Resource limits (systemd transient scope, when systemd-run is present):
#   CPU quota, MemoryMax + MemorySwapMax=0, TasksMax.
#
# ponytail: --ro-bind /usr exposes the whole read-only tree; tighten to the exact
# `ldd worker` output once the target libc is pinned.

set -euo pipefail

worker=${1:?usage: worker-sandbox.sh <worker-binary> [args...]}
shift
[ -x "$worker" ] || { echo "worker-sandbox: $worker is not an executable file" >&2; exit 127; }
command -v bwrap >/dev/null 2>&1 || { echo "worker-sandbox: bwrap (bubblewrap) is not installed" >&2; exit 127; }

artifact_dir=$(cd "$(dirname "$worker")" && pwd)
uid=${SPROUTBOAT_WORKER_UID:-65534}
gid=${SPROUTBOAT_WORKER_GID:-65534}

bwrap_args=(
  --unshare-user
  --unshare-pid
  --unshare-ipc
  --unshare-uts
  --unshare-cgroup-try
  --clearenv
  --new-session
  --die-with-parent
  --uid "$uid" --gid "$gid"
  --hostname worker
  --proc /proc
  --dev /dev
  --tmpfs /tmp
  --chdir /
  --ro-bind "$artifact_dir" "$artifact_dir"
)

# --clearenv wiped everything; forward the port the supervisor assigned.
[ -n "${PORT:-}" ] && bwrap_args+=(--setenv PORT "$PORT")

# Read-only host paths the dynamic loader + libc need. Override for a minimal set.
default_robind='/usr:/lib:/lib64:/etc/ld.so.cache:/etc/ld.so.conf:/etc/ld.so.conf.d:/etc/alternatives'
IFS=: read -ra robind <<< "${SPROUTBOAT_WORKER_ROBIND:-$default_robind}"
for path in "${robind[@]}"; do
  [ -n "$path" ] && bwrap_args+=(--ro-bind-try "$path" "$path")
done

if [ -n "${SPROUTBOAT_WORKER_SECCOMP:-}" ]; then
  if [ -r "$SPROUTBOAT_WORKER_SECCOMP" ]; then
    exec 3<"$SPROUTBOAT_WORKER_SECCOMP"
    bwrap_args+=(--seccomp 3)
  elif [ "${SPROUTBOAT_WORKER_SECCOMP_REQUIRED:-0}" = "1" ]; then
    echo "worker-sandbox: seccomp filter $SPROUTBOAT_WORKER_SECCOMP is required but unreadable" >&2
    exit 126
  else
    # A fresh host has no compiled BPF yet. The syscall allowlist is the last
    # layer; namespace, filesystem, fork, and egress isolation do not need it.
    echo "worker-sandbox: seccomp filter $SPROUTBOAT_WORKER_SECCOMP not readable; starting without it (set SPROUTBOAT_WORKER_SECCOMP_REQUIRED=1 to enforce)" >&2
  fi
fi

launch=(bwrap "${bwrap_args[@]}" -- "$worker" "$@")

cgroup_mode=${SPROUTBOAT_WORKER_CGROUP:-auto}
if [ "$cgroup_mode" != "off" ]; then
  if command -v systemd-run >/dev/null 2>&1; then
    exec systemd-run --quiet --collect --scope \
      --property=MemoryMax="${SPROUTBOAT_WORKER_MEMORY_MAX:-128M}" \
      --property=MemorySwapMax=0 \
      --property=CPUQuota="${SPROUTBOAT_WORKER_CPU_QUOTA:-50%}" \
      --property=TasksMax="${SPROUTBOAT_WORKER_TASKS_MAX:-24}" \
      -- "${launch[@]}"
  fi
  echo "worker-sandbox: SPROUTBOAT_WORKER_CGROUP=$cgroup_mode but systemd-run is unavailable; no per-worker limits" >&2
fi

exec "${launch[@]}"
