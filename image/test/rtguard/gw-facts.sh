#!/bin/bash
# In-image (root): start the 2026.10.9 gateway as uid 1000 with nodump.so + jemalloc (ocsup order),
# then record the facts the runtime guards depend on: system.info heap fields, cron status --json,
# plugins list --json shape, environ of the gateway as uid 1000, no heap flag in its cmdline.
set -u
export OPENCLAW_GATEWAY_TOKEN=probe-token-0123456789
U="setpriv --reuid=1000 --regid=1000 --init-groups --"
cd /home/node
$U env HOME=/home/node LD_PRELOAD="/opt/ocrt/nodump.so /usr/lib/x86_64-linux-gnu/libjemalloc.so.2" \
  MALLOC_CONF=background_thread:true node --import /opt/ocrt/unpreload.mjs /app/openclaw.mjs gateway \
  --allow-unconfigured --bind lan --port 18789 --auth token >/tmp/gw.log 2>&1 &
GW=$!
t0=$(date +%s%N)
for i in $(seq 1 240); do
  curl -fsS http://127.0.0.1:18789/startupz >/dev/null 2>&1 && break
  sleep 0.25
done
echo "startupz after $(( ($(date +%s%N) - t0) / 1000000 )) ms"
echo "gateway pid $GW cmdline: $(tr '\0' ' ' </proc/$GW/cmdline)"
echo "gateway environ owner: $(stat -c %u:%g /proc/$GW/environ)"
echo "gateway environ as uid1000: $($U cat /proc/$GW/environ 2>&1 | head -c 80)"
echo "gateway maps jemalloc: $(grep -c jemalloc /proc/$GW/maps)"
for c in $(cat /proc/$GW/task/*/children 2>/dev/null); do
  echo "child $c $(tr '\0' ' ' </proc/$c/cmdline | head -c 80) LD_PRELOAD in env: $(tr '\0' '\n' </proc/$c/environ 2>/dev/null | grep -c LD_PRELOAD)"
done
call() { $U env HOME=/home/node OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN node /app/openclaw.mjs "$@" 2>&1; }
echo "== system.info"
call gateway call system.info --json > /tmp/si.json; node -e "const s=require(\"fs\").readFileSync(\"/tmp/si.json\",\"utf8\");const j=JSON.parse(s.slice(s.indexOf(\"{\")));console.log(\"keys:\",Object.keys(j).join(\",\"));console.log(\"processMemory:\",JSON.stringify(j.processMemory||null))"
echo "== cron status --json"
call cron status --json | tail -c 600
echo
echo "== heap_size_limit in ocrt-like 6g container: $($U node -e 'console.log(require("v8").getHeapStatistics().heap_size_limit/1048576)') MiB"
kill $GW; wait $GW 2>/dev/null
