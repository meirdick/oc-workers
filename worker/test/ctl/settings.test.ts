// Settings document (ctl/settings.ts, core/tunables.ts): versions, validation, seed from OC_SETTINGS, and each
// Control DO consumer reading it at call time. The Runtime DO, ingress and a changed idleMinutes across a
// sleep decision are covered in test/rt-settings.test.ts and test/scenarios/sleep.test.ts.
import { describe, expect, it } from "vitest";
import { defaultsFlat, expand, flatten, SPECS, timerOverlay, validateDoc } from "../../src/core/tunables";
import { cfgOf } from "../../src/ctl/archives";
import { boundsTick, storageLimits } from "../../src/ctl/bounds";
import { snapshotSummary } from "../../src/ctl/chain";
import { DAY, DEFAULT_SETTINGS, mergeSettings } from "../../src/ctl/ctx";
import { latestSettings, putSettings, seedSettings, settingsView } from "../../src/ctl/settings";
import { snapshotAllowed } from "../../src/ctl/snapshots";
import { archiveCfg } from "../../src/gates/archive-policy";
import { type World, world } from "./world";

/** A world whose settings() reads the newest settings row, like the Control DO. */
function live(o: Parameters<typeof world>[0] = {}): World {
  const w = world(o);
  w.ctx.settings = () => {
    const row = latestSettings(w.db);
    return mergeSettings(DEFAULT_SETTINGS, row ? JSON.parse(row.doc) : null);
  };
  return w;
}
const put = (w: World, set: Record<string, unknown>, extra: object = {}) =>
  putSettings(w.ctx, { set, ...extra });
const ok = (r: ReturnType<typeof putSettings>) => {
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body;
};

describe("tunables table", () => {
  it("defaults expand to DEFAULT_SETTINGS and every default passes its own check", () => {
    expect(validateDoc(expand(defaultsFlat()))).toEqual([]);
    expect(DEFAULT_SETTINGS.checkpoint).toEqual({ intervalMinutes: 60, maxPerDay: 30 });
    expect(DEFAULT_SETTINGS.login.rateLimits).toEqual({
      windowMinutes: 10,
      ipFail: 5,
      ipTry: 20,
      allFail: 30,
      maxCodes: 10,
    });
    expect(SPECS.every((s) => s.kind !== "int" || (s.min ?? 0) <= (s.def as number))).toBe(true);
  });

  it("rejects an unknown key, both sides of a floor and cap, a non-integer and a broken relation", () => {
    expect(validateDoc({ sleep: { idleMinutes: 0 } })).toEqual(["sleep.idleMinutes must be 1 to 60"]);
    expect(validateDoc({ sleep: { idleMinutes: 61 } })).toHaveLength(1);
    expect(validateDoc({ sleep: { idleMinutes: 1 } })).toEqual([]);
    expect(validateDoc({ sleep: { idleMinutes: 60 } })).toEqual([]);
    expect(validateDoc({ sleep: { idleMinutes: 1.5 } })[0]).toMatch(/whole number/);
    expect(validateDoc({ nap: { hours: 1 } })).toEqual(["unknown setting nap.hours"]);
    // a key named __proto__ (JSON.parse makes it an own key) is refused and never reaches Object.prototype
    const evil = JSON.parse('{"__proto__": {"polluted": 1}}');
    expect(validateDoc(evil)).toEqual(["unknown setting __proto__.polluted"]);
    expect(expand({ "__proto__.polluted": 1, "constructor.prototype.polluted": 1 })).toEqual({});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(validateDoc({ storage: { pruneAtMb: 3000 } })[0]).toMatch(/refuseAtMb must be above/);
    expect(validateDoc({ checkpoint: { maxPerDay: 90 } })[0]).toMatch(/snapshots.maxPerDay must be at least/);
  });

  it("maps units to timers; in test worlds only changed values override the short test timers", () => {
    const flat = flatten({ ...expand(defaultsFlat()), sleep: { idleMinutes: 7 }, cron: { tailSeconds: 30 } });
    const all = timerOverlay(flat, false);
    expect(all.t.idleMs).toBe(7 * 60_000);
    expect(all.t.cronTailMs).toBe(30_000);
    expect(all.t.rebaseEveryMs).toBe(24 * 3_600_000);
    expect(all.t.inboxKeepMs).toBe(24 * 3_600_000);
    expect(all.rt.checkpointMs).toBe(3_600_000);
    const changed = timerOverlay(flat, true);
    expect(Object.keys(changed.t).sort()).toEqual(["cronTailMs", "idleMs"]);
    expect(changed.rt).toEqual({});
  });
});

describe("settings document", () => {
  it("versions: new version per change, none for the same document, baseVer guard, null removes", () => {
    const w = live();
    expect(ok(put(w, { "sleep.idleMinutes": 9 }))).toMatchObject({ ver: 1, changed: true });
    expect(ok(put(w, { "sleep.idleMinutes": 9 }))).toMatchObject({ ver: 1, changed: false });
    expect(put(w, { "sleep.idleMinutes": 10 }, { baseVer: 0 })).toEqual({
      status: 409,
      body: { error: "stale", ver: 1 },
    });
    expect(ok(put(w, { "archive.everyHours": 3 }, { baseVer: 1 })).ver).toBe(2);
    expect(w.ctx.settings().sleep.idleMinutes).toBe(9); // set keys stay
    expect(w.ctx.settings().archive.everyHours).toBe(3);
    ok(put(w, { "sleep.idleMinutes": null }));
    expect(w.ctx.settings().sleep.idleMinutes).toBe(5); // default again
    expect(w.db.one("SELECT COUNT(*) AS n FROM settings")).toEqual({ n: 3 });
  });

  it("PUT with a __proto__ key is refused and pollutes nothing", () => {
    const w = live();
    const r = putSettings(w.ctx, { doc: JSON.parse('{"__proto__": {"polluted": 1}}') });
    expect(r.status).toBe(400);
    expect(put(w, { "__proto__.polluted": 1 }).status).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(latestSettings(w.db)).toBeNull();
  });

  it("a refused change writes nothing and names the problem; 20 versions are kept", () => {
    const w = live();
    const bad = putSettings(w.ctx, { set: { "chain.tagWarn": 3 } });
    expect(bad).toMatchObject({ status: 400, body: { error: "chain.tagWarn must be 10 to 2000" } });
    expect(putSettings(w.ctx, {}).status).toBe(400);
    expect(w.db.one("SELECT COUNT(*) AS n FROM settings")).toEqual({ n: 0 });
    for (let i = 0; i < 25; i++) ok(put(w, { "sleep.idleMinutes": 1 + i }));
    expect(w.db.one("SELECT COUNT(*) AS n, MIN(ver) AS lo FROM settings")).toEqual({ n: 20, lo: 6 });
  });

  it("OC_SETTINGS seeds version 1 only; a later deploy value does not change it", () => {
    const w = live();
    seedSettings(w.db, { sleep: { idleMinutes: 8 }, bucket: "b", publicOrigin: "https://x" }, w.ctx.now());
    expect(latestSettings(w.db)).toMatchObject({ ver: 1, source: "deploy" });
    expect(w.ctx.settings().sleep.idleMinutes).toBe(8);
    seedSettings(w.db, { sleep: { idleMinutes: 30 } }, w.ctx.now());
    expect(w.ctx.settings().sleep.idleMinutes).toBe(8);
    ok(put(w, { "sleep.idleMinutes": 12 }));
    seedSettings(w.db, { sleep: { idleMinutes: 30 } }, w.ctx.now());
    expect(w.ctx.settings().sleep.idleMinutes).toBe(12);
  });

  it("GET shows the document, the effective values and the versions; PUT and POST both write", async () => {
    const w = live();
    const req = (method: string, body: Record<string, unknown> = {}, query: Record<string, string> = {}) =>
      w.api.core.ops({ action: "settings", method, sub: [], query, body, role: "owner" });
    expect((await req("PUT", { set: { "gens.churnPerDay": 4 } })).status).toBe(200);
    expect((await req("POST", { doc: { gens: { churnPerDay: 6 } } })).status).toBe(200);
    const g = (await req("GET")).body as any;
    expect(g).toMatchObject({
      ver: 2,
      doc: { gens: { churnPerDay: 6 } },
      effective: { gens: { churnPerDay: 6 } },
    });
    expect(g.effective.sleep.idleMinutes).toBe(5);
    expect(g.versions.map((v: { ver: number }) => v.ver)).toEqual([2, 1]);
    expect(((await req("GET", {}, { ver: "1" })).body as any).doc).toEqual({ gens: { churnPerDay: 4 } });
    expect((await req("GET", {}, { ver: "9" })).status).toBe(404);
    expect((await req("DELETE")).status).toBe(404);
  });

  it("settingsView gives the Runtime DO timers and the Auth DO login numbers", () => {
    const w = live();
    ok(put(w, { "sleep.uiIdleMinutes": 3, "login.sessionDays": 2, "login.rateLimits.ipFail": 7 }));
    const v = settingsView(w.ctx);
    expect(v.ver).toBe(1);
    expect(v.rt.uiIdleMs).toBe(3 * 60_000);
    expect(v.login).toMatchObject({ sessionDays: 2, rateLimits: { ipFail: 7, ipTry: 20 } });
  });
});

describe("consumers read the document at call time", () => {
  it("archive cadence: hours, minutes, per-day and drill days in ms", () => {
    const w = live();
    ok(
      put(w, {
        "archive.everyHours": 2,
        "archive.minGapMinutes": 30,
        "archive.maxPerDay": 5,
        "archive.drillEveryDays": 7,
      }),
    );
    expect(cfgOf(w.ctx)).toMatchObject({
      everyMs: 2 * 3_600_000,
      minGapMs: 30 * 60_000,
      perDay: 5,
      drillEveryMs: 7 * DAY,
      openHoldMs: 10 * 60_000, // untouched hold stays
    });
    expect(archiveCfg({ everyMs: 99, everyHours: 1 }).everyMs).toBe(99); // raw ms still wins
  });

  it("snapshot budgets: checkpoint.maxPerDay stops checkpoints; snapshots.maxPerDay is the planned alert line", async () => {
    const w = live();
    w.install();
    ok(put(w, { "checkpoint.maxPerDay": 2 }));
    for (let i = 0; i < 2; i++)
      w.api.core.snapshotSaved({
        id: `c${i}`,
        size: 1,
        imageKey: "oc",
        digest: "sha256:img1",
        kind: "checkpoint",
        gen: 1,
        epoch: 1,
        opId: null,
        parentId: null,
      } as never);
    expect(snapshotAllowed(w.ctx, "checkpoint")).toEqual({ allow: false, why: "checkpoint-budget" });
    ok(put(w, { "checkpoint.maxPerDay": 3 }));
    expect(snapshotAllowed(w.ctx, "checkpoint")).toEqual({ allow: true });
    ok(put(w, { "snapshots.maxPerDay": 10 })); // 2 checkpoints + 9 planned > 10
    for (let i = 0; i < 9; i++)
      w.api.core.snapshotSaved({
        id: `p${i}`,
        size: 1,
        imageKey: "oc",
        digest: "sha256:img1",
        kind: "planned",
        gen: 1,
        epoch: 1,
        opId: null,
        parentId: null,
      } as never);
    expect(w.db.one("SELECT class FROM alerts WHERE class = 'snapshot-budget'")).toBeTruthy();
  });

  it("registry tag warning line is chain.tagWarn", () => {
    const w = live();
    w.install();
    for (let i = 0; i < 6; i++)
      w.api.core.snapshotSaved({
        id: `t${i}`,
        size: 1,
        imageKey: "oc",
        digest: "sha256:img1",
        kind: "sleep",
        gen: 1,
        epoch: 1,
        opId: null,
        parentId: null,
      } as never);
    expect(snapshotSummary(w.ctx).warn).toBeNull(); // 12 tags, line 100
    ok(put(w, { "chain.tagWarn": 11 }));
    expect(snapshotSummary(w.ctx).warn).toMatch(/12 registry tags \(> 11\)/);
  });

  it("storage limits: pruneAtMb starts the hard caps; refuseAtMb is what the gates read", () => {
    const w = live();
    ok(put(w, { "storage.pruneAtMb": 100, "storage.refuseAtMb": 300 }));
    expect(storageLimits(w.ctx)).toEqual({ soft: 100_000_000, hard: 300_000_000 });
    expect(boundsTick(w.ctx, { size: 150_000_000 }).hard).toBe(true); // over 100 MB, under the default 1024 MB
    expect(boundsTick(w.ctx, { size: 50_000_000 }).hard).toBe(false);
    expect(w.ledger.o.storage?.().hard).toBe(300_000_000);
  });

  it("gens.churnPerDay moves the gen-churn alert line", async () => {
    const w = live();
    w.install();
    ok(put(w, { "gens.churnPerDay": 3 }));
    for (let i = 0; i < 3; i++)
      await w.api.beginBoot({ epoch: 1, mode: "prod", opId: `l${i}`, reason: "ladder" });
    expect(w.db.one("SELECT class FROM alerts WHERE class = 'gen-churn'")).toBeNull();
    await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "l3", reason: "ladder" });
    expect(w.db.one("SELECT class FROM alerts WHERE class = 'gen-churn'")).toBeTruthy();
  });

  it("cost guard: off never holds; cost.releaseBelowPct moves the release line", () => {
    const w = live({ settings: { sleep: { snapshotCostUsd: 1 } as never } });
    w.install();
    // many short cycles make spend24 + cycle exceed always24
    for (let i = 0; i < 60; i++)
      w.db.run(
        "INSERT INTO wake_log (gen, reason, wake_at, slept_at, cpu_s) VALUES (1, 'x', ?, ?, 20)",
        w.clock.t - (i + 1) * 20_000,
        w.clock.t - (i + 1) * 20_000 + 10_000,
      );
    w.ctx.settings = () =>
      mergeSettings(DEFAULT_SETTINGS, { sleep: { snapshotCostUsd: 1, costGuard: "off" } });
    expect(w.api.costCheck()).toMatchObject({ allow: true, holding: false });
    expect(w.db.meta("costHold")).toBe("0");
    w.ctx.settings = () => mergeSettings(DEFAULT_SETTINGS, { sleep: { snapshotCostUsd: 1 } });
    expect(w.api.costCheck().allow).toBe(false);
    // release line: at 99 % of always-on the guard lets go once spend24 < 0.99 × always24
    const hold = w.api.costCheck();
    w.ctx.settings = () =>
      mergeSettings(DEFAULT_SETTINGS, { sleep: { snapshotCostUsd: 1 }, cost: { releaseBelowPct: 99 } });
    w.db.run("DELETE FROM wake_log");
    expect(hold.holding).toBe(true);
    expect(w.api.costCheck().allow).toBe(true);
  });

  it("sleep.maxAwakeHours is the uptime limit in the boot plan; the old runtime.maxUptimeHours still maps", async () => {
    const w = live();
    w.install();
    ok(put(w, { "sleep.maxAwakeHours": 24 }));
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "b1", reason: "wake:cli" });
    expect(r.plan.runtime.maxUptimeHours).toBe(24);
    const legacy = mergeSettings(DEFAULT_SETTINGS, { runtime: { maxUptimeHours: 12 } });
    expect(legacy.sleep.maxAwakeHours).toBe(12);
  });
});
