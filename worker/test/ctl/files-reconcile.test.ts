// 1.2.4 files reconcile (ctl/files-reconcile.ts): files_obj follows R2 for files written outside the gate (an owner
// sync straight to R2). Add, resize, remove; paged and bounded per step; removal only at the end of a full pass;
// gate writes during a pass stay; alarm cadence while awake; the owner op; cap alerts.
import { describe, expect, it } from "vitest";
import {
  filesReconcileStep,
  RECONCILE_PAGE,
  RECONCILE_PASS_MAX_MS,
  reconcileDue,
  reconcileLast,
} from "../../src/ctl/files-reconcile";
import { GateLedger } from "../../src/gates/ledger";
import { FILES_PROBE } from "../../src/gates/replica";
import { world } from "./world";

const k = (n: string) => `f/t1/${n}`;
const rows = (w: ReturnType<typeof world>) =>
  w.db.all<{ key: string; bytes: number }>("SELECT key, bytes FROM files_obj ORDER BY key");
const listCalls = (w: ReturnType<typeof world>) => w.r2.ops.filter((o) => o.op === "list").length;

describe("files reconcile", () => {
  it("adds objects the gate never saw, fixes sizes, drops objects gone from R2; other prefixes and the probe key are not counted", async () => {
    const w = world();
    // through the gate: a (3 bytes), b (5 bytes, later changed outside), gone (deleted outside)
    for (const [n, b] of [
      ["a", 3],
      ["b", 5],
      ["gone", 7],
    ] as const) {
      await w.r2.put(k(n), "x".repeat(b));
      w.ledger.filesPost({ op: "PutObject", key: k(n), status: 200, bytes: b });
    }
    w.advance(1000);
    // outside the gate
    await w.r2.put(k("synced/notes.md"), "y".repeat(11));
    await w.r2.put(k("b"), "z".repeat(2));
    await w.r2.delete(k("gone"));
    await w.r2.put(`f/other/x`, "q");
    await w.r2.put(k(FILES_PROBE), "1");
    expect(w.ledger.filesView()).toMatchObject({ used: 15, objects: 3 });
    const r = await filesReconcileStep(w.ctx, w.ledger);
    expect(r).toMatchObject({
      ran: true,
      done: true,
      pages: 1,
      objects: 3,
      added: 1,
      resized: 1,
      removed: 1,
    });
    expect(rows(w)).toEqual([
      { key: k("a"), bytes: 3 },
      { key: k("b"), bytes: 2 },
      { key: k("synced/notes.md"), bytes: 11 },
    ]);
    expect(w.ledger.filesView()).toMatchObject({ used: 16, objects: 3 });
    expect(reconcileLast(w.ctx)).toMatchObject({ objects: 3, added: 1, resized: 1, removed: 1 });
    // a second pass with no change changes nothing
    w.advance(1000);
    expect(await filesReconcileStep(w.ctx, w.ledger)).toMatchObject({ added: 0, resized: 0, removed: 0 });
  });

  it("pages: one step lists at most maxPages pages; the cursor goes on next step; removal waits for the full pass", async () => {
    const w = world();
    const n = 2 * RECONCILE_PAGE + 10;
    for (let i = 0; i < n; i++) await w.r2.put(k(`p/${String(i).padStart(5, "0")}`), "1");
    // a stale row (deleted outside before the pass) and one the gate writes during the pass (not in R2 yet)
    w.ledger.filesPost({ op: "PutObject", key: k("stale"), status: 200, bytes: 9 });
    w.advance(1000);
    const s1 = await filesReconcileStep(w.ctx, w.ledger, { maxPages: 1 });
    expect(s1).toMatchObject({ done: false, pages: 1, objects: RECONCILE_PAGE, removed: 0 });
    expect(rows(w).length).toBe(RECONCILE_PAGE + 1); // the stale row is still there
    w.advance(1000);
    w.ledger.filesPost({ op: "PutObject", key: k("during"), status: 200, bytes: 4 });
    const s2 = await filesReconcileStep(w.ctx, w.ledger, { maxPages: 1 });
    expect(s2).toMatchObject({ done: false, pages: 1 });
    expect(reconcileDue(w.ctx)).toBe(true); // an open pass is always due
    const s3 = await filesReconcileStep(w.ctx, w.ledger, { maxPages: 1 });
    expect(s3).toMatchObject({ done: true, pages: 1, objects: 10, removed: 1 });
    expect(w.ledger.filesView()).toMatchObject({ used: n + 4, objects: n + 1 });
    expect(rows(w).some((r) => r.key === k("stale"))).toBe(false);
    expect(rows(w).some((r) => r.key === k("during"))).toBe(true);
    expect(reconcileLast(w.ctx)).toMatchObject({ objects: n, added: n, removed: 1 });
    expect(reconcileDue(w.ctx)).toBe(false);
  });

  it("a gate write after the list began keeps its size (the list may be older)", () => {
    const w = world();
    w.ledger.filesPost({ op: "PutObject", key: k("a"), status: 200, bytes: 50 });
    const at = w.ctx.now();
    expect(w.ledger.filesReconcilePage(at - 10, at, [{ key: k("a"), bytes: 1 }])).toEqual({
      added: 0,
      resized: 0,
    });
    expect(rows(w)).toEqual([{ key: k("a"), bytes: 50 }]);
    expect(w.ledger.filesReconcilePage(at, at + 1, [{ key: k("a"), bytes: 1 }])).toEqual({
      added: 0,
      resized: 1,
    });
    expect(rows(w)).toEqual([{ key: k("a"), bytes: 1 }]);
  });

  it("files over the cap counted by a reconcile raise storage-cap-80 and storage-cap-100; the gate then refuses", async () => {
    const w = world();
    const led = new GateLedger(w.ctx.db.store as never, {
      inst: "t1",
      now: w.ctx.now,
      files: () => ({ cap: 100, objectMax: 100 }),
    });
    led.migrate();
    await w.r2.put(k("big"), "x".repeat(85));
    await filesReconcileStep(w.ctx, led);
    expect(w.db.all<{ class: string }>("SELECT class FROM alerts").map((a) => a.class)).toContain(
      "storage-cap-80",
    );
    w.advance(1000);
    await w.r2.put(k("more"), "x".repeat(20));
    await filesReconcileStep(w.ctx, led);
    expect(w.db.all<{ class: string }>("SELECT class FROM alerts").map((a) => a.class)).toContain(
      "storage-cap-100",
    );
    expect(led.filesView()).toMatchObject({ used: 105, objects: 2 });
  });

  it("an R2 list error ends the step without a throw; a pass with a cursor starts again; an old pass starts again", async () => {
    const w = world();
    for (let i = 0; i < RECONCILE_PAGE + 1; i++) await w.r2.put(k(`q${i}`), "1");
    expect((await filesReconcileStep(w.ctx, w.ledger, { maxPages: 1 })).done).toBe(false);
    w.r2.listFail = 1;
    const e = await filesReconcileStep(w.ctx, w.ledger, { maxPages: 1 });
    expect(e.error).toMatch(/list failed/);
    expect(w.db.meta("filesReconcile")).toBeNull();
    expect(await filesReconcileStep(w.ctx, w.ledger)).toMatchObject({
      done: true,
      objects: RECONCILE_PAGE + 1,
    });
    // an open pass older than RECONCILE_PASS_MAX_MS is dropped
    for (let i = 0; i < RECONCILE_PAGE; i++) await w.r2.put(k(`r${i}`), "1");
    await filesReconcileStep(w.ctx, w.ledger, { maxPages: 1 });
    expect(w.db.meta("filesReconcile")).not.toBeNull();
    w.advance(RECONCILE_PASS_MAX_MS + 1);
    const again = await filesReconcileStep(w.ctx, w.ledger);
    expect(again).toMatchObject({ done: true, objects: 2 * RECONCILE_PAGE + 1 });
  });
});

describe("files reconcile: callers", () => {
  it("the alarm runs one pass while awake, then waits filesReconcileMs; never while asleep", async () => {
    const w = world({ timers: { filesReconcileMs: 30 * 60_000 } });
    w.install();
    await w.r2.put(k("x"), "abc");
    w.db.setMeta("rtState", "asleep");
    await w.core.tick();
    expect(listCalls(w)).toBe(0);
    w.db.setMeta("rtState", "running");
    await w.core.tick();
    expect(listCalls(w)).toBe(1);
    expect(w.ledger.filesView()).toMatchObject({ used: 3, objects: 1 });
    w.advance(10 * 60_000);
    await w.core.tick();
    expect(listCalls(w)).toBe(1);
    w.advance(20 * 60_000);
    await w.core.tick();
    expect(listCalls(w)).toBe(2);
  });

  it("POST /ops/files/reconcile: counts now, asleep too, and returns the usage", async () => {
    const w = world();
    w.install();
    w.db.setMeta("rtState", "asleep");
    await w.r2.put(k("from-laptop.md"), "hello");
    const r = await w.core.ops({
      action: "files",
      method: "POST",
      sub: ["reconcile"],
      query: {},
      body: {},
      role: "owner",
    });
    expect(r).toMatchObject({
      status: 200,
      body: { ok: true, done: true, more: false, added: 1, files: { used: 5, objects: 1 } },
    });
    w.r2.listFail = 1;
    const bad = await w.core.ops({
      action: "files",
      method: "POST",
      sub: ["reconcile"],
      query: {},
      body: {},
      role: "owner",
    });
    expect(bad).toMatchObject({ status: 502, body: { ok: false } });
  });
});
