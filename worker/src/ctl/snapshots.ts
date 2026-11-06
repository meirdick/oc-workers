// Snapshot, archive and image index (spec §6.5, §15) and the clean marker (spec §6.4, §14).
import type { SnapshotHandle } from "../core/types";
import { alert } from "./alerts";
import { type Ctx, ring, utcDay } from "./ctx";
import { j, pj } from "./sql";

/** `pruned`: its registry tags were deleted (ctl/chain.ts markPruned); never a boot source. */
export type SnapState = "ok" | "suspect" | "bad" | "superseded" | "abandoned" | "expired" | "pruned";
export interface SnapRow {
  id: string;
  size: number | null;
  image_key: string;
  digest: string;
  kind: string;
  gen: number;
  epoch: number;
  op_id: string | null;
  parent_id: string | null;
  chain_base: string | null;
  created_at: number;
  last_restored_at: number | null;
  state: SnapState;
  misses: number;
  lease_epoch: number | null;
}

export const CONSISTENT_KINDS = ["maint", "planned", "sleep"];
/** Budget per UTC day (§15.1). sleep and planned are counted but not refused. `checkpoint` and `checkpointStop`
 * are the defaults of settings snapshots.maxPerDay and checkpoint.maxPerDay. */
export const SNAP_BUDGET = { checkpoint: 40, checkpointStop: 30, maint: 2, final: 1 };

export const ttlEnd = (c: Ctx, s: Pick<SnapRow, "created_at" | "last_restored_at">) =>
  Math.max(s.created_at, s.last_restored_at ?? 0) + c.timers.snapshotTtlMs;

export function getSnapshot(c: Ctx, id: string): SnapRow | null {
  return c.db.one<SnapRow>("SELECT * FROM snapshots WHERE id = ?", id);
}

/** Handle saved (before destroy): row `ok`, chain fields, day budget count. Idempotent by id. */
export function snapshotSaved(c: Ctx, h: SnapshotHandle): SnapRow {
  const have = getSnapshot(c, h.id);
  if (have) return have;
  const parent = h.parentId ? getSnapshot(c, h.parentId) : null;
  const base = parent ? (parent.chain_base ?? parent.id) : h.id;
  const now = c.now();
  c.db.run(
    `INSERT INTO snapshots (id, size, image_key, digest, kind, gen, epoch, op_id, parent_id, chain_base,
       created_at, state, misses, lease_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', 0, ?)`,
    h.id,
    h.size,
    h.imageKey,
    h.digest,
    h.kind,
    h.gen,
    h.epoch,
    h.opId ?? null,
    parent ? parent.id : null,
    base,
    now,
    h.epoch,
  );
  countSnap(c, h.kind);
  return getSnapshot(c, h.id) as SnapRow;
}

function countSnap(c: Ctx, kind: string): void {
  const day = utcDay(c.now());
  c.db.run("INSERT INTO budget_day (day) VALUES (?) ON CONFLICT(day) DO NOTHING", day);
  const row = c.db.one<{ snaps: string }>("SELECT snaps FROM budget_day WHERE day = ?", day);
  const m = pj<Record<string, number>>(row?.snaps, {});
  m[kind] = (m[kind] ?? 0) + 1;
  c.db.run("UPDATE budget_day SET snaps = ? WHERE day = ?", j(m), day);
  if (
    kind === "planned" &&
    (m.planned ?? 0) + (m.checkpoint ?? 0) + (m.maint ?? 0) > c.settings().snapshots.maxPerDay
  )
    alert(c, "snapshot-budget", "warn", `planned snapshot over the day budget (${j(m)})`);
}

/** May a snapshot of this kind be taken now (§15.1)? */
export function snapshotAllowed(c: Ctx, kind: string): { allow: boolean; why?: string } {
  const m = pj<Record<string, number>>(
    c.db.one<{ snaps: string }>("SELECT snaps FROM budget_day WHERE day = ?", utcDay(c.now()))?.snaps,
    {},
  );
  if (kind === "checkpoint" && (m.checkpoint ?? 0) >= c.settings().checkpoint.maxPerDay)
    return { allow: false, why: "checkpoint-budget" };
  if (kind === "maint" && (m.maint ?? 0) >= SNAP_BUDGET.maint) return { allow: false, why: "maint-budget" };
  return { allow: true };
}

/** "Snapshot not found" (§15.2): first miss → suspect, second → bad. Markers bound to it go void. */
export function snapshotMiss(c: Ctx, id: string): SnapState | null {
  const s = getSnapshot(c, id);
  if (!s) return null;
  const next: SnapState = s.state === "suspect" || s.misses >= 1 ? "bad" : "suspect";
  c.db.run("UPDATE snapshots SET state = ?, misses = misses + 1 WHERE id = ?", next, id);
  voidMarkersForSnapshot(c, id, `snapshot-${next}`);
  ring(c, "snapshot", "miss", { id, state: next });
  return next;
}

/** A boot from this snapshot reached started: TTL renews; suspect → ok. */
export function snapshotRestored(c: Ctx, id: string): void {
  c.db.run(
    "UPDATE snapshots SET last_restored_at = ?, state = CASE WHEN state = 'suspect' THEN 'ok' ELSE state END WHERE id = ?",
    c.now(),
    id,
  );
}

export function snapshotAbandon(c: Ctx, id: string): boolean {
  const s = getSnapshot(c, id);
  if (!s) return false;
  c.db.run("UPDATE snapshots SET state = 'abandoned' WHERE id = ?", id);
  voidMarkersForSnapshot(c, id, "snapshot-abandoned");
  return true;
}

/** An L3/L4 boot skipped these `ok` snapshots (§6.5). */
export function supersedeNewerThan(c: Ctx, digest: string, createdAt: number): number {
  const rows = c.db.all<{ id: string }>(
    "SELECT id FROM snapshots WHERE state = 'ok' AND digest = ? AND created_at > ?",
    digest,
    createdAt,
  );
  for (const r of rows) c.db.run("UPDATE snapshots SET state = 'superseded' WHERE id = ?", r.id);
  return rows.length;
}

/** ok/superseded past TTL → expired; markers bound to them void. */
export function expireSnapshots(c: Ctx): string[] {
  const rows = c.db.all<SnapRow>("SELECT * FROM snapshots WHERE state IN ('ok', 'suspect', 'superseded')");
  const out: string[] = [];
  for (const s of rows) {
    if (ttlEnd(c, s) >= c.now()) continue;
    c.db.run("UPDATE snapshots SET state = 'expired' WHERE id = ?", s.id);
    voidMarkersForSnapshot(c, s.id, "snapshot-expired");
    out.push(s.id);
  }
  return out;
}

/** A chain is live while any snapshot in it is ok/suspect/superseded and inside TTL (§15.3). */
export function liveChains(
  c: Ctx,
): Map<string, { digest: string; imageKey: string; length: number; ids: string[] }> {
  const rows = c.db.all<SnapRow>("SELECT * FROM snapshots ORDER BY created_at");
  const chains = new Map<
    string,
    { digest: string; imageKey: string; length: number; ids: string[]; live: boolean }
  >();
  for (const s of rows) {
    const b = s.chain_base ?? s.id;
    const ch = chains.get(b) ?? { digest: s.digest, imageKey: s.image_key, length: 0, ids: [], live: false };
    ch.length++;
    ch.ids.push(s.id);
    if (["ok", "suspect", "superseded"].includes(s.state) && ttlEnd(c, s) >= c.now()) ch.live = true;
    chains.set(b, ch);
  }
  const out = new Map<string, { digest: string; imageKey: string; length: number; ids: string[] }>();
  for (const [k, v] of chains)
    if (v.live) out.set(k, { digest: v.digest, imageKey: v.imageKey, length: v.length, ids: v.ids });
  return out;
}

/** /ops/images-in-use: image keys and digests of non-retired epochs and live chains. */
export function imagesInUse(c: Ctx): { imageKey: string; digest: string; why: string }[] {
  const out = new Map<string, { imageKey: string; digest: string; why: string }>();
  for (const e of c.db.all<{ n: number; image_key: string; digest: string }>(
    "SELECT n, image_key, digest FROM epochs WHERE status != 'retired'",
  ))
    out.set(e.digest, { imageKey: e.image_key, digest: e.digest, why: `epoch e${e.n}` });
  for (const [base, ch] of liveChains(c))
    if (!out.has(ch.digest))
      out.set(ch.digest, { imageKey: ch.imageKey, digest: ch.digest, why: `chain ${base}` });
  return [...out.values()];
}

/**
 * Registry prune guard (§15.3, M6 uses it): never a `rootfs-*` tag; never an image tag whose digest is used by
 * a non-retired epoch or is the base of a live chain.
 */
export function pruneAllowed(c: Ctx, tag: string, digest: string): { allow: boolean; why?: string } {
  if (tag.startsWith("rootfs-")) return { allow: false, why: "rootfs-tag" };
  const use = imagesInUse(c).find((x) => x.digest === digest);
  return use ? { allow: false, why: use.why } : { allow: true };
}

export function chainLength(c: Ctx, id: string | null | undefined): number {
  if (!id) return 0;
  const s = getSnapshot(c, id);
  if (!s) return 0;
  return (
    c.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM snapshots WHERE chain_base = ?", s.chain_base ?? s.id)
      ?.n ?? 0
  );
}

// ---- archives index (records only; the gate does the R2 multipart) ----

export interface ArchiveRow {
  id: string;
  key: string;
  kind: string;
  state: "open" | "complete" | "aborted";
  sha256: string | null;
  size: number | null;
  digest: string | null;
  state_schema: number | null;
  agent_schema: number | null;
  txid: string | null;
  gen: number | null;
  created_at: number;
  completed_at: number | null;
  /** M4 columns (gates/ledger.ts GATE_COLUMNS). */
  reason?: string | null;
  ws_entries?: number | null;
  ws_missing?: number | null;
  verified_at?: number | null;
}

// ---- clean marker (single use) ----

export type MarkerState = "pending" | "valid" | "consumed" | "void";
export interface MarkerRow {
  id: string;
  op_id: string;
  gen: number;
  epoch: number;
  digest: string;
  snapshot_id: string | null;
  txid: string;
  bytes: string;
  last_write_at: string;
  state: MarkerState;
  void_reason: string | null;
  consumed_by_gen: number | null;
  created_at: number;
  updated_at: number;
}

export interface MarkerInput {
  opId: string;
  gen: number;
  epoch: number;
  digest: string;
  txidPerDb: Record<string, number>;
  bytesPerDb: Record<string, number>;
  lastWriteAtPerDb: Record<string, number | null>;
  mode?: string;
  unclean?: string[];
}

/** Sleep phase 6 / planned stop `marker` (§14). Idempotent by op id. Refused when unclean or not prod. */
export function markerPending(c: Ctx, m: MarkerInput): { ok: boolean; id?: string; error?: string } {
  if (m.unclean?.length) return { ok: false, error: "unclean" };
  if (m.mode && m.mode !== "prod") return { ok: false, error: "mode" };
  const have = c.db.one<MarkerRow>("SELECT * FROM markers WHERE op_id = ?", m.opId);
  if (have)
    return have.state === "void" ? { ok: false, id: have.id, error: "void" } : { ok: true, id: have.id };
  const id = `mk-${m.gen}-${m.opId.slice(0, 16)}`;
  const now = c.now();
  // A newer pending marker supersedes any older non-consumed one.
  c.db.run(
    "UPDATE markers SET state = 'void', void_reason = 'superseded', updated_at = ? WHERE state IN ('pending', 'valid')",
    now,
  );
  c.db.run(
    `INSERT INTO markers (id, op_id, gen, epoch, digest, txid, bytes, last_write_at, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    id,
    m.opId,
    m.gen,
    m.epoch,
    m.digest,
    j(m.txidPerDb),
    j(m.bytesPerDb),
    j(m.lastWriteAtPerDb),
    now,
    now,
  );
  return { ok: true, id };
}

/** Snapshot handle saved: pending → valid (snapshot_id bound). */
export function markerValid(c: Ctx, opId: string, snapshotId: string): { ok: boolean; error?: string } {
  const m = c.db.one<MarkerRow>("SELECT * FROM markers WHERE op_id = ?", opId);
  if (!m) return { ok: false, error: "no-marker" };
  if (m.state === "valid" && m.snapshot_id === snapshotId) return { ok: true };
  if (m.state !== "pending") return { ok: false, error: m.state };
  c.db.run(
    "UPDATE markers SET state = 'valid', snapshot_id = ?, updated_at = ? WHERE id = ?",
    snapshotId,
    c.now(),
    m.id,
  );
  return { ok: true };
}

export function markerVoid(c: Ctx, by: { opId?: string; id?: string }, reason: string): boolean {
  const m = by.opId
    ? c.db.one<MarkerRow>("SELECT * FROM markers WHERE op_id = ?", by.opId)
    : c.db.one<MarkerRow>("SELECT * FROM markers WHERE id = ?", by.id ?? "");
  if (!m || m.state === "consumed" || m.state === "void") return false;
  c.db.run(
    "UPDATE markers SET state = 'void', void_reason = ?, updated_at = ? WHERE id = ?",
    reason,
    c.now(),
    m.id,
  );
  ring(c, "marker", "void", { id: m.id, reason });
  return true;
}

export function voidMarkersForSnapshot(c: Ctx, snapshotId: string, reason: string): void {
  c.db.run(
    "UPDATE markers SET state = 'void', void_reason = ?, updated_at = ? WHERE snapshot_id = ? AND state IN ('pending', 'valid')",
    reason,
    c.now(),
    snapshotId,
  );
}

/** Any upload recorded for marker.gen after created_at voids a valid marker (§6.4 `late-upload`). */
export function voidOnLateUpload(c: Ctx, gen: number, at: number): void {
  c.db.run(
    "UPDATE markers SET state = 'void', void_reason = 'late-upload', updated_at = ? WHERE gen = ? AND state IN ('pending', 'valid') AND created_at < ?",
    c.now(),
    gen,
    at,
  );
}

export function validMarkerFor(c: Ctx, snapshotId: string): MarkerRow | null {
  return c.db.one<MarkerRow>("SELECT * FROM markers WHERE state = 'valid' AND snapshot_id = ?", snapshotId);
}
