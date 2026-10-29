#!/usr/bin/env bash
# mem.sh <target>...: memory of the whole unit after start, after a 10 s warm-up, and after 30 s of the mix at 2000/s
source $HOME/.local/share/sproutboat-bench/apichallenge-20261029/common.sh
trap stop EXIT
for t in "$@"; do
  start $t
  echo "$t idle  $(mem)"
  i0=$(stat_us user_usec); j0=$(stat_us system_usec); sleep 20; i1=$(stat_us user_usec); j1=$(stat_us system_usec)
  echo "$t idle_cpu_ms_per_s=$(( (i1-i0+j1-j0)/20000 )) (user $(( (i1-i0)/20000 )) sys $(( (j1-j0)/20000 )))"
  mix -rate 500 -dur 10s >/dev/null
  echo "$t warm  $(mem)"
  out=$(mix -rate 2000 -dur 30s)
  echo "$t load  $(mem) :: $out"
done
