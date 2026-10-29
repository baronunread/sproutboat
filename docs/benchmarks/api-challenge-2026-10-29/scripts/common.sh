# Shared by the apichallenge-20261029 scripts. Source it; do not run it.
B=$HOME/.local/share/sproutboat-bench
S=$B/apichallenge-20261029
D=$B/12dollar-20261026          # read only; its othello.lock is checked by run.sh
CG=/sys/fs/cgroup/system.slice/bench12.service
W=/tmp/apc29
DOID=63adeb232f31b09ead2911537cbcd58f8bda9acb68858985e804a5b7b3b6f47a   # miniflare D1 id "feed"
run() { GOMAXPROCS=1 taskset -c 0 $S/loadgen-only -addr 127.0.0.1:3000 -tokens $S/tokens.json -conns ${CONNS:-512} "$@"; }
mix() { GOMAXPROCS=1 taskset -c 0 $S/loadgen -addr 127.0.0.1:3000 -tokens $S/tokens.json -conns 512 "$@"; }
stat_us() { awk -v k=$1 '$1==k{print $2}' $CG/cpu.stat; }
stop() { sudo systemctl stop bench12 2>/dev/null || true; sudo systemctl reset-failed bench12 2>/dev/null || true; }
unit() { # unit <extra systemd-run args...> -- cmd...   (LAUNCH_NS: time of the systemd-run call, after the seed copy)
  LAUNCH_NS=$(date +%s%N)
  sudo systemd-run --unit=bench12 --uid="$(id -u)" --gid="$(id -g)" \
    -p AllowedCPUs=1 -p MemoryMax=1536M -p MemorySwapMax=0 -p LimitNOFILE=65535 -p CPUAccounting=yes "$@" >/dev/null 2>&1
}
# launch <standalone|workerd|sproutd>: fresh copy of the seed, fresh unit; does not wait
launch() {
  BARE=; [ "$1" = workerd-bare ] && BARE=1
  stop; rm -rf $W; mkdir -p $W
  case "$1" in
  standalone)
    mkdir -p $W/data/d1; cp $S/feed.db $W/data/d1/DB.sqlite
    unit -E JWT_SECRET=twelve-dollar-challenge -E HOST=0.0.0.0 -E PORT=3000 -E SB_DATA_DIR=$W/data $S/bin/feed-0.42.0 ;;
  workerd|workerd-bare)
    mkdir -p $W/persist/miniflare-D1DatabaseObject; cp $S/feed.db $W/persist/miniflare-D1DatabaseObject/$DOID.sqlite
    unit ${BARE:+-E MF_BARE_SOCKET=1} -E MINIFLARE_WORKERD_PATH=$B/tools/workerd -E COMPAT=2026-09-27 $B/tools/node $S/mf/mf.mjs 3000 $W/persist $S/bin/workerd-index.js ;;
  workerd-do)
    mkdir -p $W/persist/-Db; cp $S/feed.db $W/persist/-Db/748d00a72bcf25abf768f013a1dd9f2d6f0454cc5242816dcdcac97dfb951a36.sqlite
    unit -E MF_BARE_SOCKET=1 -E MINIFLARE_WORKERD_PATH=$B/tools/workerd -E COMPAT=2026-09-27 $B/tools/node $S/mf/mfdo.mjs 3000 $W/persist $S/bin/workerd-do-index.js ;;
  sproutd)
    mkdir -p $W/state/feed/d1; cp $S/feed.db $W/state/feed/d1/DB.sqlite
    echo "JWT_SECRET=twelve-dollar-challenge" > $W/feed.env
    cat > $W/sproutd.conf <<CONF
runtime $S/rt
state $W/state
port 3000
cgroup on
admin $W/admin.sock
app feed $S/bin/feed.so
host feed bench
host feed localhost
host feed 127.0.0.1
secrets feed $W/feed.env
limits feed memory-mb 1024
CONF
    unit -p Delegate=yes $S/rt/native-host serve $W/sproutd.conf ;;
  esac
}
waitup() { for _ in $(seq 400); do curl -sf localhost:3000/health >/dev/null && return 0; sleep 0.05; done; return 1; }
start() { launch "$1"; waitup; sleep 1; }
# mem: one line of memory numbers for everything in the unit (kB): rss, pss, anon, file, shmem, cgroup current/peak
mem() {
  local rss=0 pss=0 anon=0 file=0 shm=0 p
  for p in $(cat $CG/cgroup.procs $CG/*/cgroup.procs 2>/dev/null | sort -u); do
    rss=$((rss+$(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null || echo 0)))
    anon=$((anon+$(awk '/RssAnon/{print $2}' /proc/$p/status 2>/dev/null || echo 0)))
    file=$((file+$(awk '/RssFile/{print $2}' /proc/$p/status 2>/dev/null || echo 0)))
    shm=$((shm+$(awk '/RssShmem/{print $2}' /proc/$p/status 2>/dev/null || echo 0)))
    pss=$((pss+$(awk '/^Pss:/{print $2}' /proc/$p/smaps_rollup 2>/dev/null || echo 0)))
  done
  echo "rss_kb=$rss pss_kb=$pss anon_kb=$anon file_kb=$file shmem_kb=$shm cg_current_kb=$(( $(cat $CG/memory.current)/1024 )) cg_peak_kb=$(( $(cat $CG/memory.peak 2>/dev/null || echo 0)/1024 ))"
}
