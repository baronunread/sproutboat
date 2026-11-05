#!/usr/bin/env bash
#
# Sproutboat single-VPS installer. SSH into a fresh Linux box and:
#
#   curl -fsSL https://raw.githubusercontent.com/baronunread/sproutboat/main/install.sh | sudo bash
#   # or, from a checkout:  sudo ./install.sh
#
# It asks a few questions up front, then runs unattended: packages, Caddy,
# bubblewrap, a firewall, one admin identity, and the control + edge + dashboard
# services. It pauses once to let you add a DNS record.
#
# Non-interactive: set SB_DOMAIN, SB_ACME_EMAIL, SB_ADMIN. The dashboard is
# always installed; sign in with the admin token this prints. GitHub sign-in is
# optional — set SB_GITHUB_CLIENT_ID + SB_GITHUB_CLIENT_SECRET to enable it.
# SB_CF_TOKEN — optional, only to use DNS-01 (inbound :80 blocked).
# SB_SKIP_DNS_CHECK=1 — don't wait for DNS to resolve.
#
# Install mode (see docs/homelab.md). Flags: --homelab, --public (same as SB_MODE).
# The choices are kept in /etc/sproutboat/install.env, so `sbctl update` keeps them;
# an environment variable overrides the file. Defaults depend on the mode.
#   SB_MODE=public|homelab     public (default): a VPS with Caddy as the public listener.
#                              homelab: behind your own proxy, on a LAN or over Tailscale.
#   SB_PROXY=caddy|external    caddy (public default) installs and manages Caddy. external
#                              (homelab default) installs no Caddy: control serves the
#                              dashboard and you point your own proxy at 8787 and 8080.
#   SB_FIREWALL=ufw|off        ufw (public default) takes over ufw (deny inbound, allow
#                              SB_SSH_PORT, 80, 443). off (homelab default) leaves it alone.
#   SB_SSH_PORT=22             the SSH port ufw keeps open.
#   SB_SCHEME=https|http       the scheme of the public URLs. http needs SB_PROXY=external.
#   SB_BIND_HOST=127.0.0.1     where control and the edge listen. Anything but loopback
#                              needs homelab mode and relaxes the edge's egress isolation
#                              to SB_BIND_ALLOW (space-separated CIDRs; default: the private,
#                              CGNAT, link-local and ULA ranges). See docs/homelab.md.
#   SB_ACME_STAGING=1          Let's Encrypt staging (kept across updates; 0 turns it off).
#
# By default this installs the newest released version (the highest `v*` tag).
# The Rust edge and egress binaries are fetched from the GitHub Release of that tag;
# SB_ENGINE_DIR=<dir> installs a local build instead, SB_EDGE / SB_EGRESS (rust|bun) pick
# the engines (kept in /etc/sproutboat/engine.env; see infra/README.md, Engines).
# SB_REF=v0.1.0 pins a version, SB_REF=main tracks the development branch, and
# `sbctl update` moves to the newest release unless SB_REF says otherwise.

set -euo pipefail

# Pinned third-party binaries. Bump a version AND its hash together; `sbctl
# update` re-runs this script and replaces the binary when the pin changes.
# Hashes are the project-published ones (Bun: SHASUMS256.txt on the release;
# Caddy: caddy_<version>_checksums.txt, SHA-512).
BUN_VERSION="1.4.4"
BUN_SHA256_X64="bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c"
BUN_SHA256_X64_BASELINE="e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76"
CADDY_VERSION="2.11.9"
CADDY_SHA512_AMD64="0e85544340290a16ce4bfb76fe7d65e9de1bf3a6e67f5ccfff30b30d27ea4c73e078077b7bf3e58ae60b6b12e44327705287059c775bca5782e8ee85ea7edd75"
ROOT=/opt/sproutboat
STATE=/var/lib/sproutboat
ETC=/etc/sproutboat
CADDY_BIN=/usr/local/bin/caddy-sproutboat
SB_REPO_GIVEN=${SB_REPO:-}
SB_REPO=${SB_REPO:-https://github.com/baronunread/sproutboat.git}
# Empty means "newest release"; resolved once git exists (see: locate the source).
SB_REF=${SB_REF:-}
if [ "${SB_UPDATE:-0}" = 1 ]; then
  SB_REF_PINNED=${SB_UPDATE_PINNED_REF-}
  # sbctl update fetched this release from the repository recorded in update.env (a fork
  # or a mirror). Keep recording it; the default would send the next update elsewhere.
  if [ -z "$SB_REPO_GIVEN" ]; then
    _repo=$(sed -n "s/^SPROUTBOAT_UPDATE_REPO=//p" "$ETC/update.env" 2>/dev/null | tail -1)
    [ -z "$_repo" ] || SB_REPO=$_repo
  fi
else SB_REF_PINNED=$SB_REF; fi

# Colours only when stdout is a terminal (never in CI logs / pipes).
if [ -t 1 ]; then
  C_HEAD=$'\033[1;36m'; C_DIM=$'\033[2m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_0=$'\033[0m'
else
  C_HEAD=; C_DIM=; C_OK=; C_WARN=; C_ERR=; C_0=
fi

say()  { printf '\n%s▸%s %s%s%s\n' "$C_HEAD" "$C_0" "$C_HEAD" "$*" "$C_0"; }  # section header
note() { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_0"; }                          # indented detail
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_0" "$*"; }
warn() { printf '%s !%s %s\n' "$C_WARN" "$C_0" "$*" >&2; }
die()  { printf '%s ✗%s %s\n' "$C_ERR" "$C_0" "$*" >&2; exit 1; }
rule() { printf '  %s────────────────────────────────────────────────────%s\n' "$C_DIM" "$C_0"; }
randhex() { od -An -tx1 -N32 /dev/urandom | tr -d " \n"; }  # 64 hex chars, no external deps

# fetch_verified URL DEST EXPECTED_HASH [sha256|sha512]: download to DEST.part,
# verify, then move into place. A mismatch removes the download and dies.
fetch_verified() {
  local url=$1 dest=$2 want=$3 algo=${4:-sha256} got
  curl -fsSL --retry 3 "$url" -o "$dest.part" || { rm -f "$dest.part"; die "download failed: $url"; }
  if command -v "${algo}sum" >/dev/null 2>&1; then
    got=$("${algo}sum" "$dest.part" | cut -d' ' -f1)
  else
    got=$(shasum -a "${algo#sha}" "$dest.part" | cut -d' ' -f1)
  fi
  if [ "$got" != "$want" ]; then
    rm -f "$dest.part"
    die "$algo mismatch for $url (expected $want, got $got)"
  fi
  mv -f "$dest.part" "$dest"
}

# --- memory budget ---------------------------------------------------------
# See "Memory budget" in infra/README.md. The edge cgroup (edge + every sprout,
# broker, bwrap and Bun sidecar) gets half of RAM, rounded down to 64 MiB, never
# below 512 MiB. Takes MemTotal in kB so it can be unit tested.
edge_budget_mib() {
  local mib=$(( $1 / 2 / 1024 / 64 * 64 ))
  [ "$mib" -ge 512 ] || mib=512
  echo "$mib"
}
mem_total_mib() { awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo; }
mem_available_mib() { awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo; }
edge_memory_max_mib() {
  local override=${SB_EDGE_MEMORY_MAX:-}
  if [ -n "$override" ]; then
    case "$override" in
      *[!0-9]*|0) die "SB_EDGE_MEMORY_MAX must be a number of MiB, got '$override'" ;;
    esac
    echo "$override"; return
  fi
  edge_budget_mib "$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
}

# Heavy update steps (bun install, dashboard build, auth migration) run in a
# transient scope with a memory cap so a build cannot take the box down.
BUILD_MEMORY_MAX=${SB_BUILD_MEMORY_MAX:-1200M}
capped() {
  if [ "${SB_SKIP_SERVICES:-0}" != 1 ] && command -v systemd-run >/dev/null 2>&1; then
    systemd-run --quiet --scope --collect -p MemoryMax="$BUILD_MEMORY_MAX" -p MemorySwapMax=0 -- "$@"
  else
    "$@"
  fi
}
# Refuse to start a capped build when there is less free memory than its cap.
# Runs before anything is changed on disk. SB_SKIP_MEMCHECK=1 bypasses it.
check_build_memory() {
  [ "${SB_UPDATE:-0}" = 1 ] && [ "${SB_SKIP_MEMCHECK:-0}" != 1 ] || return 0
  local cap=${BUILD_MEMORY_MAX%[Mm]} avail
  case "$cap" in *[!0-9]*|'') return 0 ;; esac
  avail=$(mem_available_mib 2>/dev/null || true)
  [ -n "$avail" ] || return 0
  if [ "$avail" -lt "$cap" ]; then
    die "only ${avail} MiB of memory is available, the update build needs up to ${cap} MiB; stop the backup timer (systemctl stop sproutboat-backup.timer) or wait for the backup to finish, then retry (SB_SKIP_MEMCHECK=1 bypasses this check)"
  fi
}

# --- safe update --------------------------------------------------------------
# On `sbctl update` (SB_UPDATE=1): back up, verify the backup, save the running
# release to /opt/sproutboat-prev, and only then touch /opt/sproutboat. After the
# restart a health gate decides: any failure from the snapshot on rolls back to the
# saved release and exits non-zero. See "Updating and rolling back" in infra/README.md.
# SB_SKIP_BACKUP=1 skips the backup, SB_NO_ROLLBACK=1 keeps a failed update in place
# for debugging (the exit code is still non-zero), SB_HEALTH_TIMEOUT (45) sets the gate.
SAFE_UPDATE=0
if [ "${SB_UPDATE:-0}" = 1 ] && [ "${SB_SKIP_SERVICES:-0}" != 1 ]; then SAFE_UPDATE=1; fi
PREV_RELEASE=/opt/sproutboat-prev
PRE_UPDATE_BACKUP=

# The newest backup archive written after file $1 was created.
backup_newer_than() {
  find "$STATE/backups" -maxdepth 1 -type f -name 'sproutboat-*.tar.gz*' -newer "$1" 2>/dev/null | sort | tail -n 1
}

# Take a backup with the INSTALLED code (under the backup unit's own memory cap), then
# check it with the verifier of the release being installed. Dies before anything has
# changed when either fails.
pre_update_backup() {
  if [ "${SB_SKIP_BACKUP:-0}" = 1 ]; then
    warn "SB_SKIP_BACKUP=1: no pre-update backup; a failed update cannot be undone for data"
    return 0
  fi
  local mark archive key vargs=()
  say "Pre-update backup"
  mark=$(mktemp)
  systemctl start sproutboat-backup.service \
    || { rm -f "$mark"; die "the pre-update backup failed (journalctl -u sproutboat-backup); nothing was changed. SB_SKIP_BACKUP=1 skips it"; }
  archive=$(backup_newer_than "$mark")
  rm -f "$mark"
  [ -n "$archive" ] || die "the backup unit finished but wrote no archive under $STATE/backups; nothing was changed"
  key=$(val_env_op "$ETC/control.env" "$ETC/control.local.env" SPROUTBOAT_BACKUP_KEY_FILE)
  [ -z "$key" ] || vargs=(--key "$key")
  "$ROOT/bun/bin/bun" "$SRC/apps/control/src/backups.ts" verify "$archive" "${vargs[@]}" \
    || die "the pre-update backup $archive failed verification; nothing was changed"
  PRE_UPDATE_BACKUP=$archive
  ok "backup $(basename "$archive") verified"
  note "this archive is the fallback for data: sbctl restore $archive --force"
}

# Run on every exit once the snapshot exists. A non-zero exit rolls back, using the
# STAGED rollback and health scripts (the installed copies may not exist yet).
rollback_armed() {
  local rc=$1
  trap - EXIT
  trap '' HUP INT TERM
  [ "$rc" -ne 0 ] || exit 0
  printf '\n%s ✗%s the update failed (exit %s)\n' "$C_ERR" "$C_0" "$rc" >&2
  if [ "${SB_NO_ROLLBACK:-0}" = 1 ]; then
    warn "SB_NO_ROLLBACK=1: leaving the failed update in place. Roll back by hand: sudo bash $SRC/infra/sb-rollback"
    exit "$rc"
  fi
  say "Rolling back to the previous release"
  SB_HEALTH_BIN="$SRC/infra/sb-health" bash "$SRC/infra/sb-rollback" \
    || warn "the rollback did not finish cleanly; see the messages above"
  [ -z "$PRE_UPDATE_BACKUP" ] || warn "data fallback: sbctl restore $PRE_UPDATE_BACKUP --force"
  exit "$rc"
}

# Poll the whole host (units, control, edge, egress, caddy) until healthy or timeout.
health_gate() {
  SB_HEALTH_TIMEOUT=${SB_HEALTH_TIMEOUT:-45} bash "$SRC/infra/sb-health"
}

# `curl ... | sudo bash` leaves stdin on the pipe, not the terminal. Prompts and
# the DNS-wait keypress read from $PROMPT_TTY instead; empty means truly no
# terminal (CI / cron) and interactive input is impossible.
if [ -t 0 ]; then PROMPT_TTY=/dev/stdin
elif [ -r /dev/tty ]; then PROMPT_TTY=/dev/tty
else PROMPT_TTY=; fi

ask()  { # ask VAR "prompt" ["default"]
  local __v=$1 __p=$2 __d=${3:-} __a
  if [ -n "${!__v:-}" ]; then return; fi
  [ -n "$PROMPT_TTY" ] || die "$__v is unset and no terminal is available (set it in the environment for non-interactive installs)"
  read -r -p "$__p${__d:+ [$__d]}: " __a < "$PROMPT_TTY" || true
  printf -v "$__v" '%s' "${__a:-$__d}"
}

# SB_SKIP_SERVICES=1 provisions files + builds but does not touch systemd or the
# firewall — for testing the installer in a container/CI.
SKIP_SERVICES=${SB_SKIP_SERVICES:-0}

[ "$(id -u)" = 0 ] || die "run as root (sudo ./install.sh)"
[ "$(uname -s)" = Linux ] || die "Linux only"

# --homelab / --public set SB_MODE (--uninstall is handled below; --upgrade is ignored).
for __a in "$@"; do
  case "$__a" in
    --homelab) SB_MODE=homelab ;;
    --public) SB_MODE=public ;;
  esac
done

# --- uninstall: `install.sh --uninstall [--keep-state]` -------------------
if [ "${1:-}" = --uninstall ]; then
  KEEP_STATE=0; [ "${2:-}" = --keep-state ] && KEEP_STATE=1
  say "Uninstall Sproutboat"
  note "removes services, Caddy config, log rotation, /opt/sproutboat, users, and the sysctl drop-in"
  [ "$KEEP_STATE" = 1 ] && note "keeps $STATE (database, artifacts, backups)" \
                        || note "ALSO deletes $STATE — database, artifacts, backups"
  if [ "${SB_UNINSTALL_YES:-0}" != 1 ]; then
    [ -n "$PROMPT_TTY" ] || die "not a TTY; re-run with SB_UNINSTALL_YES=1 to confirm"
    read -r -p "  type 'remove' to confirm: " __c < "$PROMPT_TTY" || true
    [ "$__c" = remove ] || die "aborted"
  fi
  systemctl disable --now sproutboat-control sproutboat-edge sproutboat-egress caddy sproutboat-backup.timer sproutboat-backup.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/sproutboat-control.service /etc/systemd/system/sproutboat-edge.service \
        /etc/systemd/system/sproutboat-egress.service \
        /etc/systemd/system/sproutboat-backup.service /etc/systemd/system/sproutboat-backup.timer
  rm -rf /etc/systemd/system/sproutboat-control.service.d /etc/systemd/system/sproutboat-edge.service.d \
       /etc/systemd/system/sproutboat-egress.service.d /etc/systemd/system/caddy.service.d
  # only remove caddy.service if this installer created it (has our marker path)
  grep -q "$CADDY_BIN" /etc/systemd/system/caddy.service 2>/dev/null && rm -f /etc/systemd/system/caddy.service
  systemctl daemon-reload
  rm -f "$CADDY_BIN" /usr/local/bin/sbctl /etc/sysctl.d/80-sproutboat-userns.conf /root/sproutboat-admin.env \
        /etc/logrotate.d/sproutboat /etc/systemd/journald.conf.d/sproutboat.conf
  rm -f /usr/local/lib/sproutboat/backup-stage /usr/local/lib/sproutboat/health /usr/local/lib/sproutboat/rollback
  rm -rf /opt/sproutboat-prev
  # /etc/sproutboat holds caddy.d (operator drop-ins) and goes even with --keep-state: copy it first.
  # /etc/caddy is the operator's own on an SB_PROXY=external install: only remove ours.
  [ "$(sed -n 's/^SB_PROXY=//p' "$ETC/install.env" 2>/dev/null | head -1)" = external ] || rm -rf /etc/caddy
  rm -rf "$ROOT" /usr/local/lib/sproutboat /opt/sproutboat-src /etc/sproutboat
  [ "$KEEP_STATE" = 1 ] || rm -rf "$STATE"
  for u in sproutboat-control sproutboat-edge; do id "$u" >/dev/null 2>&1 && userdel "$u" || true; done
  getent group sproutboat >/dev/null && groupdel sproutboat 2>/dev/null || true
  ok "removed"
  note "firewall rules (if the installer managed ufw) were left in place: 'ufw delete allow 80/tcp' etc. to drop them"
  exit 0
fi

[ "$(uname -m)" = x86_64 ] || die "x86-64 only (artifact target is linux-x86_64)"
if [ "$SKIP_SERVICES" != 1 ]; then
  command -v systemctl >/dev/null || die "systemd required"
  [ -f /sys/fs/cgroup/cgroup.controllers ] || die "cgroups v2 unified hierarchy required (boot with systemd.unified_cgroup_hierarchy=1)"
else
  warn "SB_SKIP_SERVICES=1 — systemd, firewall, image pull, and service start are skipped"
fi

# --- distro -----------------------------------------------------------------
. /etc/os-release
case "${ID:-}${ID_LIKE:+ $ID_LIKE}" in
  *debian*|*ubuntu*) PKG=apt ;;
  *rhel*|*fedora*|*centos*|*rocky*|*almalinux*|*amzn*) PKG=dnf ;;
  *) die "unsupported distro '${ID:-?}' — need a Debian/Ubuntu or RHEL-family host" ;;
esac
say "Host: ${PRETTY_NAME:-$ID} ($PKG)"

# --- locate (or fetch) the source tree ------------------------------------
# SB_PULL=1 remains available for recovery runs that need a git refresh even
# when the script runs from inside an already-provisioned $ROOT. Normal
# `sbctl update` uses its staged source tree instead.
SRC=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)
if [ "${SB_PULL:-0}" = 1 ] || [ -z "$SRC" ] || [ ! -f "$SRC/package.json" ] || [ ! -d "$SRC/apps/control" ]; then
  command -v git >/dev/null || { [ "$PKG" = apt ] && apt-get install -y -qq git || dnf install -y -q git; }
  # Default to the newest release tag, so a plain `curl | bash` installs a
  # version rather than whatever landed on main this morning. `ls-remote` needs
  # no API token and no auth; an unreleased repo has no v* tags, so this falls
  # back to main on its own. The grep keeps it to plain vX.Y.Z: `-v:refname`
  # ranks v1.0.0-rc1 above v0.10.1, so a prerelease would otherwise install
  # itself as the newest release. Ask for one by name (SB_REF=v1.0.0-rc1).
  if [ -z "$SB_REF" ]; then
    SB_REF=$(git ls-remote --tags --refs --sort=-v:refname "$SB_REPO" 'v*' 2>/dev/null |
      grep -E 'refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 | sed 's#.*refs/tags/##')
    [ -n "$SB_REF" ] || { SB_REF=main; warn "no released version found — installing from main"; }
  fi
  say "Fetching Sproutboat ($SB_REF)"
  SRC=/opt/sproutboat-src
  if [ -d "$SRC/.git" ]; then git -C "$SRC" fetch -q --depth 1 origin "$SB_REF" && git -C "$SRC" reset -q --hard FETCH_HEAD
  else git clone -q --depth 1 --branch "$SB_REF" "$SB_REPO" "$SRC"; fi
fi

# --- ask everything up front, then run unattended -----------------------
# Backfill from a previous install so a re-run (`sbctl update`, or piping the
# script again) is unattended — `ask` no-ops for anything already set.
val_env() { [ -f "$1" ] || return 0; sed -n "s/^$2=//p" "$1" | head -1; }
# val_env_op MANAGED LOCAL KEY: the value the services see, an operator-owned LOCAL
# file winning over the installer-owned MANAGED file (the order their units read them).
val_env_op() {
  local v=
  [ ! -f "$2" ] || v=$(sed -n "s/^$3=//p" "$2" | tail -1)
  [ -n "$v" ] || v=$(val_env "$1" "$3")
  printf %s "$v"
}
# Operator settings live in <name>.local.env, which this installer never rewrites; the
# systemd units read it right after <name>.env. env_split moves anything an operator put
# in the installer-owned file (as the docs used to say) into the local one, after a
# backup copy. ensure_local_env creates the local file, with a header, when it is missing.
# See "Where settings live" in infra/README.md.
env_split() { # env_split NAME KEY...: KEY... are the keys this installer writes to NAME.env
  local name=$1 out line; shift
  [ -f "$ETC/$name.env" ] || return 0
  out=$(bash "$ROOT/infra/sb-envsplit" "$ETC/$name.env" "$ETC/$name.local.env" "$@") \
    || die "could not move your settings out of $ETC/$name.env into $name.local.env; nothing was rewritten"
  while IFS= read -r line; do
    case "$line" in
      moved\ *) note "$name.env: moved ${line#moved } to $name.local.env" ;;
      kept\ *) warn "$name.env and $name.local.env both set ${line#kept }; keeping the value in $name.local.env (the one the service reads)" ;;
      backup\ *) ok "the old $name.env is kept as ${line#backup }" ;;
    esac
  done <<< "$out"
}
# operator_env NAME OWNER:GROUP MODE "what goes here" KEY...: the local file first (with its
# header), then the move, so a file the move creates still starts with the header.
operator_env() {
  local name=$1
  ensure_local_env "$1" "$2" "$3" "$4"
  shift 4
  env_split "$name" "$@"
}
ensure_local_env() { # ensure_local_env NAME OWNER:GROUP MODE "what goes here"
  local f=$ETC/$1.local.env
  if [ ! -e "$f" ]; then
    {
      printf "# Your settings for %s. install.sh never rewrites this file.\n" "$1.env"
      printf "# %s.env is regenerated on every install and update; put anything of yours here\n" "$1"
      printf "# instead. The services read this file right after it, so a key set here wins.\n"
      printf "# One KEY=value per line, no quotes needed. Restart the service to apply a change.\n"
      printf "# %s\n#\n" "$4"
    } > "$f"
    chown "$2" "$f"; chmod "$3" "$f"
  fi
}
SB_DOMAIN=${SB_DOMAIN:-$(val_env "$ETC/sproutboat.env" SPROUTBOAT_DEPLOYMENT_DOMAIN)}
SB_ADMIN=${SB_ADMIN:-$(val_env "$ETC/control.env" SPROUTBOAT_BOOTSTRAP_USERNAME)}
SB_ACME_EMAIL=${SB_ACME_EMAIL:-$(val_env "$ETC/caddy.env" ACME_EMAIL)}
# No Caddy on an SB_PROXY=external install: the admin email lives in control.env.
SB_ACME_EMAIL=${SB_ACME_EMAIL:-$(val_env "$ETC/control.env" SPROUTBOAT_ADMIN_EMAILS)}

# --- install mode: public VPS or homelab ----------------------------------------
# The choices live in $ETC/install.env (no secrets). Environment variables override
# the file; a box with no file is a public install. Written below, backfilled here.
valid_ip() { # IPv4 dotted quad, or IPv6 (hex digits and colons)
  local ip=$1 o
  case "$ip" in
    *:*) [[ "$ip" =~ ^[0-9a-fA-F:]+$ ]] && [[ "$ip" == *:* ]]; return ;;
    *.*.*.*) ;;
    *) return 1 ;;
  esac
  [[ "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || return 1
  local IFS=.
  for o in $ip; do [ "$o" -le 255 ] || return 1; done
}
valid_cidr() { # address/prefix
  local addr=${1%%/*} len=${1#*/} max=32
  [ "$addr" != "$1" ] || return 1
  valid_ip "$addr" || return 1
  case "$addr" in *:*) max=128 ;; esac
  [[ "$len" =~ ^[0-9]{1,3}$ ]] && [ "$len" -le "$max" ]
}
# resolve_mode_defaults: validate SB_MODE, SB_PROXY, SB_FIREWALL, SB_SSH_PORT, SB_SCHEME,
# SB_BIND_HOST, SB_BIND_ALLOW and SB_ACME_STAGING from the environment, fill in the
# defaults for the mode, and print the result as shell assignments (for eval).
resolve_mode_defaults() {
  local mode=${SB_MODE:-public} proxy=${SB_PROXY:-} firewall=${SB_FIREWALL:-} scheme=${SB_SCHEME:-https}
  local bind=${SB_BIND_HOST:-127.0.0.1} ssh=${SB_SSH_PORT:-22} staging=${SB_ACME_STAGING:-0} c
  local allow=${SB_BIND_ALLOW:-10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 fc00::/7 fe80::/10}
  case "$mode" in public|homelab) ;; *) die "SB_MODE must be public or homelab, got '$mode'" ;; esac
  if [ -z "$proxy" ]; then if [ "$mode" = homelab ]; then proxy=external; else proxy=caddy; fi; fi
  if [ -z "$firewall" ]; then if [ "$mode" = homelab ]; then firewall=off; else firewall=ufw; fi; fi
  case "$proxy" in caddy|external) ;; *) die "SB_PROXY must be caddy or external, got '$proxy'" ;; esac
  case "$firewall" in ufw|off) ;; *) die "SB_FIREWALL must be ufw or off, got '$firewall'" ;; esac
  case "$scheme" in https|http) ;; *) die "SB_SCHEME must be https or http, got '$scheme'" ;; esac
  if [ "$scheme" = http ] && [ "$proxy" != external ]; then
    die "SB_SCHEME=http needs SB_PROXY=external: the bundled Caddy always serves HTTPS"
  fi
  case "$staging" in 0|1) ;; *) die "SB_ACME_STAGING must be 0 or 1, got '$staging'" ;; esac
  [[ "$ssh" =~ ^[0-9]{1,5}$ ]] && [ "$ssh" -ge 1 ] && [ "$ssh" -le 65535 ] || die "SB_SSH_PORT must be a port number, got '$ssh'"
  valid_ip "$bind" || die "SB_BIND_HOST must be an IP address (127.0.0.1, 0.0.0.0, a LAN address), got '$bind'"
  case "$bind" in
    127.*|::1) ;;
    *) [ "$mode" = homelab ] || die "SB_BIND_HOST=$bind is only accepted in homelab mode (a public install keeps control and the edge on loopback)" ;;
  esac
  [ -n "$allow" ] || die "SB_BIND_ALLOW must list at least one CIDR"
  for c in $allow; do valid_cidr "$c" || die "SB_BIND_ALLOW entry '$c' is not a CIDR (for example 192.168.0.0/16)"; done
  printf 'SB_MODE=%q\nSB_PROXY=%q\nSB_FIREWALL=%q\nSB_SSH_PORT=%q\nSB_SCHEME=%q\nSB_BIND_HOST=%q\nSB_BIND_ALLOW=%q\nSB_ACME_STAGING=%q\n' \
    "$mode" "$proxy" "$firewall" "$ssh" "$scheme" "$bind" "$allow" "$staging"
}
# bind_dropins UNIT HOST ALLOW: the text of the 20-sproutboat-bind.conf drop-in for
# control or edge. Prints nothing for a loopback bind (the unit's own default).
bind_dropins() {
  local unit=$1 host=$2 allow=$3 c
  case "$host" in 127.*|::1|'') return 0 ;; esac
  printf '%s\n' "# Generated by install.sh and rewritten on every install and update; do not edit." \
    "# Set by SB_BIND_HOST in /etc/sproutboat/install.env (homelab mode)." \
    "[Service]" \
    "Environment=SPROUTBOAT_BIND_HOST=$host"
  [ "$unit" = edge ] || return 0
  printf '%s\n' "# WARNING: the edge unit denies all IP traffic except loopback (IPAddressDeny=any)," \
    "# which is what keeps sprouts off the host network. These ranges are now open to" \
    "# the edge AND to every sprout it runs, in both directions. Prefer a loopback bind" \
    "# and let your proxy be the LAN listener (docs/homelab.md)."
  for c in $allow; do printf 'IPAddressAllow=%s\n' "$c"; done
}
# reserved_username NAME: names control refuses as a namespace (identity.ts reservedUsernames).
# The bootstrap token only authenticates when its username is valid there, so an
# install with a reserved admin name has an admin token that never works.
reserved_username() {
  case "$1" in www|api|admin|status|docs|support|cli|dashboard|sproutboat) return 0 ;; *) return 1 ;; esac
}
# url_host ADDR: the host part of a URL that reaches a service bound to ADDR from this box.
url_host() {
  case "$1" in
    0.0.0.0|'') echo 127.0.0.1 ;;
    ::) echo '[::1]' ;;
    *:*) echo "[$1]" ;;
    *) echo "$1" ;;
  esac
}

SB_MODE_EXPLICIT=${SB_MODE:-}
INSTALL_ENV=$ETC/install.env
if [ -f "$INSTALL_ENV" ]; then
  # Same mode as before (or none named): keep the saved choices. Naming a different
  # mode starts from that mode's defaults instead of the old mode's leftovers.
  if [ -z "$SB_MODE_EXPLICIT" ] || [ "$SB_MODE_EXPLICIT" = "$(val_env "$INSTALL_ENV" SB_MODE)" ]; then
    for _k in SB_MODE SB_PROXY SB_FIREWALL SB_SSH_PORT SB_SCHEME SB_BIND_HOST SB_BIND_ALLOW SB_ACME_STAGING; do
      [ -n "${!_k:-}" ] || printf -v "$_k" '%s' "$(val_env "$INSTALL_ENV" "$_k")"
    done
  fi
else
  # A box installed before install.env existed: its only record of ACME staging is the
  # Caddyfile the previous installer wrote. Carry it over so an update keeps staging.
  if [ -z "${SB_ACME_STAGING:-}" ] && grep -q "acme-staging-v02" /etc/caddy/Caddyfile 2>/dev/null; then SB_ACME_STAGING=1; fi
fi
if [ ! -f "$INSTALL_ENV" ] && [ -z "$SB_MODE_EXPLICIT" ] && [ "${SB_UPDATE:-0}" != 1 ] && [ -n "$PROMPT_TTY" ]; then
  say "Install mode"
  note "public: a VPS, Caddy serves 80/443 and manages certificates, ufw is configured"
  note "homelab: behind your own proxy, on a LAN or over Tailscale; no Caddy, no ufw changes"
  ask SB_MODE "Install mode (public/homelab)" public
fi
resolved_mode=$(resolve_mode_defaults)
eval "$resolved_mode"
# A Cloudflare token given on an earlier run lives in caddy.env; keep using it.
[ "$SB_PROXY" != caddy ] || SB_CF_TOKEN=${SB_CF_TOKEN:-$(val_env "$ETC/caddy.env" CLOUDFLARE_API_TOKEN)}

say "Configuration"
ask SB_DOMAIN     "Deployment domain, e.g. fn.example.com (must be one you control)"
[[ "$SB_DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "not a valid domain: $SB_DOMAIN"
if [ "$SB_PROXY" = caddy ]; then ask SB_ACME_EMAIL "Email for Let's Encrypt (cert expiry notices)"
else ask SB_ACME_EMAIL "Admin email (you sign in to the dashboard with it)"; fi
ask SB_ADMIN      "Admin username (3-32 lowercase a-z 0-9 -)" "$(echo "${SUDO_USER:-admin}" | tr -cd 'a-z0-9-' | cut -c1-32)"
[[ "$SB_ADMIN" =~ ^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$ ]] || die "invalid admin username: $SB_ADMIN"
! reserved_username "$SB_ADMIN" || die "admin username '$SB_ADMIN' is reserved (control refuses it, so the admin token would never work); pick another, for example your name"
note "domain $SB_DOMAIN · acme $SB_ACME_EMAIL · admin $SB_ADMIN"
note "mode $SB_MODE · proxy $SB_PROXY · firewall $SB_FIREWALL · scheme $SB_SCHEME · bind $SB_BIND_HOST"
# The dashboard ships with every install. GitHub sign-in is opt-in via env; the
# admin always signs in with the bootstrap token.
# Kept across updates like the secrets below: a re-run without them must not turn sign-in off.
SB_GITHUB_CLIENT_ID=${SB_GITHUB_CLIENT_ID:-$(val_env "$ETC/control.env" GITHUB_CLIENT_ID)}
SB_GITHUB_CLIENT_SECRET=${SB_GITHUB_CLIENT_SECRET:-$(val_env "$ETC/control.env" GITHUB_CLIENT_SECRET)}
DASH_URL="$SB_SCHEME://dashboard.$SB_DOMAIN"
CONTROL_URL="$SB_SCHEME://control.$SB_DOMAIN"

# Reuse secrets across re-runs so an existing CLI login / session keeps working.
ADMIN_TOKEN=$(val_env "$ETC/control.env" SPROUTBOAT_BOOTSTRAP_TOKEN)
if [ -n "$ADMIN_TOKEN" ]; then TOKEN_IS_NEW=0; else ADMIN_TOKEN=$(randhex); TOKEN_IS_NEW=1; fi
BETTER_AUTH_SECRET=$(val_env "$ETC/control.env" BETTER_AUTH_SECRET); BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-$(randhex)}

# --- unprivileged user namespaces (bubblewrap needs them) ------------------
say "Enabling unprivileged user namespaces"
mkdir -p /etc/sysctl.d
{
  echo "# Sproutboat: bubblewrap needs unprivileged user namespaces"
  echo "kernel.unprivileged_userns_clone=1"
  echo "user.max_user_namespaces=15000"
  echo "kernel.apparmor_restrict_unprivileged_userns=0"
} > /etc/sysctl.d/80-sproutboat-userns.conf
# Apply the keys this kernel actually knows; ignore the rest.
for k in kernel.unprivileged_userns_clone user.max_user_namespaces kernel.apparmor_restrict_unprivileged_userns; do
  v=1; [ "$k" = user.max_user_namespaces ] && v=15000
  sysctl -qw "$k=$v" 2>/dev/null || true
done

# --- packages -------------------------------------------------------------
# The server only runs deployments (under bubblewrap) — it never builds them.
# No Docker. Building worker artifacts is the CLI's job (Porffor + Zig).
say "Installing host packages"
if [ "$PKG" = apt ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git patch rsync bubblewrap unzip dnsutils logrotate
  [ "$SB_FIREWALL" != ufw ] || apt-get install -y -qq ufw
else
  dnf install -y -q ca-certificates curl git patch rsync bubblewrap unzip bind-utils logrotate
  [ "$SB_FIREWALL" != ufw ] || dnf install -y -q ufw
fi

# --- firewall: default-deny, only SSH + Caddy -----------------------------
# --- move binding data out of logs/ (idempotent) ------------------
# Older installs derived broker state from the log path, so KV / R2 / D1 / queue
# data lived under $STATE/logs/. The units now name $STATE/brokers and
# $STATE/resources. Move before anything starts: a running broker holds the
# SQLite files open.
for _d in brokers resources; do
  if [ -d "$STATE/logs/$_d" ] && [ ! -e "$STATE/$_d" ]; then
    say "Moving $_d out of logs/ (binding data)"
    systemctl stop sproutboat-edge >/dev/null 2>&1 || true
    mv "$STATE/logs/$_d" "$STATE/$_d"
    ok "$STATE/$_d"
  fi
done

if [ "$SKIP_SERVICES" = 1 ]; then
  say "Firewall — skipped (SB_SKIP_SERVICES)"
elif [ "$SB_FIREWALL" != ufw ]; then
  say "Firewall: not managed (SB_FIREWALL=off)"
  note "ufw is left as it is; make sure your own rules cover the ports your proxy and clients use"
else
  say "Configuring firewall (deny inbound except $SB_SSH_PORT/80/443)"
  ufw --force default deny incoming >/dev/null
  ufw --force default allow outgoing >/dev/null
  for p in "$SB_SSH_PORT" 80 443; do ufw allow "$p"/tcp >/dev/null; done
  ufw --force enable >/dev/null
fi

# --- identities + directories -------------------------------------------
say "Creating service identities and directories"
getent group sproutboat >/dev/null || groupadd --system sproutboat
for u in sproutboat-control sproutboat-edge; do
  id "$u" >/dev/null 2>&1 || useradd --system --gid sproutboat --no-create-home --shell /usr/sbin/nologin "$u"
done
install -d -m 0755 -o root "$ROOT"
install -d -m 0750 -o sproutboat-control -g sproutboat "$STATE" "$STATE/artifacts"
install -d -m 0770 -o sproutboat-edge   -g sproutboat "$STATE/logs"
install -d -m 2770 -o sproutboat-edge   -g sproutboat "$STATE/brokers"
install -d -m 2770 -o sproutboat-edge   -g sproutboat "$STATE/resources"
# #141: control drops activation requests here and the edge answers; both
# delete them, so both need group write. The sprout sandbox never mounts it.
install -d -m 2770 -o sproutboat-control -g sproutboat "$STATE/activation"
# Older binding files may predate shared control-plane administration.
for _d in brokers resources; do
  chgrp -R sproutboat "$STATE/$_d"
  chmod -R g+rwX "$STATE/$_d"
done
install -d -m 0750 -o root -g sproutboat "$ETC"

# Refuse a starved build before the source tree is replaced.
check_build_memory

# Updates: check the disk, back up and verify, save the running release, then arm
# the rollback. Nothing below this block runs without a way back.
if [ "$SAFE_UPDATE" = 1 ]; then
  say "Preparing a safe update"
  bash "$SRC/infra/sb-snapshot" --check || die "no room for the previous-release snapshot; nothing was changed"
  pre_update_backup
  say "Saving the running release to $PREV_RELEASE"
  bash "$SRC/infra/sb-snapshot" || die "could not snapshot the running release; nothing was changed"
  ok "previous release kept in $PREV_RELEASE (sbctl rollback restores it)"
  trap 'rollback_armed $?' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
fi

# --- sync the tree ------------------------------------------------------
# --delete keeps $ROOT a clean mirror of the checkout, but must NOT touch the
# things provisioned INTO $ROOT afterwards (Bun, deps, the built dashboard).
say "Syncing $SRC -> $ROOT"
rsync -a --delete --chmod=Du=rwx,Dgo=rx,Fu=rwX,Fgo=rX \
  --exclude .git --exclude node_modules --exclude .phase0 --exclude .sproutboat --exclude .local \
  --exclude /bun --exclude /bin --exclude /apps/web/dist --exclude /apps/web/.tanstack \
  "$SRC"/ "$ROOT"/
# Keep the service-visible application root traversable after a staged update.
install -d -m 0755 -o root -g root "$ROOT"

# --- Bun (pinned, checksum-verified) ------------------------------------
BUN="$ROOT/bun/bin/bun"
BUN_HAVE=
[ -x "$BUN" ] && BUN_HAVE=$("$BUN" --version 2>/dev/null || true)
if [ "$BUN_HAVE" != "$BUN_VERSION" ]; then
  if [ -n "$BUN_HAVE" ]; then say "Upgrading Bun v$BUN_HAVE -> v$BUN_VERSION"; else say "Installing Bun v$BUN_VERSION"; fi
  # Same rule as the official installer: CPUs without AVX2 need the baseline build.
  bun_asset=bun-linux-x64; bun_sha=$BUN_SHA256_X64
  if ! grep -qw avx2 /proc/cpuinfo 2>/dev/null; then bun_asset=bun-linux-x64-baseline; bun_sha=$BUN_SHA256_X64_BASELINE; fi
  bun_tmp=$(mktemp -d)
  fetch_verified "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$bun_asset.zip" "$bun_tmp/bun.zip" "$bun_sha" sha256
  unzip -q "$bun_tmp/bun.zip" -d "$bun_tmp/x"
  install -d -m 0755 "$ROOT/bun/bin"
  install -m 0755 "$bun_tmp/x/$bun_asset/bun" "$BUN.new"
  mv -f "$BUN.new" "$BUN"
  ln -sf bun "$ROOT/bun/bin/bunx"
  rm -rf "$bun_tmp"
  ok "Bun $("$BUN" --version)"
fi

# --- Rust engines (edge + egress) -------------------------------------
# The edge and egress run as static Rust binaries from the GitHub Release of the tag
# being installed (.github/workflows/release.yml). They live OUTSIDE the rsync --delete
# tree. SB_ENGINE_DIR=<dir> (the two binaries plus SHA256SUMS) installs an unreleased
# build instead; SB_ENGINE_BASE_URL overrides the download base. Any failure here is a
# warning, never fatal: the Bun engines remain available (infra/sb-engine).
ENGINE_DIR=/usr/local/lib/sproutboat/bin
ENGINE_FILES=(sproutboat-edge sproutboat-egress)
ENGINE_STATUS=pending   # installed | current | stale | none (recorded for the summary)
ENGINE_NOTE=

engine_asset() { echo "$1-linux-x64"; }

# sums_hash <SHA256SUMS> <asset>: the hash listed for an asset, empty if absent.
sums_hash() { awk -v f="$2" '$2 == f || $2 == "*" f { print $1; exit }' "$1"; }

engines_present() { # every binary already installed
  local n
  for n in "${ENGINE_FILES[@]}"; do [ -x "$ENGINE_DIR/$n" ] || return 1; done
}

engines_match() { # engines_match <SHA256SUMS>: installed binaries equal the listed hashes
  local n want have
  for n in "${ENGINE_FILES[@]}"; do
    [ -x "$ENGINE_DIR/$n" ] || return 1
    want=$(sums_hash "$1" "$(engine_asset "$n")")
    [ -n "$want" ] || return 1
    have=$(sha256sum "$ENGINE_DIR/$n" | cut -d' ' -f1)
    [ "$have" = "$want" ] || return 1
  done
}

# verify_engines <dir>: SHA256SUMS in <dir> lists and matches both binaries.
verify_engines() {
  local n want have
  [ -s "$1/SHA256SUMS" ] || return 1
  for n in "${ENGINE_FILES[@]}"; do
    want=$(sums_hash "$1/SHA256SUMS" "$(engine_asset "$n")")
    [ -n "$want" ] || return 1
    have=$(sha256sum "$1/$(engine_asset "$n")" | cut -d' ' -f1)
    [ "$have" = "$want" ] || return 1
  done
}

# fetch_engines <dest>: put SHA256SUMS and the binaries in <dest>. Returns non-zero when
# there is no source for this run.
fetch_engines() {
  local dest=$1 tag=${SB_REF:-} n base
  if [ -n "${SB_ENGINE_DIR:-}" ]; then
    [ -f "$SB_ENGINE_DIR/SHA256SUMS" ] || { ENGINE_NOTE="$SB_ENGINE_DIR/SHA256SUMS not found"; return 1; }
    cp "$SB_ENGINE_DIR/SHA256SUMS" "$dest/SHA256SUMS"
    for n in "${ENGINE_FILES[@]}"; do
      cp "$SB_ENGINE_DIR/$(engine_asset "$n")" "$dest/" 2>/dev/null \
        || cp "$SB_ENGINE_DIR/$n" "$dest/$(engine_asset "$n")" 2>/dev/null \
        || { ENGINE_NOTE="$SB_ENGINE_DIR lacks $n"; return 1; }
    done
    return 0
  fi
  if [ -z "$tag" ] && [ -d "$SRC/.git" ]; then tag=$(git -C "$SRC" describe --tags --exact-match HEAD 2>/dev/null || true); fi
  if ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    ENGINE_NOTE="'${tag:-no ref}' is not a vX.Y.Z release, so there are no published engine binaries (use SB_ENGINE_DIR for a local build)"
    return 1
  fi
  base=${SB_ENGINE_BASE_URL:-https://github.com/baronunread/sproutboat/releases/download}/$tag
  curl -fsSL --retry 2 -m 60 "$base/SHA256SUMS" -o "$dest/SHA256SUMS" || { ENGINE_NOTE="could not download $base/SHA256SUMS"; return 1; }
  if engines_match "$dest/SHA256SUMS"; then return 0; fi
  for n in "${ENGINE_FILES[@]}"; do
    curl -fsSL --retry 2 -m 300 "$base/$(engine_asset "$n")" -o "$dest/$(engine_asset "$n")" \
      || { ENGINE_NOTE="could not download $base/$(engine_asset "$n")"; return 1; }
  done
}

install_engines() {
  local tmp n
  install -d -m 0755 -o root -g root /usr/local/lib/sproutboat "$ENGINE_DIR"
  tmp=$(mktemp -d)
  if fetch_engines "$tmp"; then
    if engines_match "$tmp/SHA256SUMS"; then
      ENGINE_STATUS=current; ENGINE_NOTE="Rust engines already match the release"
      ok "$ENGINE_NOTE"
    elif verify_engines "$tmp"; then
      for n in "${ENGINE_FILES[@]}"; do
        install -m 0755 -o root -g root "$tmp/$(engine_asset "$n")" "$ENGINE_DIR/$n.new"
        mv -f "$ENGINE_DIR/$n.new" "$ENGINE_DIR/$n"
      done
      ENGINE_STATUS=installed; ENGINE_NOTE="Rust engines installed in $ENGINE_DIR"
      ok "$ENGINE_NOTE"
    else
      ENGINE_NOTE="checksum verification of the engine binaries failed"
    fi
  fi
  rm -rf "$tmp"
  [ "$ENGINE_STATUS" = pending ] || return 0
  if engines_present; then
    ENGINE_STATUS=stale
    warn "$ENGINE_NOTE: keeping the Rust engines from a previous install, which may be stale"
  else
    ENGINE_STATUS=none
    warn "$ENGINE_NOTE: no Rust engines installed, falling back to the Bun engines for now"
  fi
}

# engines_healthy <seconds>: the edge pool route (loopback Host) and the egress both
# answer HTTP within the time. Any HTTP status counts for the egress.
engines_healthy() {
  local deadline=$((SECONDS + $1))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -s -o /dev/null -m 2 -H 'Host: 127.0.0.1' "http://$(url_host "$SB_BIND_HOST"):8080/__sb/pool" \
      && curl -s -o /dev/null -m 2 http://127.0.0.1:8070/; then return 0; fi
    sleep 1
  done
  return 1
}

say "Installing the Rust engines (edge, egress)"
install_engines || true
# engine.env: SB_EDGE / SB_EGRESS = rust|bun. A fresh install defaults to rust; an
# existing file is kept (an operator who chose bun stays on bun); SB_EDGE / SB_EGRESS in
# the environment override. With no Rust binaries at all, fall back to bun.
ENGINE_EDGE=${SB_EDGE:-$(val_env "$ETC/engine.env" SB_EDGE)}; ENGINE_EDGE=${ENGINE_EDGE:-rust}
ENGINE_EGRESS=${SB_EGRESS:-$(val_env "$ETC/engine.env" SB_EGRESS)}; ENGINE_EGRESS=${ENGINE_EGRESS:-rust}
case "$ENGINE_EDGE" in rust|bun) ;; *) die "SB_EDGE must be rust or bun" ;; esac
case "$ENGINE_EGRESS" in rust|bun) ;; *) die "SB_EGRESS must be rust or bun" ;; esac
if [ "$ENGINE_STATUS" = none ]; then ENGINE_EDGE=bun; ENGINE_EGRESS=bun; fi
printf 'SB_EDGE=%s\nSB_EGRESS=%s\n' "$ENGINE_EDGE" "$ENGINE_EGRESS" > "$ETC/engine.env"
chown root:root "$ETC/engine.env"; chmod 0644 "$ETC/engine.env"
note "engines: edge=$ENGINE_EDGE egress=$ENGINE_EGRESS"

# --- Caddy ----------------------------------------------------------
# Stock Caddy is enough: per-hostname certs via HTTP-01 / TLS-ALPN-01, no DNS
# API. The stock build is pinned and checksum-verified. Only if SB_CF_TOKEN is
# set (DNS-01, for hosts where inbound :80 is blocked) do we use the
# caddyserver.com build API for the Cloudflare DNS module; it builds on demand,
# so it cannot be pinned by checksum.
CADDY_HAVE=
[ -x "$CADDY_BIN" ] && CADDY_HAVE=$("$CADDY_BIN" version 2>/dev/null | head -1 || true)
CADDY_REPLACED=0
if [ "$SB_PROXY" = external ]; then
  say "Caddy: skipped (SB_PROXY=external)"
  if [ -x "$CADDY_BIN" ] || [ -f /etc/caddy/Caddyfile ]; then
    note "a Caddy from an earlier install is left alone; this installer no longer manages or restarts it"
  fi
elif [ -n "${SB_CF_TOKEN:-}" ]; then
  if [ ! -x "$CADDY_BIN" ] || ! "$CADDY_BIN" list-modules 2>/dev/null | grep -q dns.providers.cloudflare; then
    say "Downloading Caddy + caddy-dns/cloudflare"
    warn "This Caddy build is not checksum-verified (the caddyserver.com build API builds on demand and is not pinned to v$CADDY_VERSION)."
    curl -fsSL --retry 3 "https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/caddy-dns/cloudflare" -o "$CADDY_BIN.new"
    chmod 0755 "$CADDY_BIN.new"
    mv -f "$CADDY_BIN.new" "$CADDY_BIN"
    CADDY_REPLACED=1
  fi
  "$CADDY_BIN" list-modules 2>/dev/null | grep -q dns.providers.cloudflare || die "Caddy build lacks the cloudflare DNS module"
elif [ -x "$CADDY_BIN" ] && "$CADDY_BIN" list-modules 2>/dev/null | grep -q dns.providers.cloudflare; then
  # An earlier install used the Cloudflare build; without SB_CF_TOKEN in this run, do not swap it for stock.
  warn "Keeping the existing Caddy with the Cloudflare DNS module (not checksum-verified); set SB_CF_TOKEN to manage it."
else
  case "$CADDY_HAVE" in
    "v$CADDY_VERSION"*) ;;
    *)
      if [ -n "$CADDY_HAVE" ]; then say "Upgrading Caddy ${CADDY_HAVE%% *} -> v$CADDY_VERSION"; else say "Installing Caddy v$CADDY_VERSION"; fi
      caddy_tmp=$(mktemp -d)
      fetch_verified "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" "$caddy_tmp/caddy.tgz" "$CADDY_SHA512_AMD64" sha512
      tar -xzf "$caddy_tmp/caddy.tgz" -C "$caddy_tmp" caddy
      install -m 0755 "$caddy_tmp/caddy" "$CADDY_BIN.new"
      mv -f "$CADDY_BIN.new" "$CADDY_BIN"
      rm -rf "$caddy_tmp"
      CADDY_REPLACED=1
      ok "Caddy $("$CADDY_BIN" version | head -1)"
      ;;
  esac
fi

say "Installing application dependencies"
# The runtime CLI is a moving git ref (sproutboat-cli#main); a frozen lockfile
# would keep an explicit recovery pull pinned to whatever commit bun.lock last
# recorded. Normal staged updates use the release's frozen lockfile.
if [ "${SB_PULL:-0}" = "1" ]; then
  ( cd "$ROOT" && capped "$BUN" update --silent sproutboat ) && ok "runtime CLI re-resolved"
fi
( cd "$ROOT" && capped "$BUN" install --frozen-lockfile --silent ) && ok "dependencies ready"
# bun install and the dashboard build inherit the caller's umask (the updater
# runs with a restrictive one to keep its staging tree private). The service
# users must be able to read and traverse both, regardless of how we were run.
[ -d "$ROOT/node_modules" ] && chmod -R a+rX "$ROOT/node_modules"

say "Building the dashboard"
( cd "$ROOT" && capped "$BUN" run --silent web:build >/dev/null ) && ok "dashboard built -> $ROOT/apps/web/dist"
[ -d "$ROOT/apps/web/dist" ] && chmod -R a+rX "$ROOT/apps/web/dist"

# Backups are encrypted at rest with this key (AES-256-GCM, no KDF: it is
# already random). Created once and kept across updates; the backup user reads
# it through the sproutboat group. Without a copy off the box, every backup is
# unreadable after losing the disk.
BACKUP_KEY_FILE=$ETC/backup.key
if [ ! -s "$BACKUP_KEY_FILE" ]; then
  ( umask 077; randhex > "$BACKUP_KEY_FILE" )
  BACKUP_KEY_IS_NEW=1
else
  BACKUP_KEY_IS_NEW=0
fi
chown root:sproutboat "$BACKUP_KEY_FILE"; chmod 0640 "$BACKUP_KEY_FILE"

# --- write env BEFORE starting services -----------------------------
say "Writing $ETC/{install,sproutboat,control,egress}.env"
# Installer-owned files are rewritten below; the operator's settings live in the
# matching *.local.env, which nothing here rewrites. Move anything an operator put in an
# installer-owned file into its local file first, with a backup copy of the old file.
# (install.env, engine.env and update.env have no local file: they hold only the keys
# listed in their own sections, and each of those is read back before it is rewritten.)
umask 077
operator_env sproutboat root:sproutboat 0640 "Settings shared by the control service and the edge." \
  SPROUTBOAT_DEPLOYMENT_DOMAIN SPROUTBOAT_DASHBOARD_URL SPROUTBOAT_DASHBOARD_DIR
operator_env control root:sproutboat 0640 "Limits, backups (SPROUTBOAT_BACKUP_S3_*, SPROUTBOAT_BACKUP_ENCRYPT), events, ...: see infra/README.md." \
  SPROUTBOAT_DATABASE_PATH SPROUTBOAT_ARTIFACTS_DIR SPROUTBOAT_DEPLOYMENTS_PATH \
  SPROUTBOAT_BOOTSTRAP_USERNAME SPROUTBOAT_BOOTSTRAP_TOKEN SPROUTBOAT_ADMIN_EMAILS \
  BETTER_AUTH_SECRET BETTER_AUTH_URL SPROUTBOAT_BACKUP_KEY_FILE GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET
operator_env egress root:root 0600 "Example: SB_EGRESS_ALLOW=10.0.0.5 lets sprouts reach that private address. The egress service, control and the edge all read it." \
  SB_EGRESS_TOKEN
if [ "$SB_PROXY" = caddy ]; then
  operator_env caddy root:root 0640 "Environment for Caddy, for example XDG_DATA_HOME to keep its data (certificates) elsewhere." \
    ACME_EMAIL CLOUDFLARE_API_TOKEN
fi
umask 022
# install.env holds the mode choices (no secrets) so `sbctl update` keeps them.
{
  echo "# Written by install.sh; kept across updates. Environment variables override it on a re-run."
  echo "# No secrets here. See docs/homelab.md."
  echo "SB_MODE=$SB_MODE"
  echo "SB_PROXY=$SB_PROXY"
  echo "SB_FIREWALL=$SB_FIREWALL"
  echo "SB_SSH_PORT=$SB_SSH_PORT"
  echo "SB_SCHEME=$SB_SCHEME"
  echo "SB_BIND_HOST=$SB_BIND_HOST"
  echo "SB_BIND_ALLOW=$SB_BIND_ALLOW"
  echo "SB_ACME_STAGING=$SB_ACME_STAGING"
} > "$INSTALL_ENV"
chown root:root "$INSTALL_ENV"; chmod 0644 "$INSTALL_ENV"
umask 077
{
  echo "# Generated by install.sh and rewritten on every install and update. Put your own settings in sproutboat.local.env."
  echo "SPROUTBOAT_DEPLOYMENT_DOMAIN=$SB_DOMAIN"
  echo "SPROUTBOAT_DASHBOARD_URL=$DASH_URL"
  # No Caddy to serve the dashboard files: control serves the built SPA itself.
  [ "$SB_PROXY" != external ] || echo "SPROUTBOAT_DASHBOARD_DIR=$ROOT/apps/web/dist/client"
} > "$ETC/sproutboat.env"
chown root:sproutboat "$ETC/sproutboat.env"; chmod 0640 "$ETC/sproutboat.env"
{
  echo "# Generated by install.sh and rewritten on every install and update. Put your own settings in control.local.env."
  echo "SPROUTBOAT_DATABASE_PATH=$STATE/sproutboat.sqlite"
  echo "SPROUTBOAT_ARTIFACTS_DIR=$STATE/artifacts"
  echo "SPROUTBOAT_DEPLOYMENTS_PATH=$STATE/deployments.json"
  echo "SPROUTBOAT_BOOTSTRAP_USERNAME=$SB_ADMIN"
  echo "SPROUTBOAT_BOOTSTRAP_TOKEN=$ADMIN_TOKEN"
  echo "SPROUTBOAT_ADMIN_EMAILS=$SB_ACME_EMAIL"
  echo "BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET"
  echo "BETTER_AUTH_URL=$DASH_URL"
  echo "SPROUTBOAT_BACKUP_KEY_FILE=$BACKUP_KEY_FILE"
  if [ -n "$SB_GITHUB_CLIENT_ID" ] && [ -n "$SB_GITHUB_CLIENT_SECRET" ]; then
    echo "GITHUB_CLIENT_ID=$SB_GITHUB_CLIENT_ID"
    echo "GITHUB_CLIENT_SECRET=$SB_GITHUB_CLIENT_SECRET"
  fi
} > "$ETC/control.env"
chown root:sproutboat "$ETC/control.env"; chmod 0640 "$ETC/control.env"

# #252 — the token brokers present to sproutboat-egress. Kept across upgrades,
# like the other secrets. An operator's SB_EGRESS_ALLOW lives in egress.local.env
# (moved there above if it was found in this file). Only systemd reads this file,
# so root-only.
EGRESS_TOKEN=$(val_env "$ETC/egress.env" SB_EGRESS_TOKEN); EGRESS_TOKEN=${EGRESS_TOKEN:-$(randhex)}
{
  echo "# Generated by install.sh and rewritten on every install and update. Put your own settings in egress.local.env."
  echo "SB_EGRESS_TOKEN=$EGRESS_TOKEN"
} > "$ETC/egress.env"
chmod 0600 "$ETC/egress.env"

if [ "$SB_PROXY" = caddy ]; then
{
  echo "# Generated by install.sh and rewritten on every install and update. Put your own settings in caddy.local.env."
  echo "ACME_EMAIL=$SB_ACME_EMAIL"
  [ -n "${SB_CF_TOKEN:-}" ] && echo "CLOUDFLARE_API_TOKEN=$SB_CF_TOKEN"
} > "$ETC/caddy.env"
chmod 0640 "$ETC/caddy.env"
fi
umask 022

if [ "$SB_PROXY" = caddy ]; then
say "Generating /etc/caddy/Caddyfile for $SB_DOMAIN"
install -d /etc/caddy
acme_line=""
[ -n "${SB_CF_TOKEN:-}" ] && acme_line=$'\n\tacme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}'
# SB_ACME_STAGING=1 -> Let's Encrypt staging (untrusted certs, no rate limit) for
# a first shakeout; kept in install.env. Re-run with SB_ACME_STAGING=0 to switch to prod.
[ "$SB_ACME_STAGING" = 1 ] && acme_line="$acme_line"$'\n\tacme_ca https://acme-staging-v02.api.letsencrypt.org/directory'
{
  cat <<EOF
{
	email {\$ACME_EMAIL}$acme_line
	on_demand_tls {
		ask http://127.0.0.1:8787/internal/tls/allow
	}
}

# Control API (CLI + dashboard /api). Cert via HTTP-01 (or DNS-01 if configured).
control.$SB_DOMAIN {
	reverse_proxy 127.0.0.1:8787
}
EOF
  cat <<EOF

dashboard.$SB_DOMAIN {
	handle /api/* {
		reverse_proxy 127.0.0.1:8787
	}
	handle {
		root * $ROOT/apps/web/dist/client
		try_files {path} /_shell.html
		file_server
	}
}
EOF
  cat <<'EOF'

# Every <project>.<user>.<domain> deployment. Cert issued on demand,
# only for a hostname control confirms is an active route.
https:// {
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:8080
}
EOF
  cat <<'EOF'

# Operator additions (kept across updates). See /etc/sproutboat/caddy.d/README.caddy
import /etc/sproutboat/caddy.d/*.caddy
EOF
} > /etc/caddy/Caddyfile.new

# Operator drop-ins: complete site blocks that survive `sbctl update`. The
# README.caddy below always matches the import glob. (Caddy only logs a warning
# for an import glob with no matches, it does not fail; the file is kept anyway.)
install -d -m 0755 /etc/sproutboat/caddy.d
[ -f /etc/sproutboat/caddy.d/README.caddy ] || cat > /etc/sproutboat/caddy.d/README.caddy <<'EOF'
# Operator Caddy drop-ins.
#
# Files matching *.caddy in this directory are imported at the end of the
# generated /etc/caddy/Caddyfile. They survive "sbctl update", which rewrites
# the Caddyfile itself.
#
# Each file must hold complete site blocks (for example "www.example.com { ... }"),
# not global options: the global block lives in the generated Caddyfile.
#
# Before a reload, the installer runs "caddy validate" on the whole config, so a
# broken file here stops the update (the live Caddyfile is left untouched).
# Check a change by hand with:
#   caddy-sproutboat validate --config /etc/caddy/Caddyfile --adapter caddyfile
# then "sudo systemctl reload caddy".
#
# Example: infra/caddy/caddy.d/www-redirect.caddy.example in the repository.
EOF

# Validate the candidate before it replaces the live file, so a bad drop-in
# cannot leave a broken Caddyfile for the next Caddy restart. The env mirrors
# caddy.env, which the Caddyfile placeholders read.
if ! caddy_err=$(ACME_EMAIL="$SB_ACME_EMAIL" CLOUDFLARE_API_TOKEN="${SB_CF_TOKEN:-}" "$CADDY_BIN" validate --config /etc/caddy/Caddyfile.new --adapter caddyfile 2>&1 >/dev/null); then
  rm -f /etc/caddy/Caddyfile.new
  printf '%s\n' "$caddy_err" >&2
  die "Caddy config failed validation (the live /etc/caddy/Caddyfile is unchanged). A file in /etc/sproutboat/caddy.d is probably at fault; fix or remove it and re-run."
fi
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
fi

for f in routes.json deployments.json; do
  [ -s "$STATE/$f" ] || { printf '[]\n' > "$STATE/$f"; chown sproutboat-control:sproutboat "$STATE/$f"; chmod 0640 "$STATE/$f"; }
done

# --- DNS: guide the one record, then wait for it to resolve here --------
PUBLIC_IP=
[ "$SB_MODE" = homelab ] || PUBLIC_IP=$(curl -fsS4 -m 5 https://api.ipify.org 2>/dev/null || true)
if [ "$SB_MODE" = homelab ]; then
  # Never look up a public address and never wait: the box is not necessarily public.
  say "Add ONE DNS record"
  rule
  note "Name   *.$SB_DOMAIN     (a wildcard)"
  note "Value  this box's LAN or tailnet address (or the address of your proxy)"
  rule
  note "Covers control.$SB_DOMAIN, dashboard.$SB_DOMAIN, and every"
  note "<project>.$SB_ADMIN.$SB_DOMAIN deployment. Local DNS (Pi-hole, dnsmasq) or split DNS is fine."
else
if [ "$SB_PROXY" = caddy ]; then say "Add ONE DNS record, then Caddy can issue TLS certificates"
else say "Add ONE DNS record"; fi
rule
note "Type   A"
note "Name   *.$SB_DOMAIN     (a wildcard — the name is literally  *  )"
note "Value  ${PUBLIC_IP:-<the public IPv4 of this box>}"
note "Proxy  OFF / DNS only / grey cloud"
rule
note "Covers control.$SB_DOMAIN, dashboard.$SB_DOMAIN, and every"
note "<project>.$SB_ADMIN.$SB_DOMAIN deployment. No DNS API token needed."
if [ "$SKIP_SERVICES" = 1 ] || [ "${SB_SKIP_DNS_CHECK:-0}" = 1 ] || [ -z "$PUBLIC_IP" ] || [ -z "$PROMPT_TTY" ]; then
  warn "Not waiting for DNS — the record must exist before the first HTTPS request."
else
  probe="sbdns-$RANDOM.$SB_DOMAIN"
  say "Waiting up to 5 min for *.$SB_DOMAIN -> $PUBLIC_IP"
  note "press any key to skip — you can add the record later, certs just wait for it"
  for _ in $(seq 1 60); do
    got=$(getent ahostsv4 "$probe" 2>/dev/null | awk 'NR==1{print $1}' || true)
    [ "$got" = "$PUBLIC_IP" ] && { ok "DNS is live"; break; }
    if read -r -t 5 -n 1 -s _k < "$PROMPT_TTY"; then warn "skipped the DNS wait"; break; fi
  done
fi
fi

# --- systemd -------------------------------------------------------
say "Installing systemd units"
if [ "$SB_PROXY" = caddy ]; then
install -d -m 0755 /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/sproutboat.conf <<EOF
[Service]
EnvironmentFile=$ETC/caddy.env
EnvironmentFile=-$ETC/caddy.local.env
ExecStart=
ExecStart=$CADDY_BIN run --environ --config /etc/caddy/Caddyfile
ExecReload=
ExecReload=$CADDY_BIN reload --config /etc/caddy/Caddyfile --force
MemoryMax=256M
MemoryHigh=224M
EOF
[ -f /lib/systemd/system/caddy.service ] || [ -f /etc/systemd/system/caddy.service ] || cat > /etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy
After=network-online.target
[Service]
Type=notify
ExecStart=$CADDY_BIN run --environ --config /etc/caddy/Caddyfile
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
fi
EDGE_MAX_MIB=$(edge_memory_max_mib)
EDGE_HIGH_MIB=$(( EDGE_MAX_MIB * 85 / 100 ))
install -d -m 0755 /etc/systemd/system/sproutboat-edge.service.d
cat > /etc/systemd/system/sproutboat-edge.service.d/10-sproutboat-memory.conf <<EOF
# Generated by install.sh and rewritten on every install and update; do not edit.
# The edge cap is half of RAM (see "Memory budget" in infra/README.md). To
# override it, add a drop-in that sorts later (for example 50-local.conf), or run
# the installer with SB_EDGE_MEMORY_MAX=<MiB> set on each update.
[Service]
MemoryMax=${EDGE_MAX_MIB}M
MemoryHigh=${EDGE_HIGH_MIB}M
EOF
ok "edge memory cap ${EDGE_MAX_MIB}M (high ${EDGE_HIGH_MIB}M)"
# Where control and the edge listen (homelab mode may widen it). Rewritten every time;
# a loopback bind removes the drop-in and the unit's own 127.0.0.1 applies.
for u in control edge; do
  bind_d=/etc/systemd/system/sproutboat-$u.service.d
  bind_text=$(bind_dropins "$u" "$SB_BIND_HOST" "$SB_BIND_ALLOW")
  if [ -n "$bind_text" ]; then
    install -d -m 0755 "$bind_d"
    printf '%s\n' "$bind_text" > "$bind_d/20-sproutboat-bind.conf"
  else
    rm -f "$bind_d/20-sproutboat-bind.conf"
  fi
done
if [ "$SB_BIND_HOST" != 127.0.0.1 ]; then
  warn "control and the edge listen on $SB_BIND_HOST (SB_BIND_HOST). The edge may now reach $SB_BIND_ALLOW, and so can every sprout. See docs/homelab.md."
fi
for u in sproutboat-control sproutboat-edge sproutboat-egress; do
  install -m 0644 "$ROOT/infra/systemd/$u.service" "/etc/systemd/system/$u.service"
done
install -m 0644 "$ROOT/infra/systemd/sproutboat-backup.service" /etc/systemd/system/sproutboat-backup.service
install -m 0644 "$ROOT/infra/systemd/sproutboat-backup.timer"   /etc/systemd/system/sproutboat-backup.timer
install -m 0755 "$ROOT/infra/sbctl" /usr/local/bin/sbctl

# --- log rotation + journald cap (idempotent) -----------------------------
install -d -m 0755 /etc/logrotate.d
install -m 0644 "$ROOT/infra/logrotate/sproutboat" /etc/logrotate.d/sproutboat
install -d -m 0755 /etc/systemd/journald.conf.d
JOURNALD_CHANGED=0
cmp -s "$ROOT/infra/journald/sproutboat.conf" /etc/systemd/journald.conf.d/sproutboat.conf || JOURNALD_CHANGED=1
install -m 0644 "$ROOT/infra/journald/sproutboat.conf" /etc/systemd/journald.conf.d/sproutboat.conf
install -d -m 0755 -o root -g root /usr/local/lib/sproutboat
install -m 0755 "$ROOT/infra/sb-update" /usr/local/lib/sproutboat/update
install -m 0755 "$ROOT/infra/sb-backup-stage" /usr/local/lib/sproutboat/backup-stage
install -m 0755 "$ROOT/infra/sb-engine" /usr/local/lib/sproutboat/engine
# Bun-fallback drop-ins (or none, for rust) before systemd re-reads the units.
SB_ENGINE_NO_RELOAD=1 /usr/local/lib/sproutboat/engine apply
install -m 0755 "$ROOT/infra/sb-health" /usr/local/lib/sproutboat/health
install -m 0755 "$ROOT/infra/sb-rollback" /usr/local/lib/sproutboat/rollback

# --- Better Auth schema (dashboard + admin token login) ---------------
say "Migrating the auth database"
( cd "$ROOT" && SPROUTBOAT_DATABASE_PATH="$STATE/sproutboat.sqlite" \
    BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" BETTER_AUTH_URL="$DASH_URL" \
    capped "$BUN" x --bun auth@1.7.1 migrate --config apps/control/src/auth.migrate.ts --yes >/dev/null ) && ok "auth schema up to date"
chown sproutboat-control:sproutboat "$STATE"/sproutboat.sqlite* 2>/dev/null || true

# --- move binding data out of logs/ (idempotent) ------------------
# Older installs derived broker state from the log path, so KV / R2 / D1 / queue
# data lived under $STATE/logs/. The units now name $STATE/brokers and
# $STATE/resources. Move before anything starts: a running broker holds the
# SQLite files open.
for _d in brokers resources; do
  if [ -d "$STATE/logs/$_d" ] && [ ! -e "$STATE/$_d" ]; then
    say "Moving $_d out of logs/ (binding data)"
    systemctl stop sproutboat-edge >/dev/null 2>&1 || true
    mv "$STATE/logs/$_d" "$STATE/$_d"
    ok "$STATE/$_d"
  fi
done

if [ "$SKIP_SERVICES" = 1 ]; then
  say "Services — skipped (SB_SKIP_SERVICES)"
else
  systemctl daemon-reload
  # logrotate.timer ships on Debian, Ubuntu and Fedora; hosts with the cron job
  # already rotate daily.
  systemctl enable --now logrotate.timer 2>/dev/null || true
  # journald only re-reads its drop-ins on restart; do it once, when ours changed.
  [ "$JOURNALD_CHANGED" = 1 ] && { systemctl restart systemd-journald || warn "could not restart systemd-journald"; }

  # --- start (control first — its env now exists) ----------------
  # `enable --now` starts an inactive unit but deliberately leaves an active
  # one alone. An upgrade has just replaced the source beneath active Bun
  # processes, so explicitly restart them or they keep running the old code.
  say "Starting services"
  units=(sproutboat-control sproutboat-egress sproutboat-edge)
  [ "$SB_PROXY" != caddy ] || units+=(caddy)
  units+=(sproutboat-backup.timer)
  systemctl enable "${units[@]}" >/dev/null 2>&1
  systemctl restart sproutboat-control sproutboat-egress sproutboat-edge
  # A replaced binary needs a real restart; a reload keeps running the old one.
  if [ "$SB_PROXY" = caddy ]; then
    if [ "$CADDY_REPLACED" = 1 ]; then systemctl restart caddy; else systemctl reload-or-restart caddy; fi
  fi
  systemctl start sproutboat-backup.timer
  if [ "$SAFE_UPDATE" = 1 ]; then
    # The gate replaces the per-unit lines: it checks the units and the HTTP
    # endpoints, and a failure rolls the update back (see rollback_armed).
    say "Health gate (up to ${SB_HEALTH_TIMEOUT:-45} s)"
    health_gate || die "the health gate failed after the restart"
    ok "healthy"
  else
    for u in "${units[@]}"; do
      systemctl is-active --quiet "$u" && ok "$u" || warn "$u is not active; check: journalctl -u $u"
    done
  fi

  # --- engine health probe (fresh installs only) --------------------
  # An update has its own health gate and rollback. On a fresh install, if the Rust
  # engines do not answer within 20 s, switch both to Bun and carry on.
  if [ "${SB_UPDATE:-0}" != 1 ] && { [ "$ENGINE_EDGE" = rust ] || [ "$ENGINE_EGRESS" = rust ]; }; then
    say "Checking the Rust engines"
    if engines_healthy 20; then
      ok "edge answers on $(url_host "$SB_BIND_HOST"):8080, egress on 127.0.0.1:8070"
    else
      warn "THE RUST ENGINES DID NOT ANSWER within 20 s: switching edge and egress to the Bun engines"
      warn "see: journalctl -u sproutboat-edge -u sproutboat-egress; retry later with 'sudo sbctl engine rust'"
      /usr/local/lib/sproutboat/engine set both bun
      ENGINE_EDGE=bun; ENGINE_EGRESS=bun
      systemctl restart sproutboat-egress sproutboat-edge
      if engines_healthy 20; then ok "Bun engines are answering"; else warn "the Bun engines did not answer either: check journalctl -u sproutboat-edge"; fi
    fi
  fi

  # --- verify ---------------------------------------------------
  say "Runtime preflight"
  ( cd "$ROOT" && "$BUN" run --silent runtime:preflight --quiet ) \
    && ok "sandbox ready" \
    || warn "preflight reported problems — run 'sudo sbctl preflight' for detail; deployments need bubblewrap working"

  # A fresh install must not report success with a unit down (after any engine
  # fallback above). Give a unit that is still restarting a few seconds.
  if [ "$SAFE_UPDATE" != 1 ]; then
    for u in "${units[@]}"; do
      for _ in 1 2 3 4 5 6 7 8 9 10; do systemctl is-active --quiet "$u" && break; sleep 1; done
      systemctl is-active --quiet "$u" || die "$u is not active after the install; check: journalctl -u $u"
    done
  fi
fi

# Snapshot /etc/sproutboat and Caddy's data for the backups. The nightly unit
# refreshes it itself; this covers dashboard-triggered backups until then.
# Best-effort: a staging problem must not fail an install or update.
if [ "$SKIP_SERVICES" != 1 ]; then
  /usr/local/lib/sproutboat/backup-stage || warn "could not stage config for backups; check: /usr/local/lib/sproutboat/backup-stage"
fi

# Keep the token retrievable — the SSH scrollback is not a safe home for it.
printf 'SPROUTBOAT_API_URL=%s\nSPROUTBOAT_TOKEN=%s\n' "$CONTROL_URL" "$ADMIN_TOKEN" > /root/sproutboat-admin.env
chmod 0600 /root/sproutboat-admin.env
UPDATE_COMMIT=${SB_UPDATE_COMMIT:-$(git -C "$SRC" rev-parse HEAD 2>/dev/null || true)}
UPDATE_COMMIT=${UPDATE_COMMIT:-unknown}
{
  printf 'SPROUTBOAT_UPDATE_REPO=%s\n' "$SB_REPO"
  printf 'SPROUTBOAT_UPDATE_REF=%s\n' "$SB_REF_PINNED"
  printf 'SPROUTBOAT_UPDATE_COMMIT=%s\n' "$UPDATE_COMMIT"
} > "$ETC/update.env"
chown root:root "$ETC/update.env"; chmod 0600 "$ETC/update.env"

# Everything that can fail an update has passed: disarm the rollback.
trap - EXIT HUP INT TERM

printf '\n%s▸ Sproutboat is up%s\n' "$C_OK" "$C_0"
rule
if [ "$TOKEN_IS_NEW" = 1 ]; then
  note "admin credentials (saved to /root/sproutboat-admin.env)"
else
  note "admin credentials unchanged; token remains in /root/sproutboat-admin.env"
fi
printf '    SPROUTBOAT_API_URL  %s%s%s\n' "$C_HEAD" "$CONTROL_URL" "$C_0"
[ "$TOKEN_IS_NEW" = 1 ] && printf '    SPROUTBOAT_TOKEN    %s%s%s\n' "$C_HEAD" "$ADMIN_TOKEN" "$C_0"
rule

if [ "$SB_PROXY" = external ]; then
  up_host=$(url_host "$SB_BIND_HOST")
  case "$SB_BIND_HOST" in 0.0.0.0|::) up_host="<this box's address>" ;; esac
  say "Point your reverse proxy here (mode $SB_MODE, proxy external)"
  rule
  note "control.$SB_DOMAIN       -> http://$up_host:8787"
  note "dashboard.$SB_DOMAIN     -> http://$up_host:8787   (control serves the dashboard too)"
  note "*.$SB_ADMIN.$SB_DOMAIN   -> http://$up_host:8080   (the edge; add each custom domain here too)"
  rule
  note "The proxy must forward the Host header unchanged (the edge routes on it) and"
  note "should set X-Forwarded-Proto. Recipes for nginx, Traefik, Caddy, LAN and Tailscale: docs/homelab.md"
  if [ "$SB_BIND_HOST" != 127.0.0.1 ]; then
    warn "SB_BIND_HOST=$SB_BIND_HOST: the edge and every sprout can reach $SB_BIND_ALLOW. A loopback bind plus a proxy on this box avoids that."
  fi
fi

say "Dashboard  $DASH_URL"
note "sign in with email $SB_ACME_EMAIL and the admin token as the password"
if [ -n "$SB_GITHUB_CLIENT_ID" ] && [ -n "$SB_GITHUB_CLIENT_SECRET" ]; then
  note "GitHub sign-in enabled — OAuth callback: $DASH_URL/api/auth/callback/github"
fi

say "Deploy from your workstation"
note "npx sproutboat login --api-url $CONTROL_URL --token <token>"
note "sproutboat init hello && cd hello && sproutboat deploy"

if [ -n "$PRE_UPDATE_BACKUP" ]; then
  say "This update"
  note "pre-update backup: $PRE_UPDATE_BACKUP (the fallback for data: sbctl restore <archive> --force)"
fi
if [ "$SAFE_UPDATE" = 1 ]; then
  note "previous release kept in $PREV_RELEASE; undo this update with: sudo sbctl rollback"
fi

say "Operate  (sudo sbctl <cmd>)"
note "sbctl status            health of every unit"
if [ "$SB_PROXY" = caddy ]; then note "sbctl logs [control|edge|caddy]   follow logs"; else note "sbctl logs [control|edge]   follow logs"; fi
note "sbctl mode              show the install mode (install.env)"
note "sbctl down / sbctl up   pause / resume everything"
note "sbctl engine [rust|bun] show or switch the edge and egress engines (now: edge=$ENGINE_EDGE egress=$ENGINE_EGRESS)"
note "sbctl update [--check]  stage a fresh release, then run its installer (--check: show what would change)"
note "sbctl health / rollback check the host / return to the previous release"
note "sbctl uninstall         remove everything (--keep-state to keep the db)"

say "Backups"
note "daily to $STATE/backups (last 7 kept, encrypted); manage under Admin -> Backups"
warn "copy $BACKUP_KEY_FILE off this box now (password manager or secret store): without it every backup is unreadable"
if [ "$BACKUP_KEY_IS_NEW" = 1 ]; then note "backup key created: $BACKUP_KEY_FILE"; fi
warn "take a provider snapshot now, and copy backups off-box"
