// Scope §4 M1 row 7 [Z0.12]: an `npm install` balloon as a CLI child dies before ocsup does
// (oom_score_adj: tini -1000, ocsup -900, Litestream -800, gateway tree +500).
import { ps } from "../harness/flows.mjs";

// Balloon outside ocrt/gw (a CLI child started by agent code in a shell: container cgroup), with the
// gateway tree's oom_score_adj, until the container limit is hit (VM-level OOM stand-in).
const BALLOON = `echo 500 > /proc/self/oom_score_adj; exec node --max-old-space-size=64 -e 'process.title="m1-npm-balloon";const a=[];setInterval(()=>a.push(Buffer.alloc(64<<20,1)),100)'`;

export default {
  name: "npm-install-balloon-dies-first",
  source: "scope §4 M1 'npm install balloon ... dies before ocsup' [Z0.12]; plan §4.2 oom_score_adj",
  rule: "oom_score_adj read back: tini -1000, ocsup -900, Litestream -800, gateway >= 500. A balloon at +500 past the container limit (3 GiB) is OOM-killed; ocsup, tini and Litestream survive; container keeps running.",
  timeoutMs: 600_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1, memory: "3g" });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    await t.sleep(12_000);
    const p = ps(b);
    const adj = (pid) => Number(b.sh(`cat /proc/${pid}/oom_score_adj`).out);
    const ocsup = p.find((x) => x.uid === 0 && /ocsup\.mjs/.test(x.cmd) && x.pid !== 1);
    const ls = p.find((x) => /litestream replicate/.test(x.cmd));
    // The gateway itself, not an ocio helper whose argv holds /home/node/.openclaw.
    const gw = p.find((x) => x.uid === 1000 && /openclaw\.mjs gateway|openclaw-gateway/.test(x.cmd));
    const scores = {
      tini: adj(1),
      ocsup: ocsup && adj(ocsup.pid),
      litestream: ls && adj(ls.pid),
      gateway: gw && adj(gw.pid),
    };
    t.measure("oomScoreAdj", scores);
    t.check(
      "scores: tini -1000, ocsup -900, litestream -800, gateway >= 500",
      scores.tini === -1000 && scores.ocsup === -900 && scores.litestream === -800 && scores.gateway >= 500,
      scores,
    );
    b.as1000(`(${BALLOON}) >/dev/null 2>&1 &`);
    const k = Date.now();
    let gone = null;
    while (Date.now() - k < 120_000) {
      if (!b.running()) break;
      if (!ps(b).some((x) => /m1-npm-balloon/.test(x.cmd))) {
        gone = Date.now() - k;
        break;
      }
      await t.sleep(250);
    }
    const p2 = ps(b);
    t.measure("balloonGoneMs", gone);
    t.check("balloon killed", gone !== null, gone);
    t.check("container running", b.running());
    t.check("ocsup alive (same pid)", !!ocsup && p2.some((x) => x.pid === ocsup.pid));
    t.check("litestream alive (same pid)", !!ls && p2.some((x) => x.pid === ls.pid));
    t.measure("dmesgOom", b.sh("dmesg 2>/dev/null | grep -i 'killed process' | tail -3").out);
  },
};
