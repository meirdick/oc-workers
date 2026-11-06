// Archive cadence and sleep hold (M4, spec 08 §17.2 /v1/archive/*, plan §6.1 row 7, M3 e2e F10, live A A2).
// One rule set, read by the ControlGate ledger (may an archive start now?) and by the Control DO sleep gate
// (hold the sleep while an archive is due or open). Pure reads over the Control DO SQLite.
//
// Cadence: ocsup polls `POST /v1/archive/start {manifest.reason:"6h"|"due"}` about once a minute while
// awake. The Control DO answers 409 `fresh` unless an archive is due:
//   - none:  no complete archive yet;
//   - dirty: a gen upload landed after the newest complete archive started, and minGapMs has passed;
//   - age:   the newest complete archive is older than everyMs (the 6 h cadence of plan §6.1 row 7).
// Owner, pre-upgrade and post-rollback archives and a pending request skip the cadence (day cap only).
// Sleep hold (rule 1 blockers): `archive-open` while an archive of this gen is open (cap openHoldMs);
// `archive-due` from the due point until ocsup tries a start (cap dueHoldMs); `archive-requested` while an
// owner request waits (cap requestHoldMs, and stallMs without progress). Each hold has a cap, so a broken
// archiver never keeps the install awake for long.
// Day cap: cadence archives stop at dayCap(cfg, false); owner/upgrade requests have FORCED_EXTRA_PER_DAY more
// (oc-demo 2026-11-05: the dirty cadence took all 24 starts by 19:52 UTC, so every pre-upgrade request after
// that got 429 archive-cap and its sleep hold was re-armed by each deploy for hours).

export interface ArchiveCfg {
  /** Min time between two cadence archives when the state changed. guess: 15 min. */
  minGapMs: number;
  /** Max age of the newest complete archive while awake (plan §6.1 row 7: 6 h). */
  everyMs: number;
  /** Sleep waits this long at most for an open archive. guess: 10 min (2 GB at ~4 MB/s). */
  openHoldMs: number;
  /** Sleep waits this long at most after the due point for ocsup to start the archive. */
  dueHoldMs: number;
  /** Sleep waits this long at most for an owner/pre-upgrade request to complete. */
  requestHoldMs: number;
  /** An `open` row older than this is dead (container gone); the next start aborts it. */
  openMaxMs: number;
  /** Archives started per UTC day. Spec said 8 (6 h cadence); the dirty cadence needs more. guess: 24. */
  perDay: number;
  /** Monthly restore drill. */
  drillEveryMs: number;
  /** A request with no progress (start, part) this long is `failed` (archive-stalled alert, hold cleared). */
  stallMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const ARCHIVE_DEFAULTS: ArchiveCfg = Object.freeze({
  minGapMs: 15 * MIN,
  everyMs: 6 * HOUR,
  openHoldMs: 10 * MIN,
  dueHoldMs: 3 * MIN,
  requestHoldMs: 30 * MIN,
  openMaxMs: 30 * MIN,
  perDay: 24,
  drillEveryMs: 30 * DAY,
  stallMs: 15 * MIN,
});

/** Spec §17.2 said 8/day (6 h cadence). The M4 dirty cadence uses ArchiveCfg.perDay. */
export const ARCHIVES_PER_DAY = 8;
/** Starts per UTC day kept for owner/upgrade requests after the cadence used its share. guess: 8. */
export const FORCED_EXTRA_PER_DAY = 8;

/** Archive starts allowed per UTC day: cadence polls, or forced (a live request or a forced reason). */
export function dayCap(cfg: ArchiveCfg, forced: boolean): number {
  return Math.max(cfg.perDay, ARCHIVES_PER_DAY) + (forced ? FORCED_EXTRA_PER_DAY : 0);
}

/** Settings keys of the `archive` block (core/tunables.ts) → ArchiveCfg field and ms per unit. */
const SETTING_KEYS: [string, keyof ArchiveCfg, number][] = [
  ["everyHours", "everyMs", HOUR],
  ["minGapMinutes", "minGapMs", MIN],
  ["maxPerDay", "perDay", 1],
  ["drillEveryDays", "drillEveryMs", DAY],
];

/**
 * Settings `archive` block over the defaults: `everyHours`, `minGapMinutes`, `maxPerDay`, `drillEveryDays`, and
 * raw ms keys (the holds, tests) named like ArchiveCfg. A raw ms key wins over its settings key.
 */
export function archiveCfg(over: unknown): ArchiveCfg {
  const o = (over && typeof over === "object" ? over : {}) as Record<string, unknown>;
  const out = { ...ARCHIVE_DEFAULTS };
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  for (const [k, field, unit] of SETTING_KEYS) if (ok(o[k])) out[field] = o[k] * unit;
  for (const k of Object.keys(out) as (keyof ArchiveCfg)[]) if (ok(o[k])) out[k] = o[k];
  return out;
}

/** Reasons that skip the cadence rule (owner or upgrade path asked for this archive). */
export const FORCED_REASONS = new Set(["pre-upgrade", "post-rollback", "owner", "ctl", "seed", "drill"]);
/** Reasons that are cadence polls. */
export const CADENCE_REASONS = new Set(["6h", "due", "maint"]);

export interface ArchiveQ {
  one<T>(q: string, ...b: (string | number | null)[]): T | null;
}

export interface NewestArchive {
  id: string;
  created_at: number;
  completed_at: number | null;
}

/** Newest complete archive (not bad, not deleted). */
export function newestComplete(q: ArchiveQ): NewestArchive | null {
  return q.one<NewestArchive>(
    "SELECT id, created_at, completed_at FROM archives WHERE state = 'complete' ORDER BY created_at DESC, id DESC LIMIT 1",
  );
}

/** Last replica upload over all gens (ReplicaGate `gendb.last_write_at`). */
export function lastWriteAt(q: ArchiveQ): number | null {
  return q.one<{ m: number | null }>("SELECT MAX(last_write_at) AS m FROM gendb")?.m ?? null;
}

export interface Due {
  due: boolean;
  why: "none" | "dirty" | "age" | "fresh" | "gap";
  /** When the archive became due (for the sleep hold). */
  since: number | null;
  newestAt: number | null;
  lastWriteAt: number | null;
}

/** Cadence rule. `now` in ms. */
export function archiveDue(q: ArchiveQ, now: number, cfg: ArchiveCfg): Due {
  const n = newestComplete(q);
  const w = lastWriteAt(q);
  if (!n) return { due: true, why: "none", since: w, newestAt: null, lastWriteAt: w };
  const dirty = w !== null && w > n.created_at;
  const ageDue = n.created_at + cfg.everyMs;
  if (now >= ageDue) return { due: true, why: "age", since: ageDue, newestAt: n.created_at, lastWriteAt: w };
  if (!dirty) return { due: false, why: "fresh", since: null, newestAt: n.created_at, lastWriteAt: w };
  const gapAt = n.created_at + cfg.minGapMs;
  if (now < gapAt) return { due: false, why: "gap", since: null, newestAt: n.created_at, lastWriteAt: w };
  return {
    due: true,
    why: "dirty",
    since: Math.max(gapAt, w ?? 0),
    newestAt: n.created_at,
    lastWriteAt: w,
  };
}

export interface ArchiveRequest {
  id: string;
  reason: string;
  at: number;
  state: "pending" | "running" | "done" | "failed";
  archiveId?: string | null;
  doneAt?: number | null;
  why?: string | null;
  /** Last step seen (requested, start refused: cap, started, part n, aborted: ...). */
  step?: string | null;
  /** Last progress (request, start, part). The stall rule counts from here. */
  progressAt?: number | null;
}

/** When a live request counts as stalled (null: no live request). */
export function requestStallAt(r: ArchiveRequest | null, cfg: ArchiveCfg): number | null {
  if (!r || (r.state !== "pending" && r.state !== "running")) return null;
  return (r.progressAt ?? r.at) + cfg.stallMs;
}

/** Sleep-gate blockers (spec 08 §10.1 rule 1) from the archive state. */
export function archiveHold(
  q: ArchiveQ,
  now: number,
  cfg: ArchiveCfg,
  o: {
    gen: number | null;
    attemptAt: number;
    /** Gen of the last start attempt: the `archive-due` hold needs an ocsup that polls (this gen did). */
    attemptGen: number | null;
    request: ArchiveRequest | null;
    prod: boolean;
  },
): string[] {
  if (!o.prod) return [];
  const out: string[] = [];
  const open = q.one<{ id: string; created_at: number }>(
    "SELECT id, created_at FROM archives WHERE state = 'open' AND gen = ? ORDER BY created_at DESC LIMIT 1",
    o.gen ?? -1,
  );
  if (open && now - open.created_at < cfg.openHoldMs) out.push(`archive-open:${open.id}`);
  // M4 S4: with the day cap reached ocsup's start is refused (`cap`), so waiting for it only blocks the sleep.
  const day = new Date(now).toISOString().slice(0, 10);
  const started =
    q.one<{ archives: number }>("SELECT archives FROM budget_day WHERE day = ?", day)?.archives ?? 0;
  const r = o.request;
  const stallAt = requestStallAt(r, cfg);
  if (
    r &&
    stallAt !== null &&
    now - r.at < cfg.requestHoldMs &&
    now < stallAt &&
    (r.state === "running" || started < dayCap(cfg, true))
  )
    out.push(`archive-requested:${r.reason}`);
  if (!open && o.gen !== null && o.attemptGen === o.gen && started < dayCap(cfg, false)) {
    const d = archiveDue(q, now, cfg);
    if (d.due && d.since !== null && o.attemptAt < d.since && now - d.since < cfg.dueHoldMs)
      out.push(`archive-due:${d.why}`);
  }
  return out;
}

/** Drill J: the R2 sidecar next to an archive object (index facts, so a wiped Control DO can rebuild the row). */
export const sidecarKey = (key: string) => `${key.replace(/\.tar\.gz$/, "")}.json`;
