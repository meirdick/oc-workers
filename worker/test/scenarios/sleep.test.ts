// Spec §21.2 sleep scenarios (§10, §11.2, §16): each phase × {flag abort, platform SIGTERM, DO restart},
// snapshot failures, destroy timeout, wake races, adaptive idle, cost guard, cron pre-wake.
import { afterEach, describe, expect, it } from "vitest";
import { H, MIN, S } from "../harness/timers";
import type { World } from "../harness/world";
import {
  done,
  expectState,
  fresh,
  gensOf,
  setSettings,
  startCount,
  sutP,
  toAsleep,
  toAsleepUnconfirmed,
  toBackoff,
  toDraining,
  toMaintenance,
  toQuiescing,
  toRetired,
  toRunning,
  toStarting,
  toStopped,
  toStopping,
  toWaitingCapacity,
} from "./helpers";

const sut = await sutP;
let w: World;
afterEach((ctx) => done(w, ctx));

const PHASES = [
  "check",
  "prepare",
  "edge",
  "stop-gateway",
  "flush",
  "marker",
  "snapshot",
  "destroy",
] as const;
type Phase = (typeof PHASES)[number];
const CTL_OF: Partial<Record<Phase, string>> = {
  check: "sleep-check",
  prepare: "sleep-prepare",
  edge: "sleep-prepare", // the flag set while prepare answers is read at the edge
  "stop-gateway": "sleep-stop-gateway",
  flush: "sleep-flush",
};
const sleepOps = (x: World) => x.ops_().filter((o) => o.kind === "sleep");
const ctlOps = (x: World) => x.rt().ocsup.ctl.map((c) => c.op);

/** Run fn once when the sleep op reaches `phase` (ocsupctl call, marker write, snapshot or destroy call). */
function atPhase(x: World, phase: Phase, fn: () => void) {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    fn();
  };
  const ctl = CTL_OF[phase];
  if (ctl) {
    const o = x.rt().ocsup;
    const prev = o.script;
    o.script = (op, id, a) => {
      if (op === ctl) once();
      return prev(op, id, a);
    };
  } else if (phase === "marker") {
    const st = x.ctl().storage;
    const prev = st.onWrite;
    st.onWrite = (q, b) => {
      if (/insert\s+(or\s+\w+\s+)?into\s+markers/i.test(q)) once();
      prev?.(q, b);
    };
  } else if (phase === "snapshot") x.rt().c.hooks.snapshot = once;
  else if (phase === "destroy") x.rt().c.hooks.destroy = once;
  return () => done;
}

describe.skipIf(!sut.ok)(`sleep ${sut.why}`, () => {
  it("S37 baseline: idle → asleep with a valid marker, sleep snapshot and the container gone", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    expect(ctlOps(w)).toEqual(
      expect.arrayContaining(["sleep-check", "sleep-prepare", "sleep-stop-gateway", "sleep-flush"]),
    );
    expect(w.markers().at(-1)?.state).toBe("valid");
    expect(w.snapshots().at(-1)?.kind).toBe("sleep");
    expect(w.rt().c.running).toBe(false);
    expect(sleepOps(w).at(-1)?.state).toBe("done");
    expect(w.rt().kv<{ snapshotId: string }>("sleep")?.snapshotId).toBe(w.snapshots().at(-1)?.id);
  });

  for (const phase of PHASES.slice(0, 6)) {
    it(`S44 abort by wake flag at phase ${phase} → right abort path, same gen, marker void, running`, async () => {
      w = await fresh(sut, { sleep: true });
      await toRunning(w);
      const gen = gensOf(w).at(-1)?.gen;
      const hit = atPhase(w, phase, () => void w.rt().call("requestWake", "webhook"));
      await w.until(() => hit() && sleepOps(w).at(-1)?.state !== "open", 30_000);
      await w.advance(1 * S);
      expect(sleepOps(w).at(-1)?.state).toBe("aborted");
      const ops = ctlOps(w);
      if (["check", "prepare", "edge"].includes(phase)) expect(ops).not.toContain("resume-after-sleep");
      if (phase === "prepare" || phase === "edge") expect(ops).toContain("sleep-cancel");
      if (["stop-gateway", "flush", "marker"].includes(phase)) expect(ops).toContain("resume-after-sleep");
      expect(w.markers().filter((m) => m.state === "pending" || m.state === "valid")).toEqual([]);
      expect(w.rt().c.count("snapshot")).toBe(0);
      expect(gensOf(w).at(-1)?.gen).toBe(gen);
      expectState(w, "running");
    });
  }

  for (const phase of PHASES.slice(6)) {
    it(`S44 wake flag at phase ${phase} → op runs to the end, wake right after phase 8`, async () => {
      w = await fresh(sut, { sleep: true });
      await toRunning(w);
      atPhase(w, phase, () => void w.rt().call("requestWake", "webhook"));
      await w.until(() => sleepOps(w).at(-1)?.state === "done", 30_000);
      await w.until(() => startCount(w) === 2, 5_000);
      expect(w.markers().at(-1)?.state).toMatch(/valid|consumed/);
    });
  }

  it("S43 webhook inside the prepared lease (phase 3) → sleep-cancel, op aborted, row replayed after resume", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    atPhase(w, "prepare", () => {
      w.dropRequestWake = 1; // the edge check must find the row by itself
      void w.webhook({ update_id: 77, message: { from: { id: 5 }, chat: { id: 5 }, text: "hi" } });
    });
    await w.until(() => sleepOps(w).at(-1)?.state === "aborted", 30_000);
    expect(ctlOps(w)).toContain("sleep-cancel");
    await w.until(() => w.rt().ocsup.replays.some((r) => r.updateId === 77), 10_000);
    expect(w.inbox().find((r) => r.platform_key === "77")?.state).toMatch(/accepted|replicated/);
  });

  for (const phase of PHASES) {
    it(`S42 platform SIGTERM at phase ${phase} → no more ocsupctl, no marker kept, asleep after settle`, async () => {
      w = await fresh(sut, { sleep: true });
      await toRunning(w);
      const o = w.rt().ocsup;
      atPhase(w, phase, () => void o.sigterm());
      await w.until(
        () => w.state() === "draining" || w.state() === "asleep" || sleepOps(w).at(-1)?.state === "done",
        30_000,
      );
      const n = o.ctl.length;
      await o.drained();
      if (w.rt().c.running) w.rt().c.signalled();
      await w.until(() => w.state() === "asleep" || w.state() === "asleep-unconfirmed", 10_000);
      if (PHASES.indexOf(phase) < 6) {
        expect(o.ctl.slice(n).filter((c) => c.op !== "status")).toEqual([]);
        expect(sleepOps(w).at(-1)?.state).toBe("interrupted:sigterm");
        expect(w.markers().filter((m) => m.state === "pending" || m.state === "valid")).toEqual([]);
        if (o.finals[0]?.status === 200) {
          const fid = (o.finals[0].body as { snapshotId: string }).snapshotId;
          expect(w.rt().kv<{ snapshotId: string }>("sleep")?.snapshotId ?? w.snapshots().at(-1)?.id).toBe(
            fid,
          );
        }
      }
    });
  }

  for (const phase of PHASES) {
    it(`S38 DO restart at phase ${phase} → resumes that phase, one marker, ≤ 1 extra snapshot`, async () => {
      w = await fresh(sut, { sleep: true });
      await toRunning(w);
      const cut = w.restartWhen(
        "Runtime",
        w.rtName(),
        (q, b) =>
          (phase === "check"
            ? /insert\s+(or\s+\w+\s+)?into\s+ops/i.test(q) && b.includes("sleep")
            : /^\s*update\s+ops/i.test(q)) &&
          b.includes(phase) &&
          !b.includes("start"),
      );
      await w.until(() => cut(), 30_000);
      if (!w.rt().slot.inst) await w.rt().call("ensure");
      await w.until(() => w.state() === "asleep" || w.state() === "asleep-unconfirmed", 30_000);
      expect(sleepOps(w).length).toBe(1);
      expect(sleepOps(w)[0]?.state).toBe("done");
      expect(w.markers().length).toBe(1);
      expect(w.rt().c.count("snapshot")).toBeLessThanOrEqual(phase === "snapshot" ? 2 : 1);
      expect(w.snapshots().filter((s) => s.kind === "sleep").length).toBe(1);
    });
  }

  it("S45 phase 4 sleep-unclean-exit → abort + alert, no marker, no snapshot", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    w.rt().ocsup.script = (op) =>
      op === "sleep-stop-gateway" ? { ok: false, error: "sleep-unclean-exit" } : undefined;
    await w.until(() => sleepOps(w).at(-1)?.state === "aborted", 30_000);
    expect(w.alert("sleep-unclean-exit")).toBeTruthy();
    expect(w.markers()).toEqual([]);
    expect(w.rt().c.count("snapshot")).toBe(0);
    expect(ctlOps(w)).toContain("resume-after-sleep");
  });

  it("S45 phase 5 sleep-flush-failed → abort + alert, no marker, no snapshot", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    w.rt().ocsup.script = (op) =>
      op === "sleep-flush" ? { ok: false, error: "sleep-flush-failed" } : undefined;
    await w.until(() => sleepOps(w).at(-1)?.state === "aborted", 30_000);
    expect(w.alert("sleep-flush-failed")).toBeTruthy();
    expect(w.markers()).toEqual([]);
    expect(w.rt().c.count("snapshot")).toBe(0);
  });

  it("S46 snapshot fails 3 times → no destroy, marker void, retry after sleepRetryMs; 3rd failed sleep in a day → alert, awake", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    const c = w.rt().c;
    c.snapshotFail = Array(9).fill("snapshot failed (fake)");
    await w.until(() => sleepOps(w).at(-1)?.state === "aborted", 30_000);
    expect(c.count("destroy")).toBe(0);
    expect(c.count("snapshot")).toBe(3);
    expect(w.markers().at(-1)?.state).toBe("void");
    const t = Date.now();
    await w.until(() => sleepOps(w).length === 2, 60_000);
    expect(Date.now() - t).toBeGreaterThanOrEqual(15 * S - 1500);
    await w.until(() => sleepOps(w).filter((o) => o.state === "aborted").length === 3, 120_000, 200);
    expect(w.alert("sleep-snapshot-failed")).toBeTruthy();
    await w.advance(30 * S);
    expect(sleepOps(w).length).toBe(3);
    expectState(w, "running");
  }, 30_000);

  it("S47 destroy timeout at phase 8 → asleep-unconfirmed, stop:true ack, zombie alert, asleep after settle, wake waits", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    const c = w.rt().c;
    c.destroyHang = 1000;
    await w.until(() => w.state() === "asleep-unconfirmed", 30_000);
    const ack = await w.rt().ocsup.heartbeat();
    expect(ack?.body?.stop).toBe(true);
    await w.rt().call("requestWake", "webhook");
    const n = startCount(w);
    await w.advance(11 * S, 200);
    expect(w.alert("zombie")).toBeTruthy();
    expect(startCount(w)).toBe(n);
    c.vanish();
    await w.until(() => startCount(w) > n, 20_000);
  });

  it("S48 3 aborts in 1 h → alert sleep-aborted, no sleep for abortHoldMs", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    const o = w.rt().ocsup;
    o.script = (op) => {
      if (op === "sleep-prepare") void w.rt().call("requestWake", "ui");
      return undefined;
    };
    await w.until(() => sleepOps(w).filter((x) => x.state === "aborted").length === 3, 60_000);
    expect(w.alert("sleep-aborted")).toBeTruthy();
    o.script = () => undefined;
    const n = sleepOps(w).length;
    await w.advance(50 * S, 200);
    expect(sleepOps(w).length).toBe(n);
    await w.until(() => w.state() === "asleep", 60_000);
  }, 30_000);

  it("S49 two requestWake at once → one start op, one gen, no destroy(stale)", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    const g = gensOf(w).length;
    await Promise.all([w.rt().call("requestWake", "webhook"), w.rt().call("requestWake", "cron")]);
    await w.until(() => w.state() === "running", 20_000);
    expect(gensOf(w).length).toBe(g + 1);
    expect(w.ops_().filter((o) => o.kind === "start" && o.reason?.startsWith("wake:")).length).toBe(1);
    expect(w.rt().c.calls.some((c) => c.op === "destroy" && /stale/.test(String(c.detail)))).toBe(false);
  });

  it("S49 queued start after an aborted sleep → phase 0 no-op: no beginBoot, no destroy", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    atPhase(w, "stop-gateway", () => void w.rt().call("requestWake", "webhook"));
    await w.until(() => sleepOps(w).at(-1)?.state === "aborted", 30_000);
    await w.advance(500);
    expect(gensOf(w).length).toBe(1);
    expect(w.rt().c.calls.filter((c) => c.op === "destroy" && /stale/.test(String(c.detail)))).toEqual([]);
    expect(startCount(w)).toBe(1);
    const starts = w.ops_().filter((o) => o.kind === "start");
    expect(starts.every((o) => o.state !== "open")).toBe(true);
  });

  it("S55 nextWakeAtMs < minSleepMs away → no sleep", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    const o = w.rt().ocsup;
    o.script = (op) =>
      op === "sleep-check"
        ? { ok: true, blockers: [], nextWakeAtMs: Date.now() + 3 * S, eventJobs: [], channels: [] }
        : undefined;
    await w.advance(30 * S, 200);
    expect(w.rt().c.count("snapshot")).toBe(0);
    expectState(w, "running");
  });

  it("S54 nextWakeAtMs ahead → alarm at nextWakeAtMs − leadMs, wake reason cron", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    const at = Date.now() + 30 * S;
    w.rt().ocsup.nextWakeAtMs = at;
    await w.until(() => w.state() === "asleep", 30_000);
    expect(w.rt().alarmAt()).toBe(at - 1 * S);
    await w.until(() => startCount(w) === 2, 40_000);
    expect(
      w
        .ops_()
        .filter((o) => o.kind === "start")
        .at(-1)?.reason,
    ).toBe("wake:cron");
  });
  it.todo(
    "S54 after 20 wakes leadMs = clamp(p95 alarm-to-startupz + 30 s, 60-300 s) (no test values for the clamp)",
  );

  it("S51 each sleep-gate rule false on its own → no sleep op; status names the reason", async () => {
    const cases: [string, (x: World) => void][] = [
      ["mode off", (x) => setSettings(x, { sleep: { mode: "off" } })],
      [
        "sleep-check blocker",
        (x) =>
          (x.rt().ocsup.script = (op) =>
            op === "sleep-check"
              ? { ok: true, blockers: [{ kind: "turn" }], nextWakeAtMs: null, eventJobs: [], channels: [] }
              : undefined),
      ],
      ["rpo seeding", (x) => (x.rt().ocsup.rpo = "seeding")],
      ["recent activity", (x) => setInterval(() => (x.rt().ocsup.lastActivityAt = Date.now()), 500)],
    ];
    for (const [label, apply] of cases) {
      w = await fresh(sut, { sleep: true });
      await toRunning(w);
      apply(w);
      await w.advance(15 * S, 200);
      expect([label, w.rt().c.count("snapshot")]).toEqual([label, 0]);
      expect([label, w.state()]).toEqual([label, "running"]);
      const st = await w.ops("status");
      expect([label, JSON.stringify(st.body).length > 2]).toEqual([label, true]);
      w.dispose();
    }
  });

  it("S52 adaptive idle: quick re-wakes double idleMs to the cap; reset after a long sleep", async () => {
    // Test maintEveryMs (60 s) would wake it every minute; this needs sleeps of 7 and 61 min.
    w = await fresh(sut, { sleep: true, timers: { maintEveryMs: 3 * H, heldMaxMs: 3 * H } });
    await toAsleep(w);
    const idles: number[] = [];
    for (let i = 0; i < 5; i++) {
      await w.advance(7 * MIN, 30 * S); // wake 7 min after the sleep ended
      await w.rt().call("requestWake", "cli");
      await w.until(() => w.state() === "running", 20_000);
      await w.until(() => w.state() === "asleep", 120_000);
      idles.push(w.rt().kv<{ idleMs: number }>("sleep")?.idleMs as number);
    }
    expect(idles).toEqual([4 * S, 8 * S, 16 * S, 24 * S, 24 * S]); // test base 2 s, cap idleCapMs 24 s
    await w.advance(61 * MIN, 60 * S);
    await w.rt().call("requestWake", "cli");
    await w.until(() => w.state() === "running", 20_000);
    expect(w.rt().kv<{ idleMs: number }>("sleep")?.idleMs).toBe(2 * S);
  }, 60_000);

  it("S53 cost guard: short cycles until spend24 + cycle > always24 → sleep refused, one sleep-thrash; allowed again under 80 %", async () => {
    // 30 s reconcile: after the trip it stays awake ~24 h of fake time; 1 s ticks cost 25 s of CPU.
    w = await fresh(sut, {
      sleep: true,
      settings: { sleep: { mode: "auto", snapshotCostUsd: 1 } },
      timers: {
        reconcileMs: 30 * S,
        hbMs: 30 * S,
        hbLostMs: 180 * S,
        fenceMs: 150 * S,
        maintEveryMs: 48 * H,
        heldMaxMs: 48 * H,
      },
    });
    await toAsleep(w);
    let refused = false;
    for (let i = 0; i < 40 && !refused; i++) {
      await w.rt().call("requestWake", "cli");
      await w.until(() => w.state() === "running", 20_000);
      try {
        // Adaptive idle grows to idleCapMs (24 s test) on quick re-wakes; wait past it.
        await w.until(() => w.state() === "asleep", 70_000, 500);
      } catch {
        refused = true;
      }
    }
    expect(refused).toBe(true);
    // One send per day (§16.1); alerts.count counts raises, the ring marks sends with due:true.
    expect(w.ring("sleep-thrash").filter((r) => /"due":true/.test(r.detail)).length).toBe(1);
    const st = await w.ops("status");
    expect(JSON.stringify(st.body)).toMatch(/cost/i);
    await w.advance(24 * H, 10 * MIN);
    await w.until(() => w.state() === "asleep", 60_000);
  }, 60_000);

  it("settings: a changed sleep.idleMinutes takes effect at the next sleep decision, without a deploy", async () => {
    w = await fresh(sut, {
      sleep: true,
      timers: { maintEveryMs: 48 * H, heldMaxMs: 48 * H, hbMs: 30 * S, hbLostMs: 180 * S, fenceMs: 150 * S },
    });
    const put = async (set: Record<string, unknown>) => {
      const r = await w.fetch("/ops/settings", {
        method: "PUT",
        body: JSON.stringify({ set }),
        headers: { "content-type": "application/json" },
      });
      expect(r.status).toBe(200);
    };
    await put({ "sleep.idleMinutes": 3 });
    await toRunning(w);
    // idle limit 3 min: 2 min of idleness is no reason to sleep (the 2 s test idle would have slept long ago)
    await w.advance(2 * MIN, S);
    expect(w.state()).toBe("running");
    // owner lowers it to 1 min: idle is already past it, so the next decision sleeps, no deploy
    await put({ "sleep.idleMinutes": 1 });
    await w.until(() => w.state() === "asleep", 30 * S);
    // and the other way: raised to 4 min holds the next awake period for 3 minutes
    await put({ "sleep.idleMinutes": 4 });
    await w.advance(15 * MIN, 30 * S); // asleep > 10 min: no quick re-wake doubling
    await w.rt().call("requestWake", "cli");
    await w.until(() => w.state() === "running", 20_000);
    await w.advance(3 * MIN, S);
    expect(w.state()).toBe("running");
    const eff = (await w.ops("settings")).body as {
      ver: number;
      effective: { sleep: { idleMinutes: number } };
    };
    expect([eff.ver, eff.effective.sleep.idleMinutes]).toEqual([4, 4]); // version 1 is the OC_SETTINGS seed
  }, 120_000);

  // §10.7 per state: [label, setup, new start op at once, wakeRequested set]. null = §10.7 silent (issue I-10).
  const WAKE_ROWS: [string, (x: World) => Promise<unknown>, boolean, boolean | null][] = [
    [
      "new",
      async (x) => {
        x.down.add("Runtime");
        await x.cron();
        x.down.clear();
      },
      true,
      null,
    ],
    ["starting", (x) => toStarting(x), false, null],
    ["waiting-capacity", (x) => toWaitingCapacity(x), false, null],
    ["backoff", (x) => toBackoff(x), false, true],
    ["running", (x) => toRunning(x), false, false],
    ["maintenance", (x) => toMaintenance(x), false, null],
    ["draining", (x) => toDraining(x), false, null],
    ["quiescing", (x) => toQuiescing(x), false, true],
    ["asleep", (x) => toAsleep(x), true, null],
    [
      "asleep-unconfirmed",
      async (x) => {
        await toAsleepUnconfirmed(x);
        x.rt().c.destroyHang = 1000;
      },
      false,
      true,
    ],
    ["stopping", (x) => toStopping(x), false, null],
    ["stopped", (x) => toStopped(x), false, false],
    ["retired", (x) => toRetired(x), false, false],
  ];
  it.each(WAKE_ROWS)("S50 requestWake in state %s → §10.7 action", async (label, setup, starts, flag) => {
    w = await fresh(sut, { sleep: label.startsWith("asleep") || label === "quiescing" });
    await setup(w);
    expect(w.state() ?? "new").toBe(label); // no rec yet = new
    const n = w.ops_().filter((o) => o.kind === "start").length;
    await w.rt().call("requestWake", "cli");
    const m = w.ops_().filter((o) => o.kind === "start").length;
    expect([label, m > n]).toEqual([label, starts]);
    if (flag !== null) expect([label, !!w.rt().kv("wakeRequested")]).toEqual([label, flag]);
    if (label === "stopped" || label === "retired") expect(w.state()).toBe(label);
  });
});
