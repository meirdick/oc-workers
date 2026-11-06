#!/bin/bash
# Litestream restore in pre-start. 2 CPUs, no Doctor. Source runs end with SIGKILL (no clean stop).
#  S1 (gen G1): marker table m0_probe (1000 rows) in state/openclaw.sqlite + a synthetic agent DB
#     agents/m0probe/agent/openclaw-agent.sqlite (WAL, no OpenClaw schema). SIGKILL.
#  R1 (gen G1+1, restore G1, empty volume): both DBs restored; contents checked from a sidecar.
#     The gateway then refuses the synthetic agent DB (schema version 0, exit 78) -> expected.
#  S2 (gen G1+5): marker table only. SIGKILL.
#  R2 (gen G1+6, restore G1+5, empty volume, new boot_id): restore, lock class dead, /startupz, marker rows.
#  R3 (same volume as R2, not empty): restore skipped.
set -u
G1=${G1:-51} # use fresh gens per run (old LTX keys stay in the bucket)
D=$(cd "$(dirname "$0")" && pwd)
OUT=${OUT:-/tmp/claude-1000/m0img/logs}
BID() { cat /proc/sys/kernel/random/uuid; }
vol() { docker volume rm -f "$1" >/dev/null 2>&1; docker volume create "$1" >/dev/null; }
marker='const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync("/home/node/.openclaw/state/openclaw.sqlite");db.exec("pragma busy_timeout=5000");
db.exec("create table if not exists m0_probe(id integer primary key, v text)");
const ins=db.prepare("insert into m0_probe(v) values (?)");for(let i=0;i<1000;i++)ins.run("row-"+i);
console.log("state m0_probe rows",db.prepare("select count(*) n from m0_probe").get().n);'
agentdb='const {DatabaseSync}=require("node:sqlite");const fs=require("fs");
fs.mkdirSync("/home/node/.openclaw/agents/m0probe/agent",{recursive:true});
const db=new DatabaseSync("/home/node/.openclaw/agents/m0probe/agent/openclaw-agent.sqlite");
db.exec("pragma journal_mode=wal; create table t(id integer primary key, v text)");
const ins=db.prepare("insert into t(v) values (?)");for(let i=0;i<1000;i++)ins.run("row-"+i);
console.log("agent t rows",db.prepare("select count(*) n from t").get().n);'
check='const {DatabaseSync}=require("node:sqlite");
for (const f of process.argv.slice(1)) { try { const db=new DatabaseSync(f,{readOnly:true});
 const q=(s)=>{try{return db.prepare(s).get().n}catch(e){return "n/a"}};
 console.log(f.replace("/s/",""),"m0_probe="+q("select count(*) n from m0_probe"),"t="+q("select count(*) n from t"),
  "integrity="+db.prepare("pragma integrity_check").get().integrity_check); } catch(e) { console.log(f, String(e.message)) } }'
src() { # name gen withAgent
  vol ocm0-$1; GEN=$2 "$D/boot.sh" ocm0-$1 2 0 ocm0-$1 -e OCRT_TEST_FAKE_BOOT_ID="$(BID)"
  docker exec -u 1000 ocm0-$1 node -e "$marker"
  [ "$3" = 1 ] && docker exec -u 1000 ocm0-$1 node -e "$agentdb"
  sleep 25
  docker exec ocm0-$1 sh -c 'grep "\"ev\":\"litestream-start\"" /var/lib/ocrt/ocsup.log | tail -1' | cut -c1-260
  docker kill ocm0-$1 >/dev/null; sleep 1; docker logs ocm0-$1 >"$OUT/ocm0-$1.log" 2>&1; echo "$1 killed"
}
events() { grep -E '"ev":"(restore-[a-z]+|lock|doctor|exit|startupz)"' "$OUT/$1.log" | cut -c1-420; }
files() { docker run --rm -u 1000 -v "$1":/s --entrypoint node oc-m0:dev -e "$check" /s/state/openclaw.sqlite /s/agents/m0probe/agent/openclaw-agent.sqlite; }

echo "== S1"; src s1 $G1 1
echo "== R1"; vol ocm0-rr1; GEN=$((G1+1)) "$D/boot.sh" ocm0-rr1 2 0 ocm0-rr1 -e OCRT_RESTORE_GEN=$G1 -e OCRT_TEST_FAKE_BOOT_ID="$(BID)"
sleep 3; docker logs ocm0-rr1 >"$OUT/ocm0-rr1.log" 2>&1; events ocm0-rr1 | head -8
docker rm -f ocm0-rr1 >/dev/null; files ocm0-rr1
echo "== S2"; src s2 $((G1+5)) 0
echo "== R2"; vol ocm0-rr2; GEN=$((G1+6)) "$D/boot.sh" ocm0-rr2 2 0 ocm0-rr2 -e OCRT_RESTORE_GEN=$((G1+5)) -e OCRT_TEST_FAKE_BOOT_ID="$(BID)"
events ocm0-rr2
echo "R2 lock wait lines: $(grep -c 'Waiting for the previous Gateway\|wait [0-9]* s and retry' "$OUT/ocm0-rr2.log")"
docker stop -t 900 ocm0-rr2 >/dev/null; docker rm ocm0-rr2 >/dev/null; files ocm0-rr2
echo "== R3"; GEN=$((G1+7)) "$D/boot.sh" ocm0-rr3 2 0 ocm0-rr2 -e OCRT_RESTORE_GEN=$((G1+5)) -e OCRT_TEST_FAKE_BOOT_ID="$(BID)"
grep -E '"ev":"restore-[a-z]+"' "$OUT/ocm0-rr3.log" | cut -c1-300
docker rm -f ocm0-s1 ocm0-s2 ocm0-rr3 >/dev/null; for v in s1 s2 rr1 rr2; do docker volume rm ocm0-$v >/dev/null; done
