// Runtime machine rows 16-36 (spec 08 §5.2): running, maintenance, draining.
import { describe, expect, it } from "vitest";
import { exitError, M0_TEXTS } from "../../src/core/fake-container";
import { world } from "./world";

/** Keep the sleep gate closed so `running` ticks only run liveness. */
const awake = (w: ReturnType<typeof world>) => {
  w.ctl.inputs.blockers = ["socket:discord"];
};

describe("running rows", () => {
  it("T-R16 running with a retired epoch: destroy(retired) on the next tick (scenario 9)", async () => {
    const w = world();
    awake(w);
    await w.boot();
    w.ctl.epoch = "retired";
    await w.tick(w.clock.now() + 2000);
    expect(w.state()).toBe("retired");
    expect(w.c.destroyReasons).toContain("retired");
    expect(w.rows()).toContain(16);
  });

  it("T-R17 hb age > hbLostMs: class lost, destroyed, next start ≥ lastHb + 200 s (scenario 13)", async () => {
    const w = world();
    awake(w);
    await w.boot();
    await w.hb();
    const hbAt = w.clock.now();
    await w.clock.advance(w.timers.hbLostMs + 10);
    await w.tick();
    expect(w.rows()).toContain(17);
    expect(w.state()).toBe("backoff");
    expect(w.core.store.stops(1)[0]?.cls).toBe("lost");
    expect(w.c.destroyCount).toBe(1);
    expect(w.core.ladder().nextStartAt).toBeGreaterThanOrEqual(hbAt + w.timers.unconfirmedWaitMs);
  });

  it("T-R18 identity mismatch: class stale, destroy(stale), L1", async () => {
    const w = world();
    awake(w);
    await w.boot();
    await w.hb();
    w.ocsup.bootJson = { gen: 7, epoch: 1, iid: "x", secretHash: "0".repeat(64) };
    await w.tick(w.clock.now() + 1000);
    expect(w.rows()).toContain(18);
    expect(w.c.destroyReasons).toContain("stale");
    expect(w.core.ladder().level).toBe(1);
  });

  it("T-R19 identity exec fails: retry next tick, no destroy", async () => {
    const w = world();
    awake(w);
    await w.boot();
    await w.hb();
    w.ocsup.identityFails = true;
    await w.tick(w.clock.now() + 1000);
    expect(w.rows()).toContain(19);
    expect(w.state()).toBe("running");
    expect(w.c.destroyCount).toBe(0);
  });

  it("T-R20 five /healthz fails: restart-gateway; exec fail → replace exit:70", async () => {
    const w = world();
    awake(w);
    await w.boot();
    w.c.portHandler = (req) =>
      new URL(req.url).pathname === "/healthz"
        ? new Response("bad", { status: 500 })
        : Response.json({ status: "started" });
    for (let i = 0; i < 5; i++) {
      await w.hb();
      await w.tick(w.clock.now() + 1000);
    }
    expect(w.ocsup.ops).toContain("restart-gateway");
    expect(w.state()).toBe("running");
    w.ocsup.ctl["restart-gateway"] = () => "hang";
    for (let i = 0; i < 5; i++) {
      await w.hb();
      await w.tick(w.clock.now() + 1000);
    }
    expect(w.rows().filter((r) => r === 20).length).toBeGreaterThanOrEqual(2);
    expect(w.state()).toBe("backoff");
    expect(w.core.store.stops(1)[0]?.cls).toBe("exit:70");
  });

  it("T-R21 running=false with no settle and no op: class lost, unconfirmed (scenario 34)", async () => {
    const w = world();
    awake(w);
    await w.boot();
    await w.hb();
    w.c.vanish();
    await w.tick(w.clock.now() + 1000);
    expect(w.rows()).toContain(21);
    expect(w.core.store.stops(1)[0]).toMatchObject({ cls: "lost", confirmed: false });
    expect(w.ctl.alerted("inactivity?")).toBe(1);
  });

  it("T-R22 settle in running: record stop, ladder (exit 75 auto-restart → zero, new gen)", async () => {
    const w = world();
    awake(w);
    await w.boot();
    await w.event("exit", { code: 75, reason: "auto-restart" });
    w.c.exit(exitError(75));
    await w.idle();
    expect(w.rows()).toContain(22);
    expect(w.core.store.stops(5).map((s) => s.cls)).toContain("auto-restart");
    await w.until(() => w.state() === "running");
    expect(w.ctl.genCounter).toBe(2);
  });

  it("T-R23 sigterm event in running: draining", async () => {
    const w = world();
    awake(w);
    await w.boot();
    await w.event("sigterm");
    expect(w.state()).toBe("draining");
    expect(w.rows()).toContain(23);
  });

  it("T-R23 draining heartbeat in running: draining", async () => {
    const w = world();
    awake(w);
    await w.boot();
    await w.hb({ draining: true, phase: "draining" });
    expect(w.state()).toBe("draining");
  });

  it("T-R24 sleep gate holds: op sleep journaled", async () => {
    const w = world();
    await w.boot();
    await w.hb();
    await w.tick(w.clock.now() + 3000);
    expect(w.rows()).toContain(24);
    expect(["quiescing", "asleep"]).toContain(w.state());
  });

  it("T-R25 maintenance due: op maint, then running (T-R30)", async () => {
    const w = world();
    awake(w);
    await w.boot();
    for (let i = 0; i < 70 && !w.rows().includes(30); i++) {
      await w.hb();
      await w.tick(w.clock.now() + 1000);
    }
    expect(w.rows()).toContain(25);
    expect(w.rows()).toContain(30);
    expect(w.ctl.count("r2Probe")).toBe(1);
    expect(w.state()).toBe("running");
  });

  it("T-R26 owner stop in running: planned stop (snapshot planned, marker valid) → stopped (T-R53)", async () => {
    const w = world();
    awake(w);
    await w.boot();
    await w.core.ownerStop();
    expect(w.rows()).toContain(26);
    await w.idle();
    expect(w.state()).toBe("stopped");
    expect(w.rows()).toContain(53);
    expect(w.ocsup.ops).toEqual(expect.arrayContaining(["stop", "stop-status"]));
    expect(w.ctl.snapshots[0]?.kind).toBe("planned");
    expect([...w.ctl.markers.values()][0]?.state).toBe("valid");
    expect(w.core.store.stops(5).map((x) => x.cls)).toEqual(["planned"]);
  });

  it("T-R27 wake in running: clears wakeRequested, records activity", async () => {
    const w = world();
    awake(w);
    await w.boot();
    w.core.store.put("wakeRequested", { reason: "cli", at: 1 });
    await w.clock.advance(500);
    const r = await w.core.requestWake("webhook");
    expect(r.action).toBe("none");
    expect(w.rows()).toContain(27);
    expect(w.core.wakeRequested()).toBeUndefined();
    expect(w.core.rec().lastActivityAt).toBe(w.clock.now());
  });

  it("T-R28 retire in running: destroy(retired), settle, retired; confirmed retire has no 200 s wait (scenario 28)", async () => {
    const w = world();
    awake(w);
    await w.boot();
    const r = await w.core.retire();
    expect(r.settled).toBe(true);
    expect(w.rows()).toContain(28);
    expect(w.state()).toBe("retired");
    expect(w.c.destroyReasons).toEqual(["retired"]);
    expect(w.core.store.stops(5).map((x) => x.cls)).toEqual(["planned"]);
    expect(w.core.store.stops(1)[0]?.confirmed).toBe(true);
  });

  it("T-R29 exit 77 then settle with an active epoch: class fenced, L1", async () => {
    const w = world();
    awake(w);
    await w.boot();
    await w.event("exit", { code: 77, reason: "stale" });
    w.c.exit(exitError(77));
    await w.idle();
    expect(w.rows()).toContain(29);
    expect(w.core.store.stops(1)[0]?.cls).toBe("fenced");
    expect(w.core.ladder().level).toBe(1);
  });

  it("T-R31 settle in maintenance: backoff", async () => {
    const w = world();
    awake(w);
    await w.boot();
    w.core.tr(25);
    w.c.exit(exitError(70));
    await w.idle();
    expect(w.rows()).toContain(31);
    expect(w.state()).toBe("backoff");
  });

  it("T-R32 drain: running=false → class platform, confirmed, start at once (scenario 12)", async () => {
    const w = world();
    awake(w);
    await w.boot();
    await w.event("sigterm");
    w.c.exit(new Error(M0_TEXTS.signalled));
    await w.idle();
    expect(w.rows()).toContain(32);
    const stop = w.core.store.stops(1)[0];
    expect(stop).toMatchObject({ cls: "platform", confirmed: true });
    await w.until(() => w.state() === "running", 3);
    expect(w.state()).toBe("running");
  });

  it("T-R33 drain over drainCapMs: class lost, destroy, unconfirmed", async () => {
    const w = world();
    awake(w);
    await w.boot();
    await w.event("sigterm");
    await w.clock.advance(w.timers.drainCapMs + 10);
    await w.tick();
    expect(w.rows()).toContain(33);
    expect(w.core.store.stops(1)[0]).toMatchObject({ cls: "lost", confirmed: false });
    expect(w.c.destroyCount).toBe(1);
  });

  it("T-R34 sigterm then 6 ticks: no restart, no destroy, no exec (scenario 10)", async () => {
    const w = world();
    awake(w);
    await w.boot();
    await w.event("sigterm");
    const execs = w.c.execLog.length;
    for (let i = 0; i < 6; i++) await w.tick(w.clock.now() + 1000);
    expect(w.rows().filter((r) => r === 34).length).toBe(6);
    expect(w.c.destroyCount).toBe(0);
    expect(w.c.startCount).toBe(1);
    expect(w.c.execLog.length).toBe(execs);
  });

  it("T-R35 sigterm, DO reset, container exit: start at once, class platform (scenario 11)", async () => {
    const w = world();
    awake(w);
    await w.boot();
    await w.event("sigterm");
    w.c.vanish();
    await w.restart();
    expect(w.rows()).toContain(35);
    expect(w.state()).toBe("backoff");
    expect(w.core.ladder().nextStartAt).toBe(w.clock.now());
    expect(w.core.store.stops(1)[0]?.cls).toBe("platform");
    await w.tick();
    expect(w.state()).toBe("running");
  });

  it("T-R36 settle while draining with a sigterm-interrupted sleep op: asleep, final handle used (scenario 42)", async () => {
    const w = world();
    await w.boot();
    await w.hb();
    // Sleep op stops at prepare: sigterm arrives there.
    w.ocsup.ctl["sleep-prepare"] = () => {
      void w.event("sigterm");
      return { ok: true, status: "ready" };
    };
    await w.tick(w.clock.now() + 3000);
    expect(w.state()).toBe("draining");
    const opsAfter = w.ocsup.ops.length;
    const f = await w.core.finalSnapshot({ kind: "final" });
    expect(f.ok).toBe(true);
    w.c.exit();
    await w.idle();
    expect(w.rows()).toContain(41);
    expect(w.rows()).toContain(36);
    expect(w.state()).toBe("asleep");
    expect(w.core.sleepRec().snapshotId).toBe(f.snapshotId);
    expect(w.ocsup.ops.length).toBe(opsAfter);
    expect([...w.ctl.markers.values()].every((m) => m.state !== "valid")).toBe(true);
  });
});
