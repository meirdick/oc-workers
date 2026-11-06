// M4 fix A1 (M3 live A): an orphan cron_jobs row (a Doctor staged copy left a row with store_key
// /var/lib/ocrt/stage-u/cron/jobs.json and a past nextRunAtMs) made nextWakeAtMs past, so no job ever
// pre-woke the install. ocsup reconciles the rows against the gateway's own job list (`cron.list`, the data
// behind `openclaw cron status/list`) at each gateway start (boot, wake) and after each aborted sleep.
// Orphan = a row the gateway does not list AND whose store_key is not the live store; or any row under
// /var/lib/ocrt/ (ocsup staging, never live). Each orphan is deleted (ocio cron-fix) and logged.

export const STAGING_PREFIX = "/var/lib/ocrt/";

/** Job ids from a cron.list answer. guess on the shape: {jobs:[{id|jobId}]} or an array; null = unknown. */
export function liveJobIds(answer) {
  const a = answer?.result ?? answer;
  const list = Array.isArray(a)
    ? a
    : Array.isArray(a?.jobs)
      ? a.jobs
      : Array.isArray(a?.items)
        ? a.items
        : null;
  if (!list) return null;
  return new Set(list.map((j) => String(j?.id ?? j?.jobId ?? j?.job_id ?? "")).filter(Boolean));
}

/** rows: [{store_key, job_id}]. live: Set of ids or null (gateway list unknown). liveKey: live store path. */
export function orphansOf(rows, live, liveKey) {
  const out = [];
  for (const r of rows || []) {
    const k = String(r.store_key ?? "");
    const id = String(r.job_id ?? "");
    if (!id || k === liveKey) continue;
    if (k.startsWith(STAGING_PREFIX)) out.push({ store_key: k, job_id: id, why: "staging" });
    else if (live && !live.has(id)) out.push({ store_key: k, job_id: id, why: "not-listed" });
  }
  return out;
}

/**
 * deps: readRows() → [{store_key, job_id}] | null; listLive() → answer | null; del(rows) → {ok, deleted};
 * liveKey; log(ev, o); alert(class, severity, detail). Returns {ok, orphans, deleted, why?}. Never throws.
 */
export async function reconcileCron(why, deps) {
  try {
    const rows = await deps.readRows();
    if (!rows) return { ok: false, why: "read-failed", orphans: 0, deleted: 0 };
    let live = null;
    try {
      live = liveJobIds(await deps.listLive());
    } catch {
      live = null;
    }
    const orphans = orphansOf(rows, live, deps.liveKey);
    if (!orphans.length) {
      deps.log?.("cron-reconcile", { why, rows: rows.length, live: live ? live.size : null, orphans: 0 });
      return { ok: true, orphans: 0, deleted: 0, live: live ? live.size : null };
    }
    const r = await deps.del(orphans.map(({ store_key, job_id }) => ({ store_key, job_id })));
    const deleted = r?.ok ? Number(r.deleted) || 0 : 0;
    deps.log?.("cron-orphan-deleted", {
      level: r?.ok ? "warn" : "error",
      why,
      orphans: orphans.map((o) => `${o.job_id}@${o.store_key}:${o.why}`).slice(0, 20),
      deleted,
      err: r?.ok ? null : (r?.error ?? "delete failed"),
    });
    // Routine cleanup at every gateway start: the log line above is the record, not an alert (M8 live, 6 per day).
    return { ok: !!r?.ok, orphans: orphans.length, deleted, live: live ? live.size : null };
  } catch (e) {
    deps.log?.("cron-reconcile-error", { why, err: String(e?.message || e).slice(0, 200) });
    return { ok: false, why: "error", orphans: 0, deleted: 0 };
  }
}
