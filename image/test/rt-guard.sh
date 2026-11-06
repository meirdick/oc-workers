#!/bin/bash
# M1 runtime guard checks in the real image (local Docker): probe.sh (nft owner match, dumpable shim,
# uid-1000 Litestream) and rtguard/in.mjs (cgroups, reap, memwatch, oom, CPU).
# Needs a 15.0.0.0/24 network with a listener at 15.0.0.1:80 (NET, default ocm1 from the M1 harness).
set -uo pipefail
D=$(cd "$(dirname "$0")" && pwd)
IMG=${IMG:-oc-m1-rt:dev}
NET=${NET:-ocm1}
echo "== probe.sh (privileged, cgroupns private, 2 cpu, 6g, network $NET)"
docker run --rm --privileged --cgroupns private --cpus 2 --memory 6g --network "$NET" \
  --entrypoint bash "$IMG" /opt/ocrt/probe.sh 2>&1 | grep -E 'nft|uid0 ->|uid1000 ->|nodump|baseline|litestream|PR_SET|environ'
echo "== rtguard/in.mjs"
docker run --rm --privileged --cgroupns private --cpus 2 --memory 6g \
  -v "$D/rtguard":/t:ro --entrypoint tini "$IMG" -s -- node /t/in.mjs
