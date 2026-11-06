// Snapshot chain bound (ctl/chain.ts): rebase policy, prune ordering (create before delete; never a tag of the
// live chain), the /ops/status `snapshots` summary and /ops/archive/can-run.
import { describe, expect, it } from "vitest";
import { archiveCanRun } from "../../src/ctl/archives";
import { markPruned, prunePlan, rebasePolicy, snapshotSummary } from "../../src/ctl/chain";
import { bootComplete, type World, world } from "./world";

const snap = (w: World, id: string, parentId: string | null, digest = "sha256:img1", size = 10) => {
  w.advance(1000);
  return w.api.snapshotSaved({ id, size, digest, imageKey: "oc", gen: 1, epoch: 1, kind: "sleep", parentId });
};
const archive = (w: World) =>
  w.db.run(
    `INSERT INTO archives (id, key, kind, state, sha256, size, digest, txid, created_at)
     VALUES ('a1', 'a/t1/x.tar.gz', 'clean', 'complete', ?, 10, 'sha256:img1', '{"state/openclaw.sqlite":42}', ?)`,
    "a".repeat(64),
    w.clock.t,
  );
/** Old chain o1 <- o2 <- o3 (o1 restored once), then optionally a new root n1 from a rebase boot. */
async function twoChains(w: World, o: { newRoot: boolean; wakeFromNew: boolean }) {
  w.install();
  await bootComplete(w);
  await snap(w, "o1", null, "sha256:img1", 120_000_000);
  await snap(w, "o2", "o1", "sha256:img1", 1_300_000);
  await snap(w, "o3", "o2", "sha256:img1", 1_400_000);
  w.db.run("UPDATE snapshots SET last_restored_at = ? WHERE id = 'o1'", w.clock.t);
  if (o.newRoot) await snap(w, "n1", null, "sha256:img1", 118_000_000);
  if (o.wakeFromNew) {
    w.advance(1000);
    const r = await bootComplete(w, { reason: "wake:webhook" });
    expect(r.plan.rootfs).toMatchObject({ kind: "snapshot", snapshotId: "n1" });
  }
}

describe("rebase policy", () => {
  it("due above rebaseChainMax snapshots or past rebaseEveryMs; not due inside the bound", async () => {
    const w = world({ timers: { rebaseChainMax: 3, rebaseEveryMs: 3_600_000 } });
    w.install();
    expect(rebasePolicy(w.ctx)).toMatchObject({ due: false, why: "no snapshot" });
    await snap(w, "s1", null);
    await snap(w, "s2", "s1");
    await snap(w, "s3", "s2");
    expect(rebasePolicy(w.ctx)).toMatchObject({ due: false, chainBase: "s1", chainLength: 3 });
    await snap(w, "s4", "s3");
    expect(rebasePolicy(w.ctx)).toMatchObject({ due: true, chainLength: 4 });
    const v = world({ timers: { rebaseChainMax: 40, rebaseEveryMs: 3_600_000 } });
    v.install();
    await snap(v, "s1", null);
    v.advance(3_600_001);
    expect(rebasePolicy(v.ctx).due).toBe(true);
    expect(rebasePolicy(v.ctx).why).toMatch(/root is 1 h old/);
  });

  it("defaults: 40 snapshots or 24 h", () => {
    const w = world({ real: true });
    expect([w.ctx.timers.rebaseChainMax, w.ctx.timers.rebaseEveryMs]).toEqual([40, 24 * 3_600_000]);
  });
});

describe("prune ordering (create before delete)", () => {
  it("before the new root exists the old chain is the live chain: nothing to prune", async () => {
    const w = world();
    await twoChains(w, { newRoot: false, wakeFromNew: false });
    const p = prunePlan(w.ctx);
    expect(p.liveBase).toBe("o1");
    expect(p.ids).toEqual([]);
    expect(markPruned(w.ctx, ["o1", "o2", "o3"])).toEqual({ pruned: [], refused: ["o1", "o2", "o3"] });
  });

  it("new root saved but no wake from it yet: not ready, nothing to prune", async () => {
    const w = world();
    await twoChains(w, { newRoot: true, wakeFromNew: false });
    const p = prunePlan(w.ctx);
    expect(p).toMatchObject({ ready: false, liveBase: "n1", ids: [] });
    expect(p.why).toMatch(/waiting for one wake/);
    expect(markPruned(w.ctx, ["o1"]).refused).toEqual(["o1"]);
  });

  it("after one wake from the new root: the old chain is prunable, the live chain never", async () => {
    const w = world();
    await twoChains(w, { newRoot: true, wakeFromNew: true });
    await snap(w, "n2", "n1");
    const p = prunePlan(w.ctx);
    expect(p).toMatchObject({ ready: true, liveBase: "n1", ids: ["o1", "o2", "o3"] });
    expect(p.bytes).toBe(122_700_000);
    const m = markPruned(w.ctx, ["n1", "n2", "o1", "o2", "o3"]);
    expect(m).toEqual({ pruned: ["o1", "o2", "o3"], refused: ["n1", "n2"] });
    expect(w.db.all<{ id: string }>("SELECT id FROM snapshots WHERE state = 'pruned' ORDER BY id")).toEqual([
      { id: "o1" },
      { id: "o2" },
      { id: "o3" },
    ]);
    // A pruned snapshot is never a boot source again.
    w.db.run("UPDATE snapshots SET state = 'suspect' WHERE id IN ('n1', 'n2')");
    w.db.run("UPDATE snapshots SET state = 'bad' WHERE id IN ('n1', 'n2')");
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "after", reason: "wake:webhook" });
    expect(r.plan.rootfs.kind).toBe("image");
  });

  it("keeps a chain with a valid marker, the chain the current gen booted from, and other digests", async () => {
    const w = world();
    await twoChains(w, { newRoot: true, wakeFromNew: true });
    await snap(w, "x1", null, "sha256:old");
    w.db.run(
      `INSERT INTO markers (id, op_id, gen, epoch, digest, snapshot_id, txid, bytes, last_write_at, state, created_at, updated_at)
       VALUES ('mk1', 'op-mk', 1, 1, 'sha256:img1', 'o2', '{}', '{}', '{}', 'valid', ?, ?)`,
      w.clock.t,
      w.clock.t,
    );
    const p = prunePlan(w.ctx);
    expect(p.ids).toEqual([]);
    expect(p.keep).toEqual(
      expect.arrayContaining([
        { base: "n1", why: "live chain" },
        { base: "o1", why: "marker" },
        { base: "x1", why: "other digest" },
      ]),
    );
  });

  it("an old chain that grew after the new root (a fallback boot) is kept", async () => {
    const w = world();
    await twoChains(w, { newRoot: true, wakeFromNew: true });
    await snap(w, "o4", "o3");
    // o4 is now the newest, so the old chain is live again: nothing of either chain goes.
    expect(prunePlan(w.ctx).ids).toEqual([]);
  });
});

describe("/ops/status snapshots summary", () => {
  it("chain length, tags and bytes from the index; warn above 100 tags", async () => {
    const w = world();
    w.install();
    await snap(w, "s0", null, "sha256:img1", 1000);
    for (let i = 1; i <= 50; i++) await snap(w, `s${i}`, `s${i - 1}`, "sha256:img1", 100);
    const s = snapshotSummary(w.ctx);
    expect(s).toMatchObject({ chainBase: "s0", chainLength: 51, indexed: 51, tags: 102, bytes: 6000 });
    expect(s.rebase.due).toBe(true);
    expect(s.warn).toMatch(/102 registry tags/);
    const st = (await w.core.status()) as { snapshots: { tags: number } };
    expect(st.snapshots.tags).toBe(102);
  });

  it("no warn at 100 tags or fewer", async () => {
    const w = world();
    w.install();
    await snap(w, "s0", null);
    expect(snapshotSummary(w.ctx)).toMatchObject({ tags: 2, warn: null });
  });
});

describe("/ops/archive/can-run", () => {
  const T = 600_000;
  it("yes when awake, asleep or the ladder starts in time; no in backoff past it, restore-blocked, stopped", () => {
    const w = world();
    archive(w);
    w.advance(30 * 60_000);
    const now = w.clock.t;
    const run = (rt: Parameters<typeof archiveCanRun>[1]) => archiveCanRun(w.ctx, rt, T);
    expect(run({ state: "running" }).canRun).toBe(true);
    expect(run({ state: "asleep", desired: "asleep" }).canRun).toBe(true);
    expect(run({ state: "backoff", desired: "asleep", ladder: { nextStartAt: now + 60_000 } }).canRun).toBe(
      true,
    );
    const far = run({ state: "backoff", desired: "asleep", ladder: { nextStartAt: now + 3_600_000 } });
    expect(far).toMatchObject({ canRun: false, state: "backoff", newestAgeMs: 30 * 60_000 });
    expect(
      run({ state: "backoff", ladder: { nextStartAt: now, lastClass: "restore-blocked:mismatch" } }),
    ).toMatchObject({ canRun: false, state: "restore-blocked:mismatch" });
    expect(run({ state: "stopped", desired: "asleep" }).canRun).toBe(false);
    expect(run(null)).toMatchObject({ canRun: false, state: "none" });
  });

  it("is served at GET /ops/archive/can-run", async () => {
    const w = world();
    w.install();
    const r = await w.core.ops({
      action: "archive",
      method: "GET",
      sub: ["can-run"],
      query: { withinMs: "600000" },
      body: {},
      role: "owner",
    });
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("canRun");
  });
});
