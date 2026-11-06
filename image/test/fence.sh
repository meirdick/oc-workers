#!/bin/bash
# Heartbeat and self-fence. HB every 3 s.
#  F1: OCRT_FENCE=1, gate mode fail -> exit 77 after 3 failed heartbeats.
#  F2: OCRT_FENCE=0, gate mode fail -> keeps running.
#  F3: gate mode stale (409) -> exit 77 at once.
set -u
D=$(cd "$(dirname "$0")" && pwd)
gm() { docker exec ocm0-gate sh -c "echo $1 > /log/mode"; }
run() { # name fence mode
  docker volume rm -f ocm0-$1 >/dev/null 2>&1; docker volume create ocm0-$1 >/dev/null
  gm ok
  "$D/boot.sh" ocm0-$1 2 0 ocm0-$1 -e OCRT_HB_MS=3000 -e OCRT_FENCE=$2
  t0=$(date +%s%3N); gm $3
  for i in $(seq 1 300); do [ "$(docker inspect -f '{{.State.Status}}' ocm0-$1)" = exited ] && break; sleep 0.1; done
  echo "$1: fence=$2 mode=$3 state=$(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' ocm0-$1) after_ms=$(( $(date +%s%3N) - t0 ))"
  docker logs ocm0-$1 2>&1 | grep -E '"ev":"(heartbeat|self-fence|exit)"' | tail -5 | cut -c1-200
  gm ok; docker rm -f ocm0-$1 >/dev/null; docker volume rm ocm0-$1 >/dev/null
}
run f1 1 fail
run f2 0 fail
run f3 0 stale
