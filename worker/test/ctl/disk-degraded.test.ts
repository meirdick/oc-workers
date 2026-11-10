// Plan §4.12: a full disk sets status `degraded`. ocsup reports it only as alert `disk-full` (the Runtime DO flag
// never had it: M7 soak disk-100, docs/research/soak-m7-findings.md §4b). The heartbeat disk use closes it.
import { describe, expect, it } from "vitest";
import { alert } from "../../src/ctl/alerts";
import { checkState } from "../../src/ctl/panel-checks";
import { world } from "./world";

type St = { degraded: boolean; degradedWhy: string[]; disk: unknown; alerts: { class: string }[] };
const open = (w: ReturnType<typeof world>, cls: string) =>
  w.db.one<{ open: number }>("SELECT open FROM alerts WHERE class = ?", cls)?.open ?? null;

describe("status degraded from the disk (plan §4.12)", () => {
  it("open disk-full: degraded with the reason; a heartbeat under 90 % closes it and clears degraded", async () => {
    const w = world();
    w.install();
    let s = (await w.api.status()) as unknown as St;
    expect([s.degraded, s.degradedWhy]).toEqual([false, []]);

    alert(w.ctx, "disk-full", "high", "used 96% inodes 2%");
    w.api.noteHeartbeat({ gen: 1, disk: { usedPct: 96, inodesPct: 2 } });
    s = (await w.api.status()) as unknown as St;
    expect(s.degraded).toBe(true);
    expect(s.degradedWhy).toEqual(["disk-full"]);
    expect(s.disk).toMatchObject({ gen: 1, usedPct: 96, inodesPct: 2 });
    expect(checkState(s)).toMatchObject({ result: "WARN", detail: "new, degraded (disk-full)" });
    expect(checkState(s).fix).toMatch(/delete large files/);

    // 90 % or more: ocsup is still degraded (diskwatch leaves it under LEVELS.clean); the alert stays open.
    w.api.noteHeartbeat({ gen: 1, disk: { usedPct: 91, inodesPct: 2 } });
    expect(open(w, "disk-full")).toBe(1);
    // inodes count too
    w.api.noteHeartbeat({ gen: 1, disk: { usedPct: 50, inodesPct: 92 } });
    expect(open(w, "disk-full")).toBe(1);

    w.api.noteHeartbeat({ gen: 1, disk: { usedPct: 85, inodesPct: 2 } });
    expect(open(w, "disk-full")).toBe(0);
    s = (await w.api.status()) as unknown as St;
    expect([s.degraded, s.degradedWhy]).toEqual([false, []]);
    expect(
      w.db.one("SELECT 1 AS x FROM ring WHERE kind = 'closed' AND detail LIKE '%disk-full%'"),
    ).toBeTruthy();

    // The next excursion opens it again (alert() sets open = 1).
    alert(w.ctx, "disk-full", "high", "ENOSPC");
    expect(((await w.api.status()) as unknown as St).degraded).toBe(true);
  });

  it("disk-high shows in the alerts but does not set degraded; it closes under 80 %", async () => {
    const w = world();
    w.install();
    alert(w.ctx, "disk-high", "warn", "used 82% inodes 2%");
    const s = (await w.api.status()) as unknown as St;
    expect(s.degraded).toBe(false);
    expect(s.alerts.map((a) => a.class)).toContain("disk-high");
    w.api.noteHeartbeat({ gen: 1, disk: { usedPct: 81, inodesPct: 2 } });
    expect(open(w, "disk-high")).toBe(1);
    w.api.noteHeartbeat({ gen: 1, disk: { usedPct: 79, inodesPct: 2 } });
    expect(open(w, "disk-high")).toBe(0);
  });

  it("a heartbeat without disk use (disk watch not started) changes nothing", async () => {
    const w = world();
    w.install();
    alert(w.ctx, "disk-full", "high", "x");
    w.api.noteHeartbeat({ gen: 1, disk: null });
    w.api.noteHeartbeat({ gen: 1, disk: {} });
    w.api.noteHeartbeat({ gen: 1 });
    expect(open(w, "disk-full")).toBe(1);
  });

  it("Runtime DO reasons stay; the disk reason is added once", async () => {
    const w = world();
    w.install();
    const rt = w.rt(1);
    const base = rt.status.bind(rt);
    rt.status = async () => ({ ...(await base()), degraded: true, degradedWhy: ["readyz"] });
    alert(w.ctx, "disk-full", "high", "x");
    const s = (await w.api.status()) as unknown as St;
    expect(s.degraded).toBe(true);
    expect(s.degradedWhy).toEqual(["readyz", "disk-full"]);
    expect(checkState(s).fix).toMatch(/delete large files/);
  });
});
