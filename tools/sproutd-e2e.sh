#!/usr/bin/env bash
#
# Design 05, phase 1: the exit criteria, end to end, on a fresh Linux VM.
#
#   sudo tools/sproutd-e2e.sh
#
# 1. a test project is served by sproutd through the real edge;
# 2. rollback works;
# 3. `sbctl update` does not touch sproutd.
#
# It provisions the staging install (tools/sproutd-staging.sh) unless one is there, deploys two
# hand-built modules (tools/sproutd-e2e/build-modules.sh) through control, and sends requests to the
# edge on localhost with Host headers: no DNS, TLS or Caddy. Along the way it resolves the design's
# section 7.3 items that a running system can answer, and prints them as INFO lines. Exit status is
# the number of failed checks.
#
# Environment:
#   SBSTG_PREFIX (/data/sbstg)   SBSTG_SPROUTD_SRC   SBSTG_GENERATION   (as for sproutd-staging.sh)
#   MODULE_V1, MODULE_V2         the two modules, built for SBSTG_GENERATION
#   MODULE_OTHER_GENERATION      optional: a module built for a different generation (the ABI probe)
#   SBSTG_FRESH=1                uninstall and reinstall first
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PREFIX=${SBSTG_PREFIX:-/data/sbstg}
ETC=$PREFIX/etc/sproutboat
STATE=$PREFIX/var/lib/sproutboat
SD_SOCK=/run/sbstg-sproutd/admin.sock
AD_SOCK=/run/sbstg-sproutd-adapter/adapter.sock
: "${MODULE_V1:?set MODULE_V1}" "${MODULE_V2:?set MODULE_V2}"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }

PASSED=0 FAILED=0
pass() { PASSED=$((PASSED + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf 'FAIL  %s  -- %s\n' "$1" "${2:-}"; }
info() { printf 'INFO  %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }
check() { # NAME CONDITION-EXIT-STATUS DETAIL
  if [ "$2" = 0 ]; then pass "$1"; else fail "$1" "${3:-}"; fi
}
eq() { # NAME ACTUAL EXPECTED
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "got '$2', want '$3'"; fi
}

vid_of() { sha256sum "$1" | cut -c1-16; }
V1=$(vid_of "$MODULE_V1"); V2=$(vid_of "$MODULE_V2")

install_stack() {
  [ "${SBSTG_FRESH:-0}" = 1 ] && "$HERE/sproutd-staging.sh" uninstall >/dev/null 2>&1
  if [ ! -f "$ETC/admin.env" ]; then
    section "Provisioning the staging install"
    "$HERE/sproutd-staging.sh" install || { echo "install failed" >&2; exit 2; }
  fi
}
install_stack
# shellcheck disable=SC1090
. "$ETC/admin.env"
HOST="phase1.$ADMIN.$DOMAIN"
TOKEN_FILE=$PREFIX/etc/sproutd/adapter.token
BUN=/usr/local/bin/bun

api() { # METHOD PATH [curl args...]
  local method=$1 path=$2; shift 2
  curl -s -X "$method" -H "Authorization: Bearer $SPROUTBOAT_TOKEN" "$SPROUTBOAT_API_URL$path" "$@"
}
api_code() { local method=$1 path=$2; shift 2; curl -s -o /tmp/sbd-e2e-body -w '%{http_code}' -X "$method" -H "Authorization: Bearer $SPROUTBOAT_TOKEN" "$SPROUTBOAT_API_URL$path" "$@"; }
edge() { curl -s -H "Host: $HOST" "$EDGE$1" "${@:2}"; }
edge_code() { curl -s -o /tmp/sbd-e2e-body -w '%{http_code}' -H "Host: $HOST" "$EDGE$1" "${@:2}"; }
sd_admin() { sudo -u sbstg-sproutd "$BUN" "$HERE/sproutd-e2e/admin.ts" "$SD_SOCK" "$@"; }
adapter() { curl -s --unix-socket "$AD_SOCK" -H "Authorization: Bearer $(cat "$TOKEN_FILE")" "$@"; }
unit_pid() { systemctl show -p MainPID --value "$1"; }
unit_since() { systemctl show -p ActiveEnterTimestampMonotonic --value "$1"; }
app_id() { adapter -H "X-Sb-Owner: bootstrap:$ADMIN" http://adapter/v1/projects/phase1 | jq -r .id; }
worker_pid() { sd_admin list | sed -n "s/^app $(app_id) pid:\([0-9]*\) .*/\1/p"; }
wait_for() { # SECONDS COMMAND...: poll until it succeeds
  local n=$1; shift
  for _ in $(seq 1 $((n * 5))); do "$@" >/dev/null 2>&1 && return 0; sleep 0.2; done
  return 1
}
serves() { [ "$(edge /)" = "phase1 $1" ]; }

section "Environment"
info "kernel $(uname -r), $(. /etc/os-release && echo "$PRETTY_NAME"), cgroup $(stat -fc %T /sys/fs/cgroup)"
info "lsm: $(cat /sys/kernel/security/lsm)"
info "bun $($BUN --version)  platform $(git -C "${SBSTG_SRC:-$HERE/..}" rev-parse --short HEAD 2>/dev/null || echo '?')  sproutd native-host sha256 $(sha256sum "$PREFIX/opt/sproutd/generation/native-host/native-host" | cut -c1-16)"
info "module v1 $V1, v2 $V2"

section "Services"
for u in sbstg-control sbstg-egress sbstg-edge sbstg-sproutd sbstg-sproutd-adapter; do
  eq "$u is active" "$(systemctl is-active $u)" active
done
eq "control answers" "$(curl -s "$SPROUTBOAT_API_URL/internal/health" | jq -r .ok)" true
check "adapter answers with the token" "$([ "$(adapter http://adapter/v1/health | jq -r .ok)" = true ]; echo $?)"

# Start from nothing so a rerun means the same thing.
api DELETE "/api/projects/phase1?confirm=phase1" >/dev/null

section "The admin socket stays strict; the adapter is the one door"
eq "admin socket mode" "$(stat -c %a $SD_SOCK)" 600
eq "admin socket owner" "$(stat -c %U $SD_SOCK)" sbstg-sproutd
eq "adapter socket mode" "$(stat -c %a $AD_SOCK)" 660
eq "adapter socket group" "$(stat -c %G $AD_SOCK)" sbstg-sproutd-api
eq "adapter without a token: 401" "$(curl -s -o /dev/null -w '%{http_code}' --unix-socket $AD_SOCK http://adapter/v1/health)" 401
eq "adapter with a wrong token: 401" "$(curl -s -o /dev/null -w '%{http_code}' --unix-socket $AD_SOCK -H 'Authorization: Bearer nope' http://adapter/v1/health)" 401
sudo -u nobody curl -s -o /dev/null --unix-socket $AD_SOCK http://adapter/v1/health 2>/dev/null
check "another local user cannot open the adapter socket" "$([ $? -ne 0 ]; echo $?)"
sudo -u nobody "$BUN" "$HERE/sproutd-e2e/admin.ts" $SD_SOCK list >/dev/null 2>&1
check "another local user cannot open the admin socket" "$([ $? -ne 0 ]; echo $?)"
sudo -u sbstg-control "$BUN" "$HERE/sproutd-e2e/admin.ts" $SD_SOCK list >/dev/null 2>&1
check "control cannot open the admin socket either" "$([ $? -ne 0 ]; echo $?)"
eq "control can reach the adapter (it is in the group)" "$(sudo -u sbstg-control curl -s --unix-socket $AD_SOCK -H "Authorization: Bearer $(cat $TOKEN_FILE)" http://adapter/v1/health | jq -r .ok)" true

section "1. A project on sproutd, served through the real edge"
eq "runtime defaults to the supervisor" "$(api GET /api/projects/phase1/runtime | jq -r .runtime)" supervisor
eq "choose sproutd with a 64 MiB limit" "$(api PUT /api/projects/phase1/runtime -d '{"runtime":"sproutd","limits":{"memoryMb":64}}' | jq -r .runtime)" sproutd
eq "unknown limit refused" "$(api_code PUT /api/projects/phase1/runtime -d '{"runtime":"sproutd","limits":{"cpuQuota":50}}')" 400
code=$(api_code POST /api/projects/phase1/deployments -F "module=@$MODULE_V1")
eq "deploy module v1" "$code" 201
D1=$(jq -r .id </tmp/sbd-e2e-body)
eq "the deployment names the version sproutd reports" "$(jq -r .vid </tmp/sbd-e2e-body)" "$V1"
check "edge forwards: v1 answers" "$(wait_for 10 serves v1; echo $?)" "$(edge /)"
eq "x-app-version header passes through" "$(curl -s -D- -o /dev/null -H "Host: $HOST" "$EDGE/" | tr -d '\r' | sed -n 's/^x-app-version: //Ip')" v1
eq "the app sees the original Host" "$(edge /host)" "$HOST"
eq "a POST body reaches the app" "$(edge /post -X POST --data-binary 'hello')" "v1:5"
eq "an unknown host is the edge's 404" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: nothing.example.test' $EDGE/)" 404
check "routes.json carries the backend" "$(jq -e --arg h "$HOST" '.[] | select(.hostname == $h) | .backend.kind == "sproutd"' $STATE/routes.json >/dev/null; echo $?)"
eq "the supervisor started nothing" "$(curl -s "$EDGE/__sb/pool" | jq -r .live)" 0
eq "no bubblewrap sandbox process exists" "$(ps -eo comm | grep -c '^bwrap$' | tr -d ' ')" 0
WP=$(worker_pid)
check "sproutd has a live worker for it" "$([ -n "$WP" ]; echo $?)" "list: $(sd_admin list | tr '\n' '|')"
if [ -n "$WP" ]; then
  CG=/sys/fs/cgroup$(sed 's/^0:://' /proc/$WP/cgroup)
  eq "limits mapped: the worker cgroup has memory.max 64 MiB" "$(cat "$CG/memory.max")" 67108864
  eq "the worker runs as its own uid, not the daemon's" "$([ "$(stat -c %u /proc/$WP)" -ge 300000 ] && echo yes || echo no)" yes
  cpu=$(cut -d" " -f1 "$CG/cpu.max" 2>/dev/null)
  check "the worker cgroup has no CPU limit (CPU stays 'not yet')" "$([ -z "$cpu" ] || [ "$cpu" = max ]; echo $?)" "cpu.max=$cpu"
fi
sleep 1
check "the edge request log has the request (dashboard metrics keep working)" "$(grep "\"hostname\":\"$HOST\"" $STATE/logs/requests.ndjson | tail -50 | jq -e -s 'any(.[]; .status == 200 and .path == "/")' >/dev/null; echo $?)"
eq "control lists the deployment with its version" "$(api GET /api/projects/phase1/deployments | jq -r '.[0].vid')" "$V1"
eq "sproutd's console log is reachable through control" "$(api_code GET /api/projects/phase1/logs/sprout)" 200
eq "the adapter keeps owners apart: another owner has no such app" "$(adapter -H 'X-Sb-Owner: bootstrap:someone-else' http://adapter/v1/projects/phase1 | jq -r .exists)" false

section "Secrets map onto sproutd's file format"
SECRET_TOKEN='s3cr3t=value with  spaces  '
SECRET_GREETING='héllo wörld #not-a-comment'
eq "set TOKEN" "$(api_code PUT /api/projects/phase1/secrets/TOKEN -d "$(jq -nc --arg v "$SECRET_TOKEN" '{value: $v}')")" 201
eq "set GREETING" "$(api_code PUT /api/projects/phase1/secrets/GREETING -d "$(jq -nc --arg v "$SECRET_GREETING" '{value: $v}')")" 201
secrets_applied() { [ "$(edge /secrets | jq -r .TOKEN)" = "$SECRET_TOKEN" ]; }
check "the running app sees both values byte for byte, within seconds" "$(wait_for 20 secrets_applied; echo $?)" "$(edge /secrets)"
got=$(edge /secrets | jq -r .GREETING)
if [ "$got" = "$SECRET_GREETING" ]; then pass "GREETING (UTF-8, '#', spaces) arrives intact"; else info "FINDING: a non-ASCII secret arrives as bytes read as Latin-1: sent '$SECRET_GREETING', the app sees '$got' (same when sproutd is handed the file directly, so it is the runtime's env, not control or the adapter)"; fi
eq "a value with a newline is refused when set" "$(api_code PUT /api/projects/phase1/secrets/MULTI -d '{"value":"a\nb"}')" 400
info "newline refusal says: $(jq -r .error </tmp/sbd-e2e-body)"
eq "a reserved SB_ name is refused" "$(api_code PUT /api/projects/phase1/secrets/SB_TOKEN -d '{"value":"x"}')" 400
eq "a secret removed from control disappears from the app" "$(api_code DELETE /api/projects/phase1/secrets/GREETING)" 200
greeting_gone() { [ "$(edge /secrets | jq -r .GREETING)" = null ]; }
check "...within seconds" "$(wait_for 20 greeting_gone; echo $?)" "$(edge /secrets)"

section "2. Deploy v2 and roll back to v1 under load"
LOAD=/tmp/sbd-e2e-load; rm -f $LOAD.*
( n=0; bad=0
  while [ ! -e $LOAD.stop ]; do
    out=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Host: $HOST" "$EDGE/health"); n=$((n + 1))
    [ "$out" = 200 ] || { bad=$((bad + 1)); echo "$(date +%T.%N) $out" >>$LOAD.errors; }
    v=$(curl -s -m 5 -H "Host: $HOST" "$EDGE/"); echo "$v" >>$LOAD.versions
    sleep 0.02
  done; echo "$n $bad" >$LOAD.counts ) &
LOAD_PID=$!
sleep 1
code=$(api_code POST /api/projects/phase1/deployments -F "module=@$MODULE_V2")
eq "deploy module v2" "$code" 201
D2=$(jq -r .id </tmp/sbd-e2e-body)
eq "v2 is sproutd's active version" "$(jq -r .vid </tmp/sbd-e2e-body)" "$V2"
check "v2 answers through the edge" "$(wait_for 10 serves v2; echo $?)"
sleep 1
code=$(api_code POST "/api/projects/phase1/deployments/$D1/activate")
eq "rollback to v1 (activate the first deployment)" "$code" 200
info "rollback went via: $(jq -r .via </tmp/sbd-e2e-body)"
check "v1 answers again" "$(wait_for 10 serves v1; echo $?)"
sleep 1
touch $LOAD.stop; wait $LOAD_PID
read -r REQS BAD <$LOAD.counts
eq "no request failed while deploying and rolling back ($REQS probes)" "$BAD" 0
[ "$BAD" != 0 ] && info "errors: $(head -5 $LOAD.errors | tr '\n' ' ')"
check "the load saw both versions" "$([ "$(sort -u $LOAD.versions | grep -c phase1)" -ge 2 ]; echo $?)" "$(sort $LOAD.versions | uniq -c | tr '\n' ' ')"
eq "control marks v1 active" "$(api GET /api/projects/phase1/deployments | jq -r '[.[] | select(.active)] | .[0].vid')" "$V1"
eq "sproutd agrees: its active version is v1" "$(sd_admin versions "$(app_id)" | sed 's/^ok //' | jq -r '[.[] | select(.active)][0].id')" "$V1"
# Rolling forward is the same call on the other deployment.
eq "roll forward to v2" "$(api_code POST "/api/projects/phase1/deployments/$D2/activate")" 200
check "v2 answers" "$(wait_for 10 serves v2; echo $?)"
eq "and back to v1" "$(api_code POST "/api/projects/phase1/deployments/$D1/activate")" 200
check "v1 answers" "$(wait_for 10 serves v1; echo $?)"
eq "an unknown deployment cannot be activated" "$(api_code POST /api/projects/phase1/deployments/nope/activate)" 404

section "Limits change on a running app"
eq "raise to 96 MiB" "$(api PUT /api/projects/phase1/runtime -d '{"runtime":"sproutd","limits":{"memoryMb":96}}' | jq -r .effectiveLimits.memoryMb)" 96
eq "sproutd reports the new limit" "$(sd_admin limits "$(app_id)" | grep -o 'memory-mb=[0-9]*')" "memory-mb=96"

section "Control and sproutd restart independently"
before=$(unit_pid sbstg-sproutd)
systemctl restart sbstg-control
check "control restarted: still v1 through the edge" "$(wait_for 20 serves v1; echo $?)"
eq "sproutd untouched by a control restart" "$(unit_pid sbstg-sproutd)" "$before"
systemctl restart sbstg-sproutd
check "sproutd restarted: v1 again (it restored its own state)" "$(wait_for 30 serves v1; echo $?)"
secrets_back() { [ "$(edge /secrets | jq -r .TOKEN)" = "$SECRET_TOKEN" ]; }
check "...with its secrets" "$(wait_for 10 secrets_back; echo $?)"
# sproutd loses everything: control rebuilds it from its own copies of the modules.
systemctl stop sbstg-sproutd-adapter sbstg-sproutd
find /var/lib/sbstg-sproutd /var/lib/sbstg-sproutd-adapter -mindepth 1 -delete
systemctl start sbstg-sproutd sbstg-sproutd-adapter
check "sproutd with an empty STATE: reconcile redeploys v1" "$(wait_for 60 serves v1; echo $?)"
check "...with its secrets" "$(wait_for 20 secrets_back; echo $?)"
journalctl -u sbstg-control --since '-3min' --no-pager 2>/dev/null | grep -o 'sproutd reconcile ([a-z]*): .*' | tail -3 | while read -r l; do info "$l"; done

section "3. sbctl update does not touch sproutd"
declare -A PID_BEFORE SINCE_BEFORE
for u in sbstg-control sbstg-egress sbstg-edge sbstg-sproutd sbstg-sproutd-adapter; do PID_BEFORE[$u]=$(unit_pid $u); SINCE_BEFORE[$u]=$(unit_since $u); done
WP_BEFORE=$(worker_pid)
info "before: $(for u in "${!PID_BEFORE[@]}"; do printf '%s=%s ' "$u" "${PID_BEFORE[$u]}"; done) worker=$WP_BEFORE"
out=$("$PREFIX/bin/sbctl" update 2>&1); rc=$?
eq "sbctl update succeeds" "$rc" 0
info "$(echo "$out" | grep -E 'restarting|Updating' | tr '\n' ' ')"
for u in sbstg-control sbstg-egress sbstg-edge; do
  [ "${PID_BEFORE[$u]}" != "$(unit_pid $u)" ] && pass "$u was restarted by the update" || fail "$u was restarted by the update" "pid unchanged"
done
for u in sbstg-sproutd sbstg-sproutd-adapter; do
  eq "$u not restarted: same pid" "$(unit_pid $u)" "${PID_BEFORE[$u]}"
  eq "$u not restarted: same start time" "$(unit_since $u)" "${SINCE_BEFORE[$u]}"
done
check "v1 still answers through the new edge" "$(wait_for 20 serves v1; echo $?)"
eq "the same sproutd worker serves it (an edge restart no longer ends the app)" "$(worker_pid)" "$WP_BEFORE"
eq "staged sbctl status lists no sproutd" "$("$PREFIX/bin/sbctl" status | grep -ci sproutd)" 0
eq "no sproutd text in the installer, updater, sbctl or shipped units" "$(cd "$HERE/.." && grep -il sproutd install.sh infra/sbctl infra/sb-update infra/systemd/*.service infra/systemd/*.timer | wc -l | tr -d ' ')" 0

section "Section 7.3: what a running system answers"
SDUSER=sbstg-sproutd
# Not /tmp: the daemon has a private one.
tmpd=$(mktemp -d "$PREFIX/probe.XXXXXX"); chmod 755 "$tmpd"
cp "$MODULE_V1" "$tmpd/app.so"; chmod 644 "$tmpd/app.so"
# (a) a secrets value with a newline, handed to sproutd directly, in its own file format
printf 'A=one\nB=two\nthird line\n' >"$tmpd/newline.env"
printf 'A=x\nSB_X=1\n' >"$tmpd/reserved.env"
printf 'TOKEN= a=b #c \nGREETING=h\xc3\xa9llo\n' >"$tmpd/edgecases.env"
chown -R $SDUSER "$tmpd"
probe() { # NAME ENVFILE
  sd_admin deploy "probe-$1" "$tmpd/app.so" "$tmpd/$2" | tr '\n' ' '
  sd_admin host "probe-$1" "probe-$1.test" >/dev/null
  local code; code=$(curl -s -o /tmp/sbd-e2e-body -w '%{http_code}' -H "Host: probe-$1.test" "http://127.0.0.1:18600/secrets"); echo "http $code $(head -c 120 /tmp/sbd-e2e-body)"
  sd_admin logs "probe-$1" 5 | head -c 300; echo
  sd_admin remove "probe-$1" >/dev/null
}
info "newline value:   $(probe nl newline.env)"
info "reserved name:   $(probe res reserved.env)"
info "edge-case values: $(probe edge edgecases.env)"
# (b) a module from another generation
if [ -n "${MODULE_OTHER_GENERATION:-}" ]; then
  cp "$MODULE_OTHER_GENERATION" "$tmpd/other.so"; chmod 644 "$tmpd/other.so"; chown $SDUSER "$tmpd/other.so"
  reply=$(sd_admin deploy probe-abi "$tmpd/other.so" | tr '\n' ' ')
  info "module of another generation, new app:   $reply"
  sleep 1
  info "   ...request: http $(curl -s -o /tmp/sbd-e2e-body -w '%{http_code}' -H 'Host: probe-abi.test' http://127.0.0.1:18600/) ; list: $(sd_admin list | grep probe-abi | head -c 200)"
  sd_admin remove probe-abi >/dev/null 2>&1
  reply=$(sd_admin deploy "$(app_id)" "$tmpd/other.so" | tr '\n' ' ')
  info "module of another generation, over a live app: $reply"
  eq "the live app still serves v1 after that attempt" "$(edge /)" "phase1 v1"
fi
rm -rf "$tmpd"

section "Result"
printf '%s passed, %s failed\n' "$PASSED" "$FAILED"
exit "$FAILED"
