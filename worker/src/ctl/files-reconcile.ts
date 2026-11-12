// Files reconcile (1.2.4, docs/11 §8). The ledger table files_obj only knows writes that went through the gate. An
// owner tool can write f/<inst>/ straight to R2 (for example rclone with an R2 token). This step lists f/<inst>/ with
// the R2 binding, page by page, and fixes files_obj (add, resize, remove), so the cap and `ochost caps` match R2.
// Callers: the Control DO alarm while the install is awake, at most once per timers.filesReconcileMs; `ochost doctor`
// (fresh); POST /ops/files/reconcile. One step lists at most maxPages pages of 1000. A pass that needs more keeps
// its cursor in meta `filesReconcile` and goes on at the next step. Removal happens only at the end of a full pass.
import { filesPrefix } from "../core/contract";
import type { GateLedger } from "../gates/ledger";
import { FILES_PROBE } from "../gates/replica";
import { type Ctx, ring } from "./ctx";

export const RECONCILE_PAGE = 1000;
/** Pages per alarm or doctor step: 5 list calls, up to 5000 objects. */
export const RECONCILE_STEP_PAGES = 5;
/** Pages per POST /ops/files/reconcile call. */
export const RECONCILE_OP_PAGES = 20;
/** A pass older than this starts again: its cursor may no longer be valid. guess: R2 does not document a TTL. */
export const RECONCILE_PASS_MAX_MS = 6 * 3_600_000;

const META_PASS = "filesReconcile";
const META_LAST = "filesReconcileLast";

interface PassState {
  /** Start of the pass (ms); files_obj.seen gets this value. */
  pass: number;
  cursor: string | null;
  objects: number;
  added: number;
  resized: number;
}
/** The last full pass. */
export interface ReconcileLast {
  at: number;
  objects: number;
  added: number;
  resized: number;
  removed: number;
}
export interface ReconcileOut {
  /** false: not due (alarm) or no ledger. */
  ran: boolean;
  /** true: the pass reached the end of the list in this step. */
  done: boolean;
  pages: number;
  objects: number;
  added: number;
  resized: number;
  removed: number;
  error?: string;
}

const NONE: ReconcileOut = {
  ran: false,
  done: false,
  pages: 0,
  objects: 0,
  added: 0,
  resized: 0,
  removed: 0,
};

export function reconcileLast(c: Ctx): ReconcileLast | null {
  return c.db.metaJson<ReconcileLast | null>(META_LAST, null);
}
export function reconcileOpen(c: Ctx): boolean {
  return c.db.metaJson<PassState | null>(META_PASS, null) !== null;
}
/** Alarm rule: a pass is open, or the last full pass is older than timers.filesReconcileMs. */
export function reconcileDue(c: Ctx): boolean {
  if (reconcileOpen(c)) return true;
  const last = reconcileLast(c);
  return !last || c.now() - last.at >= c.timers.filesReconcileMs;
}

/**
 * One bounded step: go on with the open pass, or start one. Never throws. An R2 list error ends the step; an open
 * pass with a cursor is then dropped (the cursor may be the cause), so the next step starts from the top.
 */
export async function filesReconcileStep(
  c: Ctx,
  ledger: GateLedger,
  o: { maxPages?: number } = {},
): Promise<ReconcileOut> {
  const max = Math.max(1, o.maxPages ?? RECONCILE_STEP_PAGES);
  const prefix = filesPrefix(c.inst);
  let st = c.db.metaJson<PassState | null>(META_PASS, null);
  if (st && c.now() - st.pass > RECONCILE_PASS_MAX_MS) {
    ring(c, "files", "reconcile-restart", { pass: st.pass });
    st = null;
  }
  if (!st) st = { pass: c.now(), cursor: null, objects: 0, added: 0, resized: 0 };
  const out: ReconcileOut = { ...NONE, ran: true };
  try {
    while (out.pages < max) {
      const listAt = c.now();
      let l: Awaited<ReturnType<Ctx["bucket"]["list"]>>;
      try {
        l = await c.bucket.list({
          prefix,
          limit: RECONCILE_PAGE,
          ...(st.cursor ? { cursor: st.cursor } : {}),
        });
      } catch (e) {
        // A stale cursor fails the list: drop the pass so the next step starts from the top.
        if (st.cursor) c.db.delMeta(META_PASS);
        throw e;
      }
      out.pages++;
      const objs = l.objects
        .filter((x) => x.key.startsWith(prefix) && x.key !== `${prefix}${FILES_PROBE}`)
        .map((x) => ({ key: x.key, bytes: x.size }));
      const r = ledger.filesReconcilePage(st.pass, listAt, objs);
      out.objects += objs.length;
      out.added += r.added;
      out.resized += r.resized;
      st = {
        ...st,
        cursor: l.truncated && l.cursor ? l.cursor : null,
        objects: st.objects + objs.length,
        added: st.added + r.added,
        resized: st.resized + r.resized,
      };
      if (!st.cursor) {
        const end = ledger.filesReconcileEnd(st.pass);
        out.removed = end.removed;
        out.done = true;
        const last: ReconcileLast = {
          at: c.now(),
          objects: st.objects,
          added: st.added,
          resized: st.resized,
          removed: end.removed,
        };
        c.db.delMeta(META_PASS);
        c.db.setMeta(META_LAST, last);
        if (last.added || last.resized || last.removed) ring(c, "files", "reconcile", last);
        return out;
      }
      c.db.setMeta(META_PASS, st);
    }
    return out;
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 200);
    ring(c, "files", "reconcile-error", error);
    return { ...out, error };
  }
}
