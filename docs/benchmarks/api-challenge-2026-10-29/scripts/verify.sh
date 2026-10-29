#!/usr/bin/env bash
# verify.sh <target>...: the sidebyside verify.sh requests against each target; md5 of headers+bodies,
# and of bodies+status only (headers differ legitimately between runtimes).
source $HOME/.local/share/sproutboat-bench/apichallenge-20261029/common.sh
trap stop EXIT
for t in "$@"; do
  start $t
  { curl -s localhost:3000/feed; echo; for id in 1 5 77 123456 499999 500000 0 abc 99999999; do curl -s -i localhost:3000/posts/$id | grep -v -i -E '^(date|content-length)'; echo; done; curl -s -i localhost:3000/nope | grep -v -i '^date'; } > /tmp/apc-verify-$t.txt
  { curl -s localhost:3000/feed; echo; for id in 1 5 77 123456 499999 500000 0 abc 99999999 ; do curl -s -w ' [%{http_code}]\n' localhost:3000/posts/$id; done; curl -s -w ' [%{http_code}]\n' localhost:3000/nope; } > /tmp/apc-verify-body-$t.txt
  echo "$t full=$(md5sum < /tmp/apc-verify-$t.txt | cut -c1-12) body+status=$(md5sum < /tmp/apc-verify-body-$t.txt | cut -c1-12)"
done
