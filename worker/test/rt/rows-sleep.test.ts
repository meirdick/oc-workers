// Runtime machine rows 37-58 (spec 08 §5.2) and the sleep op (§10).
import { describe, expect, it } from "vitest";
import { exitError } from "../../src/core/fake-container";
import { SLEEP_PHASES } from "../../src/rt/sleep";
import { type World, world } from "./world";

async function asleep(w: World) {
  await w.boot();
  await w.hb();
  await w.tick(w.clock.now() + 3000);
  await w.idle();
}

describe("sleep op", () => {
  it("T-R37 full sleep: 8 phases, marker valid with the handle saved before destroy, asleep", async () => {
    const w = world();
    await asleep(w);
    expect(w.state()).toBe("asleep");
    expect(w.rows()).toContain(37);
    expect(w.ocsup.ops).toEqual(["sleep-check", "sleep-prepare", "sleep-stop-gateway", "sleep-flush"]);
    const op = w.core.store.ops(5).find((o) => o.kind === "sleep");
    expect(op?.state).toBe("done");
    expect(Object.keys(op?.phaseAt ?? {})).toEqual(expect.arrayContaining([...SLEEP_PHASES, "done"]));
    const saved = w.ctl.calls.findIndex((c) => c.m === "snapshotSaved");
    const valid = w.ctl.calls.findIndex((c) => c.m === "markerValid");
    expect(saved).toBeGreaterThan(-1);
    expect(valid).toBeGreaterThan(saved);
    expect(w.c.calls.lastIndexOf("destroy")).toBeGreaterThan(-1);
    expect([...w.ctl.markers.values()][0]?.state).toBe("valid");
    expect(w.ctl.count("markReplicated")).toBe(1);
    expect(w.ctl.slept).toEqual([1]);
    expect(w.core.sleepRec().snapshotId).toBe(w.ctl.snapshots[0]?.id);
  });

  it("M3 e2e: a settled sleep resets a ladder left in slow (duty cycle never runs ladderResetMs)", async () => {
    const w = world();
    await w.boot();
    await w.hb();
    w.core.putLadder({ ...w.core.ladder(), level: "slow", slowSince: w.clock.now(), stateFaults: 1 });
    await w.tick(w.clock.now() + 3000);
    await w.idle();
    expect(w.state()).toBe("asleep");
    expect(w.core.ladder().level).toBe(1);
    expect(w.core.ladder().stateFaults).toBe(0);
  });

  it("T-R38 destroy timeout in phase 8: asleep-unconfirmed; hb acked stop:true (T-R51); zombie alert; asleep after settle (T-R49) (scenario 47)", async () => {
    const w = world();
    await w.boot();
    await w.hb();
    w.c.hangDestroy = true;
    await w.tick(w.clock.now() + 3000);
    await w.idle();
    expect(w.state()).toBe("asleep-unconfirmed");
    expect(w.rows()).toContain(38);
    const ack = await w.hb();
    expect(ack.stop).toBe(true);
    expect(w.rows()).toContain(51);
    await w.clock.advance(w.timers.zombieAlertMs + 10);
    await w.tick();
    expect(w.rows()).toContain(50);
    expect(w.ctl.alerted("zombie")).toBeGreaterThanOrEqual(1);
    w.c.exit();
    await w.tick(w.clock.now() + 1000);
    expect(w.rows()).toContain(49);
    expect(w.state()).toBe("asleep");
  });

  it("T-R39 abort by wake flag at each phase 1-6 (scenario 44)", async () => {
    for (const at of ["sleep-check", "sleep-prepare", "sleep-stop-gateway", "sleep-flush"]) {
      const w = world();
      await w.boot();
      await w.hb();
      const orig = w.ocsup.ctl[at] as (a: unknown) => unknown;
      w.ocsup.ctl[at] = (a) => {
        w.core.store.put("wakeRequested", { reason: "webhook", at: 0 });
        return orig(a);
      };
      await w.tick(w.clock.now() + 3000);
      await w.idle();
      expect(w.state(), at).toBe("running");
      expect(w.rows()).toContain(39);
      const ops = w.ocsup.ops;
      if (at === "sleep-check") expect(ops).not.toContain("sleep-cancel");
      if (at === "sleep-prepare") expect(ops).toContain("sleep-cancel");
      if (at === "sleep-check" || at === "sleep-prepare") expect(ops).not.toContain("resume-after-sleep");
      if (at === "sleep-stop-gateway" || at === "sleep-flush") {
        expect(ops).toContain("resume-after-sleep");
        expect(w.core.boot()?.gen).toBe(1);
      }
      expect([...w.ctl.markers.values()].every((m) => m.state !== "valid")).toBe(true);
      expect(w.c.snapshotCount).toBe(0);
    }
  });

  it("T-R39 abort after the marker write (phase 6): marker void, resume, same gen", async () => {
    const w = world();
    await w.boot();
    await w.hb();
    const orig = w.ctl.markReplicated.bind(w.ctl);
    w.ctl.markReplicated = async (a) => {
      w.ctl.pending = 1;
      return orig(a);
    };
    await w.tick(w.clock.now() + 3000);
    await w.idle();
    expect(w.state()).toBe("running");
    expect([...w.ctl.markers.values()][0]?.state).toBe("void");
    expect(w.ocsup.ops).toContain("resume-after-sleep");
    expect(w.core.boot()?.gen).toBe(1);
  });

  it("T-R40 wake during quiescing sets the flag only, then aborts at the next edge", async () => {
    const w = world();
    await w.boot();
    await w.hb();
    w.ocsup.ctl["sleep-prepare"] = () => {
      void w.core.requestWake("webhook");
      return { ok: true, status: "ready" };
    };
    await w.tick(w.clock.now() + 3000);
    await w.idle();
    expect(w.rows()).toContain(40);
    expect(w.state()).toBe("running");
    expect(w.ocsup.ops).toContain("sleep-cancel");
  });

  it("T-R42 settle before phase destroy: op fails, marker void, backoff", async () => {
    const w = world();
    await w.boot();
    await w.hb();
    w.ocsup.ctl["sleep-flush"] = () => {
      w.c.exit(exitError(137));
      return { ok: false, error: "failed" };
    };
    await w.tick(w.clock.now() + 3000);
    await w.idle();
    expect(w.rows()).toContain(42);
    expect(w.state()).toBe("backoff");
  });

  it("phase 4 sleep-unclean-exit and phase 5 sleep-flush-failed: abort + alert, no marker, no snapshot (scenario 45)", async () => {
    for (const [op, err] of [
      ["sleep-stop-gateway", "sleep-unclean-exit"],
      ["sleep-flush", "sleep-flush-failed"],
    ] as const) {
      const w = world();
      await w.boot();
      await w.hb();
      w.ocsup.ctl[op] = () => ({ ok: false, error: err });
      await w.tick(w.clock.now() + 3000);
      await w.idle();
      expect(w.state()).toBe("running");
      expect(w.ctl.alerted(err)).toBe(1);
      expect(w.ctl.count("markerPending")).toBe(0);
      expect(w.c.snapshotCount).toBe(0);
    }
  });

  it("snapshot fails 3 times: no destroy, marker void, retry in 15 min; 3rd failing day → alert, awake to maint (scenario 46)", async () => {
    const w = world();
    await w.boot();
    await w.hb();
    for (let i = 0; i < 3; i++) w.c.snapshotErrors.push(new Error("snapshot failed"));
    await w.tick(w.clock.now() + 3000);
    await w.idle();
    expect(w.state()).toBe("running");
    expect(w.c.destroyCount).toBe(0);
    expect([...w.ctl.markers.values()][0]?.state).toBe("void");
    expect(w.core.sleepRec().retryAt).toBe(w.core.sleepRec().retryAt);
    expect((w.core.sleepRec().retryAt ?? 0) - w.clock.now()).toBeGreaterThan(w.timers.sleepRetryMs - 2000);
    // two more failing sleeps today
    for (let k = 0; k < 2; k++) {
      for (let i = 0; i < 3; i++) w.c.snapshotErrors.push(new Error("snapshot failed"));
      w.core.patchSleep({ retryAt: null, noSleepUntil: null });
      await w.hb();
      await w.tick(w.clock.now() + 3000);
      await w.idle();
    }
    expect(w.ctl.alerted("sleep-snapshot-failed")).toBe(1);
    expect(w.core.sleepRec().stayAwakeUntilMaint).toBe(true);
    await w.hb();
    await w.tick(w.clock.now() + 3000);
    expect(w.core.sleepRec().blockedOn).toBe("10:snapshot-failed");
  });

  it("3 aborts in 1 h: alert sleep-aborted, no sleep for 1 h (scenario 48)", async () => {
    const w = world();
    await w.boot();
    w.ocsup.ctl["sleep-stop-gateway"] = () => ({ ok: true, clean: true, openRows: 2, eventJobs: [] });
    for (let i = 0; i < 3; i++) {
      await w.hb();
      await w.tick(w.clock.now() + 3000);
      await w.idle();
    }
    expect(w.ctl.alerted("sleep-aborted")).toBe(1);
    await w.hb();
    await w.tick(w.clock.now() + 3000);
    expect(w.core.sleepRec().blockedOn).toBe("10:abort-hold");
  });

  it("DO restart at each sleep phase 1-8: resumes the same phase, no second marker, ≤ 1 extra snapshot (scenario 38)", async () => {
    for (const phase of SLEEP_PHASES) {
      const w = world();
      await w.boot();
      await w.hb();
      let hit = false;
      const hook = () => {
        if (hit) return;
        hit = true;
        w.core.halt();
      };
      // Halt the instance when the op reaches `phase` (check: at its first ocsupctl call).
      if (phase === "check") {
        const o = w.ocsup.ctl["sleep-check"] as (a: unknown) => unknown;
        w.ocsup.ctl["sleep-check"] = (a) => {
          if (!hit) {
            hook();
            return "hang";
          }
          return o(a);
        };
      }
      const orig = w.core.store.setPhase.bind(w.core.store);
      w.core.store.setPhase = (id, p, patch) => {
        orig(id, p, patch);
        if (p === phase) hook();
      };
      await w.tick(w.clock.now() + 3000);
      await w.idle();
      expect(w.core.store.openOp("sleep")?.phase, phase).toBe(phase);
      await w.restart();
      await w.tick();
      await w.idle();
      expect(w.state(), phase).toBe("asleep");
      expect(w.ctl.count("markerPending") <= 2, phase).toBe(true);
      expect(new Set([...w.ctl.markers.keys()]).size, phase).toBe(1);
      expect(w.c.snapshotCount, phase).toBeLessThanOrEqual(2);
    }
  });

  it("T-R41 sigterm event during sleep phase 2: no more ocsupctl, marker void, op interrupted (scenario 42)", async () => {
    const w = world();
    await w.boot();
    await w.hb();
    w.ocsup.ctl["sleep-prepare"] = () => {
      void w.event("sigterm");
      return { ok: true, status: "ready" };
    };
    await w.tick(w.clock.now() + 3000);
    await w.idle();
    expect(w.state()).toBe("draining");
    expect(w.ocsup.ops).toEqual(["sleep-check", "sleep-prepare"]);
    expect(w.core.store.ops(5).find((o) => o.kind === "sleep")?.state).toBe("interrupted:sigterm");
  });
});

describe("asleep rows", () => {
  it("T-R43 wake while asleep: start op wake:r, restores the sleep snapshot, marker consumed (scenario 65)", async () => {
    const w = world();
    await asleep(w);
    const snap = w.core.sleepRec().snapshotId;
    const r = await w.core.requestWake("webhook");
    expect(r.action).toBe("start");
    expect(w.rows()).toContain(43);
    await w.idle();
    expect(w.state()).toBe("running");
    expect(w.c.startedWith?.source).toEqual({ snapshotId: snap });
    expect(w.ctl.genCounter).toBe(2);
    expect([...w.ctl.markers.values()][0]?.state).toBe("consumed");
    // second boot from the same snapshot restores from the gen (single-use marker)
    w.c.exit(exitError(75));
    await w.event("exit", { code: 75, reason: "auto-restart" });
    await w.idle();
    await w.until(() => w.state() === "running");
    const last = w.ctl.calls.filter((c) => c.m === "beginBoot").length;
    expect(last).toBeGreaterThanOrEqual(3);
  });

  it("T-R43 two requestWake at once: one start op, one beginBoot (scenario 49)", async () => {
    const w = world();
    await asleep(w);
    const n = w.ctl.count("beginBoot");
    await Promise.all([w.core.requestWake("webhook"), w.core.requestWake("cron")]);
    await w.idle();
    expect(w.ctl.count("beginBoot")).toBe(n + 1);
    expect(w.c.destroyReasons.filter((x) => x === "stale").length).toBe(0);
  });

  it("T-R44 alarm at wakeAt = nextWakeAtMs − leadMs: wake reason cron (scenario 54)", async () => {
    const w = world();
    await w.boot();
    await w.hb();
    const next = w.clock.now() + 30_000;
    w.ocsup.ctl["sleep-flush"] = () => ({
      ok: true,
      nextWakeAtMs: next,
      txidPerDb: {},
      bytesPerDb: {},
      lastWriteAtPerDb: {},
    });
    await w.tick(w.clock.now() + 3000);
    await w.idle();
    expect(w.state()).toBe("asleep");
    expect(w.alarm.at).toBe(next - w.timers.leadMs);
    await w.tick(w.alarm.at as number);
    expect(w.rows()).toContain(44);
    const last = w.ctl.calls.filter((c) => c.m === "beginBoot").pop()?.a as { reason: string };
    expect(last.reason).toBe("wake:cron");
  });

  it("nextWakeAtMs < 10 min away: no sleep (scenario 55)", async () => {
    const w = world();
    await w.boot();
    await w.hb();
    w.ocsup.ctl["sleep-check"] = () => ({ ok: true, blockers: [], nextWakeAtMs: w.clock.now() + 3000 });
    await w.tick(w.clock.now() + 3000);
    await w.idle();
    expect(w.state()).toBe("running");
    expect(w.ocsup.ops).not.toContain("sleep-prepare");
  });

  it("T-R45 T-R46 T-R47 ensure while asleep: nothing / wake cron after wakeAt + 2 min / wake inbox (scenario 69)", async () => {
    const w = world();
    await asleep(w);
    await w.core.ensure();
    expect(w.rows()).toContain(47);
    expect(w.state()).toBe("asleep");
    w.ctl.pending = 1;
    await w.core.ensure();
    expect(w.rows()).toContain(46);
    await w.idle();
    expect(w.state()).toBe("running");

    const w2 = world();
    await asleep(w2);
    w2.core.patchSleep({ wakeAt: w2.clock.now() - 3 * 60_000 });
    await w2.core.ensure();
    expect(w2.rows()).toContain(45);
  });

  it("T-R48 asleep with a running container at constructor: not adopted, destroy(stale) (scenario 68)", async () => {
    const w = world();
    await asleep(w);
    w.c.adoptRunning({ inst: "t1", epoch: "1", gen: "1", mode: "prod" });
    w.c.hangDestroy = true;
    await w.restart();
    expect(w.rows()).toContain(48);
    expect(w.c.destroyReasons).toContain("stale");
    expect(w.state()).toBe("asleep-unconfirmed");
  });

  it("T-R52 flagged wake in asleep-unconfirmed waits for settle or lastHb + 200 s", async () => {
    const w = world();
    await w.boot();
    await w.hb();
    w.c.hangDestroy = true;
    await w.tick(w.clock.now() + 3000);
    await w.idle();
    expect(w.state()).toBe("asleep-unconfirmed");
    const r = await w.core.requestWake("webhook");
    expect(r.action).toBe("after-settle");
    const starts = w.c.startCount;
    await w.tick(w.clock.now() + 1000);
    expect(w.c.startCount).toBe(starts);
    await w.clock.advance(w.timers.unconfirmedWaitMs);
    await w.tick();
    expect(w.rows()).toContain(52);
  });
});

describe("stop, retire, constructor rows", () => {
  it("T-R54 stop with destroy timeout: stopped, unconfirmed", async () => {
    const w = world();
    w.ctl.inputs.blockers = ["socket:x"];
    await w.boot();
    w.c.hangDestroy = true;
    await w.core.ownerStop();
    await w.idle();
    expect(w.state()).toBe("stopped");
    expect(w.rows()).toContain(54);
  });

  it("T-R55 owner start from stopped; T-R56 ensure and wake do nothing while stopped", async () => {
    const w = world();
    w.ctl.inputs.blockers = ["socket:x"];
    await w.boot();
    await w.core.ownerStop();
    await w.idle();
    await w.core.ensure();
    await w.core.requestWake("webhook");
    expect(w.rows()).toContain(56);
    expect(w.state()).toBe("stopped");
    await w.core.ownerStart();
    expect(w.rows()).toContain(55);
    await w.idle();
    expect(w.state()).toBe("running");
  });

  it("T-R57 retire from backoff pre-empts the queued start", async () => {
    const w = world();
    w.c.startErrors.push(new Error("boom"));
    await w.core.init();
    await w.core.ensure();
    await w.idle();
    expect(w.state()).toBe("backoff");
    await w.core.retire();
    expect(w.rows()).toContain(57);
    expect(w.state()).toBe("retired");
  });

  it("T-R58 constructor with persisted epoch retired and a running container: destroy(retired)", async () => {
    const w = world();
    w.ctl.inputs.blockers = ["socket:x"];
    await w.boot();
    w.core.patchRec({ epochStatus: "retired" });
    await w.restart();
    expect(w.rows()).toContain(58);
    expect(w.c.destroyReasons).toContain("retired");
    expect(w.state()).toBe("retired");
  });

  it("retired DO: proxy answers retired (421 in the DO)", async () => {
    const w = world();
    w.ctl.epoch = "retired";
    await w.core.init();
    await w.core.ensure();
    expect(await w.core.proxyAllowed()).toBe("retired");
  });
});
