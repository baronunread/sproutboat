#!/usr/bin/env bash
# cold.sh <reps> <target>...: unit start to first /health 200 (ms), then the first, second and third GET /feed (ms)
source $HOME/.local/share/sproutboat-bench/apichallenge-20261029/common.sh
trap stop EXIT
reps=$1; shift
for r in $(seq $reps); do for t in "$@"; do
  stop; sleep 1
  launch $t; t0=$LAUNCH_NS
  while ! curl -sf localhost:3000/health >/dev/null 2>&1; do sleep 0.01; done
  t1=$(date +%s%N)
  f=$(for i in 1 2 3; do curl -s -o /dev/null -w '%{time_total} ' localhost:3000/feed; done)
  p=$(for i in 1 2 3; do curl -s -o /dev/null -w '%{time_total} ' localhost:3000/posts/4242; done)
  echo "$r $t start_to_health_ms=$(( (t1-t0)/1000000 )) feed_s=[$f] post_s=[$p] $(mem)"
done; done
