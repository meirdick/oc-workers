// Amend §1.6 S1, S2 (M1 seed-budget, scaled): marker wakes of a 100 MB set -> seedBytes ~ 3x the set per
// wake, outside the tier budget; a forced second TXID-1 L0 key in one gen -> refused, replica-reseed.
// Tier changes are Control DO logic (M2); here the fake's seed/tier byte split is the record.

import { IP } from "../harness/env.mjs";
import { sleepOp, sleepSnapshot, waitL0, wake } from "../harness/flows.mjs";

const N = Number(process.env.OCM1_SEED_WAKES || 3);
const BIG = `node -e 'const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync("/home/node/.openclaw/state/openclaw.sqlite");c.exec("PRAGMA journal_mode=WAL;create table if not exists m1_big(b blob)");const s=c.prepare("insert into m1_big values(randomblob(1048576))");c.exec("begin");for(let i=0;i<100;i++)s.run();c.exec("commit");c.close();console.log("100MB")'`;

export default {
  name: "seed-budget",
  source: "amend §1.6 S1-S2 (M1 seed-budget, scaled to N marker wakes)",
  rule: `${N} marker wakes of a ~100 MB state DB: per wake gen, seed bytes (L0 min TXID 1 + L9 + L1-3 up to 1.5x) between 2x and 3.5x the DB size; non-seed (tier) bytes < 10% of seed bytes. A second TXID-1 level-0 PUT in one gen -> 409 and alert replica-reseed.`,
  needs: ["ocsupctl"],
  timeoutMs: 3_600_000,
  async run(t) {
    const a = t.box({ name: "g1", gen: 1 });
    await a.start();
    if (!t.check("g1 /startupz", (await a.startupz()) !== null)) return;
    t.check("100 MB written", /100MB/.test(a.as1000(BIG).out));
    await waitL0(t, 1, { timeoutMs: 300_000 });
    let box = a;
    const per = [];
    for (let i = 0; i < N; i++) {
      const r = await sleepOp(t, box);
      if (!t.check(`sleep ${i + 1} flush ok`, r.answers.flush?.ok, r.answers.flush)) return;
      const { snap, marker } = sleepSnapshot(t, box, r.answers.flush);
      const st0 = await t.gateState();
      const w = await wake(t, box, { snap, sqlite: marker, name: `w${i + 1}` });
      if (!t.check(`wake ${i + 1} /startupz`, w.ms !== null, w.ms)) return;
      await t.sleep(90_000); // seed L0 + L9 + first L1 compaction
      const st = await t.gateState();
      const u = st.uploads?.[w.box.o.gen]?.["state/openclaw.sqlite"] || {};
      per.push({
        gen: w.box.o.gen,
        seedMB: +(u.seedBytes / 1e6).toFixed(1),
        bytesMB: +(u.bytes / 1e6).toFixed(1),
        tierDeltaMB: +((st.tierBytes - st0.tierBytes) / 1e6).toFixed(1),
        levels: u.levels,
      });
      box = w.box;
    }
    t.measure("perWake", per);
    t.check(
      "seed bytes 2x-3.5x of 100 MB per wake",
      per.length === N && per.every((p) => p.seedMB >= 200 && p.seedMB <= 350),
      per.map((p) => p.seedMB),
    );
    t.check(
      "tier bytes < 10% of seed per wake",
      per.every((p) => p.tierDeltaMB < p.seedMB * 0.1),
      per.map((p) => p.tierDeltaMB),
    );
    // Forced reseed: a second level-0 key with min TXID 1 in the current gen, straight to ReplicaGate.
    const gen = box.o.gen;
    const key = `r/m1/g${gen}/state/openclaw.sqlite/0000/0000000000000001-00000000000000ff.ltx`;
    const res = await fetch(`http://${IP.replica}/oc-host-m1/${key}`, { method: "PUT", body: "x" });
    const st = await t.gateState();
    t.check("forced reseed refused (409)", res.status === 409, res.status);
    t.check(
      "alert replica-reseed",
      (st.alerts || []).some((x) => x.class === "replica-reseed"),
    );
  },
};
