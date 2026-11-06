// M3 fixes of the M2 security review, Control DO side: F6 (replay driver stall), F2 (storage bounds, guard),
// F11 (Control DO alarm chain after a hung tick).
import { describe, expect, it } from "vitest";
import { boundsGuard, boundsTick, DEAD_KEEP, GEN_ROWS_KEEP, HARD } from "../../src/ctl/bounds";
import { credRestore } from "../../src/ctl/creds";
import { DEAD_AFTER_TIMEOUTS } from "../../src/ctl/driver";
import { CAPS, STORAGE } from "../../src/gates/ledger";
import { FakeStorage } from "../harness/storage";
import { tg, type World, world } from "./world";

async function running(w: World, rows: number[]) {
  w.install();
  w.api.noteRtState(1, "running");
  w.rt(1).state = "running";
  w.db.run(
    `INSERT INTO gens (gen, epoch, op_id, reason, mode, secret, restore_gens, plan, plan_kind, state, unplanned, issued_at)
     VALUES (1, 1, 'op-1', 'user', 'prod', 's', '[]', '{"sqlite":{"kind":"fresh"}}', 'fresh', 'booting', 0, 0)`,
  );
  for (const id of rows) w.api.inboxPut({ body: tg(id), headers: { host: "h" } });
  await w.api.onStarted({
    epoch: 1,
    gen: 1,
    opId: "op-1",
    reason: "user",
    digest: "d",
    wakeAt: 0,
    aliveMs: 1,
    startupzMs: 1,
  });
}
const states = (w: World) =>
  w.db.all<{ platform_key: string; state: string; dead_reason: string | null }>(
    "SELECT platform_key, state, dead_reason FROM inbox ORDER BY CAST(platform_key AS INTEGER)",
  );

describe("F6 replay driver: a delivery the gateway never answers", () => {
  it("A13: a hung Runtime DO deliver ends at deliverTimeoutMs; kickDriver settles; later rows go on", async () => {
    const w = world({ timers: { deliverTimeoutMs: 50 } });
    await running(w, [1, 2, 3]);
    w.api.ingressReady(1); // attempts count after ingress-ready
    let hang = true;
    w.rt(1).deliverFn = () => (hang ? new Promise(() => {}) : { status: 200, durable: true });
    const t0 = Date.now();
    await w.api.kickDriver(); // 1 hung delivery (timeout), then row 1 waits for its retry time
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(
      w.db.one<{ attempts: number }>("SELECT attempts FROM inbox WHERE platform_key = '1'")?.attempts,
    ).toBe(1);
    hang = false;
    w.advance(60_000);
    await w.api.kickDriver();
    expect(states(w).map((r) => r.state)).toEqual(["accepted", "accepted", "accepted"]);
  });

  it(`${DEAD_AFTER_TIMEOUTS} timeouts in a row of one row → dead deliver-timeout, alert inbox-dead, next rows accepted`, async () => {
    const w = world();
    await running(w, [1, 2, 3]);
    w.rt(1).deliverFn = (r) =>
      JSON.parse(r.body).update_id === 1
        ? { status: 0, durable: false, error: "timeout" }
        : { status: 200, durable: true };
    for (let i = 0; i < DEAD_AFTER_TIMEOUTS + 2; i++) {
      await w.api.kickDriver();
      w.advance(60_000);
    }
    expect(states(w)).toEqual([
      { platform_key: "1", state: "dead", dead_reason: "deliver-timeout" },
      { platform_key: "2", state: "accepted", dead_reason: null },
      { platform_key: "3", state: "accepted", dead_reason: null },
    ]);
    expect(w.db.all("SELECT class FROM alerts WHERE class = 'inbox-dead'")).toHaveLength(1);
    expect(w.rt(1).delivered.filter((d) => JSON.parse(d.body).update_id === 1)).toHaveLength(
      DEAD_AFTER_TIMEOUTS,
    );
  });

  it("a 503 (container not ready) between timeouts resets the count: no dead row", async () => {
    const w = world();
    await running(w, [1]);
    let n = 0;
    w.rt(1).deliverFn = () =>
      n++ % 2 ? { status: 503, durable: false } : { status: 0, durable: false, error: "timeout" };
    for (let i = 0; i < 8; i++) {
      await w.api.kickDriver();
      w.advance(60_000);
    }
    expect(states(w)[0]?.state).toBe("pending");
  });
});

describe("F2 storage bounds (Control DO side)", () => {
  it("owner creds restore keeps the newest CAPS.credsHistPerPath versions", () => {
    const w = world();
    w.install();
    for (let s = 1; s <= 40; s++)
      w.db.run(
        "INSERT INTO creds_hist (path, seq, gen, sha256, mode, b64, deleted, at) VALUES ('a', ?, 1, 'x', 384, 'eA==', 0, ?)",
        s,
        w.clock.t,
      );
    w.db.run(
      "INSERT INTO creds (path, gen, seq, sha256, mode, b64, deleted, updated_at) VALUES ('a', 1, 40, 'x', 384, 'eA==', 0, 0)",
    );
    expect(credRestore(w.ctx, "a", 35).status).toBe(200);
    expect(w.db.one("SELECT COUNT(*) AS n, MIN(seq) AS lo FROM creds_hist")).toEqual({
      n: CAPS.credsHistPerPath,
      lo: 41 - CAPS.credsHistPerPath + 1,
    });
  });

  it("boundsTick: dead inbox rows newest 500, per-gen gate rows of the newest 50 gens; a pruned ring row", () => {
    const w = world();
    w.install();
    for (let i = 0; i < DEAD_KEEP + 40; i++)
      w.db.run(
        `INSERT INTO inbox (id, route, account, platform_key, received_at, headers, body, state)
         VALUES (?, '/telegram-webhook', 'default', ?, ?, '{}', 'x', 'dead')`,
        `d${i}`,
        String(i),
        w.clock.t + i,
      );
    for (let g = 1; g <= GEN_ROWS_KEEP + 10; g++) {
      w.db.run(
        `INSERT INTO gens (gen, epoch, op_id, reason, mode, secret, restore_gens, plan, plan_kind, state, unplanned, issued_at)
         VALUES (?, 1, ?, 'user', 'prod', 's', '[]', '{}', 'fresh', 'deleted', 0, 0)`,
        g,
        `op-g${g}`,
      );
      w.db.run("INSERT INTO gate_hbseq (gen, seq, at) VALUES (?, 1, 0)", g);
    }
    const r = boundsTick(w.ctx, { size: 1000 });
    expect(r.pruned["inbox-dead"]).toBe(40);
    expect(r.pruned.gate_hbseq).toBe(10);
    expect(w.db.one("SELECT COUNT(*) AS n FROM inbox")).toEqual({ n: DEAD_KEEP });
    expect(w.db.one("SELECT MIN(platform_key + 0) AS lo FROM inbox")).toEqual({ lo: 40 }); // newest kept
    expect(w.db.all("SELECT class FROM alerts WHERE class = 'ctl-prune'")).toHaveLength(0); // a ring row, not an alert
    expect(w.db.all("SELECT id FROM ring WHERE src = 'bounds' AND kind = 'pruned'")).toHaveLength(1);
  });

  it("storage guard above STORAGE.soft: hard caps, ctl-storage-high; ensure() still runs", async () => {
    const st = new FakeStorage();
    let size = 0;
    Object.defineProperty(st.sql, "databaseSize", { get: () => size });
    const w = world({ storage: st });
    w.install();
    for (let s = 1; s <= 10; s++)
      w.db.run(
        "INSERT INTO creds_hist (path, seq, gen, sha256, mode, b64, deleted, at) VALUES ('a', ?, 1, 'x', 384, 'eA==', 0, ?)",
        s,
        w.clock.t,
      );
    for (let v = 1; v <= 30; v++)
      w.db.run(
        "INSERT INTO config (ver, status, sha, doc, created_at) VALUES (?, 'candidate', ?, '{}', 0)",
        v,
        `s${v}`,
      );
    size = STORAGE.soft + 1;
    const out = await w.api.ensure();
    expect(out.epoch).toBe(1);
    expect(w.db.one("SELECT COUNT(*) AS n FROM creds_hist")).toEqual({ n: HARD.credsHistPerPath });
    expect(w.db.one("SELECT COUNT(*) AS n FROM config")).toEqual({ n: HARD.configRows });
    expect(w.db.all("SELECT class FROM alerts WHERE class = 'ctl-storage-high'")).toHaveLength(1);
    // below soft: once per hour only
    size = 1000;
    expect(boundsGuard(w.ctx)).toBeNull();
    w.advance(3_600_000);
    expect(boundsGuard(w.ctx)?.hard).toBe(false);
  });
});

describe("F11 Control DO alarm chain", () => {
  it("a tick that never settles: alarm() returns at TICK_CAP_MS and re-arms; the next alarm does not overlap", async () => {
    const { Control, TICK_CAP_MS, WATCHDOG_MS } = await import("../../src/ctl/do");
    const st = new FakeStorage();
    const ctx = {
      storage: st,
      blockConcurrencyWhile: (f: () => Promise<unknown>) => f(),
      waitUntil: () => {},
    } as unknown as DurableObjectState;
    const env = { OC_INST: "t1", OC_TEST: "1", BUCKET: {}, RUNTIME: { getByName: () => ({}) } } as never;
    const d = new Control(ctx, env);
    let ticks = 0;
    (d.api as unknown as { tick: () => Promise<number | null> }).tick = () => {
      ticks++;
      return new Promise(() => {});
    };
    const real = globalThis.setTimeout;
    // shorten the cap for this test: run timers at once
    (globalThis as { setTimeout: unknown }).setTimeout = ((f: () => void) => real(f, 0)) as never;
    try {
      const t0 = Date.now();
      await d.alarm();
      expect(ticks).toBe(1);
      expect(st.alarmAt).not.toBeNull();
      expect((st.alarmAt as number) - t0).toBeLessThanOrEqual(WATCHDOG_MS + 50);
      await d.alarm(); // the first tick still hangs: no second tick, alarm re-armed
      expect(ticks).toBe(1);
      expect(st.alarmAt).not.toBeNull();
    } finally {
      globalThis.setTimeout = real;
    }
    expect(TICK_CAP_MS).toBeLessThan(WATCHDOG_MS);
  });

  it("a tick that throws: alarm() does not throw and re-arms", async () => {
    const { Control } = await import("../../src/ctl/do");
    const st = new FakeStorage();
    const ctx = {
      storage: st,
      blockConcurrencyWhile: (f: () => Promise<unknown>) => f(),
      waitUntil: () => {},
    } as unknown as DurableObjectState;
    const d = new Control(ctx, {
      OC_INST: "t1",
      OC_TEST: "1",
      BUCKET: {},
      RUNTIME: { getByName: () => ({}) },
    } as never);
    (d.api as unknown as { tick: () => Promise<number | null> }).tick = () =>
      Promise.reject(new Error("boom"));
    await d.alarm();
    expect(st.alarmAt).not.toBeNull();
  });
});
