// Scope §4 M1 row 6 (part 1): memwatch prevents a gw cgroup OOM in 10/10 hog runs (plan §4.6 tiers).
import { gatewayPid, inGw, ps } from "../harness/flows.mjs";

// uid 1000 hog in the gateway cgroup: +64 MiB every 250 ms (256 MiB/s), touched pages, until killed.
const HOG = `exec node --max-old-space-size=64 -e 'process.title="m1-hog";const a=[];setInterval(()=>{a.push(Buffer.alloc(64<<20,1))},250)'`;
const RUNS = Number(process.env.OCM1_HOG_RUNS || 10);
const oomKills = (b) => {
  const ev = b.sh("cat /sys/fs/cgroup/ocrt/gw/memory.events 2>/dev/null").out;
  return Number(/oom_kill (\d+)/.exec(ev)?.[1] ?? -1);
};

export default {
  name: "memwatch-10-hog-runs",
  source: "scope §4 M1 'memwatch prevents a gw cgroup OOM in 10/10 hog runs' [Z1.14]; plan §4.6",
  rule: `${RUNS} runs of a 256 MiB/s hog in ocrt/gw (memory.max = VM - 1 GiB): ocrt/gw memory.events oom_kill stays 0; the hog is gone after each run; the gateway is back at /startupz after each run; ocsup never exits.`,
  needs: ["m1"],
  timeoutMs: 3_600_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1, memory: "4g" });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    const per = [];
    for (let i = 0; i < RUNS; i++) {
      const n0 = b.ev("startupz").length;
      const gw0 = gatewayPid(b);
      const k0 = oomKills(b);
      const t0 = Date.now();
      inGw(b, HOG, { detach: true });
      let hogGone = null;
      await t.sleep(1000);
      while (Date.now() - t0 < 120_000) {
        const hasHog = ps(b).some((p) => p.uid === 1000 && /m1-hog/.test(p.cmd));
        if (!hasHog) {
          hogGone = Date.now() - t0;
          break;
        }
        await t.sleep(250);
      }
      const back = await b.waitEv(() => b.ev("startupz").length > n0 || gatewayPid(b) === gw0, 240_000);
      const k1 = oomKills(b);
      const acts = b
        .events()
        .filter((e) => /memwatch|mem-tier|reap/.test(e.ev) && Date.parse(e.ts) >= t0)
        .map((e) => e.ev);
      per.push({
        run: i + 1,
        hogGoneMs: hogGone,
        oomKillDelta: k1 - k0,
        actions: [...new Set(acts)],
        gatewayBack: !!back,
      });
      t.note(`run ${i + 1}: ${JSON.stringify(per.at(-1))}`);
      if (!b.running()) break;
    }
    t.measure("runs", per);
    t.check(
      `${RUNS}/${RUNS} runs: no gw oom_kill`,
      per.length === RUNS && per.every((r) => r.oomKillDelta === 0),
      per.map((r) => r.oomKillDelta),
    );
    t.check(
      "hog removed each run",
      per.every((r) => r.hogGoneMs !== null),
      per.map((r) => r.hogGoneMs),
    );
    t.check(
      "gateway back each run",
      per.every((r) => r.gatewayBack),
    );
    t.check("ocsup still running", b.running());
  },
};
