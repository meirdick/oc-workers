// Scope §4 M1 row 10, second half [Z1.16]: a planned DB-set change restarts Litestream with no admission
// close and no gateway stop.
import { writeRows } from "../harness/sqlite.mjs";

export default {
  name: "litestream-planned-set-change",
  source: "scope §4 M1 'A planned set-change restart does neither' [Z1.16]; plan §4.8 DB set",
  rule: "A new agents/<id>/agent/openclaw-agent.sqlite: Litestream restarts with the new set (replica-set event), no suspend.prepare / admission close, no gateway exit, and the new DB gets a level-0 upload.",
  needs: ["m1"],
  timeoutMs: 400_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1 });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    await t.sleep(5000);
    const k = Date.now();
    const n0 = b.ev("gateway-exit").length;
    writeRows(b, 5, { db: "agents/m1new/agent/openclaw-agent.sqlite", tag: "n" });
    let set = null;
    while (Date.now() - k < 60_000 && !set) {
      const st = await t.gateState();
      if (st.uploads?.[1]?.["agents/m1new/agent/openclaw-agent.sqlite"]?.l0MaxTxid > 0) set = Date.now() - k;
      else await t.sleep(500);
    }
    t.measure("newDbFirstL0Ms", set);
    t.check("new DB gets a level-0 upload", set !== null, set);
    const adm = b
      .events()
      .filter(
        (e) =>
          ((e.ev === "replica-stage" && /admission|stop/.test(e.to)) ||
            /admission|suspend-prepare|suspend\.prepare/.test(`${e.ev} ${e.step || ""}`)) &&
          Date.parse(e.ts) >= k,
      );
    t.check(
      "no admission close",
      adm.length === 0,
      adm.map((e) => e.ev),
    );
    t.check("no gateway exit", b.ev("gateway-exit").length === n0);
    t.check(
      "Litestream restarted for the set change",
      b
        .events()
        .some(
          (e) => e.ev !== "gw" && /litestream|replica-set/.test(JSON.stringify(e)) && Date.parse(e.ts) >= k,
        ),
    );
  },
};
