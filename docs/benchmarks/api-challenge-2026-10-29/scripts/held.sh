#!/usr/bin/env bash
# held.sh <runs> <target> <rate>...: the challenge mix, fresh unit and seed per run, 8 s warm-up at 500/s, DUR (default 30) s
# measured; runs interleave over the rates (run 1 of every rate, then run 2). Prints CPU us per request and the bar verdict
# (p95<500 ms, p99<1000 ms, errors<1%, achieved >= 99% of offered).
source $HOME/.local/share/sproutboat-bench/apichallenge-20261029/common.sh
trap stop EXIT
runs=$1; tgt=$2; shift 2
DUR=${DUR:-30}
for run in $(seq $runs); do for r in "$@"; do
  start $tgt; mix -rate 500 -dur 8s >/dev/null
  u0=$(stat_us user_usec); s0=$(stat_us system_usec)
  out=$(mix -rate $r -dur ${DUR}s)
  u1=$(stat_us user_usec); s1=$(stat_us system_usec)
  ach=$(echo "$out" | sed -E 's/.*achieved=([0-9]+).*/\1/')
  verdict=$(echo "$out" | tr " " "\n" | awk -F= -v r=$r '$1=="achieved"{ac=$2+0} $1=="errors"{e=$2+0} $1=="p95"{p95=$2+0} $1=="p99"{p99=$2+0} END{print (p95<500 && p99<1000 && e<1 && ac>=0.99*r) ? "HELD" : "MISS"}')
  echo "$tgt run$run $r $verdict cpu_us_per_req=$(( (u1-u0+s1-s0)/(ach*DUR) )) $out"
done; done
