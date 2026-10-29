#!/usr/bin/env bash
# run.sh <out> <script> [args]: runs a script of this directory under both bench locks, with bench12 idle.
cd ~/.local/share/sproutboat-bench
out=$1; shift
( flock -w 14400 9; flock -w 14400 8
  systemctl is-active bench12 | grep -q '^active' && { echo "bench12 busy"; exit 1; }
  echo "locks held $(date -u +%FT%TZ) load: $(cut -d' ' -f1-3 /proc/loadavg)"
  apichallenge-20261029/"$@"
  echo "done $(date -u +%FT%TZ) load: $(cut -d' ' -f1-3 /proc/loadavg)"
) 9>othello.lock 8>12dollar-20261026/othello.lock 2>&1 | tee apichallenge-20261029/$out
