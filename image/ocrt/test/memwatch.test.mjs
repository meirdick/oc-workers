import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemwatch, decide, fit, hasHeapFlag, MW, projectMs } from "../lib/memwatch.mjs";
import { OOM_ADJ, oomFor, spawnPrelude } from "../lib/oom.mjs";

const G = 1024 ** 3;
const base = { vmTotal: 6 * G, vmAvail: 4 * G, gwMax: 5 * G, gwCurrent: 1 * G };

describe("memwatch", () => {
  it("tier 0 when healthy", () => {
    assert.equal(decide({ ...base, now: 0 }, {}).tier, 0);
  });

  it("tier 1 needs < 25% for 30 s", () => {
    const st = {};
    const low = { ...base, gwCurrent: 4 * G }; // 20% headroom
    assert.equal(decide({ ...low, now: 0 }, st).tier, 0);
    assert.equal(decide({ ...low, now: 29_000 }, st).tier, 0);
    assert.equal(decide({ ...low, now: 30_000 }, st).tier, 1);
    assert.equal(decide({ ...base, now: 31_000 }, st).tier, 0);
    assert.equal(st.lowSince, null);
  });

  it("tier 2 below 12%, tier 3 below 6%, the worse of VM and gw wins", () => {
    assert.equal(decide({ ...base, now: 0, vmAvail: 0.1 * 6 * G }, {}).tier, 2);
    const d = decide({ ...base, now: 0, gwCurrent: 4.8 * G }, {});
    assert.equal(d.tier, 3);
    assert.match(d.reasons[0], /^gw</);
  });

  it("heap tiers: > 80% idle restart, > 90% now", () => {
    const L = MW.heapLimitBytes;
    assert.equal(decide({ ...base, now: 0, heapUsed: 0.85 * L }, {}).tier, 1);
    assert.equal(decide({ ...base, now: 0, heapUsed: 0.91 * L }, {}).tier, 2);
    assert.equal(decide({ ...base, now: 0, heapUsed: 0.5 * L, heapLimit: 0.55 * L }, {}).tier, 2);
  });

  it("slope fallback: 5 min samples over 1 h; < 4 h tier 1, < 30 min tier 2", () => {
    assert.deepEqual(
      fit([
        { t: 0, v: 1 },
        { t: 2, v: 5 },
      ]),
      { slope: 2, intercept: 1 },
    );
    assert.equal(
      projectMs(
        [
          { t: 0, v: 10 },
          { t: 1, v: 9 },
        ],
        100,
        1,
      ),
      Number.POSITIVE_INFINITY,
    );
    const limit = MW.heapLimitBytes + MW.offHeapBaseBytes;
    const run = (ratePerMin) => {
      const st = {};
      let d;
      for (let m = 0; m <= 20; m++) {
        // sampled every minute; decide keeps one per 5 min
        d = decide({ ...base, now: m * 60_000, anon: limit - (60 - m) * ratePerMin }, st);
      }
      return { d, st };
    };
    // 10 MB/min: 40 min left at m=20 → tier 1
    const a = run(10 * 1024 ** 2);
    assert.equal(a.st.anon.length, 5);
    assert.equal(a.d.tier, 1);
    // The same slope while anon is under half the abort point: warm-up, not a leak → tier 0.
    const st = {};
    let d;
    for (let m = 0; m <= 20; m++)
      d = decide({ ...base, now: m * 60_000, anon: 0.1 * limit + m * 10 * 1024 ** 2 }, st);
    assert.equal(st.anon.length, 5);
    assert.equal(d.tier, 0);
    // 500 MB per 5 min: reaches the line in < 30 min → tier 2
    const b = decide(
      { ...base, now: 0, anon: limit - 1 },
      {
        anon: [
          { t: -1200_000, v: limit - 2 * G },
          { t: -900_000, v: limit - 1.5 * G },
          { t: -600_000, v: limit - G },
          { t: -300_000, v: limit - 0.5 * G },
        ],
        lastAnonAt: -300_000,
      },
    );
    assert.equal(b.tier, 2);
  });

  it("runner latches tier 1 once, acts on 2 and 3 each tick", async () => {
    const calls = [];
    let s = { ...base, now: 0, heapUsed: 0.85 * MW.heapLimitBytes };
    const mw = createMemwatch({
      sample: () => s,
      idleRestart: (r) => calls.push(["idle", r]),
      restartNow: (r) => calls.push(["now", r]),
      hardKill: (r) => calls.push(["kill", r]),
    });
    await mw.tick();
    await mw.tick();
    s = { ...base, now: 1, gwCurrent: 4.9 * G };
    await mw.tick();
    mw.reset();
    s = { ...base, now: 2, heapUsed: 0.85 * MW.heapLimitBytes };
    await mw.tick();
    assert.deepEqual(
      calls.map((c) => c[0]),
      ["idle", "kill", "idle"],
    );
  });

  it("no process-wide heap flag on the gateway", () => {
    assert.equal(
      hasHeapFlag(["--import", "/opt/ocrt/unpreload.mjs", "/app/openclaw.mjs", "gateway"], {}),
      false,
    );
    assert.equal(hasHeapFlag(["--max-old-space-size=2048"], {}), true);
    assert.equal(hasHeapFlag([], { NODE_OPTIONS: "--max-old-space-size=4096" }), true);
  });
});

describe("oom policy", () => {
  it("values per scope §1.1", () => {
    assert.deepEqual(
      { ...OOM_ADJ },
      { tini: -1000, ocsup: -900, litestream: -800, ocio: 0, cli: 300, gateway: 500 },
    );
    assert.throws(() => oomFor("gw"));
  });
  it("spawnPrelude joins the cgroup, sets oom, ignores TERM", () => {
    assert.deepEqual(spawnPrelude({ cg: "/c/ocrt/sys", role: "litestream", ignoreTerm: true }), [
      "echo $$ > /c/ocrt/sys/cgroup.procs 2>/dev/null || true",
      "echo -800 > /proc/self/oom_score_adj 2>/dev/null || true",
      "trap '' TERM",
    ]);
  });
});
