// Spec §5.2: one test per transition row (T-R1..T-R58). Coverage: test/coverage-rows.mjs.
import { afterEach, describe, expect, it } from "vitest";
import type { World } from "../harness/world";
import {
  done,
  expectState,
  fresh,
  gensOf,
  lastHbAt,
  lastStop,
  openOps,
  patchRec,
  setEpochStatus,
  startCount,
  sutP,
  TEXT,
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
const destroyedWith = (x: World, why: string) =>
  x.rt().c.calls.some((c) => c.op === "destroy" && String(c.detail).includes(why));
const startOp = (x: World) =>
  x
    .ops_()
    .filter((o) => o.kind === "start")
    .at(-1);

describe.skipIf(!sut.ok)(`§5.2 rows ${sut.why}`, () => {
  it("T-R1 new + ensure → starting, desired running, start op `user`", async () => {
    w = await fresh(sut);
    await w.cron();
    expect(["starting", "running"]).toContain(w.state());
    expect(w.rt().kv<{ desired: string }>("rec")?.desired).toBe("running");
    expect(startOp(w)?.reason).toBe("user");
  });
  it("T-R1 new + wake(webhook) → starting, start op `wake:webhook`", async () => {
    w = await fresh(sut);
    w.down.add("Runtime");
    await w.cron(); // Control installs e1, cannot reach the Runtime DO
    w.down.clear();
    await w.rt().call("requestWake", "webhook");
    await w.settle();
    expect(["starting", "running"]).toContain(w.state());
    expect(startOp(w)?.reason).toBe("wake:webhook");
  });
  it("T-R2 new + any RPC with epoch retired → retired, no start", async () => {
    w = await fresh(sut);
    await toRunning(w);
    await w.ops("epoch/roll", {});
    await w.until(() => w.epoch() === 2, 30_000);
    w.wipe("Runtime", w.rtName(1));
    await w.rt(1).call("ensure");
    expectState(w, "retired", 1);
    expect(startCount(w, 1)).toBe(1);
  });
  it("T-R3 starting + start-ok → running; on-started writes initialized, install marker, wake log", async () => {
    w = await fresh(sut);
    await toRunning(w);
    expect(w.ctl().meta("initialized")).toBe(1);
    expect(w.r2.keys("meta/t1/installed")).toEqual(["meta/t1/installed"]);
    expect(w.ctl().rows("SELECT * FROM wake_log").length).toBe(1);
    expect(startOp(w)?.state).toBe("done");
  });
  it("T-R4 starting + capacity → waiting-capacity, gen kept", async () => {
    w = await fresh(sut);
    await toWaitingCapacity(w);
    expect(gensOf(w).length).toBe(1);
    expect(w.stops().filter((s) => s.state_fault).length).toBe(0);
  });
  it("T-R5 waiting-capacity + tick at nextStartAt → starting, same gen", async () => {
    w = await fresh(sut);
    await toWaitingCapacity(w);
    const n = startCount(w);
    w.rt().c.startDefault = "ok";
    await w.until(() => w.state() === "running", 10_000);
    expect(startCount(w)).toBe(n + 1);
    expect(gensOf(w).length).toBe(1);
  });
  it("T-R6 waiting-capacity + retire → retired, op aborted, gen abandoned", async () => {
    w = await fresh(sut);
    await toWaitingCapacity(w);
    await w.rt().call("retire");
    expectState(w, "retired");
    expect(startOp(w)?.state).toBe("aborted");
    expect(gensOf(w)[0]?.state).toBe("abandoned");
  });
  it("T-R6 waiting-capacity + owner stop → stopped, op aborted, gen abandoned", async () => {
    w = await fresh(sut);
    await toWaitingCapacity(w);
    await w.rt().call("ownerStop");
    await w.settle();
    expectState(w, "stopped");
    expect(startOp(w)?.state).toBe("aborted");
    expect(gensOf(w)[0]?.state).toBe("abandoned");
  });
  it("T-R7 starting + snapshot not found → replan in the same op, snapshot suspect", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    const snap = w.snapshots().at(-1);
    expect(snap?.kind).toBe("sleep");
    w.rt().c.snapshots.delete(snap?.id as string);
    const lvl = w.ladder()?.level;
    await w.rt().call("requestWake", "webhook");
    await w.until(() => w.state() === "running", 20_000);
    expect(w.snapshots().find((s) => s.id === snap?.id)?.state).toBe("suspect");
    expect(w.ops_().filter((o) => o.kind === "start" && o.reason === "wake:webhook").length).toBe(1);
    expect(w.ladder()?.level ?? 1).toBe(lvl ?? 1);
    expect(lastStop(w)?.cls).toBe("snapshot-lost");
  });
  it("T-R8 starting + already running, labels match → adopt, no second container", async () => {
    w = await fresh(sut);
    await toStarting(w);
    w.rt().restart();
    w.rt().ocsup.readyAfterMs = 100;
    w.rt().ocsup.started = true;
    await w.until(() => w.state() === "running", 10_000);
    expect(w.rt().c.count("destroy")).toBe(0);
    expect(gensOf(w).length).toBe(1);
  });
  it("T-R9 starting + already running, labels differ → destroy(stale), backoff, no state fault", async () => {
    w = await fresh(sut);
    w.rt().c.start({ image: "x", labels: { inst: "t1", epoch: "1", gen: "99", mode: "prod" } });
    w.rt().c.calls.length = 0;
    await w.cron();
    await w.until(() => destroyedWith(w, "stale"), 5_000);
    await w.until(() => ["backoff", "starting", "running"].includes(w.state() as string), 5_000);
    expect(w.stops().some((s) => s.state_fault)).toBe(false);
  });
  it("T-R10 starting + plan restore-blocked → no start(), class = reason, high alert, backoff", async () => {
    w = await fresh(sut);
    await w.r2.putJson("meta/t1/installed", { at: 1 });
    await w.cron();
    await w.until(() => w.state() === "backoff", 5_000);
    expect(startCount(w)).toBe(0);
    expect(lastStop(w)?.cls).toBe("restore-blocked:mismatch");
    expect(w.alerts().some((a) => a.severity === "high")).toBe(true);
  });
  it("T-R11 starting + settle → stop recorded, backoff", async () => {
    w = await fresh(sut);
    await toStarting(w);
    w.rt().c.crash(70);
    await w.until(() => w.stops().length > 0, 5_000);
    expect(lastStop(w)?.cls).toBe("exit:70");
  });
  it("T-R11 starting + hb gap > hbLostMs → failed start", async () => {
    w = await fresh(sut, {
      timers: { budgetBootMs: 60_000, budgetRestoreImageMs: 60_000, budgetRestoreSnapMs: 60_000 },
    });
    await toStarting(w);
    w.rt().ocsup.hbDrop = true;
    await w.until(() => w.stops().length > 0, 15_000);
    expect(lastStop(w)?.cls).toBe("lost");
  });
  it("T-R11 starting + phase budget miss → failed start", async () => {
    w = await fresh(sut);
    await toStarting(w); // phase stays `restore`; image budget 15 s in test
    await w.until(() => w.stops().length > 0, 30_000, 200);
    expect(w.rt().c.count("destroy")).toBeGreaterThan(0);
  });
  it("T-R12 starting + sigterm event → draining, drain.sigtermAt persisted", async () => {
    w = await fresh(sut);
    await toStarting(w);
    await w.rt().ocsup.sigterm();
    await w.settle();
    expectState(w, "draining");
    expect(w.rt().kv<{ sigtermAt: number }>("drain")?.sigtermAt).toBeGreaterThan(0);
  });
  it("T-R13 backoff + tick at nextStartAt, desired running → start op `ladder`", async () => {
    w = await fresh(sut);
    await toBackoff(w);
    await w.until(() => w.state() === "starting" || w.state() === "running", 20_000);
    expect(startOp(w)?.reason).toBe("ladder");
  });
  it("T-R14 backoff + tick, desired asleep → start op `wake:<pending>`", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    w.rt().c.startScript = [{ monitorReject: TEXT.exit137, exitCode: 137 }];
    await w.rt().call("requestWake", "webhook");
    await w.until(() => w.state() === "backoff", 5_000);
    await w.until(() => w.state() === "running", 20_000);
    expect(
      w
        .ops_()
        .filter((o) => o.kind === "start")
        .at(-1)?.reason,
    ).toMatch(/^wake:/);
  });
  it("T-R15 backoff + wake → wakeRequested set, start waits for nextStartAt", async () => {
    w = await fresh(sut);
    await toBackoff(w);
    const next = w.ladder()?.nextStartAt as number;
    const n = startCount(w);
    await w.rt().call("requestWake", "webhook");
    expect(w.rt().kv("wakeRequested")).toBeTruthy();
    expectState(w, "backoff");
    expect(startCount(w)).toBe(n);
    await w.until(() => startCount(w) > n, 30_000);
    expect(Date.now()).toBeGreaterThanOrEqual(next);
  });
  it("T-R16 running + tick, epoch retiring → destroy(retired), retired", async () => {
    w = await fresh(sut);
    await toRunning(w);
    setEpochStatus(w, 1, "retiring");
    await w.until(() => w.state() === "retired", 10_000);
    expect(destroyedWith(w, "retired")).toBe(true);
  });
  it("T-R17 running + hb age > hbLostMs → lost, destroy, start ≥ lastHb + unconfirmedWaitMs", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.rt().ocsup.hbDrop = true;
    const lastHb = lastHbAt(w);
    await w.until(() => lastStop(w)?.cls === "lost", 20_000);
    expect(lastStop(w)?.confirmed).toBe(0);
    expect(w.rt().c.count("destroy")).toBeGreaterThan(0);
    const n = startCount(w);
    await w.until(() => startCount(w) > n, 30_000);
    expect(Date.now()).toBeGreaterThanOrEqual(lastHb + 7_000);
  });
  it("T-R18 running + identity mismatch → stale, destroy(stale), L1", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.rt().ocsup.identity = { gen: 999, epoch: 1, iid: "f".repeat(32), secretHash: "0".repeat(64) };
    await w.until(() => lastStop(w)?.cls === "stale", 20_000);
    expect(destroyedWith(w, "stale")).toBe(true);
    expect(w.ladder()?.level ?? 1).toBe(1);
  });
  it("T-R19 running + identity exec fails → retry, no destroy", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.rt().ocsup.identity = "fail";
    await w.advance(15_000);
    expectState(w, "running");
    expect(w.rt().c.count("destroy")).toBe(0);
  });
  it("T-R20 running + 5 /healthz fails → ocsupctl restart-gateway, stays running", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.rt().ocsup.healthzFail = true;
    await w.until(() => w.rt().ocsup.ctl.some((c) => c.op === "restart-gateway"), 20_000);
    expectState(w, "running");
  });
  it("T-R20 running + restart-gateway exec fails → replace, class exit:70", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const o = w.rt().ocsup;
    o.healthzFail = true;
    o.script = (op) => (op === "restart-gateway" ? "hang" : undefined); // exec fails (timeout)
    await w.until(() => lastStop(w)?.cls === "exit:70", 20_000);
  });
  it("T-R21 running + running=false with no settle → class lost, unconfirmed", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.rt().c.vanish();
    await w.until(() => w.stops().length > 0, 10_000);
    expect(lastStop(w)?.cls).toBe("lost");
    expect(lastStop(w)?.confirmed).toBe(0);
  });
  it("T-R22 running + settle 137 → stop `oom?`, ladder, restart", async () => {
    w = await fresh(sut);
    await toRunning(w);
    await w.rt().ocsup.exit(137, "supervisor");
    await w.until(() => w.stops().length > 0, 5_000);
    expect(lastStop(w)?.cls).toBe("oom?");
    await w.until(() => w.state() === "running", 20_000);
  });
  it("T-R23 running + sigterm event → draining", async () => {
    w = await fresh(sut);
    await toDraining(w);
  });
  it("T-R23 running + heartbeat draining:true (no event) → draining", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.rt().ocsup.draining = true;
    await w.until(() => w.state() === "draining", 5_000);
  });
  it("T-R24 running + sleep gate holds → op sleep, quiescing", async () => {
    w = await fresh(sut, { sleep: true });
    await toQuiescing(w);
    expect(openOps(w, "sleep").length).toBe(1);
  });
  it("T-R25 running + maintenance due → op maint, maintenance", async () => {
    w = await fresh(sut);
    await toMaintenance(w);
    expect(openOps(w, "maint").length).toBe(1);
  });
  it("T-R26 running + owner stop → planned stop op, stopping", async () => {
    w = await fresh(sut);
    await toStopping(w);
    expect(openOps(w, "stop").length).toBe(1);
  });
  it("T-R27 running + wake → stays running, wakeRequested cleared", async () => {
    w = await fresh(sut);
    await toRunning(w);
    await w.rt().call("requestWake", "ui");
    expectState(w, "running");
    expect(w.rt().kv("wakeRequested") ?? null).toBeNull();
  });
  it("T-R28 running + retire → destroy(retired), settle, retired", async () => {
    w = await fresh(sut);
    await toRetired(w);
    expect(destroyedWith(w, "retired")).toBe(true);
  });
  it("T-R29 running + exit 77 then settle, epoch active → fenced, L1, backoff", async () => {
    w = await fresh(sut);
    await toRunning(w);
    await w.rt().ocsup.exit(77, "stale");
    await w.until(() => w.stops().length > 0, 5_000);
    expect(lastStop(w)?.cls).toBe("fenced");
    expect(w.ladder()?.level ?? 1).toBe(1);
  });
  it("T-R30 maintenance + maint done → running", async () => {
    w = await fresh(sut);
    await toMaintenance(w);
    w.r2.headDelayMs = 0;
    await w.until(() => w.state() === "running", 40_000);
    expect(w.ring("row").some((r) => /"row":30/.test(r.detail))).toBe(true);
  });
  it("T-R31 maintenance + settle → backoff", async () => {
    w = await fresh(sut);
    await toMaintenance(w);
    w.rt().c.crash(70);
    // Issue I-4: the settle waits for the open maint op (here a 30 s R2 probe) before it is recorded.
    await w.until(() => w.stops().length > 0, 40_000);
    expect(lastStop(w)?.cls).toBe("exit:70");
  });
  it("T-R32 draining + platform settle → platform, confirmed, start at once", async () => {
    w = await fresh(sut);
    await toDraining(w);
    const n = startCount(w);
    w.rt().c.signalled();
    await w.until(() => startCount(w) > n, 3_000);
    expect(lastStop(w)?.cls).toBe("platform");
    expect(lastStop(w)?.confirmed).toBe(1);
  });
  it("T-R33 draining + drain cap passed → lost, destroy, unconfirmed", async () => {
    w = await fresh(sut);
    await toDraining(w);
    await w.until(() => lastStop(w)?.cls === "lost", 40_000, 200);
    expect(lastStop(w)?.confirmed).toBe(0);
    expect(w.rt().c.count("destroy")).toBeGreaterThan(0);
  });
  it("T-R34 draining + 6 ticks → no restart, destroy, snapshot or exec", async () => {
    w = await fresh(sut);
    await toDraining(w);
    const c = w.rt().c;
    const before = c.calls.length;
    await w.advance(6_000);
    const ops = c.calls.slice(before).map((x) => x.op);
    expect(ops.filter((o) => ["start", "destroy", "snapshot", "exec"].includes(o))).toEqual([]);
    expectState(w, "draining");
  });
  it("T-R35 draining + constructor with running=false → platform, nextStartAt = now", async () => {
    w = await fresh(sut);
    await toDraining(w);
    w.rt().restart();
    w.rt().c.vanish();
    const t = Date.now();
    w.rt().construct();
    await w.until(() => w.stops().length > 0, 2_000);
    expect(lastStop(w)?.cls).toBe("platform");
    expect(w.ladder()?.nextStartAt).toBeLessThanOrEqual(t + 1_000);
  });
  it("T-R36 draining + settle with an open sleep op → asleep (§10.5)", async () => {
    w = await fresh(sut, { sleep: true });
    await toQuiescing(w);
    await w.rt().ocsup.sigterm();
    await w.until(() => w.state() === "draining", 3_000);
    await w.rt().ocsup.drained();
    w.rt().c.signalled();
    await w.until(() => w.state() === "asleep" || w.state() === "asleep-unconfirmed", 5_000);
  });
  it("T-R37 quiescing + sleep done, settled → asleep", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    expect(
      w
        .ops_()
        .filter((o) => o.kind === "sleep")
        .at(-1)?.state,
    ).toBe("done");
  });
  it("T-R38 quiescing + destroy timeout → asleep-unconfirmed", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleepUnconfirmed(w);
  });
  it("T-R39 quiescing + abort from phase 4 → resume-after-sleep, running", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    const o = w.rt().ocsup;
    o.script = (op) => {
      if (op === "sleep-stop-gateway") void w.rt().call("requestWake", "webhook");
      return undefined;
    };
    await w.until(() => o.ctl.some((c) => c.op === "resume-after-sleep"), 30_000);
    await w.until(() => w.state() === "running", 5_000);
  });
  it("T-R40 quiescing + wake → flag only", async () => {
    w = await fresh(sut, { sleep: true });
    await toQuiescing(w);
    await w.rt().call("requestWake", "webhook");
    expect(w.rt().kv("wakeRequested")).toBeTruthy();
    expect(["quiescing", "running"]).toContain(w.state());
  });
  it("T-R41 quiescing + sigterm → no more ocsupctl, op interrupted:sigterm, draining", async () => {
    w = await fresh(sut, { sleep: true });
    await toQuiescing(w);
    await w.rt().ocsup.sigterm();
    await w.settle();
    const n = w.rt().ocsup.ctl.length;
    await w.advance(3_000);
    expectState(w, "draining");
    expect(w.rt().ocsup.ctl.length).toBe(n);
    expect(
      w
        .ops_()
        .filter((x) => x.kind === "sleep")
        .at(-1)?.state,
    ).toBe("interrupted:sigterm");
  });
  it("T-R42 quiescing + settle before destroy → op failed, marker void, backoff", async () => {
    w = await fresh(sut, { sleep: true });
    await toQuiescing(w);
    w.rt().c.crash(137);
    await w.until(() => w.stops().length > 0, 5_000);
    expect(
      w
        .ops_()
        .filter((x) => x.kind === "sleep")
        .at(-1)?.state,
    ).toBe("failed");
    expect(w.markers().filter((m) => m.state === "pending" || m.state === "valid")).toEqual([]);
  });
  it("T-R43 asleep + wake → start op `wake:r`", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    await w.rt().call("requestWake", "cli");
    expect(["starting", "running"]).toContain(w.state());
    expect(startOp(w)?.reason).toBe("wake:cli");
  });
  it("T-R44 asleep + alarm at wakeAt → start op `wake:cron`", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    w.rt().ocsup.nextWakeAtMs = Date.now() + 20_000;
    await w.until(() => w.state() === "asleep", 30_000);
    await w.until(() => w.state() === "starting" || w.state() === "running", 30_000);
    expect(startOp(w)?.reason).toBe("wake:cron");
  });
  it("T-R45 S69 asleep + ensure after wakeAt + 2 min (lost alarm) → wake:cron", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    w.rt().ocsup.nextWakeAtMs = Date.now() + 20_000;
    await w.until(() => w.state() === "asleep", 30_000);
    w.rt().storage.alarmAt = null;
    await w.advance(20_000 + 125_000, 1_000);
    expectState(w, "asleep");
    await w.cron();
    expect(["starting", "running"]).toContain(w.state());
    expect(startOp(w)?.reason).toBe("wake:cron");
  });
  it("T-R46 S69 asleep + ensure with a non-held pending inbox row → wake:inbox", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    w.dropRequestWake = 1;
    await w.webhook({ update_id: 1, message: { from: { id: 5 }, chat: { id: 5 }, text: "hi" } });
    expectState(w, "asleep");
    await w.cron();
    expect(["starting", "running"]).toContain(w.state());
    expect(startOp(w)?.reason).toMatch(/^wake:(inbox|webhook)$/);
  });
  it("T-R47 asleep + ensure, nothing due → alarm re-armed, still asleep", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    w.rt().storage.alarmAt = null;
    await w.cron();
    expectState(w, "asleep");
    expect(w.rt().alarmAt()).not.toBeNull();
  });
  it("T-R48 S68 asleep + constructor with running=true → destroy(stale), not adopted", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    const c = w.rt().c;
    c.start({ image: "x", labels: { ...c.labels } });
    w.rt().restart();
    w.rt().construct();
    await w.until(() => destroyedWith(w, "stale"), 3_000);
    expect(["asleep-unconfirmed", "asleep"]).toContain(w.state());
  });
  it("T-R49 asleep-unconfirmed + running=false → asleep", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleepUnconfirmed(w);
    w.rt().c.vanish();
    await w.until(() => w.state() === "asleep", 5_000);
  });
  it("T-R50 asleep-unconfirmed + ticks → destroy again, alert zombie after zombieAlertMs", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleepUnconfirmed(w);
    w.rt().c.destroyHang = 100;
    await w.advance(12_000, 200);
    expect(w.rt().c.count("destroy")).toBeGreaterThan(2);
    expect(w.alert("zombie")).toBeTruthy();
    expectState(w, "asleep-unconfirmed");
  });
  it("T-R51 asleep-unconfirmed + hb from that boot → ack stop:true", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleepUnconfirmed(w);
    const r = await w.rt().ocsup.heartbeat();
    expect(r?.body?.stop).toBe(true);
  });
  it("T-R52 asleep-unconfirmed + wake → start after lastHb + unconfirmedWaitMs", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleepUnconfirmed(w);
    w.rt().c.destroyHang = 100;
    w.rt().ocsup.hbDrop = true;
    const lastHb = lastHbAt(w);
    const n = startCount(w);
    await w.rt().call("requestWake", "webhook");
    expect(startCount(w)).toBe(n);
    await w.until(() => startCount(w) > n, 20_000, 20);
    expect(Date.now()).toBeGreaterThanOrEqual(lastHb + 7_000); // row 52: lastHb + unconfirmedWaitMs
  });
  it("T-R53 stopping + stop done, settled → stopped", async () => {
    w = await fresh(sut);
    await toStopped(w);
    expect(
      w
        .ops_()
        .filter((o) => o.kind === "stop")
        .at(-1)?.state,
    ).toBe("done");
  });
  it("T-R54 stopping + destroy timeout → stopped, stop unconfirmed", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.rt().c.destroyHang = 1;
    await w.rt().call("ownerStop");
    await w.until(() => w.state() === "stopped", 30_000);
    expect(lastStop(w)?.confirmed ?? 0).toBe(0);
  });
  it("T-R55 stopped + owner start → starting, start op `user`", async () => {
    w = await fresh(sut);
    await toStopped(w);
    await w.rt().call("ownerStart");
    expect(["starting", "running"]).toContain(w.state());
    expect(startOp(w)?.reason).toBe("user");
  });
  it("T-R56 stopped + ensure / wake → stays stopped", async () => {
    w = await fresh(sut);
    await toStopped(w);
    const n = startCount(w);
    await w.cron();
    await w.rt().call("requestWake", "webhook");
    await w.advance(3_000);
    expectState(w, "stopped");
    expect(startCount(w)).toBe(n);
  });
  it("T-R57 backoff + retire → retired; asleep + retire → retired", async () => {
    w = await fresh(sut);
    await toBackoff(w);
    await w.rt().call("retire");
    expectState(w, "retired");
    w.dispose();
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    await w.rt().call("retire");
    expectState(w, "retired");
  });
  it("T-R58 constructor with persisted epoch retired and a running container → destroy(retired)", async () => {
    w = await fresh(sut);
    await toRunning(w);
    setEpochStatus(w, 1, "retired");
    patchRec(w, { epochStatus: "retired" });
    w.rt().restart();
    w.rt().construct();
    await w.until(() => destroyedWith(w, "retired"), 3_000);
    expectState(w, "retired");
  });
});
