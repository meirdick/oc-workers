#!/bin/bash
# Stock image, no ocsup: gateway direct under tini (no Doctor), or the stock entrypoint (Doctor). Same flags as ocsup.
# usage: baseline.sh NAME CPUS DOCTOR(0|1) VOLUME
set -u
NAME=$1 CPUS=$2 DOC=$3 VOL=$4
BASE=ghcr.io/openclaw/openclaw@sha256:1a2a3ce113e435039dbeac5ae261759bb4759908563d91c81059e896b38c5d98
OUT=${OUT:-/tmp/claude-1000/m0img/logs}; mkdir -p "$OUT"
PORT=$((20000 + RANDOM % 20000))
EP=(--entrypoint tini); ARGS=(-s -- node openclaw.mjs gateway --allow-unconfigured --bind lan --port 18789 --auth token)
[ "$DOC" = 1 ] && EP=() && ARGS=(node openclaw.mjs gateway --allow-unconfigured --bind lan --port 18789 --auth token)
docker rm -f "$NAME" >/dev/null 2>&1
ms(){ date +%s%3N; }
t0=$(ms)
docker run -d --name "$NAME" "${EP[@]}" --cpus="$CPUS" --memory=6g --memory-swap=6g -p 127.0.0.1:$PORT:18789 \
  -v "$VOL":/home/node/.openclaw -e OPENCLAW_GATEWAY_TOKEN=m0testtoken0123456789abcdef "$BASE" "${ARGS[@]}" >/dev/null
ts=""
for i in $(seq 1 3000); do
  b=$(curl -s -m 1 http://127.0.0.1:$PORT/startupz 2>/dev/null)
  case "$b" in *'"ok":true'*) ts=$(( $(ms) - t0 )); break;; esac
  [ "$(docker inspect -f '{{.State.Status}}' "$NAME")" = exited ] && break
  sleep 0.1
done
t1=$(ms); docker stop -t 900 "$NAME" >/dev/null; stop_ms=$(( $(ms) - t1 ))
docker logs "$NAME" >"$OUT/$NAME.log" 2>&1; docker rm "$NAME" >/dev/null
echo "{\"name\":\"$NAME\",\"cpus\":$CPUS,\"doctor\":$DOC,\"startupz_ms\":${ts:-null},\"stop_ms\":$stop_ms}"
