#!/bin/bash
# Boot matrix: ocsup image, cpus 1|2 x Doctor 0|1 x 3 runs, fresh state volume each run; then stock baseline.
# Output: JSON lines on stdout.
D=$(cd "$(dirname "$0")" && pwd)
for r in 1 2 3; do
  for doc in 0 1; do
    for c in 1 2; do
      v=ocm0-mx-$r-$doc-$c; docker volume rm -f $v >/dev/null 2>&1; docker volume create $v >/dev/null
      STOP=1 HOLD=5 "$D/boot.sh" ocm0-mx-$r-d$doc-c$c $c $doc $v
      docker rm -f ocm0-mx-$r-d$doc-c$c >/dev/null; docker volume rm $v >/dev/null
    done
  done
done
for r in 1 2; do
  for doc in 0 1; do
    for c in 1 2; do
      v=ocm0-bl-$r-$doc-$c; docker volume rm -f $v >/dev/null 2>&1; docker volume create $v >/dev/null
      "$D/baseline.sh" ocm0-bl-$r-d$doc-c$c $c $doc $v
      docker volume rm $v >/dev/null
    done
  done
done
