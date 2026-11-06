// Plan §4.12 self-fence; contract §4: 409 stale -> exit 77 with no final sync; no 2xx ack for fenceMs ->
// gateway stopped, container kept, gateway back after a good ack (event unfence).
import { exitInfo } from "../harness/flows.mjs";

export default {
  name: "heartbeat-fence",
  source: "plan §4.12 self-fence; contract §4 (fake faults hb409, hbDrop)",
  rule: "(a) hbDrop with fenceMs 20 s: gateway stopped by ~20 s after the last ack, container running, phase fenced; after the fault clears, event unfence and /startupz again. (b) hb409: exit 77 stale, no /v1/final-snapshot, no exit event.",
  needs: ["m1"],
  timeoutMs: 900_000,
  async run(t) {
    const a = t.box({
      name: "drop",
      gen: 1,
      env: { OCRT_HB_MS: "5000", OCRT_FENCE_MS: "20000" },
      plan: { timers: { hbMs: 5000, fenceMs: 20_000, startGateMs: 120_000 } },
    });
    await a.start();
    if (!t.check("(a) /startupz", (await a.startupz()) !== null)) return;
    const n0 = a.ev("gateway-exit").length;
    const k = Date.now();
    await t.faults({ hbDrop: true });
    const ex = await a.waitEv(() => a.ev("gateway-exit").length > n0, 90_000);
    const stopMs = ex ? Date.now() - k : null;
    t.measure("fenceStopMs", stopMs);
    t.check("(a) gateway stopped within fenceMs + 15 s", stopMs !== null && stopMs <= 40_000, stopMs);
    t.check("(a) container still running", a.running());
    await t.faults({ clear: true });
    const back = await a.waitEv(() => a.ev("startupz").length > 1, 240_000);
    t.check("(a) gateway back after a good ack", !!back);
    const unf = (await t.records({ plane: "control", route: "/v1/event" })).some(
      (r) => r.body?.kind === "unfence",
    );
    t.check("(a) unfence event", unf);
    a.rm();
    const b = t.box({
      name: "409",
      gen: 2,
      env: { OCRT_HB_MS: "5000" },
      plan: { timers: { hbMs: 5000, fenceMs: 150_000, startGateMs: 120_000 } },
    });
    await b.start();
    if (!t.check("(b) /startupz", (await b.startupz()) !== null)) return;
    const since = (await t.gateState()).seq;
    await t.faults({ hb409: true });
    await b.waitExit(120_000);
    const x = await exitInfo(t, b);
    t.check("(b) exit 77 stale", x.code === 77, x);
    const fs = (await t.records({ since, plane: "control", route: "/v1/final-snapshot" })).length;
    t.check("(b) no final-snapshot", fs === 0, fs);
  },
};
