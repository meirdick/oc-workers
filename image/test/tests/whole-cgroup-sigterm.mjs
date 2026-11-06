// Amend §2 row 22: SIGTERM to the gateway pid, then to every pid left in ocrt/gw (own pgids, like
// spawn-broker and codex app-server), wait <= 5 s, then reap(). A child with its own pgid exits by
// signal 15, not 9; ocrt/gw/cgroup.procs is empty after stop-gateway.
import { cgProcs, inGw, ps } from "../harness/flows.mjs";

const CHILD = `setsid node -e 'const fs=require("fs");process.title="m1-codex-like";process.on("SIGTERM",()=>{fs.writeFileSync("/tmp/m1-codex.sig","15 "+Date.now());process.exit(0)});setInterval(()=>{},1e9)' </dev/null >/dev/null 2>&1 &`;

export default {
  name: "whole-cgroup-sigterm",
  source: "amend §2 row 22; plan §4.5 step 3",
  rule: "Drain path (platform SIGTERM to PID 1) and, if ocsupctl exists, sleep-stop-gateway: a setsid child in ocrt/gw gets SIGTERM (writes its marker), not SIGKILL; ocrt/gw cgroup has no pid left after the stop.",
  timeoutMs: 900_000,
  async run(t) {
    // Drain path.
    const a = t.box({ name: "drain", gen: 1 });
    await a.start();
    if (!t.check("drain: /startupz", (await a.startupz()) !== null)) return;
    inGw(a, CHILD);
    await t.sleep(1000);
    const kid = ps(a).find((p) => /m1-codex-like/.test(p.cmd) || /m1-codex\.sig/.test(p.cmd));
    t.check(
      "drain: child planted in gw cgroup",
      !!kid && /ocrt\/gw/.test(kid.cg),
      kid && { pid: kid.pid, pgid: kid.pgid, cg: kid.cg },
    );
    a.sigterm();
    await a.waitExit(400_000);
    const sig = a.cat("/tmp/m1-codex.sig")?.toString() || null;
    t.check("drain: child exited by SIGTERM (marker 15)", /^15 /.test(sig || ""), sig);
    // Sleep path (phase 4).
    if (!t.features.ocsupctl) return t.note("sleep path skipped: image has no ocsupctl");
    const b = t.box({ name: "sleep", gen: 2 });
    await b.start();
    if (!t.check("sleep: /startupz", (await b.startupz()) !== null)) return;
    inGw(b, CHILD);
    await t.sleep(1000);
    const opId = `op-wcs-${Date.now()}`;
    for (const op of ["sleep-check", "sleep-prepare"])
      t.note(`${op}: ${JSON.stringify(b.ctl(op, { opId })).slice(0, 200)}`);
    const st = b.ctl("sleep-stop-gateway", { opId });
    t.measure("stopGateway", st);
    const left = [...cgProcs(b, "gw"), ...cgProcs(b, "gw/main"), ...cgProcs(b, "gw/browser")];
    t.check("sleep: ocrt/gw has no pid after stop-gateway", left.length === 0, left);
    const sig2 = b.cat("/tmp/m1-codex.sig")?.toString() || null;
    t.check("sleep: child exited by SIGTERM (marker 15)", /^15 /.test(sig2 || ""), sig2);
  },
};
