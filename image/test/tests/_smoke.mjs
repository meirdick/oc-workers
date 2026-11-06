// Harness self-check (not an exit test): one fresh boot, rows, platform SIGTERM, restore of the gen.
import { probeCount, restoreRows, writeRows } from "../harness/sqlite.mjs";

export default {
  name: "_smoke",
  source: "harness self-check",
  rule: "boot reaches /startupz; heartbeat reaches the fake gate; SIGTERM exits 0; the gen restores the rows",
  timeoutMs: 300_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1 });
    await b.start();
    const ms = await b.startupz(180_000);
    t.check("startupz", ms !== null, { ms });
    const w = writeRows(b, 20, { tag: "s" });
    t.check("20 rows written", w.code === 0, w.err.slice(-200) || undefined);
    await t.sleep(12_000); // DB-set scan (10 s in M0) + sync
    const hb = await t.records({ plane: "control", route: "/v1/heartbeat" });
    t.check("heartbeat seen by fake gate", hb.length > 0, {
      n: hb.length,
      contract: hb.map((r) => r.contract).slice(0, 3),
    });
    b.sigterm();
    const s = await b.waitExit(120_000);
    t.check("exit 0 after SIGTERM", s?.exitCode === 0, s);
    const st = await t.gateState();
    t.measure("uploads", st.uploads);
    const r = restoreRows(t.image, 1, {});
    t.check("restore of g1 has the 20 rows", probeCount(r, "s") === 20, r);
  },
};
