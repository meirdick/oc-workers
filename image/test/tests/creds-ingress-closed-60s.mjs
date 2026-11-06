// Scope §4 M1 row 5 (part 3): while credsync is down for 60 s, ingress is closed (plan §4.2: alert
// credsync-down after 30 s; scope: ingress closed at 60 s). The watcher is kept down by killing every
// new watcher pid at once.
import { gateAlerts, ps } from "../harness/flows.mjs";

const isWatcher = (p) => p.uid === 1000 && /ocio/.test(p.cmd) && /cred/i.test(p.cmd);
const closedLine = (e) =>
  /admission|ingress-closed|suspend-prepare|suspend\.prepare|credsync-down/.test(
    `${e.ev} ${e.why || ""} ${e.reason || ""}`,
  );

export default {
  name: "creds-ingress-closed-60s",
  source: "scope §4 M1 'While credsync is down for 60 s, ingress is closed'; plan §4.2",
  rule: "Watcher kept down: alert credsync-down by 35 s; ingress closed (ocsup admission-close / suspend.prepare event) by 65 s and not before 55 s; after the watcher is let back, ingress opens again.",
  needs: ["m1", "ocio", "credsync"],
  timeoutMs: 400_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1 });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    await t.sleep(3000);
    const k = Date.now();
    let closedAt = null;
    let alertAt = null;
    while (Date.now() - k < 80_000) {
      const w = ps(b).filter(isWatcher);
      if (w.length) b.sh(`kill -KILL ${w.map((p) => p.pid).join(" ")}`);
      if (
        closedAt === null &&
        b
          .events()
          .some((e) => closedLine(e) && !/credsync-down/.test(e.ev) && e.t >= 0 && Date.parse(e.ts) >= k)
      )
        closedAt = Date.now() - k;
      if (alertAt === null && (await gateAlerts(t, "credsync-down")).length) alertAt = Date.now() - k;
      await t.sleep(200);
    }
    t.measure("alertMs", alertAt);
    t.measure("closedMs", closedAt);
    t.check("alert credsync-down by 35 s", alertAt !== null && alertAt <= 35_000, alertAt);
    t.check(
      "ingress closed between 55 and 65 s",
      closedAt !== null && closedAt >= 55_000 && closedAt <= 65_000,
      closedAt,
    );
    // Let it back.
    const r = Date.now();
    let open = null;
    while (Date.now() - r < 90_000 && open === null) {
      if (
        b
          .events()
          .some(
            (e) =>
              /admission-open|ingress-open|suspend-resume|credsync-up/.test(e.ev) && Date.parse(e.ts) >= r,
          )
      )
        open = Date.now() - r;
      await t.sleep(500);
    }
    t.measure("reopenMs", open);
    t.check("ingress opens again after the watcher returns", open !== null, open);
  },
};
