// Pure Runtime modules: classifier (§9.1), ladder (§9.2-§9.4), proxy headers (§19.1), ops auth (§19.2),
// timers (§20), plus core behaviours that need no machine row: inactivity, orphan, gate rules, idle, lead.
import { describe, expect, it } from "vitest";
import { exitError, M0_TEXTS } from "../../src/core/fake-container";
import { DEFAULT_TIMERS, TEST_TIMERS, timersFrom } from "../../src/core/timers";
import { classifyStop } from "../../src/rt/classify";
import { applyFailure, l5Due, maybeReset, newLadder } from "../../src/rt/ladder";
import { ROWS } from "../../src/rt/machine";
import { gatewayHeaders, safeCloseCode, wakingResponse } from "../../src/rt/proxy";
import { world } from "./world";

const T = TEST_TIMERS;

describe("classifier §9.1 (S1, S36)", () => {
  const rej = (err: unknown, o: Record<string, unknown> = {}) =>
    classifyStop({ outcome: "rejected", err, ...o });
  it.each([
    ["resolve + open sleep op", { outcome: "resolved", openOp: "sleep" }, "planned", "none", true],
    ["resolve + draining", { outcome: "resolved", draining: true }, "platform", "zero", true],
    ["resolve, neither", { outcome: "resolved" }, "unknown-platform", "infra", false],
    ["no settle, no op", { outcome: "none" }, "lost", "infra", false],
    ["no settle + open stop op", { outcome: "none", openOp: "stop" }, "planned", "none", true],
  ] as const)("S36 %s", (_n, input, cls, table, confirmed) => {
    const sc = classifyStop(input as never);
    expect([sc.cls, sc.table, sc.confirmed]).toEqual([cls, table, confirmed]);
  });
  it.each([
    [137, null, "oom?", "evidence", "fault"],
    [134, null, "heap-abort", "evidence", "fault"],
    [75, "restore-blocked:mismatch", "restore-blocked:mismatch", true, "fault"],
    [75, "restore-blocked:infra", "infra", false, "infra"],
    [75, "replica-blocked:local", "replica-blocked:local", true, "fault"],
    [75, "replica-down:local", "replica-down:local", true, "fault"],
    [75, "auto-restart", "auto-restart", false, "zero"],
    [75, "restore-blocked:schema", "restore-blocked:schema", false, "slow"],
    [75, "disk-full", "disk-full", false, "infra"],
    [78, "config-blocked", "config-blocked", true, "fault"],
    [78, "doctor-failed", "doctor-failed", true, "fault"],
    [78, "ownership", "ownership", true, "fault"],
    [78, "doctor-required", "doctor-required", false, "zero"],
    [78, "lock-blocked", "lock-blocked", false, "infra"],
    [77, "stale", "fenced", false, "infra"],
    [70, "supervisor", "supervisor", false, "infra"],
    [70, "gateway-crash-loop", "exit:70", "evidence", "fault"],
    [42, null, "exit:42", "evidence", "fault"],
  ] as const)("S1 exit %s %s", (code, reason, cls, esc, table) => {
    const sc = rej(exitError(code), reason ? { exitEvent: { code, reason } } : {});
    expect([sc.cls, sc.esc, sc.table]).toEqual([cls, esc, table]);
    // C15: exitCode rejects are unconfirmed until T1 (exitCodeConfirms) or a signalled drain.
    expect(sc.confirmed).toBe(false);
  });
  it("S1 m0 texts: capacity, signalled, snapshot, destroy with an open op", () => {
    expect(rej(new Error(M0_TEXTS.capacity)).cls).toBe("capacity");
    expect(rej(new Error(M0_TEXTS.signalled))).toMatchObject({
      cls: "platform",
      table: "zero",
      confirmed: true,
    });
    expect(rej(new Error(M0_TEXTS.snapshot("x")))).toMatchObject({ cls: "snapshot-lost", replan: true });
    expect(rej(new Error(M0_TEXTS.destroyed), { destroyed: true }).cls).toBe("planned");
    expect(rej(exitError(137), { openOp: "sleep" }).cls).toBe("oom?");
  });
  it("S1 exit event code wins over the parsed text code; 77 with a retired epoch has no backoff", () => {
    expect(rej(exitError(137), { exitEvent: { code: 75, reason: "auto-restart" } }).cls).toBe("auto-restart");
    expect(rej(exitError(77), { epochRetired: true }).table).toBe("none");
  });
  it("S14 reject with no exitCode and no exit event → unknown-platform, unconfirmed", () => {
    expect(rej(new Error("something odd"))).toMatchObject({ cls: "unknown-platform", confirmed: false });
  });
});

describe("ladder §9.2-§9.3", () => {
  const sf = (cls = "config-blocked") =>
    classifyStop({ outcome: "rejected", err: exitError(78), exitEvent: { code: 78, reason: cls } });
  it("S15 L1→L2→L3→L4→slow on state faults only; alerts at L3+; never parks", () => {
    let l = newLadder();
    const levels: unknown[] = [l.level];
    const alerts: string[] = [];
    let now = 1_000_000;
    for (let i = 0; i < 8; i++) {
      const out = applyFailure(l, sf(), { now, stateFault: true, lastHbAt: now, t: T });
      l = out.ladder;
      alerts.push(...out.alerts.map((a) => a.class));
      if (levels.at(-1) !== l.level) levels.push(l.level);
      expect(l.nextStartAt).toBeGreaterThanOrEqual(now);
      now = l.nextStartAt + 1;
    }
    expect(levels).toEqual([1, 2, 3, 4, "slow"]);
    expect(alerts).toEqual(expect.arrayContaining(["ladder-l3", "ladder-l4", "ladder-slow"]));
    expect(l.nextStartAt - (now - 1) <= T.slowMs + T.unconfirmedWaitMs).toBe(true);
  });
  it("S16 S81 S17 infra failures never move the level", () => {
    let l = newLadder();
    for (let i = 0; i < 30; i++)
      l = applyFailure(l, classifyStop({ outcome: "resolved" }), {
        now: i * 1000,
        stateFault: false,
        lastHbAt: null,
        t: T,
      }).ladder;
    expect(l.level).toBe(1);
    expect(l.stateFaults).toBe(0);
  });
  it("fault delay by level: L1 0, L2 5 s; infra 5 s/30 s/2 min/5 min; unconfirmed adds lastHb + 7 s", () => {
    let l = newLadder();
    let o = applyFailure(l, sf(), { now: 0, stateFault: true, lastHbAt: null, t: T });
    expect(o.delayMs).toBe(0);
    l = { ...newLadder(), level: 2 };
    o = applyFailure(l, sf(), { now: 0, stateFault: true, lastHbAt: null, t: T });
    expect(o.delayMs).toBe(5000);
    let li = newLadder();
    const d: number[] = [];
    for (let i = 0; i < 5; i++) {
      const x = applyFailure(li, classifyStop({ outcome: "resolved" }), {
        now: 0,
        stateFault: false,
        lastHbAt: 0,
        t: T,
      });
      d.push(x.delayMs);
      li = x.ladder;
    }
    expect(d).toEqual([5000, 30000, 120000, 300000, 300000]);
    expect(li.nextStartAt).toBe(300000);
    const u = applyFailure(newLadder(), classifyStop({ outcome: "none" }), {
      now: 100,
      stateFault: false,
      lastHbAt: 90,
      t: T,
    });
    expect(u.ladder.nextStartAt).toBe(Math.max(100 + 5000, 90 + T.unconfirmedWaitMs));
  });
  it("reset after ladderResetMs running; l5-pending only in slow with evidence and healthy probes (C5)", () => {
    const l = { ...newLadder(), level: 3 as const, stateFaults: 1, classStreak: 2, firstFailAt: 1 };
    expect(maybeReset(l, 10_000, 10_000 - T.ladderResetMs + 1, T)).toBeNull();
    expect(maybeReset(l, 10_000, 10_000 - T.ladderResetMs, T)?.level).toBe(1);
    const slow = { ...newLadder(), level: "slow" as const, slowSince: 0, mismatchCount: 3 };
    expect(l5Due(slow, T.l5PendingMs - 1, true, T)).toBe(false);
    expect(l5Due(slow, T.l5PendingMs, false, T)).toBe(false);
    expect(l5Due(slow, T.l5PendingMs, true, T)).toBe(true);
    expect(l5Due({ ...slow, mismatchCount: 0 }, T.l5PendingMs, true, T)).toBe(false);
  });
  it("machine table holds rows 1..58 in order", () => {
    expect(ROWS.map((r) => r.id)).toEqual(Array.from({ length: 58 }, (_, i) => i + 1));
  });
});

describe("proxy and timers", () => {
  it("§19.1 header rules: strip forwarding, scopes, cf-access, authorization; set XFF from CF-Connecting-IP", () => {
    const h = gatewayHeaders(
      new Headers({
        host: "oc.example.workers.dev",
        authorization: "Bearer owner",
        "x-forwarded-for": "1.2.3.4",
        forwarded: "x",
        "x-real-ip": "5.6.7.8",
        "x-openclaw-scopes": "admin",
        "cf-access-jwt-assertion": "j",
        "cf-connecting-ip": "203.0.113.9",
        cookie: "a=b",
      }),
    );
    expect(h.get("authorization")).toBeNull();
    expect(h.get("x-openclaw-scopes")).toBeNull();
    expect(h.get("cf-access-jwt-assertion")).toBeNull();
    expect(h.get("x-real-ip")).toBeNull();
    expect(h.get("forwarded")).toBeNull();
    expect(h.get("host")).toBeNull();
    expect(h.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(h.get("x-forwarded-proto")).toBe("https");
    expect(h.get("x-forwarded-host")).toBe("oc.example.workers.dev");
    expect(safeCloseCode(1006)).toBe(1000);
    expect(safeCloseCode(1012)).toBe(1012);
  });
  it("§19.1 waking answers: /healthz JSON 503, HTML 503 text, WS 503", async () => {
    const r1 = wakingResponse(new Request("https://x/healthz"));
    expect([r1.status, await r1.json()]).toEqual([503, { ok: false, status: "waking" }]);
    expect(wakingResponse(new Request("https://x/", { headers: { accept: "text/html" } })).status).toBe(503);
    expect(wakingResponse(new Request("https://x/ws", { headers: { upgrade: "websocket" } })).status).toBe(
      503,
    );
  });
  it("§20 OC_TIMERS only with OC_TEST=1; inactivityMs never shortened", () => {
    expect(timersFrom({ OC_TEST: "0", OC_TIMERS: '{"preset":"test"}' })).toEqual(DEFAULT_TIMERS);
    const t = timersFrom({ OC_TEST: "1", OC_TIMERS: '{"preset":"test","hbLostMs":9}' });
    expect(t.hbLostMs).toBe(9);
    expect(t.reconcileMs).toBe(1000);
    expect(t.inactivityMs).toBe(6 * 3600_000);
  });
});

describe("core behaviours", () => {
  it("S35 setInactivityTimeout is called on every tick before a step that throws", async () => {
    const w = world();
    w.ctl.inputs.blockers = ["socket:x"];
    await w.boot();
    w.ctl.epochStatus = async () => {
      throw new Error("ctl down");
    };
    const n = w.c.inactivityCalls.length;
    for (let i = 0; i < 3; i++) await w.tick(w.clock.now() + 1000);
    expect(w.c.inactivityCalls.length).toBe(n + 3);
    expect(w.state()).toBe("running");
  });

  it("S29 orphan snapshotInFlight at constructor: cleared, orphan? event", async () => {
    const w = world();
    w.ctl.inputs.blockers = ["socket:x"];
    await w.boot();
    w.core.store.put("snapshotInFlight", { startedAt: w.clock.now(), kind: "sleep", opId: "x" });
    await w.restart();
    expect(w.core.store.get("snapshotInFlight")).toBeUndefined();
    expect(w.ctl.rings.some((r) => r.kind === "orphan?")).toBe(true);
  });

  it("S31 constructor with the Control DO down: the proxy still serves the adopted container", async () => {
    const w = world();
    w.ctl.inputs.blockers = ["socket:x"];
    await w.boot();
    w.ctl.epochStatus = async () => {
      throw new Error("ctl down");
    };
    w.core.patchRec({ epochCheckedAt: 0 });
    await w.restart();
    expect(await w.core.proxyAllowed()).toBe("serve");
  });

  it("S50 requestWake per state (§10.7)", async () => {
    const cases: Record<string, string> = {};
    const w = world();
    w.ctl.inputs.blockers = ["socket:x"];
    await w.core.init();
    cases.new = (await w.core.requestWake("cli")).action;
    await w.idle();
    cases.running = (await w.core.requestWake("cli")).action;
    w.core.tr(25);
    cases.maintenance = (await w.core.requestWake("cli")).action;
    w.core.tr(30);
    w.core.tr(23, "draining");
    cases.draining = (await w.core.requestWake("cli")).action;
    w.core.tr(24, "quiescing");
    cases.quiescing = (await w.core.requestWake("cli")).action;
    w.core.tr(38, "asleep-unconfirmed");
    cases["asleep-unconfirmed"] = (await w.core.requestWake("cli")).action;
    w.core.tr(54, "stopped");
    cases.stopped = (await w.core.requestWake("cli")).action;
    w.core.tr(57, "retired");
    cases.retired = (await w.core.requestWake("cli")).action;
    expect(cases).toEqual({
      new: "start",
      running: "none",
      maintenance: "none",
      draining: "none",
      quiescing: "flag",
      "asleep-unconfirmed": "after-settle",
      stopped: "none",
      retired: "none",
    });
  });

  it("S51 each sleep-gate rule false on its own: no sleep op, status names the rule", async () => {
    const rules: [string, (w: ReturnType<typeof world>) => void][] = [
      ["1:mode-off", (w) => (w.ctl.inputs.mode = "off")],
      ["1:socket:discord", (w) => (w.ctl.inputs.blockers = ["socket:discord"])],
      ["2:ws", (w) => w.setBridges(1)],
      ["5:inbox", (w) => (w.ctl.inputs.inboxBusy = 1)],
      ["9:cost-guard", (w) => (w.ctl.inputs.costOk = false)],
      ["11:seeding", () => {}],
    ];
    for (const [rule, apply] of rules) {
      const w = world();
      await w.boot();
      apply(w);
      await w.hb(rule === "11:seeding" ? { rpo: "seeding" } : {});
      await w.tick(w.clock.now() + 3000);
      expect([rule, w.state()]).toEqual([rule, "running"]);
      expect((await w.core.status()).sleep.blockedOn).toBe(rule);
    }
  });

  it("S53 cost guard refusal alerts sleep-thrash once per day", async () => {
    const w = world();
    await w.boot();
    w.ctl.inputs.costOk = false;
    for (let i = 0; i < 3; i++) {
      await w.hb();
      await w.tick(w.clock.now() + 3000);
    }
    expect(w.ctl.alerted("sleep-thrash")).toBe(1);
  });

  it("S52 adaptive idle: wakes 7 min after sleep double idle 2 → 4 → 8 → 16 → 24 s cap; reset after > 60 min", async () => {
    const w = world({ timers: { maintEveryMs: 24 * 3600_000 } });
    await w.boot();
    const idles: number[] = [];
    const toSleep = async () => {
      for (let i = 0; i < 60 && w.state() !== "asleep"; i++) {
        await w.hb();
        await w.tick(w.clock.now() + 1000);
      }
    };
    for (let i = 0; i < 5; i++) {
      await toSleep();
      expect(w.state()).toBe("asleep");
      await w.clock.advance(7 * 60_000);
      await w.core.requestWake("cli");
      await w.idle();
      idles.push(w.core.sleepRec().idleMs as number);
    }
    expect(idles).toEqual([4000, 8000, 16000, 24000, 24000]);
    await toSleep();
    await w.clock.advance(61 * 60_000);
    await w.core.requestWake("cli");
    await w.idle();
    expect(w.core.sleepRec().idleMs).toBe(2000);
  });

  it("S54 lead after 20 cron wakes = clamp(p95 + 30 s, 60-300 s); before that leadMs", () => {
    const w = world({ timers: { leadMs: 120_000 } });
    const s = w.core.sleepRec();
    expect(w.core.leadMs(s)).toBe(120_000);
    expect(w.core.leadMs({ ...s, leadSamples: Array(20).fill(40_000) })).toBe(70_000);
    expect(w.core.leadMs({ ...s, leadSamples: Array(20).fill(5_000) })).toBe(60_000);
    expect(w.core.leadMs({ ...s, leadSamples: Array(20).fill(600_000) })).toBe(300_000);
  });

  it("S72 final snapshot: handle saved before the answer; second call 409 done; not running → not-running", async () => {
    const w = world();
    w.ctl.inputs.blockers = ["socket:x"];
    await w.boot();
    const a = await w.core.finalSnapshot({});
    expect(a.ok).toBe(true);
    expect(w.ctl.snapshots[0]).toMatchObject({ id: a.snapshotId, kind: "final" });
    expect(w.core.drain()?.finalSnapshotId).toBe(a.snapshotId);
    const b = await w.core.finalSnapshot({});
    expect([b.status, b.error]).toEqual([409, "done"]);
    w.c.exit();
    expect((await w.core.finalSnapshot({})).error).toBe("not-running");
  });

  it("S37 doctor-required then again: one boot with runDoctor, second → doctor-failed escalates", async () => {
    const w = world();
    w.ctl.inputs.blockers = ["socket:x"];
    await w.boot();
    await w.event("exit", { code: 78, reason: "doctor-required" });
    w.c.exit(exitError(78));
    await w.idle();
    expect(w.core.ladder().doctorPending).toBe(true);
    await w.until(() => w.state() === "running");
    const plan = w.ctl.calls.filter((c) => c.m === "beginBoot").pop()?.a as { runDoctor: boolean };
    expect(plan.runDoctor).toBe(true);
    expect(w.core.boot()?.runDoctor).toBe(true);
    await w.event("exit", { code: 78, reason: "doctor-required" });
    w.c.exit(exitError(78));
    await w.idle();
    expect(w.core.store.stops(1)[0]).toMatchObject({ cls: "doctor-failed", esc: "true" });
  });

  it("S20 hung start() ×3 → Control reslot requested once; the ladder still has a nextStartAt", async () => {
    const w = world();
    w.c.readyAfterMs = 3_600_000;
    await w.core.init();
    await w.core.ensure();
    await w.idle();
    await w.until(() => w.ctl.reslots > 0, 40);
    expect(w.ctl.reslots).toBe(1);
    expect(w.ctl.alerted("reslot")).toBe(1);
    expect(w.state()).toBe("backoff");
    expect(w.core.ladder().nextStartAt).toBeGreaterThan(0);
  });

  it("S32 deploy-check: 409 while a sleep/stop/start op is open or CODE_VERSION differs; 200 else", async () => {
    const w = world();
    w.ctl.inputs.blockers = ["socket:x"];
    await w.boot();
    expect(w.core.deployCheck("cv-1").status).toBe(200);
    expect(w.core.deployCheck("cv-2")).toMatchObject({ status: 409, reason: "code-version" });
    w.core.openOp("sleep", "test");
    expect(w.core.deployCheck("cv-1")).toMatchObject({ status: 409, reason: "op-open", opOpen: ["sleep"] });
    expect(w.core.idleInfo()).toMatchObject({ asleep: false, codeVersion: "cv-1" });
  });

  it("deliver replays through 18789 and reports durable acceptance", async () => {
    const w = world();
    w.ctl.inputs.blockers = ["socket:x"];
    await w.boot();
    w.c.portHandler = (req) =>
      new URL(req.url).pathname === "/telegram-webhook"
        ? new Response("", { status: 200, headers: { "x-openclaw-delivery-accepted": "durable" } })
        : Response.json({ status: "started" });
    const r = await w.core.deliver({ path: "/telegram-webhook", body: "{}", headers: {} });
    expect(r).toEqual({ status: 200, durable: true });
  });
});

describe("l5-pending (C5)", () => {
  it("S15 slow + 3 mismatches + healthy probes for l5PendingMs → l5-pending high, no source change", async () => {
    const w = world();
    await w.core.init();
    w.core.putLadder({ ...w.core.ladder(), level: "slow", slowSince: w.clock.now(), mismatchCount: 3 });
    w.core.patchRec({ state: "backoff", desired: "running" });
    w.core.setNextStart(w.clock.now() + 10 * 60_000);
    await w.core.tickBackoff();
    expect(w.ctl.alerted("l5-pending")).toBe(0);
    await w.clock.advance(w.timers.l5PendingMs);
    await w.core.tickBackoff();
    expect(w.ctl.alerts.find((a) => a.class === "l5-pending")?.severity).toBe("high");
    expect(w.ctl.count("beginBoot")).toBe(0);
  });
});

describe("settings document in the Runtime DO", () => {
  it("overlays timers from the Control DO, caches 10 s, and falls back to the base values", async () => {
    const w = world();
    let view: { ver: number; t: Record<string, number>; rt: Record<string, number> } = {
      ver: 1,
      t: { idleMs: 777, minAwakeMs: 9_000 },
      rt: { uiIdleMs: 555, checkpointsPerDay: 3 },
    };
    let calls = 0;
    w.ctl.settingsView = async () => {
      calls++;
      return view;
    };
    const base = { idle: w.core.t.idleMs, ui: w.core.rt.uiIdleMs };
    await w.core.refreshSettings();
    expect([w.core.t.idleMs, w.core.t.minAwakeMs, w.core.rt.uiIdleMs, w.core.rt.checkpointsPerDay]).toEqual([
      777, 9_000, 555, 3,
    ]);
    view = { ver: 2, t: {}, rt: {} };
    await w.core.refreshSettings(); // inside the cache: no call, same values
    expect(calls).toBe(1);
    expect(w.core.t.idleMs).toBe(777);
    await w.clock.advance(11_000);
    await w.core.refreshSettings();
    expect(calls).toBe(2);
    expect([w.core.t.idleMs, w.core.rt.uiIdleMs]).toEqual([base.idle, base.ui]); // key gone → base again
  });

  it("a Control DO that does not answer keeps the last values and is asked again at the next op", async () => {
    const w = world();
    w.ctl.settingsView = async () => ({ ver: 1, t: { cronTailMs: 4_000 }, rt: {} });
    await w.core.refreshSettings();
    w.ctl.settingsView = async () => {
      throw new Error("ctl down");
    };
    await w.clock.advance(11_000);
    await w.core.refreshSettings();
    expect(w.core.t.cronTailMs).toBe(4_000);
    let asked = 0;
    w.ctl.settingsView = async () => {
      asked++;
      return { ver: 2, t: { cronTailMs: 8_000 }, rt: {} };
    };
    await w.core.refreshSettings(); // no new wait after a failure
    expect([asked, w.core.t.cronTailMs]).toEqual([1, 8_000]);
  });
});
