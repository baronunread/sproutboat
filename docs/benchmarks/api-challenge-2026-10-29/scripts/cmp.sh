#!/usr/bin/env bash
# cmp.sh <trials> <ep:rate>,<ep:rate>,... <target>...: interleaved trials (trial > target > endpoint, fresh unit and seed
# each), 5 s warm-up at 500/s then DUR (default 15) s at the endpoint's rate; user+sys CPU of the whole unit per request.
source $HOME/.local/share/sproutboat-bench/apichallenge-20261029/common.sh
trap stop EXIT
trials=$1; eps=$2; shift 2
DUR=${DUR:-15}
for t in $(seq $trials); do for tgt in "$@"; do for er in ${eps//,/ }; do
  ep=${er%%:*}; rate=${er##*:}
  start $tgt
  run -only $ep -rate 500 -dur 5s >/dev/null
  u0=$(stat_us user_usec); s0=$(stat_us system_usec)
  out=$(run -only $ep -rate $rate -dur ${DUR}s)
  u1=$(stat_us user_usec); s1=$(stat_us system_usec)
  ach=$(echo "$out" | sed -E 's/.*achieved=([0-9]+).*/\1/'); n=$((ach*DUR)); [ $n -gt 0 ] || n=1
  echo "$t $tgt $ep rate=$rate user=$(( (u1-u0)*10/n ))e-1 sys=$(( (s1-s0)*10/n ))e-1 total=$(( (u1-u0+s1-s0)*10/n ))e-1 :: $out"
done; done; done
