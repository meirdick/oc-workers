// Snapshot chain bound (add §2.8 "Rebase", amend §2 row 4). Each sleep adds a child snapshot (two registry tags)
// on its parent; only an image boot starts a new chain root. Policy: rebase when the live chain has more than
// `rebaseChainMax` snapshots or its root is older than `rebaseEveryMs`. The sleep sets `rebasePending` (and asks
// for an archive when the newest one is too old); the next wake, or a maintenance wake, boots image + archive +
// gen. Prune of an old chain waits for the new root and one wake from it (create before delete), and never
// touches a chain that is live or in use.
import { requestArchive } from "./archives";
import { type Ctx, ring } from "./ctx";
import { DIGEST_ARCHIVE_SLACK_MS, digestGuard } from "./digest";
import { activeEpoch } from "./epochs";
import { currentGen, genRow } from "./gens";
import type { SnapRow } from "./snapshots";
import { pj } from "./sql";

/** Two registry tags per snapshot: `rootfs-snapshot-<sha256(id)>` and `rootfs-set-<sha256(set id)>` (m0 T3). */
export const TAGS_PER_SNAPSHOT = 2;
/** `ochost status` warns above this many estimated tags (oc-demo had 177 in two days); settings chain.tagWarn. */
export const TAGS_WARN = 100;

export interface RebasePolicy {
  due: boolean;
  why: string;
  chainBase: string | null;
  chainLength: number;
  chainAgeMs: number | null;
}

const baseOf = (s: Pick<SnapRow, "id" | "chain_base">) => s.chain_base ?? s.id;

/** Newest snapshot a boot could restore (ok or suspect), on the active epoch's digest when there is one. */
function newestUsable(c: Ctx): SnapRow | null {
  const ep = activeEpoch(c);
  const q = "SELECT * FROM snapshots WHERE state IN ('ok', 'suspect')";
  const tail = " ORDER BY created_at DESC, id DESC LIMIT 1";
  return (
    (ep ? c.db.one<SnapRow>(`${q} AND digest = ?${tail}`, ep.digest) : null) ?? c.db.one<SnapRow>(q + tail)
  );
}

/** Rows of a chain still in the registry (not pruned). */
function chainRows(c: Ctx, base: string): SnapRow[] {
  return c.db.all<SnapRow>(
    "SELECT * FROM snapshots WHERE (chain_base = ? OR id = ?) AND state != 'pruned' ORDER BY created_at",
    base,
    base,
  );
}

/** Is the live chain over the bound? Pure read. */
export function rebasePolicy(c: Ctx): RebasePolicy {
  const n = newestUsable(c);
  if (!n) return { due: false, why: "no snapshot", chainBase: null, chainLength: 0, chainAgeMs: null };
  const base = baseOf(n);
  const rows = chainRows(c, base);
  const root = rows.find((r) => r.id === base) ?? rows[0] ?? n;
  const out = { chainBase: base, chainLength: rows.length, chainAgeMs: c.now() - root.created_at };
  // A rebase boot ran after the newest snapshot: the new root comes with the next sleep.
  const last = c.db.metaNum("lastRebaseAt", 0);
  if (last && n.created_at <= last)
    return { due: false, why: "rebase boot ran; new root at the next sleep", ...out };
  if (out.chainLength > c.timers.rebaseChainMax)
    return {
      due: true,
      why: `chain has ${out.chainLength} snapshots (> ${c.timers.rebaseChainMax})`,
      ...out,
    };
  if (out.chainAgeMs > c.timers.rebaseEveryMs)
    return { due: true, why: `chain root is ${Math.round(out.chainAgeMs / 3_600_000)} h old`, ...out };
  return { due: false, why: "chain inside the bound", ...out };
}

/**
 * Sleep side (called from the sleep gate inputs): when the policy is due, mark the next wake as a rebase and ask
 * for an archive if the newest one would lose the workspace. Idempotent.
 */
export function rebaseAtSleep(c: Ctx): void {
  if (c.db.meta("rebasePending")) return;
  const p = rebasePolicy(c);
  if (!p.due) return;
  c.db.setMeta("rebasePending", { at: c.now(), why: p.why, base: p.chainBase });
  ring(c, "chain", "rebase-pending", p);
  if (!digestGuard(c, null, DIGEST_ARCHIVE_SLACK_MS).ok) requestArchive(c, "rebase");
}

/**
 * Boot side (beginBoot, prod L1 wake): rebase now when the sleep marked it, or on a maintenance (or TTL) wake
 * when the policy is due. Needs a complete archive that keeps the workspace; else it asks for one and waits.
 */
export function rebaseAtWake(c: Ctx, reason: string): boolean {
  const pending = !!c.db.meta("rebasePending");
  const maint = reason === "wake:maint" || reason === "wake:ttl";
  if (!pending && !maint) return false;
  const p = rebasePolicy(c);
  if (!p.due) {
    if (pending) c.db.delMeta("rebasePending");
    return false;
  }
  if (!c.db.one("SELECT id FROM archives WHERE state = 'complete' LIMIT 1")) return false;
  const g = digestGuard(c, null, DIGEST_ARCHIVE_SLACK_MS);
  if (!g.ok) {
    requestArchive(c, "rebase");
    ring(c, "chain", "rebase-wait-archive", { why: g.why });
    return false;
  }
  c.db.delMeta("rebasePending");
  return true;
}

export interface PrunePlan {
  /** true when the new root exists and one wake from its chain reached `started` */
  ready: boolean;
  why: string;
  liveBase: string | null;
  /** snapshot ids whose registry tags may go, oldest first */
  ids: string[];
  bytes: number;
  /** chain bases kept, with the reason */
  keep: { base: string; why: string }[];
}

/**
 * Prune plan (create before delete). Candidates: snapshots of older chains with the live chain's digest. Kept:
 * the live chain, the chain the current gen booted from, chains with a pending or valid marker, chains of
 * another digest (a rollback may need them; they reach their TTL). Empty until a wake from the new root worked.
 */
export function prunePlan(c: Ctx): PrunePlan {
  const live = newestUsable(c);
  const empty = (why: string, liveBase: string | null = null): PrunePlan => ({
    ready: false,
    why,
    liveBase,
    ids: [],
    bytes: 0,
    keep: liveBase ? [{ base: liveBase, why: "live chain" }] : [],
  });
  if (!live) return empty("no live chain");
  const liveBase = baseOf(live);
  const liveRows = chainRows(c, liveBase);
  const root = liveRows.find((r) => r.id === liveBase);
  if (!root) return empty("live chain root not in the index", liveBase);
  if (!liveRows.some((r) => r.last_restored_at !== null))
    return empty("waiting for one wake from the new chain root", liveBase);

  const keep = new Map<string, string>([[liveBase, "live chain"]]);
  const ep = activeEpoch(c);
  const gen = ep ? currentGen(c, ep.n) : null;
  const g = gen !== null ? genRow(c, gen) : null;
  const booted = pj<{ rootfs?: { snapshotId?: string } }>(g?.plan, {}).rootfs?.snapshotId;
  const rowOf = (id: string | null | undefined) =>
    id ? c.db.one<SnapRow>("SELECT * FROM snapshots WHERE id = ?", id) : null;
  const b = rowOf(booted);
  if (b && !keep.has(baseOf(b))) keep.set(baseOf(b), "current boot");
  for (const m of c.db.all<{ snapshot_id: string }>(
    "SELECT snapshot_id FROM markers WHERE state IN ('pending', 'valid') AND snapshot_id IS NOT NULL",
  )) {
    const r = rowOf(m.snapshot_id);
    if (r && !keep.has(baseOf(r))) keep.set(baseOf(r), "marker");
  }
  const ids: string[] = [];
  let bytes = 0;
  const rows = c.db.all<SnapRow>("SELECT * FROM snapshots WHERE state != 'pruned' ORDER BY created_at, id");
  const newestOf = new Map<string, number>();
  for (const r of rows) newestOf.set(baseOf(r), Math.max(newestOf.get(baseOf(r)) ?? 0, r.created_at));
  for (const r of rows) {
    const base = baseOf(r);
    if (keep.has(base)) continue;
    if (r.digest !== live.digest) {
      keep.set(base, "other digest");
      continue;
    }
    // Only chains that ended before the new root: never one that grew after it.
    if ((newestOf.get(base) ?? 0) >= root.created_at) {
      keep.set(base, "newer than the live root");
      continue;
    }
    ids.push(r.id);
    bytes += r.size ?? 0;
  }
  const out = ids;
  return {
    ready: true,
    why: out.length ? `${out.length} snapshot(s) of older chains` : "nothing to prune",
    liveBase,
    ids: out,
    bytes,
    keep: [...keep].map(([base, why]) => ({ base, why })),
  };
}

/** After the CLI asks to delete: mark the ids `pruned` that the plan still allows (rechecked now). */
export function markPruned(c: Ctx, ids: string[]): { pruned: string[]; refused: string[] } {
  const allow = new Set(prunePlan(c).ids);
  const pruned: string[] = [];
  const refused: string[] = [];
  for (const id of ids) {
    if (!allow.has(id)) {
      refused.push(id);
      continue;
    }
    c.db.run("UPDATE snapshots SET state = 'pruned' WHERE id = ?", id);
    c.db.run(
      "UPDATE markers SET state = 'void', void_reason = 'snapshot-pruned', updated_at = ? WHERE snapshot_id = ? AND state IN ('pending', 'valid')",
      c.now(),
      id,
    );
    pruned.push(id);
  }
  if (pruned.length) ring(c, "chain", "pruned", { n: pruned.length, refused: refused.length });
  return { pruned, refused };
}

/** /ops/status `snapshots`: chain length, tags and bytes still in the registry (estimate from the index). */
export function snapshotSummary(c: Ctx) {
  const p = rebasePolicy(c);
  const tot = c.db.one<{ n: number; b: number | null }>(
    "SELECT COUNT(*) AS n, SUM(size) AS b FROM snapshots WHERE state != 'pruned'",
  );
  const n = tot?.n ?? 0;
  const tags = n * TAGS_PER_SNAPSHOT;
  const warnAt = c.settings().chain.tagWarn;
  const plan = prunePlan(c);
  return {
    chainBase: p.chainBase,
    chainLength: p.chainLength,
    chainAgeMs: p.chainAgeMs,
    indexed: n,
    tags,
    bytes: tot?.b ?? 0,
    rebase: {
      due: p.due,
      why: p.why,
      pending: c.db.metaJson<{ at: number; why: string } | null>("rebasePending", null),
      lastAt: c.db.metaNum("lastRebaseAt", 0) || null,
      chainMax: c.timers.rebaseChainMax,
      everyMs: c.timers.rebaseEveryMs,
    },
    prune: { ready: plan.ready, why: plan.why, count: plan.ids.length, bytes: plan.bytes },
    warn: tags > warnAt ? `about ${tags} registry tags (> ${warnAt}); run ochost snapshot prune` : null,
  };
}
