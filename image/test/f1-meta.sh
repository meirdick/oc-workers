#!/bin/bash
# F1 (T5-T7a.md, docs/06 §1): Litestream 0.5.17 (from the M0 ocsup image) replicates a DB whose meta dir
# .<db>-litestream survives into a new gen prefix (the wake-from-snapshot case).
# SeaweedFS 3.80 is the S3 stand-in. Own network ocf1, own containers f1-*.
# Expect: A uploads L0; B (stale meta, new prefix) uploads only L9, logs "open ltx file ...0000000000000001-0000000000000001.ltx",
#   SIGTERM takes about 30 s, the gen restores without the B rows; C (meta dir wiped) uploads L0 and restores all rows;
#   D (stale meta, auto-recover: true) uploads L0 after 1 error, but its restore lost the D rows in 1 of 2 runs. Env: KEEP=1 keeps the containers.
set -u
IMG=${IMG:-oc-m0:dev}
D=$(mktemp -d)
docker rm -f f1-s3 f1-host >/dev/null 2>&1
docker network inspect ocf1 >/dev/null 2>&1 || docker network create --subnet 15.9.0.0/24 ocf1 >/dev/null
cat >"$D/s3.json" <<'J'
{"identities":[{"name":"t","credentials":[{"accessKey":"k","secretKey":"s0123456789012345678"}],"actions":["Admin","Read","List","Tagging","Write"]}]}
J
docker run -d --name f1-s3 --network ocf1 --ip 15.9.0.10 -v "$D/s3.json":/etc/s3.json:ro \
  chrislusf/seaweedfs:3.80 server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/s3.json \
  -master.volumeSizeLimitMB=64 -volume.max=20 >/dev/null
docker run -d --name f1-host --network ocf1 --entrypoint sleep "$IMG" infinity >/dev/null
docker exec f1-host sh -c 'mkdir -p /data/s && litestream version'
S3='{"endpoint":"http://15.9.0.10:8333","bucket":"oc-f1","region":"us-east-1","accessKey":"k","secretKey":"s0123456789012345678"}'
for i in $(seq 1 60); do
  docker exec f1-host node --input-type=module -e "const s3=await import('/opt/ocrt/lib/s3.mjs');console.log('bucket',await s3.createBucket($S3));" 2>/dev/null && break; sleep 2
done
cfg() { # gen autoRecover -> /data/ls-<gen>.yml
  docker exec -i f1-host sh -c "cat > /data/ls-$1.yml" <<Y
l0-retention: 10s
l0-retention-check-interval: 2s
levels:
  - interval: 5s
dbs:
  - path: /data/s/openclaw.sqlite
    replica:
      type: s3
      bucket: oc-f1
      path: r/f1/g$1/state/openclaw.sqlite
      endpoint: http://15.9.0.10:8333
      region: us-east-1
      force-path-style: true
      access-key-id: k
      secret-access-key: s0123456789012345678
      sync-interval: 1s
      auto-recover: $2
Y
}
start() { docker exec -d f1-host sh -c "exec litestream replicate -config /data/ls-$1.yml >/data/ls-$1.log 2>&1"; sleep 2; }
stop() { # SIGTERM, wait up to 45 s, print exit time
  local t0=$(date +%s.%N)
  docker exec f1-host sh -c 'pkill -TERM -x litestream; for i in $(seq 1 450); do pgrep -x litestream >/dev/null || exit 0; sleep 0.1; done; exit 1'
  echo "stop rc=$? after $(echo "$(date +%s.%N) - $t0" | bc | cut -c1-5) s"
}
write() { # n rows, 1 per 0.5 s, tag
  docker exec f1-host node -e '
const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/data/s/openclaw.sqlite");
db.exec("pragma journal_mode=wal; pragma busy_timeout=5000; create table if not exists t(id integer primary key, tag text, at text)");
const ins=db.prepare("insert into t(tag,at) values (?,?)");let i=0;
const h=setInterval(()=>{ins.run(process.argv[2],new Date().toISOString());if(++i>=+process.argv[1]){clearInterval(h);
console.log("rows now",db.prepare("select count(*) n from t").get().n)}},500);' "$1" "$2"
}
l0dir() { docker exec f1-host sh -c 'echo "local L0: $(ls /data/s/.openclaw.sqlite-litestream/ltx/0 2>/dev/null | head -3 | tr "\n" " ")... ($(ls /data/s/.openclaw.sqlite-litestream/ltx/0 2>/dev/null | wc -l) files)"'; }
keys() { docker exec f1-host node --input-type=module -e "
const s3=await import('/opt/ocrt/lib/s3.mjs');const k=await s3.listKeys($S3,'r/f1/g$1/');
const by={};for(const x of k){const l=x.split('/').at(-2);by[l]=(by[l]||0)+1}
console.log('g$1 keys by level',JSON.stringify(by));"; }
restore() { # gen -> row count of the restored copy
  docker exec f1-host sh -c "rm -f /data/r-$1.sqlite*; litestream restore -config /data/ls-$1.yml -o /data/r-$1.sqlite /data/s/openclaw.sqlite >/dev/null 2>&1; echo rc=\$?"
  docker exec f1-host node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});
console.log("restored rows",db.prepare("select count(*) n from t").get().n, JSON.stringify(db.prepare("select tag,count(*) n from t group by tag").all()))' /data/r-$1.sqlite
}
src() { docker exec f1-host node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/data/s/openclaw.sqlite",{readOnly:true});
console.log("source rows",db.prepare("select count(*) n from t").get().n)'; }
errs() { docker exec f1-host sh -c "echo \"open-ltx errors: \$(grep -c 'open ltx file' /data/ls-$1.log); shutdown-sync-failed: \$(grep -c 'shutdown sync failed' /data/ls-$1.log); auto-recovery: \$(grep -c 'auto-recovery complete' /data/ls-$1.log)\"; grep -m1 'open ltx file' /data/ls-$1.log | cut -c1-330"; }

[ -n "${ONLY_SETUP:-}" ] && exit 0
echo "== A: gen 1, fresh dir, 60 rows over 30 s, then 20 s idle for L1 compaction + L0 retention"
cfg 1 false; start 1; write 60 A; sleep 20; l0dir; keys 1; stop; errs 1
echo "== B: gen 2, same dir and meta (wake from snapshot, no restore), 40 rows"
cfg 2 false; start 2; write 40 B; sleep 5; l0dir; keys 2; stop; errs 2; src; restore 2
echo "== C: gen 3, same dir, meta dir wiped before start (fix), 40 rows, 20 s idle"
cfg 3 false; docker exec f1-host rm -rf /data/s/.openclaw.sqlite-litestream
start 3; write 40 C; sleep 20; l0dir; keys 3; stop; errs 3; src; restore 3
echo "== D: gen 4, stale meta again, auto-recover: true (alternative fix), 40 rows"
cfg 4 true; start 4; write 40 D; sleep 5; l0dir; keys 4; stop; errs 4; src; restore 4
[ -n "${KEEP:-}" ] || { docker rm -f f1-s3 f1-host >/dev/null; docker network rm ocf1 >/dev/null; }
