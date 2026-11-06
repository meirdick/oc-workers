// M4b fixes: L2 checkpoint clock from the rootfs snapshot time (M4-STATUS §7 L2), C1 plan shadowAt.
import { describe, expect, it } from "vitest";
import { rootfsAt } from "../../src/ctl/plan";
import type { ArchiveRow, SnapRow } from "../../src/ctl/snapshots";
import { world } from "./world";

const snap = (kind: string, created_at: number, last_restored_at: number | null) =>
  ({ id: "s1", kind, created_at, last_restored_at, digest: "sha256:beef" }) as SnapRow;

describe("L2 rootfsAt (plan rootfs.at)", () => {
  it("checkpoint snapshot → its time; sleep/planned never restored → null (boot); restored → its time", () => {
    expect(rootfsAt({ snap: snap("checkpoint", 100, null) })).toBe(100);
    expect(rootfsAt({ snap: snap("sleep", 100, null) })).toBeNull();
    expect(rootfsAt({ snap: snap("planned", 100, null) })).toBeNull();
    expect(rootfsAt({ snap: snap("sleep", 100, 200) })).toBe(100);
    expect(rootfsAt({ archive: { created_at: 50 } as ArchiveRow })).toBe(50);
    expect(rootfsAt({})).toBeNull();
  });
});

describe("L2 checkpoint clock under a crash loop (lives < checkpointMs)", () => {
  const setup = () => {
    const w = world({
      timers: { hbLostMs: 24 * 3600_000, maintEveryMs: 24 * 3600_000 },
      rtTimers: { checkpointMs: 60_000 },
    });
    w.ctl.inputs.mode = "off";
    w.ocsup.ctl.dirty = () => ({ ok: true, dirty: true, count: 1, bytes: 1024 });
    w.ocsup.ctl["shadow-backup"] = () => ({ ok: true, results: [] });
    return w;
  };
  const ckpts = (w: ReturnType<typeof world>) =>
    w.ctl.calls.filter((c) => c.m === "snapshotSaved" && (c.a as { kind: string }).kind === "checkpoint");

  it("each boot restores the same snapshot: a checkpoint is due 60 s after the snapshot, not after /startupz", async () => {
    const w = setup();
    const snapAt = w.clock.now();
    w.ctl.planOverride = {
      rootfs: { kind: "snapshot", snapshotId: "s-old", digest: "sha256:beef", at: snapAt },
    };
    w.c.knownSnapshots.set("s-old", 1);
    await w.boot();
    expect(w.core.boot()?.rootfsAt).toBe(snapAt);
    await w.hb();
    await w.tick(snapAt + 40_000);
    expect(ckpts(w)).toHaveLength(0);
    w.c.exit(); // crash at 40 s: life under checkpointMs
    await w.until(() => w.state() === "running" && (w.core.boot()?.gen ?? 0) > 1, 40);
    await w.hb();
    // 61 s after the snapshot, ~20 s after the restart's /startupz: the old rule (from startupz) waited 60 s more.
    await w.tick(Math.max(w.clock.now(), snapAt + 61_000));
    expect(ckpts(w)).toHaveLength(1);
  });

  it("first boot from a never-restored sleep snapshot (no rootfs.at): clock from the boot", async () => {
    const w = setup();
    await w.boot();
    expect(w.core.boot()?.rootfsAt).toBeNull();
    await w.hb();
    const t0 = w.clock.now();
    await w.tick(t0 + 30_000);
    expect(ckpts(w)).toHaveLength(0);
  });
});

describe("N1+N2 SQLite evidence: ocsup sqlite-corrupt exit → l5-pending with the evidence text", () => {
  it("exit event sqlite-corrupt raises l5-pending at once (deduped) and counts evidence", async () => {
    const w = world();
    await w.boot();
    const ev =
      "quick_check state/openclaw.sqlite: *** in database main *** Page 3: btreeInitPage() returns error code 11";
    await w.event("exit", { code: 75, reason: "sqlite-corrupt", detail: ev });
    const a = w.ctl.alerts.filter((x) => x.class === "l5-pending");
    expect(a).toHaveLength(1);
    expect(a[0]?.detail).toContain("btreeInitPage");
    expect(w.core.ladder().sqliteEvidence).toBe(1);
    await w.event("exit", { code: 75, reason: "sqlite-corrupt", detail: ev });
    expect(w.ctl.alerts.filter((x) => x.class === "l5-pending")).toHaveLength(1);
    expect(w.core.ladder().sqliteEvidence).toBe(2);
  });

  it("evidence also from a restore quick_check detail and a Doctor failure (schema poison); not from others", async () => {
    const w = world();
    await w.boot();
    await w.event("exit", {
      code: 75,
      reason: "restore-blocked:mismatch",
      detail: "state/openclaw.sqlite quick_check malformed",
    });
    await w.event("exit", { code: 78, reason: "doctor-failed", detail: "doctor exit 1" });
    await w.event("exit", { code: 75, reason: "replica-down:local" });
    expect(w.core.ladder().sqliteEvidence).toBe(2);
    expect(w.ctl.alerts.filter((x) => x.class === "l5-pending")).toHaveLength(0);
  });
});
