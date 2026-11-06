#!/bin/bash
# T2 in-container probe (spike/README.md T2). Prints facts; changes only probe cgroups and the hostname.
# Usage (as root, in the container):
#   /opt/ocrt/probe.sh                 all checks, as root and as uid 1000
#   /opt/ocrt/probe.sh listen 8081 120 TCP listener: logs the source IP of each inbound
#                                      connection (getTcpPort test) and answers HTTP 200 with it
set -u
if [ "${1:-}" = listen ]; then
  exec node -e '
const port=+process.argv[1], secs=+process.argv[2];
const srv=require("net").createServer(s=>{const who=s.remoteAddress+":"+s.remotePort;
  console.log(JSON.stringify({ts:new Date().toISOString(),ev:"inbound",from:who,local:s.localAddress+":"+s.localPort}));
  s.once("data",()=>{const b=JSON.stringify({from:who})+"\n";
    s.end("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: "+b.length+"\r\nconnection: close\r\n\r\n"+b)})});
srv.listen(port,"0.0.0.0",()=>console.log(JSON.stringify({ev:"listening",port})));
setTimeout(()=>process.exit(0),secs*1000);' "${2:-8081}" "${3:-120}"
fi

h() { printf '\n## %s\n' "$*"; }
kv() { printf '%-28s %s\n' "$1:" "$2"; }
try() { local o; o=$("$@" 2>&1); echo "rc=$? ${o//$'\n'/ | }"; }
CG=/sys/fs/cgroup

h "identity"
kv uid "$(id -u) ($(id -un))"
kv kernel "$(uname -r)"
kv os "$(. /etc/os-release; echo "$PRETTY_NAME")"
kv nproc "$(nproc)"
kv memtotal "$(awk '/MemTotal/{print $2" kB"}' /proc/meminfo)"
kv boot_id "$(cat /proc/sys/kernel/random/boot_id)"
kv hostname "$(hostname)"
kv pid1 "$(tr '\0' ' ' </proc/1/cmdline)"

h "hostname set (T2.1)"
before=$(hostname)
kv "hostname localhost" "$(try hostname localhost)"
kv "after" "$(hostname)"
kv "/etc/hosts localhost" "$(grep -c -w localhost /etc/hosts) line(s); writable=$( [ -w /etc/hosts ] && echo yes || echo no)"
[ "$(id -u)" = 0 ] && [ "$before" != "$(hostname)" ] && [ "${PROBE_KEEP_HOSTNAME:-1}" = 0 ] && hostname "$before"

h "cgroup (T2.4)"
kv "/proc/self/cgroup" "$(tr '\n' ' ' </proc/self/cgroup)"
kv "mount" "$(awk '$5=="/sys/fs/cgroup"{print $9" "$6" (" $10 ")"}' /proc/self/mountinfo | tr '\n' ' ')"
kv "controllers" "$(cat $CG/cgroup.controllers 2>&1)"
kv "subtree_control" "$(cat $CG/cgroup.subtree_control 2>&1)"
kv "top procs" "$(wc -l <$CG/cgroup.procs 2>/dev/null) pid(s)"
kv "top memory.max" "$(cat $CG/memory.max 2>&1)"
kv "cgroup.kill (kernel)" "$( [ -e $CG/cgroup.kill ] || ls $CG/*/cgroup.kill >/dev/null 2>&1 && echo present || echo absent)"
if [ -d $CG/ocrt ]; then kv "ocrt tree (ocsup)" "$(cd $CG/ocrt && find . -name cgroup.procs | sort | while read -r f; do printf '%s=%s ' "${f%/cgroup.procs}" "$(wc -l <"$f")"; done)"; fi
P=$CG/ocrt-probe
kv "mkdir probe cgroup" "$(try mkdir -p $P/a $P/b)"
if [ -d $P ]; then
  kv "+memory top subtree" "$(try sh -c "echo +memory > $CG/cgroup.subtree_control")"
  kv "+memory probe subtree" "$(try sh -c "echo +memory +pids > $P/cgroup.subtree_control")"
  kv "a/memory.max write" "$(try sh -c "echo 268435456 > $P/a/memory.max") -> $(cat $P/a/memory.max 2>&1)"
  kv "a/memory.high write" "$(try sh -c "echo 201326592 > $P/a/memory.high") -> $(cat $P/a/memory.high 2>&1)"
  kv "a/memory.oom.group" "$(try sh -c "echo 1 > $P/a/memory.oom.group")"
  kv "a/cgroup.kill" "$( [ -e $P/a/cgroup.kill ] && echo present || echo absent)"
  # Delegation: chown only the two leaf cgroup.procs to 1000 (plan §4.2), then a uid-1000 process in a moves itself to b.
  chown 1000:1000 $P/a/cgroup.procs $P/b/cgroup.procs 2>/dev/null
  setpriv --reuid=1000 --regid=1000 --clear-groups -- sleep 30 & SP=$!
  sleep 0.2
  echo $SP > $P/a/cgroup.procs 2>/dev/null
  kv "uid1000 a->b (leaf chown)" "$(try setpriv --reuid=1000 --regid=1000 --clear-groups -- sh -c "echo $SP > $P/b/cgroup.procs")"
  chown 1000:1000 $P/cgroup.procs 2>/dev/null
  kv "uid1000 a->b (+parent)" "$(try setpriv --reuid=1000 --regid=1000 --clear-groups -- sh -c "echo $SP > $P/b/cgroup.procs") now=$(cat /proc/$SP/cgroup)"
  kill $SP 2>/dev/null; wait $SP 2>/dev/null
  sleep 0.2
  rmdir $P/a $P/b $P 2>/dev/null
fi

h "oom_score_adj (T2.5)"
kv "write -900 self" "$(try sh -c 'echo -900 > /proc/self/oom_score_adj; cat /proc/self/oom_score_adj')"
kv "pid1" "$(cat /proc/1/oom_score_adj)"
kv "uid1000 lower to -1" "$(try setpriv --reuid=1000 --regid=1000 --clear-groups -- sh -c 'echo -1 > /proc/self/oom_score_adj')"

h "ptrace_scope (T2.6)"
ps=$(cat /proc/sys/kernel/yama/ptrace_scope 2>&1)
kv "ptrace_scope" "$ps"
kv "writable (same value)" "$(try sh -c "echo $ps > /proc/sys/kernel/yama/ptrace_scope")"
kv "suid_dumpable" "$(cat /proc/sys/fs/suid_dumpable)"

h "PR_SET_DUMPABLE (T2.7)"
if [ "$(id -u)" = 0 ]; then node /opt/ocrt/dumpable-check.mjs; else echo "skip: needs root"; fi

h "netfilter owner match (T2.8)"
kv "iptables/nft binary" "$(command -v iptables nft iptables-nft 2>/dev/null | tr '\n' ' ' || true)$(command -v iptables nft >/dev/null 2>&1 || echo none)"
kv "ip_tables_names" "$(cat /proc/net/ip_tables_names 2>&1 | tr '\n' ' ')"
kv "ip_tables_matches" "$(cat /proc/net/ip_tables_matches 2>&1 | tr '\n' ' ')"
kv "modules owner/nf_tables" "$(grep -E '^(xt_owner|nf_tables|nft_meta|ip_tables|x_tables) ' /proc/modules 2>&1 | awk '{print $1}' | tr '\n' ' ')"
if [ -r /proc/config.gz ]; then
  kv "kconfig" "$(zcat /proc/config.gz | grep -E '^CONFIG_(NETFILTER_XT_MATCH_OWNER|NF_TABLES|NFT_META|IP_NF_IPTABLES|NETFILTER_XT_MATCH_CGROUP)=' | tr '\n' ' ')"
else
  kv "kconfig" "/proc/config.gz absent; /boot/config: $(ls /boot/config-* 2>/dev/null || echo none)"
fi
kv "/lib/modules" "$(ls /lib/modules 2>/dev/null | tr '\n' ' ' || true)"
if [ "$(id -u)" = 0 ] && command -v nft >/dev/null 2>&1; then
  # M1: the ocsup rule (lib/netfilter.mjs ruleset()); applied, tested as uid 1000, then removed.
  GATE_IP=${PROBE_GATE_IP:-15.0.0.1}
  kv "nft apply ocsup rule" "$(try node --input-type=module -e 'import {applyRules} from "/opt/ocrt/lib/netfilter.mjs"; const r=applyRules(); console.log(JSON.stringify(r)); process.exit(r.ok?0:1)')"
  kv "uid0 -> $GATE_IP:80" "$(timeout 3 bash -c "echo > /dev/tcp/$GATE_IP/80" 2>&1 && echo open || echo closed/timeout)"
  kv "uid1000 -> $GATE_IP:80" "$(setpriv --reuid=1000 --regid=1000 --clear-groups -- timeout 3 bash -c "echo > /dev/tcp/$GATE_IP/80" 2>&1 | tr '\n' ' '; echo)"
  kv "nft counters" "$(nft list table inet ocrt 2>&1 | grep -o 'counter packets [0-9]*' | tr '\n' ' ')"
  [ "${PROBE_KEEP_NFT:-0}" = 1 ] || nft delete table inet ocrt 2>/dev/null
fi

h "M1 image (nodump.so, uid-1000 Litestream)"
if [ "$(id -u)" = 0 ]; then
  # Same order as ocsup: uid drop first, then the preload on the exec'd program.
  OCRT_PROBE_SECRET=probe setpriv --reuid=1000 --regid=1000 --init-groups -- \
    env LD_PRELOAD=/opt/ocrt/nodump.so node -e 'setTimeout(()=>{},8000)' & NP=$!
  sleep 0.7
  NODE_PID=$NP  # setpriv and env exec, so the pid is the node pid
  kv "nodump node uid" "$(awk '/^Uid:/{print $2}' /proc/$NODE_PID/status 2>&1)"
  kv "nodump environ as uid1000" "$(try setpriv --reuid=1000 --regid=1000 --clear-groups -- cat /proc/$NODE_PID/environ)"
  kv "nodump environ owner" "$(stat -c %u:%g /proc/$NODE_PID/environ 2>&1)"
  kill $NP 2>/dev/null; wait $NP 2>/dev/null
  setpriv --reuid=1000 --regid=1000 --init-groups -- node -e 'setTimeout(()=>{},3000)' & BP=$!
  sleep 0.5
  kv "baseline environ owner" "$(stat -c %u:%g /proc/$BP/environ 2>&1)"
  kill $BP 2>/dev/null; wait $BP 2>/dev/null
  kv "litestream as uid1000" "$(try setpriv --reuid=1000 --regid=1000 --clear-groups -- litestream version)"
  kv "litestream owner/mode" "$(stat -c '%u:%g %a' /usr/local/bin/litestream)"
fi

h "network"
kv "addresses" "$(awk 'NR>2{print $1}' /proc/net/dev | tr '\n' ' ')"
kv "fib local" "$(awk '/32 host LOCAL/{print prev} {prev=$2}' /proc/net/fib_trie 2>/dev/null | sort -u | tr '\n' ' ')"
kv "default route" "$(awk '$2=="00000000"{print $1}' /proc/net/route | head -1)"
kv "resolv nameserver" "$(awk '/^nameserver/{print $2}' /etc/resolv.conf | tr '\n' ' ')"
kv "15.0.0.1:80 tcp" "$(timeout 3 bash -c 'echo > /dev/tcp/15.0.0.1/80' 2>&1 && echo open || echo closed/timeout)"
echo
echo "getTcpPort source IP: run '/opt/ocrt/probe.sh listen 8081 120' and call getTcpPort(8081).fetch() from the Worker."

if [ "$(id -u)" = 0 ] && [ "${PROBE_NO_UID1000:-0}" != 1 ]; then
  h "=== same checks as uid 1000 ==="
  PROBE_NO_UID1000=1 setpriv --reuid=1000 --regid=1000 --init-groups -- bash "$0" 2>&1 | sed 's/^/  /'
fi
