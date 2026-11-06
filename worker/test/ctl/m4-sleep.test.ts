// M4 sleep drills: rebase rule (add §2.8) and the drill fault hooks (OC_TEST only).
import { describe, expect, it } from "vitest";
import { ARCHIVE_DEFAULTS, archiveHold } from "../../src/gates/archive-policy";
import { noFaults, setFault } from "../../src/rt/faults";
import { bootComplete, world } from "./world";

const archive = (w: ReturnType<typeof world>) =>
  w.db.run(
    `INSERT INTO archives (id, key, kind, state, sha256, size, digest, txid, created_at)
     VALUES ('a1', 'a/t1/x.tar.gz', 'clean', 'complete', ?, 10, 'sha256:img1', '{"state/openclaw.sqlite":42}', ?)`,
    "a".repeat(64),
    w.clock.t,
  );

describe("M4 rebase rule (chain bound, ctl/chain.ts)", () => {
  const snap = (w: ReturnType<typeof world>, id: string, parentId: string | null) => {
    w.advance(1000);
    return w.api.snapshotSaved({
      id,
      size: 10,
      digest: "sha256:img1",
      imageKey: "oc",
      gen: 1,
      epoch: 1,
      kind: "sleep",
      parentId,
    });
  };

  it("a sleep with the chain over the bound marks the next wake; that wake boots image + archive; the next does not", async () => {
    const w = world({ timers: { rebaseChainMax: 3 } });
    w.install();
    await bootComplete(w);
    for (const [id, p] of [
      ["s1", null],
      ["s2", "s1"],
      ["s3", "s2"],
      ["s4", "s3"],
    ] as const)
      await snap(w, id, p);
    archive(w);
    await w.api.sleepInputs();
    expect(w.db.metaJson<{ why: string } | null>("rebasePending", null)?.why).toMatch(/4 snapshots/);
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "w2", reason: "wake:webhook" });
    expect(b.plan.rootfs.kind).toBe("image");
    expect(b.plan.archive).toMatchObject({ archiveId: "a1" });
    expect(w.db.metaNum("lastRebaseAt")).toBe(w.clock.t);
    expect(w.db.meta("rebasePending")).toBeNull();
    // Awake after the rebase boot: the old chain is still newest, but the policy waits for the new root.
    await w.api.sleepInputs();
    expect(w.db.meta("rebasePending")).toBeNull();
    w.advance(1000);
    const c = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "w3", reason: "wake:webhook" });
    expect(w.db.all("SELECT id FROM ring WHERE src = 'gen' AND kind = 'rebase'").length).toBe(1);
    expect(c.gen).toBe(b.gen + 1);
  });

  it("a maintenance wake rebases a chain older than rebaseEveryMs without a mark; a webhook wake does not", async () => {
    const w = world({ timers: { rebaseEveryMs: 60_000 } });
    w.install();
    await bootComplete(w);
    await snap(w, "s1", null);
    archive(w);
    w.advance(61_000);
    const a = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "w1", reason: "wake:webhook" });
    expect(a.plan.rootfs.kind).toBe("snapshot");
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "m1", reason: "wake:maint" });
    expect(b.plan.rootfs.kind).toBe("image");
  });

  it("no rebase without an archive, on a ladder start, or on a non-wake start", async () => {
    const w = world({ timers: { rebaseChainMax: 1 } });
    w.install();
    await bootComplete(w);
    await snap(w, "s1", null);
    await snap(w, "s2", "s1");
    await w.api.sleepInputs();
    await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "w1", reason: "wake:cron" });
    archive(w);
    await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "l1", reason: "ladder" });
    await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "l2", reason: "wake:cron", ladder: 2 });
    expect(w.db.metaNum("lastRebaseAt", 0)).toBe(0);
  });

  it("an archive older than the newest snapshot (past the slack) is asked for; the rebase waits for it", async () => {
    const w = world({ timers: { rebaseChainMax: 1 } });
    w.install();
    await bootComplete(w);
    archive(w);
    w.advance(7 * 3_600_000);
    await snap(w, "s1", null);
    await snap(w, "s2", "s1");
    await w.api.sleepInputs();
    expect(w.db.metaJson<{ reason: string } | null>("archiveRequest", null)?.reason).toBe("rebase");
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "w1", reason: "wake:webhook" });
    expect(b.plan.rootfs.kind).toBe("snapshot");
    expect(w.db.meta("rebasePending")).not.toBeNull();
  });
});

describe("M4 drill faults", () => {
  it("sleep-at and drop-wake arm; clear keeps the abort hook", () => {
    const f = noFaults();
    const abort = () => undefined;
    f.abort = abort;
    expect(setFault(f, "sleep-at", { phase: "flush", action: "hostkill" }, 0)).toBeNull();
    expect(f.sleepAt).toEqual({ phase: "flush", action: "hostkill", ms: 60_000 });
    expect(setFault(f, "sleep-at", { phase: "flush", action: "boom" }, 0)).toMatch(/needs/);
    expect(setFault(f, "drop-wake", { count: 2 }, 0)).toBeNull();
    expect(f.dropWake).toBe(2);
    setFault(f, "clear", {}, 0);
    expect(f.sleepAt).toBeNull();
    expect(f.dropWake).toBe(0);
    expect(f.abort).toBe(abort);
  });
});

describe("M4 S4 archive-due sleep hold", () => {
  const cfg = { ...ARCHIVE_DEFAULTS };
  const mk = (o: { newest: number; lastWrite: number; started: number; day: string }) => ({
    one: <T>(sql: string): T | null => {
      if (sql.includes("state = 'open'")) return null;
      if (sql.includes("state = 'complete'"))
        return { id: "a1", created_at: o.newest, completed_at: o.newest } as T;
      if (sql.includes("MAX(last_write_at)")) return { m: o.lastWrite } as T;
      if (sql.includes("budget_day")) return { archives: o.started } as T;
      return null;
    },
  });
  const t0 = Date.parse("2026-11-01T20:00:00Z");
  const hold = (q: ReturnType<typeof mk>, now: number) =>
    archiveHold(q, now, cfg, { gen: 5, attemptAt: t0, attemptGen: 5, request: null, prod: true });

  it("with the day cap not reached, a due archive holds the sleep", () => {
    const now = t0 + cfg.minGapMs + 1000;
    const q = mk({ newest: t0, lastWrite: now, started: cfg.perDay - 1, day: "2026-11-01" });
    expect(hold(q, now)).toEqual(["archive-due:dirty"]);
  });

  it("no due hold once the day cap is reached (ocsup's start would get `cap`)", () => {
    const now = t0 + cfg.minGapMs + 1000;
    const q = mk({ newest: t0, lastWrite: now, started: cfg.perDay, day: "2026-11-01" });
    expect(hold(q, now)).toEqual([]);
  });
});
