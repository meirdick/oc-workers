// Amend §3 row 'T7e row 11': resume-after-sleep on the same gen, lag <= I, /startupz.
import { gatewayPid, sleepOp, waitL0 } from "../harness/flows.mjs";
import { probeMaxId, restoreRows, writeRows } from "../harness/sqlite.mjs";

export default {
  name: "resume-after-sleep",
  source: "amend §3 row 'T7e row 11'; add §2.6 abort path",
  rule: "Sleep op to flush ok, then resume-after-sleep: ok within 60 s; Litestream on the same gen (no new gen prefix written); gateway /startupz; rows written after the resume reach g<gen> level 0 within 5 s (lag <= I); rootfs changes kept (marker file written before the sleep is still there).",
  needs: ["ocsupctl"],
  timeoutMs: 900_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 3 });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    b.as1000("echo keep > /home/node/.openclaw/workspace-m1-keep.txt");
    writeRows(b, 20, { tag: "pre" });
    t.measure("firstL0Ms", await waitL0(t, 3));
    const pid0 = gatewayPid(b);
    const r = await sleepOp(t, b, { abortAt: "flush" });
    t.measure("busyRetries", r.busyRetries);
    t.check(
      "phases to flush ok",
      !r.busy && Object.values(r.answers).every((a) => a.ok),
      Object.keys(r.answers),
    );
    t.measure("resumeMs", r.abortAnswer?._ms);
    t.check(
      "resume-after-sleep ok <= 60 s",
      r.abortAnswer?.ok === true && r.abortAnswer._ms <= 60_000,
      r.abortAnswer,
    );
    const z = await b.waitEv(() => b.ev("startupz").length > 1, 120_000);
    t.check("/startupz after resume", !!z);
    t.check("new gateway pid", gatewayPid(b) !== pid0 && gatewayPid(b) > 0);
    // A new L0 txid, not just any PUT after k: the flush's final upload can land after k.
    const tx0 = (await t.gateState()).uploads?.[3]?.["state/openclaw.sqlite"]?.l0MaxTxid ?? 0;
    const k = Date.now();
    writeRows(b, 10, { tag: "post" });
    let ok = null;
    while (Date.now() - k < 15_000 && ok === null) {
      const st = await t.gateState();
      const u = st.uploads?.[3]?.["state/openclaw.sqlite"];
      if (u && (u.l0MaxTxid ?? 0) > tx0) ok = Date.now() - k;
      else await t.sleep(250);
    }
    t.measure("l0TxidBeforePost", tx0);
    t.check(
      "Litestream running after resume",
      b.ev("litestream-start").some((e) => Date.parse(e.ts) >= k - 120_000) ||
        /litestream replicate/.test(b.sh("ps -eo args").out),
    );
    t.measure("postResumeL0Ms", ok);
    t.check("write after resume reaches g3 within 5 s", ok !== null && ok <= 5000, ok);
    const st = await t.gateState();
    t.check(
      "no upload to another gen",
      Object.keys(st.uploads || {}).every((g) => g === "3"),
      Object.keys(st.uploads || {}),
    );
    t.check(
      "rootfs change kept",
      /keep/.test(b.as1000("cat /home/node/.openclaw/workspace-m1-keep.txt").out),
    );
    b.sigterm();
    await b.waitExit(300_000);
    const rr = restoreRows(t.image, 3, {});
    t.check("restore of g3 has pre and post rows", probeMaxId(rr) >= 30, rr.probe);
  },
};
