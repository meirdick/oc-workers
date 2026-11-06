// Scope §4 M1 row 10 [Z1.16]; plan §4.8 replication fault response: Litestream down -> admission closes
// at +5 s (suspend.prepare drain:true), gateway stops at +15 s. Litestream is held down by killing each
// new Litestream pid for 25 s.
import { gateAlerts, gateEvents, ps } from "../harness/flows.mjs";

const isLs = (p) => /litestream replicate/.test(p.cmd);
// ocsup reports the fault ladder as replica-stage {from, to} (lib/ls-lag.mjs faultStage).
const admissionEv = (e) =>
  (e.ev === "replica-stage" && /admission/.test(e.to)) ||
  /admission|suspend-prepare|suspend\.prepare/.test(`${e.ev} ${e.step || ""}`);

export default {
  name: "litestream-sigkill-admission-close",
  source:
    "scope §4 M1 'Litestream SIGKILL: admission closes at +5 s ... gateway stops at +15 s' [Z1.16]; plan §4.8",
  rule: "First SIGKILL at k: admission-close (suspend.prepare drain:true) at k+5 s +-2 s; gateway exit at k+15 s +-3 s; replica-down event or alert; after Litestream is let back and lag <= I, the gateway starts again.",
  needs: ["m1"],
  timeoutMs: 600_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1 });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    await t.sleep(12_000);
    const k = Date.now();
    let adm = null;
    let gwStop = null;
    const n0 = b.ev("gateway-exit").length;
    while (Date.now() - k < 25_000) {
      const l = ps(b).filter(isLs);
      if (l.length) b.sh(`kill -KILL ${l.map((p) => p.pid).join(" ")}`);
      if (adm === null && b.events().some((e) => admissionEv(e) && Date.parse(e.ts) >= k))
        adm = Date.now() - k;
      if (gwStop === null && b.ev("gateway-exit").length > n0) gwStop = Date.now() - k;
      await t.sleep(100);
    }
    t.measure("admissionCloseMs", adm);
    t.measure("gatewayStopMs", gwStop);
    t.check("admission closed at +5 s (+-2 s)", adm !== null && adm >= 3000 && adm <= 7000, adm);
    t.check(
      "gateway stopped at +15 s (+-3 s)",
      gwStop !== null && gwStop >= 12_000 && gwStop <= 18_000,
      gwStop,
    );
    const down = (await gateEvents(t, "replica-down")).length + (await gateAlerts(t, "replica-down")).length;
    t.check("replica-down reported", down > 0, down);
    const back = await b.waitEv(() => b.ev("startupz").length > 1, 240_000);
    t.check("gateway starts again after Litestream recovers", !!back);
  },
};
