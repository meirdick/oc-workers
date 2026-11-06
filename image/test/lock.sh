#!/bin/bash
# Lock reclaim after SIGKILL (plan §4.3-§4.4, followups/lock-on-restore.md). 2 CPUs, no Doctor.
#  A: boot (fake boot_id A), hold 40 s so the lock heartbeat and DB lease exist, docker kill (SIGKILL all).
#  B: same volume, new fake boot_id, hostname pinned "localhost" -> expect lock class dead, no wait.
#  B2: in-container: fault kill-gateway in B -> ocsup restarts the gateway, same boot -> expect no wait.
#  C: docker kill B; same volume, new boot_id, different hostname -> expect the <=95 s heartbeat wait (control).
set -u
D=$(cd "$(dirname "$0")" && pwd)
OUT=${OUT:-/tmp/claude-1000/m0img/logs}
V=ocm0-lock; docker volume rm -f $V >/dev/null 2>&1; docker volume create $V >/dev/null
wait_text() { docker logs "$1" 2>&1 | grep -c 'Waiting for the previous Gateway\|wait [0-9]* s and retry' ; }
BID() { cat /proc/sys/kernel/random/uuid; }

echo "== A"; "$D/boot.sh" ocm0-lockA 2 0 $V -e OCRT_TEST_FAKE_BOOT_ID="$(BID)"
sleep 40; docker kill ocm0-lockA >/dev/null; echo "A killed (SIGKILL) at $(date +%T)"
docker logs ocm0-lockA >"$OUT/ocm0-lockA.log" 2>&1

echo "== B (same host, new boot)"; "$D/boot.sh" ocm0-lockB 2 0 $V -e OCRT_TEST_FAKE_BOOT_ID="$(BID)"
docker exec ocm0-lockB sh -c 'grep "\"ev\":\"lock\"" /var/lib/ocrt/ocsup.log | head -1' | cut -c1-900
echo "B wait lines: $(wait_text ocm0-lockB)"
sleep 35
echo "== B2 (in-container kill-gateway)"
t0=$(date +%s%3N); docker exec ocm0-lockB sh -c 'echo kill-gateway > /var/lib/ocrt/faults'
for i in $(seq 1 2000); do [ "$(docker logs ocm0-lockB 2>&1 | grep -c '"ev":"startupz"')" -ge 2 ] && break; sleep 0.1; done
echo "B2 fault->2nd startupz ms: $(( $(date +%s%3N) - t0 ))"
docker logs ocm0-lockB 2>&1 | grep -E '"ev":"(fault|gateway-exit|reap|lock|gateway-start|startupz)"' | tail -6 | cut -c1-600
echo "B2 wait lines total: $(wait_text ocm0-lockB)"
sleep 35; docker kill ocm0-lockB >/dev/null; docker logs ocm0-lockB >"$OUT/ocm0-lockB.log" 2>&1; echo "B killed at $(date +%T)"

echo "== C (new host, new boot; control)"; "$D/boot.sh" ocm0-lockC 2 0 $V -e OCRT_TEST_FAKE_BOOT_ID="$(BID)" -e OCRT_HOSTNAME=oc-m0-other
docker exec ocm0-lockC sh -c 'grep "\"ev\":\"lock\"" /var/lib/ocrt/ocsup.log | head -1' | cut -c1-900
echo "C wait lines: $(wait_text ocm0-lockC)"
docker logs ocm0-lockC 2>&1 | grep -m2 'Waiting for the previous Gateway\|wait [0-9]* s and retry' | cut -c1-400
docker rm -f ocm0-lockA ocm0-lockB ocm0-lockC >/dev/null; docker volume rm $V >/dev/null
