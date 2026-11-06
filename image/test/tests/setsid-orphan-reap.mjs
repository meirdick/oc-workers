// Scope §4 M1 row 4: a setsid daemon from agent code is gone after reap(); a zombie does not give
// reap-failed; TIME_WAIT on :18789 is ignored (plan §4.2 reap rule).
import { exitInfo, gatewayPid, inGw, ps } from "../harness/flows.mjs";

// As uid 1000: join the gateway cgroup (delegated cgroup.procs), then start detached daemons.
const PLANT = `setsid sleep 100001 </dev/null >/dev/null 2>&1 &
setsid sh -c 'sleep 0 & exec sleep 100002' </dev/null >/dev/null 2>&1 &
true`;
const PLANT_OUT = "setsid sleep 100003 </dev/null >/dev/null 2>&1 &";
// Planted pids are found by their sleep argument: 100001 in-cgroup daemon, 100002 zombie parent, 100003 outside.
const PLANTED = /sleep 10000[123]/;

export default {
  name: "setsid-orphan-reap",
  source: "scope §4 M1 'setsid daemon ... reap()'; plan §4.2 reap()",
  rule: "After a gateway SIGKILL, ocsup reaps: setsid daemons in and outside the gw cgroup are gone, zombie present before reap gives no reap-failed, a TIME_WAIT entry on :18789 does not block; gateway reaches /startupz again; ocsup does not exit.",
  timeoutMs: 600_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1 });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    const r1 = inGw(b, PLANT);
    const r2 = b.as1000(PLANT_OUT);
    t.note(`plant cgroup: ${r1.out} ${r1.err} ${r2.err}`);
    // TIME_WAIT on the server side: HTTP/1.0 request, the server closes first.
    for (let i = 0; i < 5; i++) b.sh("curl -s -0 -m 2 -o /dev/null http://127.0.0.1:18789/startupz; true");
    await t.sleep(1000);
    const procs = ps(b);
    const planted = procs.filter((p) => PLANTED.test(p.cmd) || (p.state === "Z" && p.uid === 1000));
    t.measure(
      "planted",
      planted.map((p) => ({ pid: p.pid, sid: p.sid, state: p.state, cmd: p.cmd.slice(0, 40), cg: p.cg })),
    );
    const zombies = procs.filter((p) => p.state === "Z" && p.uid === 1000);
    t.check(
      "planted: 2 daemons + zombie parent",
      planted.filter((p) => PLANTED.test(p.cmd)).length >= 3,
      planted.length,
    );
    t.measure("zombiesBeforeReap", zombies.length);
    const tw = b.sh("grep -c ':4965 [0-9A-F:]* 06' /proc/net/tcp /proc/net/tcp6 2>/dev/null; true").out;
    t.measure("timeWaitEntries", tw);
    const n0 = b.ev("startupz").length;
    const pid = gatewayPid(b);
    b.sh(`kill -KILL -${pid} 2>/dev/null || kill -KILL ${pid}`);
    const again = await b.waitEv(() => b.ev("startupz").length > n0, 240_000);
    const after = ps(b);
    const left = after.filter((p) => PLANTED.test(p.cmd));
    const reap = b.ev("reap").at(-1);
    t.measure("reap", reap);
    t.check(
      "daemons and zombie parent gone after reap",
      left.length === 0,
      left.map((p) => p.cmd),
    );
    t.check("no reap-failed", !b.events().some((e) => /reap-failed/.test(JSON.stringify(e))), null);
    t.check("gateway /startupz again", !!again);
    t.check("ocsup still running", b.running(), b.running() ? undefined : await exitInfo(t, b));
  },
};
