// Amend §3 row 'T7e row 10' (F5): fake gate throttled 150 s -> sleep-flush-failed, no snapshot, rows in
// the gen after recovery.
import { sleepOp, waitL0 } from "../harness/flows.mjs";
import { localRows, probeMaxId, restoreRows, writeRows } from "../harness/sqlite.mjs";

export default {
  name: "sleep-flush-throttle",
  source: "amend §3 row 'T7e row 10'; amend §1.5 F1.6",
  rule: "Throttle every ReplicaGate write (503) from before stop-gateway for 150 s: sleep-flush answers ok:false error sleep-flush-failed within 60 s + 10 s; then resume-after-sleep; after the throttle ends the gen has every local row.",
  needs: ["ocsupctl"],
  timeoutMs: 1_200_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1 });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    writeRows(b, 5, { tag: "s" });
    await waitL0(t, 1);
    const r = await sleepOp(t, b, {
      abortAt: null,
      after: {
        prepare: async () => {
          writeRows(b, 30, { tag: "t" });
          await t.faults({ throttle: { status: 503, untilTs: Date.now() + 150_000 } });
        },
      },
    });
    const fl = r.answers.flush;
    t.measure("flush", fl && { ok: fl.ok, error: fl.error, ms: fl._ms });
    t.check(
      "flush fails with sleep-flush-failed",
      fl && fl.ok === false && fl.error === "sleep-flush-failed",
      fl,
    );
    t.check("flush answers within 70 s", fl && fl._ms <= 70_000, fl?._ms);
    const res = b.ctl("resume-after-sleep", { opId: fl?.opId || "x" });
    t.measure("resume", res);
    await t.sleep(160_000);
    b.sigterm();
    await b.waitExit(300_000);
    const local = localRows(b, t.image);
    const rr = restoreRows(t.image, 1, {});
    t.check(
      "gen has every row after recovery",
      probeMaxId(rr) === probeMaxId(local) && probeMaxId(local) >= 30,
      { local: probeMaxId(local), restored: probeMaxId(rr) },
    );
    t.check("no final snapshot taken for the failed sleep", (await t.gateState()).finalSnapshots.length <= 1);
  },
};
