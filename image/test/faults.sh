#!/bin/bash
# Fault hooks and edge paths. 2 CPUs.
set -u
D=$(cd "$(dirname "$0")" && pwd)
OUT=${OUT:-/tmp/claude-1000/m0img/logs}
vol() { docker volume rm -f "$1" >/dev/null 2>&1; docker volume create "$1" >/dev/null; }
fault() { docker exec "$1" sh -c "echo '$2' > /var/lib/ocrt/faults"; }
ev() { docker logs "$1" 2>&1 | grep -E "$2" | cut -c1-"${3:-300}"; }
done_() { docker rm -f "$1" >/dev/null; docker volume rm "$1" >/dev/null 2>&1; }

echo "== balloons + kill-litestream (memwatch every 3 s)"
vol ocm0-fb; "$D/boot.sh" ocm0-fb 2 0 ocm0-fb -e OCRT_MEMWATCH_MS=3000
sleep 12; fault ocm0-fb "balloon-gw 1024"; sleep 7
fault ocm0-fb "balloon-vm 1024"; sleep 7
fault ocm0-fb "balloon-stop"; sleep 4
fault ocm0-fb "kill-litestream"; sleep 4
docker logs ocm0-fb 2>&1 | grep -E '"ev":"(fault|litestream-exit|litestream-start|balloon-[a-z]+)"' | cut -c1-200
docker logs ocm0-fb 2>&1 | grep '"ev":"mem"' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.trim().split("\n")){const j=JSON.parse(l);const M=x=>x==null?null:Math.round(x/1048576);console.log(`t=${(j.t/1000).toFixed(0)}s vmAvail=${M(j.vm.available)}MiB top=${M(j.top.current)}MiB gw=${M(j.gw?.current)}MiB sys=${M(j.sys?.current)}MiB gwRss=${M(j.gatewayRss)}MiB ocsupRss=${M(j.ocsupRss)}MiB`)}})'
docker exec ocm0-fb cat /var/lib/ocrt/status.json | head -c 600; echo
done_ ocm0-fb

echo "== hang-sigterm, docker stop -t 10"
vol ocm0-fh; "$D/boot.sh" ocm0-fh 2 0 ocm0-fh; fault ocm0-fh hang-sigterm; sleep 2
t0=$(date +%s%3N); docker stop -t 10 ocm0-fh >/dev/null; echo "stop_ms=$(( $(date +%s%3N) - t0 )) exit=$(docker inspect -f '{{.State.ExitCode}}' ocm0-fh)"
ev ocm0-fh '"ev":"(fault|signal)"'; done_ ocm0-fh

echo "== exit 42"
vol ocm0-fx; "$D/boot.sh" ocm0-fx 2 0 ocm0-fx; fault ocm0-fx "exit 42"; sleep 3
echo "state=$(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' ocm0-fx)"; done_ ocm0-fx

echo "== SIGTERM in pre-start (Doctor running)"
vol ocm0-fp; docker run -d --name ocm0-fp --privileged --cgroupns=private --cpus=2 --memory=6g --network ocm0 \
  -v ocm0-fp:/home/node/.openclaw -e OCRT_DOCTOR=1 -e OCRT_SET_PTRACE=0 -e OC_GATEWAY_TOKEN=m0testtoken0123456789abcdef oc-m0:dev >/dev/null
for i in $(seq 1 100); do docker logs ocm0-fp 2>&1 | grep -q '"phase":"doctor"' && break; sleep 0.1; done; sleep 2
t0=$(date +%s%3N); docker stop -t 60 ocm0-fp >/dev/null; echo "stop_ms=$(( $(date +%s%3N) - t0 )) exit=$(docker inspect -f '{{.State.ExitCode}}' ocm0-fp)"
ev ocm0-fp '"ev":"(signal|drain-step|exit|doctor)"' 250; done_ ocm0-fp

echo "== unprivileged (no --privileged): hostname, cgroups fallback"
vol ocm0-fu; PRIV=0 STOP=1 HOLD=3 "$D/boot.sh" ocm0-fu 2 0 ocm0-fu
ev ocm0-fu '"ev":"(hostname-[a-z]+|cgroups|proc-tune|reap|exit)"' 400 | head -6; done_ ocm0-fu
