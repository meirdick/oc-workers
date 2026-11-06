// M8 live fixes: alerts close by themselves when the condition passes; ladder level 1 is the normal level.
import { describe, expect, it } from "vitest";
import { alert } from "../../src/ctl/alerts";
import { checkState } from "../../src/ctl/panel-checks";
import { type World, world } from "./world";

const open = (w: World, cls: string) =>
  w.db.one<{ open: number }>("SELECT open FROM alerts WHERE class = ?", cls)?.open ?? null;

function booting(w: World, gen: number) {
  w.install();
  w.api.noteRtState(1, "running");
  w.rt(1).state = "running";
  w.db.run(
    `INSERT INTO gens (gen, epoch, op_id, reason, mode, secret, restore_gens, plan, plan_kind, state, unplanned, issued_at)
     VALUES (?, 1, ?, 'user', 'prod', 's', '[]', '{"sqlite":{"kind":"fresh"}}', 'fresh', 'booting', 0, 0)`,
    gen,
    `op-${gen}`,
  );
}
const started = (w: World, gen: number, doctorRan: boolean) =>
  w.api.onStarted({
    epoch: 1,
    gen,
    opId: `op-${gen}`,
    reason: "user",
    digest: "d",
    wakeAt: 0,
    aliveMs: 1,
    startupzMs: 1,
    doctorRan,
  });

describe("alerts resolve on the next good event", () => {
  it("a started gen closes upgrade-regression and memwatch-restart; doctor-failed only when Doctor ran and passed", async () => {
    const w = world();
    booting(w, 1);
    alert(w.ctx, "doctor-failed", "high", "Doctor failed 2x");
    alert(w.ctx, "upgrade-regression", "high", "doctor-failed");
    alert(w.ctx, "memwatch-restart", "warn", "slope<4h");
    alert(w.ctx, "workspace-missing", "high", "workspace-missing /x (source archive)");
    await started(w, 1, false);
    expect([
      open(w, "upgrade-regression"),
      open(w, "memwatch-restart"),
      open(w, "workspace-missing"),
      open(w, "doctor-failed"),
    ]).toEqual([0, 0, 0, 1]);
    booting(w, 2);
    await started(w, 2, true);
    expect(open(w, "doctor-failed")).toBe(0);
  });

  it("asleep closes sleep-blocked", () => {
    const w = world();
    w.install();
    alert(w.ctx, "sleep-blocked", "info", "1:archive-due:dirty");
    w.api.noteRtState(1, "running");
    expect(open(w, "sleep-blocked")).toBe(1);
    w.api.noteRtState(1, "asleep");
    expect(open(w, "sleep-blocked")).toBe(0);
  });
});

describe("state check and the start ladder", () => {
  it("level 1 is normal: PASS; level 2 and slow: WARN", () => {
    expect(checkState({ state: "running", ladder: { level: 1 } }).result).toBe("PASS");
    expect(checkState({ state: "running", ladder: { level: 2 } })).toMatchObject({
      result: "WARN",
      detail: "running, start ladder level 2",
    });
    expect(checkState({ state: "backoff", ladder: { level: "slow" } }).result).toBe("WARN");
  });
});
