// Runtime machine rows 1-15 (spec 08 §5.2): new, starting, waiting-capacity, backoff.
import { describe, expect, it } from "vitest";
import { exitError, M0_TEXTS } from "../../src/core/fake-container";
import { world } from "./world";

describe("start rows", () => {
  it("T-R1 new + ensure with an active epoch starts (desired running)", async () => {
    const w = world();
    await w.core.init();
    await w.core.ensure();
    expect(w.rows()).toContain(1);
    await w.idle();
    expect(w.state()).toBe("running");
    expect(w.core.rec().desired).toBe("running");
    expect(w.c.calls.slice(0, 3)).toEqual(["intercept:15.0.0.1:80", "intercept:15.0.0.2:80", "start"]);
    expect(w.c.startedWith?.labels).toEqual({ inst: "t1", epoch: "1", gen: "1", mode: "prod" });
    expect(w.c.startedWith?.env?.OCRT_BOOT_SECRET).toBe("secret-1");
    expect(w.c.startedWith?.enableInternet).toBe(true);
    expect(w.c.inactivityCalls).toContain(6 * 3600_000);
  });

  it("T-R1 new + requestWake starts with reason wake:webhook", async () => {
    const w = world();
    await w.core.init();
    const r = await w.core.requestWake("webhook");
    expect(r.action).toBe("start");
    await w.idle();
    expect(w.state()).toBe("running");
    expect((w.ctl.calls.find((c) => c.m === "beginBoot")?.a as { reason: string } | undefined)?.reason).toBe(
      "wake:webhook",
    );
  });

  it("T-R2 new with a retired epoch goes retired, no start", async () => {
    const w = world();
    w.ctl.epoch = "retired";
    await w.core.init();
    await w.core.ensure();
    expect(w.state()).toBe("retired");
    expect(w.c.startCount).toBe(0);
  });

  it("T-R3 start ok only when /startupz JSON says started (UI catch-all 200 is not enough)", async () => {
    const w = world();
    let started = false;
    w.c.portHandler = (req) =>
      new URL(req.url).pathname === "/startupz" && started
        ? Response.json({ status: "started" })
        : new Response("<html>ui</html>", { status: 200 });
    await w.core.init();
    await w.core.ensure();
    await w.clock.advance(500);
    expect(w.state()).toBe("starting");
    started = true;
    await w.idle();
    expect(w.state()).toBe("running");
    expect(w.rows()).toContain(3);
  });

  it("T-R4 capacity on start(): waiting-capacity, gen kept, retry at 10 s (test 100 ms), no failed-start count", async () => {
    const w = world();
    w.c.startErrors.push(new Error(M0_TEXTS.capacity));
    await w.core.init();
    await w.core.ensure();
    await w.idle();
    expect(w.state()).toBe("waiting-capacity");
    expect(w.rows()).toContain(4);
    const l = w.core.ladder();
    expect(l.nextStartAt - w.clock.now()).toBe(w.timers.capacityFastMs);
    expect(l.stateFaults).toBe(0);
    expect(w.ctl.count("endBoot")).toBe(0);
    // T-R5: tick at nextStartAt resumes phase start with the same gen.
    await w.until(() => w.state() === "running");
    expect(w.rows()).toContain(5);
    expect(w.state()).toBe("running");
    expect(w.ctl.genCounter).toBe(1);
  });

  it("T-R4 capacity reject on the monitor path (scenario 2)", async () => {
    const w = world();
    w.c.readyAfterMs = 10_000;
    await w.core.init();
    await w.core.ensure();
    await w.clock.advance(1);
    w.c.exit(new Error(M0_TEXTS.capacity));
    await w.idle();
    expect(w.state()).toBe("waiting-capacity");
    expect(w.core.ladder().stateFaults).toBe(0);
  });

  it("T-R5 capacity for a long time issues one gen (C13, scenario 3 first half)", async () => {
    const w = world();
    for (let i = 0; i < 30; i++) w.c.startErrors.push(new Error(M0_TEXTS.capacity));
    await w.core.init();
    await w.core.ensure();
    await w.idle();
    await w.until(() => w.state() === "running", 40);
    expect(w.state()).toBe("running");
    expect(w.ctl.genCounter).toBe(1);
    // capacity table: 100 ms for 2 s, then 500 ms (test values).
    expect(w.core.ladder().capacitySince).toBeNull();
  });

  it("T-R6 retire pre-empts a waiting-capacity start; gen abandoned (scenario 3)", async () => {
    const w = world();
    for (let i = 0; i < 5; i++) w.c.startErrors.push(new Error(M0_TEXTS.capacity));
    await w.core.init();
    await w.core.ensure();
    await w.idle();
    expect(w.state()).toBe("waiting-capacity");
    const r = await w.core.retire();
    expect(r.settled).toBe(true);
    expect(w.state()).toBe("retired");
    expect(w.ctl.count("endBoot")).toBe(1);
    expect(w.ctl.genCounter).toBe(1);
    expect(w.core.store.ops(10).find((o) => o.kind === "start")?.state).toBe("aborted");
  });

  it("T-R6 owner stop pre-empts a waiting-capacity start", async () => {
    const w = world();
    for (let i = 0; i < 5; i++) w.c.startErrors.push(new Error(M0_TEXTS.capacity));
    await w.core.init();
    await w.core.ensure();
    await w.idle();
    await w.core.ownerStop();
    await w.idle();
    expect(w.state()).toBe("stopped");
    expect(w.rows()).toContain(6);
  });

  it("T-R7 snapshot not found on start() throw: suspect, replan in same op (scenario 4)", async () => {
    const w = world();
    w.ctl.snapshots = [
      { id: "snap-new", state: "ok", kind: "sleep" },
      { id: "snap-old", state: "ok", kind: "maint" },
    ];
    w.c.knownSnapshots.set("snap-old", 1);
    w.c.startErrors.push(new Error(M0_TEXTS.snapshot("snap-new")));
    await w.core.init();
    await w.core.ensure();
    await w.idle();
    expect(w.state()).toBe("running");
    expect(w.ctl.snapshots.find((s) => s.id === "snap-new")?.state).toBe("suspect");
    expect(w.c.startedWith?.source).toEqual({ snapshotId: "snap-old" });
    expect(w.ctl.count("beginBoot")).toBe(2);
    expect(w.ctl.genCounter).toBe(1);
    expect(w.core.ladder().level).toBe(1);
    expect(w.core.store.stops(5)[0]?.cls).toBe("snapshot-lost");
  });

  it("T-R7 snapshot not found on the monitor path: replan, marker void (scenario 4)", async () => {
    const w = world();
    w.ctl.snapshots = [
      { id: "snap-new", state: "ok", kind: "sleep" },
      { id: "snap-old", state: "ok", kind: "maint" },
    ];
    w.ctl.markers.set("mk-x", { state: "valid", snapshotId: "snap-new", opId: "o" });
    w.c.knownSnapshots.set("snap-old", 1);
    await w.core.init();
    await w.core.ensure();
    await w.idle();
    expect(w.state()).toBe("running");
    expect(w.ctl.snapshots.find((s) => s.id === "snap-new")?.state).toBe("suspect");
    expect(w.ctl.count("markerVoid")).toBeGreaterThanOrEqual(1);
    expect(w.c.startedWith?.source).toEqual({ snapshotId: "snap-old" });
  });

  it("T-R8 already running with matching labels: adopt, start() called once per gen (scenario 6)", async () => {
    const w = world();
    w.c.readyAfterMs = 60_000;
    await w.core.init();
    await w.core.ensure();
    await w.clock.advance(1);
    expect(w.core.store.openOp("start")?.phase).toBe("armed");
    // DO restart mid readiness.
    w.c.readyAt = 0;
    const core = await w.restart();
    await core.alarm();
    await w.idle();
    expect(w.state()).toBe("running");
    expect(w.c.startCount).toBe(1);
  });

  it("T-R9 already running with other labels: destroy(stale), backoff, not a state fault (scenario 19)", async () => {
    const w = world();
    w.c.adoptRunning({ inst: "t1", epoch: "1", gen: "99", mode: "prod" });
    await w.core.init();
    await w.core.ensure();
    await w.idle();
    expect(w.c.destroyReasons).toContain("stale");
    expect(w.rows()).toContain(9);
    expect(w.state()).toBe("backoff");
    expect(w.core.ladder().stateFaults).toBe(0);
    expect(w.core.store.stops(1)[0]?.stateFault).toBe(false);
  });

  it("T-R10 plan restore-blocked: no start(), class = reason, alert high (scenario 21)", async () => {
    const w = world();
    w.ctl.planOverride = { sqlite: { kind: "restore-blocked", reason: "restore-blocked:mismatch" } };
    await w.core.init();
    await w.core.ensure();
    await w.idle();
    expect(w.c.startCount).toBe(0);
    expect(w.state()).toBe("backoff");
    expect(w.rows()).toContain(10);
    expect(w.core.store.stops(1)[0]?.cls).toBe("restore-blocked:mismatch");
    expect(w.ctl.alerts.some((a) => a.class === "restore-blocked" && a.severity === "high")).toBe(true);
  });

  it("T-R10 restore-blocked:rewound: no start(), slow backoff, alert (scenario 24)", async () => {
    const w = world();
    w.ctl.planOverride = { sqlite: { kind: "restore-blocked", reason: "restore-blocked:rewound" } };
    await w.core.init();
    await w.core.ensure();
    await w.idle();
    expect(w.c.startCount).toBe(0);
    expect(w.core.ladder().nextStartAt - w.clock.now()).toBe(w.timers.slowMs);
  });

  it("T-R11 settle during readiness: record stop, ladder, backoff", async () => {
    const w = world();
    w.c.readyAfterMs = 60_000;
    await w.core.init();
    await w.core.ensure();
    await w.clock.advance(1);
    w.c.exit(exitError(137));
    await w.idle();
    expect(w.state()).toBe("backoff");
    expect(w.rows()).toContain(11);
    expect(w.core.store.stops(1)[0]?.cls).toBe("oom?");
    expect(w.ctl.count("endBoot")).toBe(1);
  });

  it("T-R11 phase budget miss: failed start, destroy", async () => {
    const w = world();
    w.c.portHandler = () => Response.json({ status: "starting" });
    await w.core.init();
    await w.core.ensure();
    await w.idle();
    expect(w.state()).toBe("backoff");
    expect(w.core.store.stops(1)[0]?.cls).toBe("budget:boot");
    expect(w.c.destroyCount).toBe(1);
  });

  it("T-R11 hb gap > hbLostMs during start: failed start (lost)", async () => {
    const w = world();
    w.c.portHandler = () => Response.json({ status: "starting" });
    await w.core.init();
    await w.core.ensure();
    await w.clock.advance(1);
    await w.hb({ phase: "restore" });
    await w.idle();
    expect(w.core.store.stops(1)[0]?.cls).toMatch(/lost|budget:restore/);
  });

  it("T-R12 sigterm during start: draining", async () => {
    const w = world();
    w.c.readyAfterMs = 60_000;
    await w.core.init();
    await w.core.ensure();
    await w.clock.advance(1);
    await w.event("sigterm");
    await w.idle();
    expect(w.state()).toBe("draining");
    expect(w.rows()).toContain(12);
  });

  it("T-R13 backoff tick at nextStartAt starts with reason ladder", async () => {
    const w = world();
    w.c.startErrors.push(new Error("boom"));
    await w.core.init();
    await w.core.ensure();
    await w.idle();
    expect(w.state()).toBe("backoff");
    await w.until(() => w.state() === "running");
    expect(w.rows()).toContain(13);
    expect(w.state()).toBe("running");
    const reasons = w.ctl.calls
      .filter((c) => c.m === "beginBoot")
      .map((c) => (c.a as { reason: string }).reason);
    expect(reasons).toContain("ladder");
  });

  it("T-R14 backoff with desired asleep starts a wake op", async () => {
    const w = world();
    await w.boot();
    w.core.patchRec({ desired: "asleep" });
    w.core.failure(w.core.mkClass("lost", "infra"), false, 21);
    w.core.patchRec({ desired: "asleep" });
    w.c.exit();
    await w.idle();
    w.core.store.put("wakeRequested", { reason: "webhook", at: w.clock.now() });
    await w.until(() => w.rows().includes(14));
    expect(w.rows()).toContain(14);
    const last = w.ctl.calls.filter((c) => c.m === "beginBoot").pop()?.a as { reason: string };
    expect(last.reason).toBe("wake:webhook");
  });

  it("T-R15 wake in backoff sets wakeRequested; start waits for nextStartAt", async () => {
    const w = world();
    w.c.startErrors.push(new Error("boom"), new Error("boom"));
    await w.core.init();
    await w.core.ensure();
    await w.idle();
    await w.runAlarms(1);
    expect(w.state()).toBe("backoff");
    const before = w.c.startCount;
    const r = await w.core.requestWake("webhook");
    expect(r.action).toBe("flag");
    expect(w.rows()).toContain(15);
    expect(w.core.wakeRequested()?.reason).toBe("webhook");
    expect(w.c.startCount).toBe(before);
  });

  it("F3 a wake in a 5 min infra backoff brings the retry to 30 s after the failure, no sooner", async () => {
    const w = world();
    await w.core.init();
    for (let i = 0; i < 4; i++) w.core.failure(w.core.mkClass("budget:boot", "infra", "", true), false, 11);
    const l0 = w.core.ladder();
    expect(l0.nextStartAt - (l0.failedAt as number)).toBe(5 * 60_000);
    await w.clock.advance(5_000);
    const r = await w.core.requestWake("webhook");
    expect(r.action).toBe("flag");
    const l1 = w.core.ladder();
    expect(l1.nextStartAt - (l1.failedAt as number)).toBe(30_000);
    // 5 s in: still waiting. Another message does not bring it closer.
    expect(w.c.startCount).toBe(0);
    await w.core.requestWake("webhook");
    expect(w.core.ladder().nextStartAt).toBe(l1.nextStartAt);
    await w.clock.advance(26_000);
    await w.core.requestWake("webhook");
    await w.idle();
    expect(w.c.startCount).toBe(1);
  });

  it("F3 state faults and unconfirmed stops keep their backoff", async () => {
    const w = world();
    await w.core.init();
    // fault table at L1 (state fault counted): no shortening
    w.core.failure(w.core.mkClass("restore-blocked:mismatch", "fault", "", true), true, 10);
    const a = w.core.ladder();
    await w.core.requestWake("webhook");
    expect(w.core.ladder().nextStartAt).toBe(a.nextStartAt);
    // an unconfirmed stop keeps its wait for the old container: never an earlier start than that
    const w2 = world();
    await w2.core.init();
    for (let i = 0; i < 4; i++) w2.core.failure(w2.core.mkClass("lost", "infra", "", false), false, 21);
    const b = w2.core.ladder();
    expect(b.unconfirmedUntil).toBeGreaterThan(b.failedAt as number);
    await w2.core.requestWake("webhook");
    expect(w2.core.ladder().nextStartAt).toBeGreaterThanOrEqual(b.unconfirmedUntil as number);
    expect(w2.core.ladder().nextStartAt - (b.failedAt as number)).toBe(30_000);
  });
});
