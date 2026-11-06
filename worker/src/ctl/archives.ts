// Archive index ops in the Control DO (M4): owner/pre-upgrade requests, sleep hold, archive GC, read-back
// verify, the monthly restore drill, and the `/ops/archive` route. The gate side (multipart, cadence answer,
// verify-on-restore) is gates/control.ts + gates/ledger.ts; the rules both read are gates/archive-policy.ts.
import {
  type ArchiveCfg,
  type ArchiveRequest,
  archiveCfg,
  archiveDue,
  archiveHold,
  lastWriteAt,
  newestComplete,
  requestStallAt,
  sidecarKey,
} from "../gates/archive-policy";
import type { GateLedger } from "../gates/ledger";
import { shaDigest, shaInit, shaUpdate } from "../gates/sha256";
import { alert } from "./alerts";
import { type Ctx, DAY, ring, utcDay } from "./ctx";
import type { ArchiveBucket, DrillArgs, DrillReport } from "./drill";
import { activeEpoch } from "./epochs";
import { currentGen } from "./gens";
import { pj } from "./sql";

export const ARCHIVE_GC_MAX = 20; // per run (like gens, §13.4)
/** Retention (plan §6.1 row 7): 8 newest, one per UTC day for 14 d, one per week for 8 weeks. */
export const KEEP_NEWEST = 8;
export const KEEP_DAILY_DAYS = 14;
export const KEEP_WEEKS = 8;
/** guess: pre-upgrade/post-rollback archives; plan says "until the version is retired + 30 d". */
export const KEEP_UPGRADE_MS = 90 * DAY;
export const BAD_KEEP_MS = 7 * DAY;
export const MULTIPART_MAX_MS = DAY; // §13.5 open multipart > 24 h → abort
/** guess: one Control DO tick verifies archives up to this size by read-back (JS SHA-256 in the DO). */
export const VERIFY_MAX_BYTES = 2 * 1024 ** 3;

export interface ArchiveIdx {
  id: string;
  key: string;
  kind: string;
  state: string;
  reason: string | null;
  sha256: string | null;
  size: number | null;
  digest: string | null;
  gen: number | null;
  created_at: number;
  completed_at: number | null;
  verified_at: number | null;
  verified_by: string | null;
  ws_entries: number | null;
  ws_missing: number | null;
  bad_reason: string | null;
}

export const cfgOf = (c: Ctx): ArchiveCfg =>
  archiveCfg((c.settings() as unknown as { archive?: unknown }).archive);

const q = (c: Ctx) => ({
  one: <T>(s: string, ...b: (string | number | null)[]) => c.db.one<T>(s, ...b),
});

// ---------------------------------------------------------------- sleep hold and request

/** Rule 1 blockers for the sleep gate (archive-policy.ts archiveHold). */
export function archiveSleepBlockers(c: Ctx): string[] {
  const ep = activeEpoch(c);
  const gen = ep ? currentGen(c, ep.n) : null;
  const mode =
    gen !== null ? c.db.one<{ mode: string }>("SELECT mode FROM gens WHERE gen = ?", gen)?.mode : null;
  return archiveHold(q(c), c.now(), cfgOf(c), {
    gen,
    attemptAt: c.db.metaNum("archiveAttemptAt", 0),
    attemptGen: c.db.meta("archiveAttemptGen") === null ? null : c.db.metaNum("archiveAttemptGen", -1),
    request: c.db.metaJson<ArchiveRequest | null>("archiveRequest", null),
    prod: mode === "prod",
  });
}

/**
 * N8: when the Worker is newer than this DO (`redeployAt`, set from the Worker version the /ops and hook calls carry)
 * and no boot has followed, the next boot may change the image digest. That boot restores the workspace from the
 * newest archive only, so writes since that archive are lost (M4 backup N8: 4.5-7.7 min). Returns the time the
 * redeploy was seen, or null when a boot (a gen issued since) has taken it.
 */
export function preBootSince(c: Ctx): number | null {
  const at = c.db.metaNum("redeployAt", 0);
  if (!at) return null;
  const ep = activeEpoch(c);
  const gen = ep ? currentGen(c, ep.n) : null;
  const issued =
    gen === null
      ? 0
      : (c.db.one<{ t: number | null }>("SELECT issued_at AS t FROM gens WHERE gen = ?", gen)?.t ?? 0);
  return issued >= at ? null : at;
}

/** A replica upload landed after the newest complete archive started (or there is no archive). */
export function archiveDirty(c: Ctx): boolean {
  const n = newestComplete(q(c));
  const w = lastWriteAt(q(c));
  return n === null ? true : w !== null && w > n.created_at;
}

/**
 * N8 gate for a stop that precedes a boot: the sleep op waits for an archive newer than the last write. Asks for one
 * (forced reason, so the 6 h cadence and the 15 min gap do not apply) when the next boot may be an archive-path
 * boot and the newest archive is behind the last write; at most one ask per minGapMs, so a gateway that keeps writing
 * cannot hold the sleep: the existing `archive-requested` hold ends at requestHoldMs; and at most one archive per
 * redeploy. Returns true when it asked.
 */
export function ensurePreBootArchive(c: Ctx): boolean {
  const since = preBootSince(c);
  if (since === null || !archiveDirty(c)) return false;
  // One pre-boot archive per redeploy. The gateway keeps writing, so "dirty" never clears while awake; the sleep
  // op's own N8 gate takes the archive that matters before a boot (M8 live: a 200 MB archive every 15 min).
  const n = newestComplete(q(c));
  if (n && n.created_at >= since) return false;
  const last = c.db.metaNum("preBootReqAt", 0);
  if (c.now() - last < cfgOf(c).minGapMs) return false;
  const cur = c.db.metaJson<ArchiveRequest | null>("archiveRequest", null);
  if (cur && (cur.state === "pending" || cur.state === "running")) return false;
  c.db.setMeta("preBootReqAt", c.now());
  requestArchive(c, "pre-upgrade");
  ring(c, "archive", "pre-boot", { why: "redeploy since the last boot" });
  return true;
}

/** Owner or upgrade path asks for an archive now (served by ocsup's next archive poll, ≤ 5 min awake). */
export function requestArchive(c: Ctx, reason: string): ArchiveRequest {
  const cur = c.db.metaJson<ArchiveRequest | null>("archiveRequest", null);
  if (
    cur &&
    (cur.state === "pending" || cur.state === "running") &&
    c.now() - cur.at < cfgOf(c).requestHoldMs
  )
    return cur;
  const r: ArchiveRequest = {
    id: `req-${c.now()}`,
    reason,
    at: c.now(),
    state: "pending",
    step: "requested",
    progressAt: c.now(),
  };
  c.db.setMeta("archiveRequest", r);
  ring(c, "archive", "request", r);
  return r;
}

/** When the live request stalls (alarm candidate), or null. */
export function archiveStallAt(c: Ctx): number | null {
  return requestStallAt(c.db.metaJson<ArchiveRequest | null>("archiveRequest", null), cfgOf(c));
}

/**
 * A request with no progress (start, part) for stallMs is marked `failed` with the last step, rings
 * `archive stalled` and raises the `archive-stalled` alert. The `archive-requested` sleep hold ends with it, so
 * one stuck archive cannot keep an install awake (oc-demo 2026-11-05: 429 archive-cap held it for hours).
 * A later complete of the same archive still marks the request done.
 */
export function archiveStallCheck(c: Ctx): ArchiveRequest | null {
  const r = c.db.metaJson<ArchiveRequest | null>("archiveRequest", null);
  const at = requestStallAt(r, cfgOf(c));
  if (!r || at === null || c.now() < at) return null;
  const attemptAt = c.db.metaNum("archiveAttemptAt", 0);
  const step =
    r.step && r.step !== "requested"
      ? r.step
      : attemptAt > r.at
        ? "start attempted, not opened"
        : "requested, no start from ocsup";
  const idleMin = Math.round((c.now() - (r.progressAt ?? r.at)) / 60_000);
  const out: ArchiveRequest = { ...r, state: "failed", why: `stalled: ${step}`, doneAt: c.now(), step };
  c.db.setMeta("archiveRequest", out);
  ring(c, "archive", "stalled", {
    id: r.id,
    reason: r.reason,
    step,
    archiveId: r.archiveId ?? null,
    idleMin,
  });
  alert(
    c,
    "archive-stalled",
    "warn",
    `${r.reason} archive ${r.id}: no progress in ${idleMin} min; last step: ${step}`.slice(0, 300),
  );
  return out;
}

// ---------------------------------------------------------------- read-back verify

/** Stream an archive from R2 and compare size and sha256 with the index. */
export async function readBack(
  bucket: ArchiveBucket,
  a: { key: string; sha256: string | null; size: number | null },
): Promise<{ ok: boolean; why?: string; bytes: number; missing?: boolean }> {
  const o = await bucket.get(a.key);
  if (!o) return { ok: false, why: "r2 object missing", bytes: 0, missing: true };
  if (a.size !== null && o.size !== a.size) {
    await o.body.cancel().catch(() => {});
    return { ok: false, why: `size ${o.size} != ${a.size}`, bytes: o.size };
  }
  let st = shaInit();
  let n = 0;
  const rd = o.body.getReader();
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    st = shaUpdate(st, value);
    n += value.length;
  }
  const sha = shaDigest(st);
  if (a.sha256 && sha !== a.sha256)
    return { ok: false, why: `sha ${sha.slice(0, 16)} != ${a.sha256.slice(0, 16)}`, bytes: n };
  return { ok: true, bytes: n };
}

/** Daily: read back the newest complete archive that has no verify yet (GC needs a newer verified copy). */
export async function verifyNewest(
  c: Ctx,
  l: GateLedger,
): Promise<{ id: string; ok: boolean; why?: string } | null> {
  const a = c.db.one<ArchiveIdx>(
    "SELECT * FROM archives WHERE state = 'complete' ORDER BY created_at DESC, id DESC LIMIT 1",
  );
  if (!a || a.verified_at !== null || (a.size ?? 0) > VERIFY_MAX_BYTES) return null;
  const r = await readBack(c.bucket as unknown as ArchiveBucket, a);
  l.archiveVerify(a.id, r.ok, "readback", r.why);
  return { id: a.id, ok: r.ok, why: r.why };
}

// ---------------------------------------------------------------- GC

export interface ArchiveGcPlan {
  keep: { id: string; why: string[] }[];
  delete: string[];
  abortUploads: { uploadId: string; key: string }[];
  /** Rows to drop from the index (aborted long ago). */
  dropRows: string[];
  newestVerified: string | null;
}

/**
 * Archive GC plan (plan §6.3 "by the retention rule, create-before-delete"). A complete archive is deleted only
 * when it is outside every keep rule AND a verified archive newer than it exists, so the last verified copy is
 * never deleted and a delete never runs before its replacement is verified.
 */
export function planArchiveGc(c: Ctx): ArchiveGcPlan {
  const now = c.now();
  const rows = c.db.all<ArchiveIdx>("SELECT * FROM archives ORDER BY created_at DESC, id DESC");
  const done = rows.filter((a) => a.state === "complete");
  const why = new Map<string, string[]>();
  const keep = (id: string | null | undefined, w: string) => {
    if (!id) return;
    why.set(id, [...(why.get(id) ?? []), w]);
  };
  const newestVerified = done.find((a) => a.verified_at !== null) ?? null;
  keep(newestVerified?.id, "newest-verified");
  for (const a of done.slice(0, KEEP_NEWEST)) keep(a.id, "newest");
  const days = new Set<string>();
  const weeks = new Set<number>();
  for (const a of done) {
    if (a.created_at >= now - KEEP_DAILY_DAYS * DAY) {
      const d = utcDay(a.created_at);
      if (!days.has(d)) {
        days.add(d);
        keep(a.id, "daily");
      }
    }
    if (a.created_at >= now - KEEP_WEEKS * 7 * DAY) {
      const w = Math.floor(a.created_at / (7 * DAY));
      if (!weeks.has(w)) {
        weeks.add(w);
        keep(a.id, "weekly");
      }
    }
    if ((a.reason === "pre-upgrade" || a.reason === "post-rollback") && a.created_at >= now - KEEP_UPGRADE_MS)
      keep(a.id, a.reason);
  }
  // In use: the plan of each live gen, the L5 source, a running request.
  for (const g of c.db.all<{ plan: string }>(
    "SELECT plan FROM gens WHERE state IN ('booting', 'complete', 'verified') ORDER BY gen DESC LIMIT 20",
  )) {
    const p = pj<{ archive?: { archiveId?: string } | null; sqlite?: { archiveId?: string } }>(g.plan, {});
    keep(p.archive?.archiveId, "plan");
    keep(p.sqlite?.archiveId, "plan");
  }
  const l5 = c.db.metaJson<{ source?: string } | null>("l5", null);
  if (l5?.source?.startsWith("archive:")) keep(l5.source.slice(8), "l5");
  const req = c.db.metaJson<ArchiveRequest | null>("archiveRequest", null);
  if (req?.archiveId) keep(req.archiveId, "request");

  const del: string[] = [];
  for (const a of done) {
    if (why.has(a.id)) continue;
    // create-before-delete: a newer verified copy must exist.
    if (!newestVerified || newestVerified.created_at <= a.created_at) continue;
    del.push(a.id);
  }
  for (const a of rows)
    if (a.state === "bad" && a.created_at < now - BAD_KEEP_MS && newestVerified) del.push(a.id);
  const abortUploads = c.db
    .all<{ upload_id: string; key: string }>(
      "SELECT upload_id, key FROM multipart WHERE kind = 'archive' AND created_at < ?",
      now - MULTIPART_MAX_MS,
    )
    .map((m) => ({ uploadId: m.upload_id, key: m.key }));
  const dropRows = rows
    .filter((a) => (a.state === "aborted" || a.state === "deleted") && a.created_at < now - 30 * DAY)
    .map((a) => a.id);
  return {
    keep: [...why.entries()].map(([id, w]) => ({ id, why: w })),
    delete: del,
    abortUploads,
    dropRows,
    newestVerified: newestVerified?.id ?? null,
  };
}

export async function runArchiveGc(
  c: Ctx,
  o: { dryRun?: boolean } = {},
): Promise<{
  ok: boolean;
  deleted: string[];
  aborted: number;
  dropped: number;
  plan: ArchiveGcPlan;
  error?: string;
}> {
  const plan = planArchiveGc(c);
  if (o.dryRun) return { ok: true, deleted: [], aborted: 0, dropped: 0, plan };
  const b = c.bucket as unknown as ArchiveBucket;
  let aborted = 0;
  for (const u of plan.abortUploads) {
    try {
      await b.resumeMultipartUpload?.(u.key, u.uploadId).abort();
    } catch {
      // NoSuchUpload: already gone
    }
    c.db.run("DELETE FROM multipart WHERE upload_id = ?", u.uploadId);
    c.db.run(
      "UPDATE archives SET state = 'aborted', completed_at = COALESCE(completed_at, ?) WHERE upload_id = ? AND state = 'open'",
      c.now(),
      u.uploadId,
    );
    aborted++;
  }
  const deleted: string[] = [];
  for (const id of plan.delete.slice(0, ARCHIVE_GC_MAX)) {
    const a = c.db.one<ArchiveIdx>("SELECT * FROM archives WHERE id = ?", id);
    if (!a) continue;
    try {
      await b.delete(a.key);
      await Promise.resolve(b.delete(sidecarKey(a.key))).catch(() => undefined); // drill J sidecar
    } catch (e) {
      ring(c, "archive-gc", "failed", { id, error: String(e).slice(0, 200) });
      return { ok: false, deleted, aborted, dropped: 0, plan, error: "r2" };
    }
    c.db.run("UPDATE archives SET state = 'deleted', deleted_at = ? WHERE id = ?", c.now(), id);
    deleted.push(id);
  }
  for (const id of plan.dropRows) c.db.run("DELETE FROM archives WHERE id = ?", id);
  ring(c, "archive-gc", "done", { deleted, aborted, dropped: plan.dropRows.length });
  return { ok: true, deleted, aborted, dropped: plan.dropRows.length, plan };
}

// ---------------------------------------------------------------- drill

export interface DrillTarget {
  drillRestore(a: DrillArgs): Promise<DrillReport>;
}

export interface DrillRecord {
  at: number;
  ok: boolean;
  archiveId: string | null;
  instance: string | null;
  report: DrillReport | null;
  why?: string;
}

/** Restore the newest complete archive into a throw-away DO and record the result (plan §1 F1). */
export async function runDrill(
  c: Ctx,
  l: GateLedger,
  target: ((name: string) => DrillTarget) | undefined,
  o: { archiveId?: string } = {},
): Promise<DrillRecord> {
  const at = c.now();
  const a = o.archiveId
    ? c.db.one<ArchiveIdx>("SELECT * FROM archives WHERE id = ? AND state = 'complete'", o.archiveId)
    : c.db.one<ArchiveIdx>(
        "SELECT * FROM archives WHERE state = 'complete' ORDER BY created_at DESC, id DESC LIMIT 1",
      );
  const rec = (x: Omit<DrillRecord, "at">): DrillRecord => {
    const r = { at, ...x };
    c.db.setMeta("drillLast", {
      ...r,
      report: r.report ? { ...r.report, dbs: r.report.dbs.slice(0, 20) } : null,
    });
    ring(c, "drill", r.ok ? "ok" : "failed", {
      archiveId: r.archiveId,
      why: r.why ?? r.report?.why,
      files: r.report?.files,
      ws: r.report?.workspaceFiles,
      dbs: r.report?.dbs.length,
      ms: r.report?.ms,
    });
    if (!r.ok)
      alert(
        c,
        "drill-failed",
        "high",
        `${r.archiveId ?? "-"}: ${(r.why ?? r.report?.why.join("; ") ?? "").slice(0, 200)}`,
      );
    return r;
  };
  if (!a)
    return rec({ ok: false, archiveId: null, instance: null, report: null, why: "no complete archive" });
  if (!target)
    return rec({ ok: false, archiveId: a.id, instance: null, report: null, why: "no drill target" });
  const instance = `drill:${c.inst}:${at}`;
  let report: DrillReport;
  try {
    report = await target(instance).drillRestore({
      archiveId: a.id,
      key: a.key,
      sha256: a.sha256,
      size: a.size,
      wsEntries: a.ws_entries,
    });
  } catch (e) {
    return rec({
      ok: false,
      archiveId: a.id,
      instance,
      report: null,
      why: `rpc: ${String(e).slice(0, 200)}`,
    });
  }
  // A sha/size/missing failure means the R2 copy is bad → the plan must skip it. Other failures alert only.
  const copyBad =
    !report.shaOk || !report.sizeOk || report.why.some((w) => w.startsWith("r2 object missing"));
  if (report.ok) l.archiveVerify(a.id, true, "drill");
  else if (copyBad) l.archiveVerify(a.id, false, "drill", report.why.join("; "));
  return rec({ ok: report.ok, archiveId: a.id, instance, report });
}

export function drillDue(c: Ctx): boolean {
  const last = c.db.metaJson<DrillRecord | null>("drillLast", null);
  const tried = c.db.metaNum("drillTriedAt", 0);
  if (c.now() - tried < DAY) return false; // at most one try per day
  if (!c.db.one("SELECT id FROM archives WHERE state = 'complete' LIMIT 1")) return false;
  return !last || c.now() - last.at >= cfgOf(c).drillEveryMs || (!last.ok && c.now() - last.at >= DAY);
}

// ---------------------------------------------------------------- status

export function archiveStatus(c: Ctx, limit = 20): Record<string, unknown> {
  const cfg = cfgOf(c);
  const due = archiveDue(q(c), c.now(), cfg);
  const newest = c.db.one<ArchiveIdx>(
    "SELECT * FROM archives WHERE state = 'complete' ORDER BY created_at DESC, id DESC LIMIT 1",
  );
  return {
    due,
    newestAgeMs: newest ? c.now() - newest.created_at : null,
    request: c.db.metaJson<ArchiveRequest | null>("archiveRequest", null),
    drill: c.db.metaJson<DrillRecord | null>("drillLast", null),
    attemptAt: c.db.metaNum("archiveAttemptAt", 0) || null,
    cfg,
    archives: c.db.all<ArchiveIdx>(
      `SELECT id, key, kind, state, reason, sha256, size, digest, gen, created_at, completed_at, verified_at,
         verified_by, ws_entries, ws_missing, bad_reason FROM archives ORDER BY created_at DESC, id DESC LIMIT ?`,
      Math.min(200, Math.max(1, limit)),
    ),
  };
}

/**
 * GET /ops/archive/can-run (dogfood row 14): can a requested archive run within `withinMs`? Only a running
 * container takes one. yes: awake or waking (running, starting, draining, quiescing), asleep or new (a wake
 * starts it), backoff or waiting-capacity whose ladder nextStartAt is inside `withinMs`. no: no active epoch,
 * stopped, stopping, retired, restore-blocked (the boot plan refuses every start), backoff past `withinMs`.
 */
export function archiveCanRun(
  c: Ctx,
  rt: {
    state: string;
    desired?: string;
    ladder?: { nextStartAt?: number; lastClass?: string | null };
    [k: string]: unknown;
  } | null,
  withinMs: number,
): {
  canRun: boolean;
  state: string;
  why: string;
  nextStartAt: number | null;
  newestAgeMs: number | null;
} {
  const newest = c.db.one<{ created_at: number }>(
    "SELECT created_at FROM archives WHERE state = 'complete' ORDER BY created_at DESC LIMIT 1",
  );
  const newestAgeMs = newest ? c.now() - newest.created_at : null;
  const base = { newestAgeMs, nextStartAt: rt?.ladder?.nextStartAt ?? null };
  if (!rt) return { canRun: false, state: "none", why: "no active epoch", ...base };
  const st = rt.state;
  const cls = rt.ladder?.lastClass ?? "";
  if (cls.startsWith("restore-blocked") && !["running", "maintenance"].includes(st))
    return { canRun: false, state: cls, why: "every boot is refused until the owner acts", ...base };
  if (["running", "maintenance", "starting", "draining", "quiescing", "asleep-unconfirmed"].includes(st))
    return { canRun: true, state: st, why: "container up or starting", ...base };
  if (st === "asleep" || st === "new") return { canRun: true, state: st, why: "a wake starts it", ...base };
  if (st === "backoff" || st === "waiting-capacity") {
    if (rt.desired === "stopped" || rt.desired === "retired")
      return { canRun: false, state: st, why: `desired ${rt.desired}`, ...base };
    const left = (base.nextStartAt ?? 0) - c.now();
    return left <= withinMs
      ? { canRun: true, state: st, why: "the ladder starts it in time", ...base }
      : { canRun: false, state: st, why: `next start in ${Math.round(left / 60_000)} min`, ...base };
  }
  return { canRun: false, state: st, why: "no container and no wake path", ...base };
}
