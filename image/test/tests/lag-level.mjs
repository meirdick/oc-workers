// Amend §1.5 F1.5 (M1 lag-level): the gate records the L9 key at start and refuses level-0 PUTs ->
// lag > 0 at once (not 0), fault path at I + 10 s.
export default {
  name: "lag-level",
  source: "amend §1.5 F1.5 (M1 lag-level); contract §4 lag rule",
  rule: "Fake refuses level-0 PUTs from the start; L9 accepted. Heartbeat litestream.dbs[].lag > 0 (or null) for the state DB, never 0 while refused; replica fault path (admission close / replica-down) starts at I + 10 s (+-3 s) after the first write.",
  needs: ["m1"],
  timeoutMs: 600_000,
  async run(t) {
    await t.faults({ throttle: { refuseLevel: 0, status: 503 } });
    const b = t.box({
      name: "a",
      gen: 1,
      env: { OCRT_HB_MS: "5000" },
      plan: { timers: { hbMs: 5000, fenceMs: 150_000, startGateMs: 0 } },
    });
    await b.start();
    const k = Date.now();
    let fault = null;
    const lags = [];
    while (Date.now() - k < 160_000) {
      const hb = await t.records({ plane: "control", route: "/v1/heartbeat" });
      for (const h of hb)
        for (const d of h.body?.litestream?.dbs || [])
          if (d.db === "state/openclaw.sqlite")
            lags.push({ ts: h.ts - k, lag: d.lag, local: d.localTxid, remote: d.remoteTxid });
      if (
        fault === null &&
        b
          .events()
          .some(
            (e) =>
              (e.ev === "replica-stage" && e.to !== "ok" && e.to !== "late") ||
              /admission|replica-down|replica-blocked|suspend/.test(`${e.ev} ${e.reason || ""}`),
          )
      )
        fault = Date.now() - k;
      if (fault !== null && lags.length > 3) break;
      await t.sleep(1000);
    }
    const st = await t.gateState();
    const levels = st.uploads?.[1]?.["state/openclaw.sqlite"]?.levels || {};
    t.measure("levels", levels);
    t.measure("lags", lags.slice(0, 12));
    t.measure("faultMs", fault);
    t.check("L9 recorded, no level-0", (levels[9] || 0) > 0 && !(levels[0] > 0), levels);
    const withLocal = lags.filter((l) => (l.local ?? 0) > 0);
    t.check(
      "lag never 0 while level 0 is refused",
      withLocal.length > 0 && withLocal.every((l) => l.lag === null || l.lag > 0),
      withLocal.slice(0, 5),
    );
    t.check("fault path started", fault !== null, fault);
  },
};
