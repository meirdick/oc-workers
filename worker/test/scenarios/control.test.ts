// Spec §21.2 scenarios on the Control DO: install (§6.6), plans (§8.3), hwm (§13.3), epochs (§6.1),
// markers (§14), gen GC (§13.4), /ops (§19.2) and the proxy (§19.1).
import { afterEach, describe, expect, it } from "vitest";
import { H, MIN, S } from "../harness/timers";
import { INST, type World } from "../harness/world";
import {
  done,
  expectState,
  fresh,
  gensOf,
  setSettings,
  startCount,
  sutP,
  toAsleep,
  toRunning,
} from "./helpers";

const sut = await sutP;
let w: World;
afterEach((ctx) => done(w, ctx));
const lastPlan = (x: World, e?: number) => x.rt(e).ocsup.boots.at(-1)?.plan as Record<string, any>;
const DAY = 24 * H;

describe.skipIf(!sut.ok)(`control plane ${sut.why}`, () => {
  it("S21 initialized=1 + empty replica → restore-blocked:mismatch, no start(), high alert", async () => {
    w = await fresh(sut);
    await w.r2.putJson(`meta/${INST}/installed`, { at: 1 });
    await w.cron();
    await w.until(() => w.stops().length > 0, 5_000);
    expect(startCount(w)).toBe(0);
    expect(w.stops()[0]?.cls).toBe("restore-blocked:mismatch");
    expect(w.alerts().some((a) => a.severity === "high")).toBe(true);
    expect(w.ctl().meta("initialized")).toBe(1);
  });

  it("S22 new Control DO + existing install marker and replica data → not fresh, initialized set", async () => {
    w = await fresh(sut);
    await w.r2.putJson(`meta/${INST}/installed`, { at: 1 });
    await w.r2.put(`r/${INST}/g3/state/openclaw.sqlite/0000/${"0".repeat(15)}1-${"0".repeat(15)}a.ltx`, "x");
    await w.cron();
    await w.advance(2 * S);
    expect(w.gens()[0]?.plan_kind).not.toBe("fresh");
    expect(w.ctl().meta("initialized")).toBe(1);
  });

  it("S23 first-install crash before started → next plan is fresh again", async () => {
    w = await fresh(sut);
    const o = w.rt().ocsup;
    o.readyAfterMs = 60 * MIN;
    await w.cron();
    await w.until(() => !!o.boot?.plan, 5_000);
    expect(o.boot?.plan?.sqlite).toEqual({ kind: "fresh" });
    await o.exit(70, "gateway-crash-loop");
    await w.until(() => o.boots.length === 2 && !!o.boot?.plan, 30_000);
    expect((o.boot?.plan?.sqlite as { kind: string } | undefined)?.kind).toBe("fresh");
    expect(w.ctl().meta("initialized") ?? 0).toBe(0);
  });

  it("S24 Control DO rewound below the hwm → ctl-rewound, restore-blocked:rewound, no start(), high alert", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const hwm = w.r2.json<{ gen: number }>(`meta/${INST}/hwm`);
    expect(hwm?.gen).toBe(1);
    await w.r2.putJson(`meta/${INST}/hwm`, { gen: 5, credsSeq: 0, at: Date.now() });
    w.ctl().restart();
    await w.ctl().call("ensure");
    await w.advance(1 * S);
    expect(w.ctl().meta("ctlState")).toBe("ctl-rewound");
    expect(Number(w.ctl().meta("genCounter"))).toBe(5);
    const n = startCount(w);
    await w.rt().ocsup.exit(70, "gateway-crash-loop");
    await w.until(() => w.stops().length >= 2 || w.gens().length > 1, 30_000);
    await w.advance(5 * S);
    expect(startCount(w)).toBe(n);
    expect(w.gens().at(-1)?.plan_kind).toBe("restore-blocked");
    expect(JSON.parse(w.gens().at(-1)?.plan ?? "{}").sqlite?.reason).toBe("restore-blocked:rewound");
    expect(w.gens().at(-1)?.gen).toBeGreaterThan(5);
    expect(w.alerts().some((a) => a.severity === "high")).toBe(true);
  });

  it.todo(
    "S26 deploy of code N during an N-1 readiness wait → records readable both ways (needs two code versions)",
  );
  it.todo("S27 code-roll failure → retire(N+1), new epoch DO name on the old code (M6 roll path)");

  it("S31 constructor with the Control DO down → proxy still serves the adopted container", async () => {
    w = await fresh(sut);
    await toRunning(w);
    expect((await w.fetch("/chat/warm")).status).toBe(200); // fills the 2 s pointer cache (§19.1)
    w.down.add("Control");
    w.rt().restart();
    const r = await w.fetch("/chat/x");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("gw /chat/x");
  });

  it("S32 deploy-check: live CODE_VERSION ≠ head → 409; open sleep op → 409", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    const a = await w.ops("deploy-check", { head: "not-the-live-code-version" });
    expect(a.status).toBe(409);
    const o = w.rt().ocsup;
    o.script = (op) => (op === "sleep-prepare" ? { ok: true, status: "busy", retryAfterMs: 200 } : undefined);
    await w.until(() => w.state() === "quiescing", 30_000);
    const st = await w.ops("idle");
    const b = await w.ops("deploy-check", { head: st.body.codeVersion });
    expect(b.status).toBe(409);
  });

  it("S33 missing image key at start → image-key-missing, slow backoff, high alert, no ladder change", async () => {
    w = await fresh(sut, { images: {} });
    delete w.rt().c.imageMap.oc;
    await w.cron();
    await w.until(() => w.stops().length > 0, 5_000);
    expect(w.stops()[0]?.cls).toBe("image-key-missing");
    expect(w.ladder()?.level ?? 1).toBe(1);
    expect(w.alerts().some((a) => a.severity === "high")).toBe(true);
    const next = w.ladder()?.nextStartAt as number;
    expect(next - Date.now()).toBeGreaterThan(10 * S); // slow table (test slowMs 15 s)
  });

  it("S33 rollback to a map without the live key → refused", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.images = {};
    const r = await w.ops("epoch/roll", { imageKey: "oc-missing" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(w.epoch()).toBe(1);
    expectState(w, "running");
  });

  it("S65 marker single-use: consumed by beginBoot; 2nd boot from the same snapshot gets `gen`", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    const m = w.markers().at(-1);
    expect(m?.state).toBe("valid");
    setSettings(w, { sleep: { mode: "off" } });
    await w.rt().call("requestWake", "cli");
    await w.until(() => w.state() === "running", 20_000);
    expect(lastPlan(w).sqlite.kind).toBe("marker");
    expect(w.markers().find((x) => x.id === m?.id)?.state).toBe("consumed");
    expect(w.markers().find((x) => x.id === m?.id)?.consumed_by_gen).toBe(gensOf(w).at(-1)?.gen);
    await w.rt().ocsup.exit(70, "gateway-crash-loop");
    await w.until(() => w.rt().ocsup.boots.length === 3 && w.state() === "running", 30_000);
    expect(lastPlan(w).rootfs.snapshotId).toBe(m?.snapshot_id);
    expect(lastPlan(w).sqlite.kind).toBe("gen");
  });

  it("S65 late upload to marker.gen voids a valid marker", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    // Keep the container alive after phase 8 hangs so the old gen can still upload.
    w.rt().c.destroyHang = 1;
    await w.until(() => w.markers().at(-1)?.state === "valid", 30_000);
    await w.rt().ocsup.uploadL0();
    await w.advance(500);
    expect(w.markers().at(-1)?.state).toBe("void");
    expect(w.markers().at(-1)?.void_reason).toBe("late-upload");
  });

  it("S66 gen GC: 40 sleep gens over 8 days → keep set exactly; abandoned > 24 h deleted; read error → no delete", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const now = Date.now();
    const ins = (gen: number, state: string, at: number, reason = "wake:cron") => {
      w.ctl().storage.sql.exec(
        `INSERT INTO gens (gen, epoch, op_id, reason, mode, secret, restore_gens, plan, plan_kind, state, unplanned,
           issued_at, complete_at, ended_at) VALUES (?, 1, ?, ?, 'prod', 's', '[]', '{}', 'gen', ?, 0, ?, ?, ?)`,
        gen,
        `op-${gen}`,
        reason,
        state,
        at,
        state === "complete" ? at + 1000 : null,
        at + 60_000,
      );
      void w.r2.put(`r/${INST}/g${gen}/state/openclaw.sqlite/0000/x.ltx`, "x");
    };
    // gens 100..139: 5 per day over 8 days, all complete sleep gens; 140, 141 abandoned 2 d and 1 h old.
    for (let i = 0; i < 40; i++) ins(100 + i, "complete", now - 8 * DAY + i * (DAY / 5));
    ins(140, "abandoned", now - 2 * DAY, "ladder");
    ins(141, "abandoned", now - 1 * H, "ladder");
    w.ctl().storage.sql.exec("UPDATE meta SET v = '141' WHERE k = 'genCounter'");
    // Fail-closed run first.
    w.r2.listFail = 1000;
    await w.ctl().call("gc");
    await w.settle();
    expect(w.gens().filter((g) => g.state === "deleted").length).toBe(0);
    w.r2.listFail = 0;
    await w.ctl().call("gc");
    await w.settle();
    const live = new Set(
      w
        .gens()
        .filter((g) => g.state !== "deleted")
        .map((g) => g.gen),
    );
    // Expected keep set (§13.4): newest 3 complete, one per UTC day for 7 d, current gen (1), gen 141 (< 24 h).
    const keep = new Set<number>([1, 137, 138, 139, 141]);
    const byDay = new Map<string, number>();
    for (let i = 0; i < 40; i++) {
      const at = now - 8 * DAY + i * (DAY / 5);
      if (now - at > 7 * DAY) continue;
      byDay.set(new Date(at).toISOString().slice(0, 10), 100 + i);
    }
    for (const g of byDay.values()) keep.add(g);
    expect([...live].sort((a, b) => a - b)).toEqual([...keep].sort((a, b) => a - b));
    expect(live.has(140)).toBe(false);
    expect(w.r2.keys(`r/${INST}/g140/`)).toEqual([]);
  });

  it.todo(
    "S67 rebase flag after 7 d → maintenance plan image + archive + gen; next sleep chain_base = itself (M4 archives)",
  );

  it("S80 plan kinds: fresh (first boot), marker (wake), gen (crash after wake)", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    expect(lastPlan(w).sqlite.kind).toBe("fresh");
    await w.until(() => w.state() === "asleep", 30_000);
    setSettings(w, { sleep: { mode: "off" } });
    await w.rt().call("requestWake", "cli");
    await w.until(() => w.state() === "running", 20_000);
    expect(lastPlan(w).sqlite.kind).toBe("marker");
    await w.rt().ocsup.exit(70, "gateway-crash-loop");
    await w.until(() => w.rt().ocsup.boots.length === 3 && w.state() === "running", 30_000);
    const p = lastPlan(w);
    expect(p.sqlite.kind).toBe("gen");
    expect(p.dbs.every((d: { state: string }) => d.state === "uploaded")).toBe(true);
  });
  it.todo("S80 plan kinds: archive (no usable gen) and restore-blocked:schema (schema-newer sources)");

  it("S82 crash between retire and flip → no active epoch; op resumes at flip; ensure refuses the retired epoch", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.restartWhen("Control", w.ctlName(), (q, b) => /update\s+epochs/i.test(q) && b.includes("retired"));
    void w.ops("epoch/roll", {}).catch(() => {});
    await w.until(() => w.epochs().find((e) => e.n === 1)?.status === "retired", 20_000);
    // Spec §6.1 has a window with no active epoch; an atomic retire+flip is also fine. Never two.
    expect(w.epochs().filter((e) => e.status === "active").length).toBeLessThanOrEqual(1);
    await w.rt(1).call("ensure");
    expectState(w, "retired", 1);
    await w.cron();
    await w.until(() => w.epoch() === 2 && w.state(2) === "running", 30_000);
    expect(
      w
        .epochs()
        .filter((e) => e.status === "active")
        .map((e) => e.n),
    ).toEqual([2]);
  });

  it("S30 CI token on each destructive /ops route → 404", async () => {
    w = await fresh(sut);
    await toRunning(w);
    for (const p of [
      "wake",
      "start",
      "stop",
      "restart",
      "sleep",
      "epoch/roll",
      "restore",
      "inbox",
      "events",
      "logs",
      "fault",
    ]) {
      const r = await w.ops(p, p === "inbox" || p === "events" || p === "logs" ? undefined : {}, "ci");
      expect([p, r.status]).toEqual([p, 404]);
    }
    for (const p of ["status", "idle", "images-in-use"]) {
      const r = await w.ops(p, undefined, "ci");
      expect([p, r.status]).toEqual([p, 200]);
    }
    expectState(w, "running");
  });
});

describe.skipIf(!sut.ok)(`issue checks ${sut.why}`, () => {
  it("I-1 S76 S34 fresh gen → complete after its first upload; a crash then restarts from it (no workaround)", async () => {
    w = await fresh(sut, { freshCompleteWorkaround: false });
    await toRunning(w);
    await w.advance(1 * S);
    expect(w.gens()[0]?.state).toBe("complete");
    w.rt().c.vanish();
    await w.until(() => w.rt().ocsup.boots.length === 2 && w.state() === "running", 30_000);
    expect(lastPlan(w).sqlite).toMatchObject({ kind: "gen", gen: 1 });
  });
});
