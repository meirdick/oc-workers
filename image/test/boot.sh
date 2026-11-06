#!/bin/bash
# One ocsup boot in the ocm0 env. Prints one JSON line.
# usage: boot.sh NAME CPUS DOCTOR(0|1) VOLUME [docker run args...]
# env: GEN (default 1), STOP=1 (docker stop -t 900 after /startupz + HOLD s), HOLD (s, default 5),
#      PRIV=0 (no --privileged), OUT (log dir, default /tmp/claude-1000/m0img/logs)
set -u
NAME=$1 CPUS=$2 DOC=$3 VOL=$4; shift 4
IMG=${IMG:-oc-m0:dev}
OUT=${OUT:-/tmp/claude-1000/m0img/logs}; mkdir -p "$OUT"
PORT=$((20000 + RANDOM % 20000))
PRIVARGS=(--privileged --cgroupns=private); [ "${PRIV:-1}" = 0 ] && PRIVARGS=()
docker rm -f "$NAME" >/dev/null 2>&1
ms(){ date +%s%3N; }
t0=$(ms)
docker run -d --name "$NAME" "${PRIVARGS[@]}" --cpus="$CPUS" --memory=6g --memory-swap=6g \
  --network ocm0 -p 127.0.0.1:$PORT:18789 -v "$VOL":/home/node/.openclaw \
  -e OCRT_INST=m0 -e OCRT_EPOCH=1 -e OCRT_GEN="${GEN:-1}" -e OCRT_DOCTOR="$DOC" -e OCRT_SET_PTRACE=0 \
  -e OCRT_S3_ENDPOINT=http://15.0.0.10:8333 -e OCRT_S3_BUCKET=oc-m0 -e OCRT_S3_REGION=us-east-1 \
  -e OCRT_S3_ACCESS_KEY_ID=ocrtkey -e OCRT_S3_SECRET_ACCESS_KEY=ocrtsecret0123456789 \
  -e OCRT_BOOT_SECRET=bootsecret-test -e OC_GATEWAY_TOKEN=m0testtoken0123456789abcdef \
  "$@" "$IMG" >/dev/null || { echo "{\"name\":\"$NAME\",\"error\":\"docker run failed\"}"; exit 1; }
ts=""
for i in $(seq 1 3000); do
  c=$(curl -s -m 1 -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/startupz 2>/dev/null)
  if [ "$c" = 200 ]; then ts=$(( $(ms) - t0 )); break; fi
  st=$(docker inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null)
  [ "$st" = exited ] && break
  sleep 0.1
done
stop_ms=null ec=null
if [ "${STOP:-0}" = 1 ]; then
  sleep "${HOLD:-5}"
  t1=$(ms); docker stop -t 900 "$NAME" >/dev/null; stop_ms=$(( $(ms) - t1 ))
  ec=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
fi
sleep 1; docker logs "$NAME" >"$OUT/$NAME.log" 2>&1
read -r ocsup_ms gw_ms <<<"$(node -e '
const ls=require("fs").readFileSync(process.argv[1],"utf8").split("\n");
const l=ls.find(x=>x.includes("\"ev\":\"startupz\""));
if(!l){console.log("null null")}else{const j=JSON.parse(l);console.log(j.sinceOcsupStartMs+" "+j.sinceGatewaySpawnMs)}' "$OUT/$NAME.log")"
echo "{\"name\":\"$NAME\",\"cpus\":$CPUS,\"doctor\":$DOC,\"startupz_ms\":${ts:-null},\"ocsup_startupz_ms\":$ocsup_ms,\"gw_spawn_to_startupz_ms\":$gw_ms,\"stop_ms\":$stop_ms,\"exit\":$ec,\"port\":$PORT}"
