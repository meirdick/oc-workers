// Spec §21.2 scenarios on the start op, classifier (§9.1), ladder (§9.3) and stuck slot (§9.4).
import { afterEach, describe, expect, it } from "vitest";
import { imageDigestOf } from "../../src/core/version";
import { H, MIN, S } from "../harness/timers";
import type { World } from "../harness/world";
import {
  done,
  expectState,
  fresh,
  gensOf,
  lastHbAt,
  lastStop,
  setSettings,
  startCount,
  sutP,
  TEXT,
  toAsleep,
  toDraining,
  toRunning,
} from "./helpers";

const sut = await sutP;
let w: World;
afterEach((ctx) => done(w, ctx));

const plans = (x: World, epoch?: number) =>
  x
    .rt(epoch)
    .ocsup.boots.map((b) => b.plan)
    .filter(Boolean) as Record<string, any>[];
const lastPlan = (x: World, epoch?: number) => plans(x, epoch).at(-1) as Record<string, any>;

/** §9.1 rows the fakes can produce: [label, inject, cls, confirmed (null = not checked)]. */
type Inj = (x: World) => Promise<void> | void;
const exitWith =
  (code: number, reason: string): Inj =>
  (x) =>
    x.rt().ocsup.exit(code, reason);
const CLASS_ROWS: [string, Inj, string, number | null][] = [
  ["resolve, open stop op", (x) => void x.rt().call("ownerStop"), "planned", 1],
  [
    "resolve, draining",
    async (x) => {
      await x.rt().ocsup.sigterm();
      x.rt().c.exitClean();
    },
    "platform",
    1,
  ],
  ["resolve, neither", (x) => x.rt().c.exitClean(), "unknown-platform", 0],
  ["exit 137 (m0 text)", exitWith(137, "supervisor"), "oom?", null],
  ["exit 134", exitWith(134, "supervisor"), "heap-abort", null],
  ["75 restore-blocked:mismatch", exitWith(75, "restore-blocked:mismatch"), "restore-blocked:mismatch", null],
  ["75 restore-blocked:infra", exitWith(75, "restore-blocked:infra"), "infra", null],
  ["75 replica-blocked:local", exitWith(75, "replica-blocked:local"), "replica-blocked:local", null],
  ["75 replica-down:local", exitWith(75, "replica-down:local"), "replica-down:local", null],
  ["75 auto-restart", exitWith(75, "auto-restart"), "auto-restart", null],
  ["75 restore-blocked:schema", exitWith(75, "restore-blocked:schema"), "restore-blocked:schema", null],
  ["75 disk-full", exitWith(75, "disk-full"), "disk-full", null],
  ["78 config-blocked", exitWith(78, "config-blocked"), "config-blocked", null],
  ["78 doctor-failed", exitWith(78, "doctor-failed"), "doctor-failed", null],
  ["78 ownership", exitWith(78, "ownership"), "ownership", null],
  ["78 doctor-required", exitWith(78, "doctor-required"), "doctor-required", null],
  ["78 lock-blocked", exitWith(78, "lock-blocked"), "lock-blocked", null],
  ["77 stale", exitWith(77, "stale"), "fenced", null],
  ["70 supervisor", exitWith(70, "supervisor"), "supervisor", null],
  ["70 gateway-crash-loop", exitWith(70, "gateway-crash-loop"), "exit:70", null],
  ["signalled text", (x) => x.rt().c.signalled(), "platform", 1],
  ["running=false, no settle", (x) => x.rt().c.vanish(), "lost", 0],
];

describe.skipIf(!sut.ok)(`start, classifier, ladder ${sut.why}`, () => {
  it.each(CLASS_ROWS)("S1 S36 class row: %s → %s", async (_l, inject, cls, confirmed) => {
    w = await fresh(sut);
    await toRunning(w);
    await inject(w);
    await w.until(() => w.stops().length > 0, 10_000);
    expect(lastStop(w)?.cls).toBe(cls);
    if (confirmed !== null) expect(lastStop(w)?.confirmed).toBe(confirmed);
  });

  it("S1 high alerts for schema, disk-full; alert for supervisor", async () => {
    for (const [code, reason, alert] of [
      [75, "restore-blocked:schema", "high"],
      [75, "disk-full", "high"],
      [70, "supervisor", null],
    ] as const) {
      w = await fresh(sut);
      await toRunning(w);
      await w.rt().ocsup.exit(code, reason);
      await w.until(() => w.stops().length > 0, 5_000);
      if (alert) expect(w.alerts().some((a) => a.severity === "high")).toBe(true);
      else expect(w.alerts().length).toBeGreaterThan(0);
      w.dispose();
    }
  });

  it("S2 capacity reject on the monitor path → waiting-capacity, no failed start, retry at capacityFastMs", async () => {
    w = await fresh(sut);
    w.rt().c.startScript = [{ monitorReject: TEXT.capacity }];
    await w.cron();
    await w.until(() => w.state() === "waiting-capacity", 3_000);
    const t = Date.now();
    expect(w.stops().filter((s) => s.state_fault).length).toBe(0);
    expect(w.ladder()?.stateFaults ?? 0).toBe(0);
    await w.until(() => startCount(w) === 2, 2_000, 20);
    expect(Date.now() - t).toBeLessThanOrEqual(300);
  });

  it("S3 capacity for 1 h with a pending retire → 1 gen, retire pre-empts, retired, gen abandoned", async () => {
    w = await fresh(sut);
    w.rt().c.startDefault = { throw: TEXT.capacity };
    await w.cron();
    await w.advance(1 * H, 500);
    expect(startCount(w)).toBeGreaterThan(100);
    expect(gensOf(w).length).toBe(1);
    expectState(w, "waiting-capacity");
    await w.rt().call("retire");
    expectState(w, "retired");
    expect(gensOf(w)[0]?.state).toBe("abandoned");
  }, 60_000);

  it("S4 snapshot not found on monitor() → suspect, next candidate in the same op, marker void, no level change", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    const snap = w.snapshots().at(-1)?.id as string;
    expect(w.markers().at(-1)?.state).toBe("valid");
    w.rt().c.snapshots.delete(snap);
    await w.rt().call("requestWake", "cli");
    await w.until(() => w.state() === "running", 20_000);
    expect(w.snapshots().find((s) => s.id === snap)?.state).toBe("suspect");
    expect(w.markers().find((m) => m.snapshot_id === snap)?.state).toBe("void");
    expect(w.stops().find((s) => s.cls === "snapshot-lost")?.state_fault).toBe(0);
    expect(lastPlan(w).sqlite.kind).not.toBe("marker");
    expect(w.ladder()?.level ?? 1).toBe(1);
  });

  it("S4 snapshot not found as a start() throw → same handling", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    const snap = w.snapshots().at(-1)?.id as string;
    w.rt().c.snapshots.delete(snap);
    w.rt().c.snapshotMissThrows = true;
    await w.rt().call("requestWake", "cli");
    await w.until(() => w.state() === "running", 20_000);
    expect(w.snapshots().find((s) => s.id === snap)?.state).toBe("suspect");
    expect(w.ops_().filter((o) => o.kind === "start" && o.reason === "wake:cli").length).toBe(1);
  });

  it("S5 newest snapshot missing while a newer archive exists → archive path; 2nd miss → bad", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    const snap = w.snapshots().at(-1) as { id: string; created_at: number };
    // Fixture: a complete archive newer than the snapshot (archives arrive via /v1/archive in M4).
    w.ctl().storage.sql.exec(
      `INSERT INTO archives (id, key, kind, state, sha256, size, digest, state_schema, agent_schema, txid, gen, created_at, completed_at)
       VALUES ('ar1', 'a/t1/x.tar.gz', 'clean', 'complete', ?, 10, ?, 0, 0, '{}', 1, ?, ?)`,
      "a".repeat(64),
      w.images.oc as string,
      snap.created_at + 1000,
      snap.created_at + 1000,
    );
    await w.r2.putJson("a/t1/x.tar.gz", { fake: true });
    w.rt().c.snapshots.delete(snap.id);
    await w.rt().call("requestWake", "cli");
    await w.until(() => w.state() === "running", 20_000);
    expect(w.snapshots().find((s) => s.id === snap.id)?.state).toBe("suspect");
    const p = lastPlan(w);
    expect(p.rootfs.kind).toBe("image");
    expect(p.archive?.archiveId).toBe("ar1");
    // Second boot that picks the suspect snapshot again → bad.
    w.rt().ocsup.script = () => undefined;
    await w.rt().ocsup.exit(70, "gateway-crash-loop");
    await w.until(() => w.snapshots().find((s) => s.id === snap.id)?.state === "bad", 30_000);
  });

  it("S6 DO restart in each start-op phase → resumes, adopts by labels, start() once per gen", async () => {
    for (const phase of ["phase0", "plan", "persist", "intercepts", "start", "armed", "ready"]) {
      w = await fresh(sut);
      const cut = w.restartWhen("Runtime", w.rtName(1), (q, b) =>
        phase === "phase0"
          ? /insert\s+(or\s+\w+\s+)?into\s+ops/i.test(q) && b.includes(phase)
          : /^\s*update\s+ops/i.test(q) && b.includes(phase),
      );
      await w.cron();
      await w.advance(500);
      if (!w.rt().slot.inst) await w.rt().call("ensure");
      await w.until(() => w.state() === "running", 20_000);
      const gens = gensOf(w).length;
      expect([phase, cut()]).toEqual([phase, true]);
      expect([phase, gens]).toEqual([phase, 1]);
      const okStarts = w.rt().c.calls.filter((c) => c.op === "start").length;
      expect([phase, okStarts <= 2]).toEqual([phase, true]); // a 2nd call only if it threw "already running"
      expect([phase, w.rt().c.count("destroy")]).toEqual([phase, 0]);
      w.dispose();
    }
  });

  it("S9 retired epoch with a running container → destroyed on the next tick", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.ctl().storage.sql.exec("UPDATE epochs SET status = 'retired' WHERE n = 1");
    await w.until(() => w.state() === "retired", 5_000);
    expect(w.rt().c.running).toBe(false);
  });

  it("S10 sigterm then 6 ticks → no restart, no destroy, no exec", async () => {
    w = await fresh(sut);
    await toDraining(w);
    const c = w.rt().c;
    const n = c.calls.length;
    await w.advance(6 * S);
    expect(c.calls.slice(n).filter((x) => ["start", "destroy", "exec", "snapshot"].includes(x.op))).toEqual(
      [],
    );
  });

  it("S11 sigterm, DO reset, container exit → start at once, class platform", async () => {
    w = await fresh(sut);
    await toDraining(w);
    w.rt().restart();
    w.rt().c.signalled();
    const t = Date.now();
    await w.rt().call("ensure");
    await w.until(() => startCount(w) === 2, 3_000, 20);
    expect(lastStop(w)?.cls).toBe("platform");
    expect(Date.now() - t).toBeLessThan(2 * S);
  });

  it("S12 signalled drain → no unconfirmedWaitMs wait", async () => {
    w = await fresh(sut);
    await toDraining(w);
    w.rt().ocsup.hbDrop = true;
    await w.rt().ocsup.drained();
    const t = Date.now();
    w.rt().c.signalled();
    await w.until(() => startCount(w) === 2, 5_000, 20);
    expect(Date.now() - t).toBeLessThan(7 * S);
    expect(lastStop(w)?.confirmed).toBe(1);
  });

  it("S13 hb > hbLostMs with a working exec → lost, replaced, next start ≥ lastHb + unconfirmedWaitMs", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.rt().ocsup.hbDrop = true;
    const lastHb = lastHbAt(w);
    await w.until(() => startCount(w) === 2, 30_000);
    expect(w.stops().at(-1)?.cls).toBe("lost");
    expect(Date.now()).toBeGreaterThanOrEqual(lastHb + 7 * S);
  });

  it("S14 reject with no exitCode and no exit event → waits until lastHb + unconfirmedWaitMs", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.rt().ocsup.hbDrop = true;
    const lastHb = lastHbAt(w);
    w.rt().c.crash(137, false);
    await w.until(() => startCount(w) === 2, 30_000);
    expect(Date.now()).toBeGreaterThanOrEqual(lastHb + 7 * S);
    expect(lastStop(w)?.confirmed).toBe(0);
  });

  it("S15 ladder L1→L2→L3→L4→slow with an eviction every tick; l5-pending; no SQLite source change", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const kinds = new Set<string>();
    const levels: (number | string)[] = [];
    const o = w.rt().ocsup;
    // Every boot dies with state-fault evidence before `started`.
    o.readyAfterMs = 60 * MIN;
    o.bootDelayMs = 10;
    const name = w.rtName(1);
    const origFire = w.advance.bind(w);
    await o.exit(78, "config-blocked");
    // §20 has no test values for the fault table (L4 waits 2 min), so this runs ~10 min of fake time.
    const seen = () => {
      const lv = w.ladder()?.level;
      if (lv !== undefined && levels.at(-1) !== lv) levels.push(lv);
    };
    for (let i = 0; i < 1500 && w.ladder()?.level !== "slow"; i++) {
      await origFire(1000, 250);
      seen();
      w.restart("Runtime", name); // eviction every tick
      seen();
      const p = w.rt().ocsup.boot?.plan as { sqlite?: { kind: string } } | undefined;
      if (p?.sqlite) kinds.add(p.sqlite.kind);
      if (w.rt().c.running && w.rt().ocsup.boot?.plan) await w.rt().ocsup.exit(78, "config-blocked");
    }
    expect(levels).toEqual([1, 2, 3, 4, "slow"]);
    expect(w.alert("ladder-l3")).toBeTruthy();
    expect(w.alert("ladder-l4")).toBeTruthy();
    expect(w.alert("ladder-slow")).toBeTruthy();
    expect([...kinds].filter((k) => k !== "gen" && k !== "archive" && k !== "fresh")).toEqual([]);
    // In slow with SQLite evidence for l5PendingMs → l5-pending, no automatic source change.
    for (let i = 0; i < 400 && !w.alert("l5-pending"); i++) {
      await w.advance(1 * S, 200);
      if (w.rt().c.running && w.rt().ocsup.boot?.plan)
        await w.rt().ocsup.exit(75, "restore-blocked:mismatch");
    }
    expect(w.alert("l5-pending")?.severity).toBe("high");
    expect(w.ctl().rows("SELECT * FROM ops WHERE kind = 'l5'").length).toBe(0);
  }, 60_000);

  it("S16 S81 crash loop during 30 min of R2 5xx → stays L1 (state faults need healthy R2)", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.r2.failUntil = Date.now() + 30 * MIN;
    const o = w.rt().ocsup;
    o.readyAfterMs = 60 * MIN;
    await o.exit(78, "config-blocked");
    const until = Date.now() + 2 * MIN;
    while (Date.now() < until) {
      await w.advance(500, 100);
      if (w.rt().c.running && o.boot?.plan) await o.exit(78, "config-blocked");
    }
    expect(w.ladder()?.level ?? 1).toBe(1);
    // The boot that started before the outage had healthy probes; it may count once.
    expect(w.stops().filter((s) => s.state_fault).length).toBeLessThanOrEqual(1);
  }, 60_000);

  it("S17 replica-oom ×10 → no stop, L1 only", async () => {
    w = await fresh(sut);
    await toRunning(w);
    for (let i = 0; i < 10; i++) {
      await w.rt().ocsup.event("replica-down", { reason: "replica-oom" });
      await w.rt().ocsup.event("replica-up", { reason: "replica-oom" });
      await w.advance(2 * S);
    }
    expect(w.stops()).toEqual([]);
    expect(w.ladder()?.level ?? 1).toBe(1);
    expectState(w, "running");
  });

  it("S18 L1 after a crash of the same epoch → same snapshot id restored again", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    const snap = w.snapshots().at(-1)?.id;
    setSettings(w, { sleep: { mode: "off" } });
    await w.rt().call("requestWake", "cli");
    await w.until(() => w.state() === "running", 20_000);
    expect(lastPlan(w).rootfs.snapshotId).toBe(snap);
    await w.rt().ocsup.exit(70, "gateway-crash-loop");
    await w.until(() => w.rt().ocsup.boots.length === 3 && w.state() === "running", 20_000);
    expect(lastPlan(w).rootfs.snapshotId).toBe(snap);
  });

  for (const kind of ["start", "destroy", "inspect"] as const) {
    it(`S20 hung ${kind}() ×3 → reslot: e1 retired, e2 active, ≤ 1 extra gen`, async () => {
      w = await fresh(sut);
      const c = w.rt(1).c;
      if (kind === "start") c.startDefault = "hang";
      if (kind === "destroy") {
        // A zombie with other labels: each attempt needs destroy("stale"), which hangs.
        c.start({ image: "x", labels: { inst: "t1", epoch: "1", gen: "77", mode: "prod" } });
        c.destroyHang = 1000; // a stuck slot: every destroy hangs
      }
      if (kind === "inspect") {
        c.start({ image: "x", labels: { inst: "t1", epoch: "1", gen: "77", mode: "prod" } });
        c.inspectHang = 1000; // a wedged slot: inspect and destroy both hang
        c.destroyHang = 1000;
      }
      await w.cron();
      await w.until(() => w.epoch() === 2, 120_000, 100);
      const e = w.epochs();
      expect(e.find((x) => x.n === 1)?.status).toBe("retired");
      expect(e.find((x) => x.n === 2)?.status).toBe("active");
      // Same image: e2 keeps e1's key; its digest is the deployed map's (O1: the epoch digest follows it).
      expect(e.find((x) => x.n === 2)?.image_key).toBe(e.find((x) => x.n === 1)?.image_key);
      expect(e.find((x) => x.n === 2)?.digest).toBe(imageDigestOf(w.images.oc));
      await w.until(() => w.state(2) === "running", 30_000);
      expect(gensOf(w, 2).length).toBeLessThanOrEqual(1);
    }, 60_000);
  }

  it("S25 ensure() with a stopped container (desired running) → starts it", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.rt().restart();
    w.rt().c.vanish();
    await w.cron();
    await w.until(() => startCount(w) === 2, 15_000);
  });

  it("S28 confirmed retire → next epoch starts with no unconfirmedWaitMs wait", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const r = await w.ops("epoch/roll", {});
    expect(r.status).toBeLessThan(300);
    const t = Date.now();
    await w.until(() => w.epoch() === 2 && w.state(2) === "running", 20_000);
    expect(Date.now() - t).toBeLessThan(7 * S);
  });

  it("S29 orphan snapshotInFlight at constructor → cleared, counted, orphan? event", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.rt().storage.sql.exec(
      "INSERT OR REPLACE INTO kv (k, v) VALUES ('snapshotInFlight', ?)",
      JSON.stringify({ startedAt: Date.now() - 1000, kind: "sleep", opId: "op-x" }),
    );
    w.rt().restart();
    w.rt().construct();
    await w.advance(2 * S);
    expect(w.rt().kv("snapshotInFlight") ?? null).toBeNull();
    expect(w.ring().some((r) => /orphan\?/.test(`${r.kind} ${r.detail}`))).toBe(true);
  });

  it("S34 running=false, no settle, no open op → lost; next plan from the newest complete gen, no marker", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.rt().c.vanish();
    await w.until(() => w.rt().ocsup.boots.length === 2 && w.state() === "running", 30_000);
    expect(w.stops()[0]?.cls).toBe("lost");
    expect(lastPlan(w).sqlite.kind).toBe("gen");
    expect(lastPlan(w).sqlite.gen).toBe(1);
  });

  it("S35 alarm with failing steps after step 1 → setInactivityTimeout on every tick, handler never throws", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const c = w.rt().c;
    const n = c.inactivity.length;
    w.down.add("Control");
    w.rt().ocsup.identity = "fail";
    w.rt().ocsup.healthzFail = true;
    await w.advance(5 * S);
    expect(c.inactivity.length - n).toBeGreaterThanOrEqual(4);
    expect(c.inactivity.every((x) => x.ms === 6 * H)).toBe(true);
    expect(w.alarmErrors).toEqual([]);
  });

  it("S37 doctor-required, then again → first: one runDoctor boot, no escalation; second: doctor-failed", async () => {
    w = await fresh(sut);
    await toRunning(w);
    await w.rt().ocsup.exit(78, "doctor-required");
    await w.until(() => w.rt().ocsup.boots.length === 2 && !!w.rt().ocsup.boot?.plan, 10_000);
    expect(lastPlan(w).runDoctor).toBe(true);
    expect(lastStop(w)?.state_fault).toBe(0);
    await w.until(() => w.state() === "running", 10_000);
    await w.rt().ocsup.exit(78, "doctor-required");
    await w.until(() => w.stops().length === 2, 5_000);
    expect(lastStop(w)?.cls).toBe("doctor-failed");
  });

  it("S19 already running with wrong labels → destroy(stale), backoff, not a state fault", async () => {
    w = await fresh(sut);
    w.rt().c.start({ image: "x", labels: { inst: "t1", epoch: "1", gen: "5", mode: "prod" } });
    await w.cron();
    await w.until(
      () => w.rt().c.calls.some((c) => c.op === "destroy" && /stale/.test(String(c.detail))),
      5_000,
    );
    await w.until(() => w.state() === "running", 20_000);
    expect(w.stops().some((s) => s.state_fault)).toBe(false);
  });

  it("S7 Control DO restart in the middle of beginBoot → 1 gen, 1 secret for the op", async () => {
    w = await fresh(sut);
    w.restartWhen("Control", w.ctlName(), (q) => /INSERT INTO gens/i.test(q));
    await w.cron();
    await w.until(() => w.state() === "running", 20_000);
    const g = gensOf(w);
    expect(g.length).toBe(1);
    expect(new Set(w.rt().ocsup.boots.map((b) => b.secret)).size).toBe(1);
  });
});
