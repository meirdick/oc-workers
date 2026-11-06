// Gen GC (spec §13.4, add §2.8, plan §6.3). Daily, fails closed. Create-before-delete: a gen is deleted only when
// a newer gen is `verified` (or, with none verified yet, `complete`), so a restorable gen always exists first.
import { type Ctx, DAY, ring, utcDay } from "./ctx";
import type { GenRow } from "./gens";
import { finishOp, openOp, setPhase } from "./journal";
import { pj } from "./sql";

export const GC_MAX_PER_RUN = 20; // guess (§13.4)

export interface GcPlan {
  keep: { gen: number; why: string[] }[];
  delete: number[];
}

/** Keep set and delete list (pure over the index). Throws on an index read error (caller fails closed). */
export function planGc(c: Ctx): GcPlan {
  const now = c.now();
  const gens = c.db.all<GenRow>("SELECT * FROM gens WHERE state != 'deleted' ORDER BY gen DESC");
  const why = new Map<number, string[]>();
  const keep = (g: number | null | undefined, w: string) => {
    if (g == null) return;
    why.set(g, [...(why.get(g) ?? []), w]);
  };
  const done = gens.filter((g) => g.state === "complete" || g.state === "verified");
  keep(gens.find((g) => g.state === "verified")?.gen, "newest-verified");
  for (const g of done.slice(0, 3)) keep(g.gen, "newest-3");
  const perDay = new Map<string, number>();
  for (const g of done) {
    const t = g.complete_at ?? g.issued_at;
    if (t < now - 7 * DAY) continue;
    const d = utcDay(t);
    if (!perDay.has(d)) perDay.set(d, g.gen);
  }
  for (const g of perDay.values()) keep(g, "daily");
  for (const g of gens) if ((g.pinned_until ?? 0) > now) keep(g.gen, "pinned");
  for (const e of c.db.all<{ n: number }>("SELECT n FROM epochs WHERE status != 'retired'")) {
    const cur = c.db.meta(`cur:${e.n}`);
    if (cur !== null) keep(Number(cur), "current");
  }
  for (const m of c.db.all<{ gen: number }>("SELECT gen FROM markers WHERE state IN ('pending', 'valid')"))
    keep(m.gen, "marker");
  // Live restoreGens: what the current boot of each non-retired epoch may read.
  for (const e of c.db.all<{ n: number }>("SELECT n FROM epochs WHERE status != 'retired'")) {
    const cg = c.db.meta(`cur:${e.n}`);
    if (cg === null) continue;
    const g = gens.find((x) => x.gen === Number(cg));
    if (g) for (const r of pj<number[]>(g.restore_gens, [])) keep(r, `restore-of-g${g.gen}`);
  }
  // Seeding: the marker gen stays the restore source (§14).
  for (const r of c.db.all<{ k: string }>("SELECT k FROM meta WHERE k LIKE 'seeding:%' AND v = '1'")) {
    const g = c.db.one<GenRow>("SELECT * FROM gens WHERE gen = ?", Number(r.k.slice(8)));
    for (const x of pj<number[]>(g?.restore_gens, [])) keep(x, "seeding-source");
  }

  // N7 / plan §6.3: create-before-delete anchors on the newest `verified` gen (a restore probe passed), so a gen
  // goes only when a newer verified copy exists. No gen verified yet (installs before N7): the newest complete.
  const newestDone = gens.find((g) => g.state === "verified")?.gen ?? done[0]?.gen ?? null;
  const del: number[] = [];
  for (const g of gens) {
    if (why.has(g.gen)) continue;
    if (g.state === "booting" || g.state === "abandoned") {
      // Never a restore source (§8.3 uses complete gens only); age rule alone.
      if (g.issued_at < now - c.timers.genAbandonedMs) del.push(g.gen);
      continue;
    }
    // create-before-delete: a complete/verified/bad gen goes only below the anchor.
    if (newestDone === null || g.gen >= newestDone) continue;
    const lastWrite =
      c.db.one<{ m: number | null }>("SELECT MAX(last_write_at) AS m FROM gendb WHERE gen = ?", g.gen)?.m ??
      g.complete_at ??
      g.issued_at;
    const sleepGen = g.reason.startsWith("wake:");
    if (lastWrite < now - c.timers.genStaleMs || sleepGen || g.state === "bad") del.push(g.gen);
  }
  return {
    keep: [...why.entries()].map(([gen, w]) => ({ gen, why: w })).sort((a, b) => b.gen - a.gen),
    delete: del.sort((a, b) => a - b),
  };
}

/** Run GC: list + batch delete `r/<inst>/g<k>/` for each gen, then mark the index. Op `gc` (§7.2). */
export async function runGc(
  c: Ctx,
  o: { dryRun?: boolean; opId?: string } = {},
): Promise<{
  ok: boolean;
  deleted: number[];
  plan?: GcPlan;
  error?: string;
  objects: number;
  more?: boolean;
}> {
  const opId = o.opId ?? `gc-${utcDay(c.now())}-${c.now()}`;
  openOp(c, opId, "gc", { dryRun: !!o.dryRun }, "list");
  let plan: GcPlan;
  try {
    plan = planGc(c);
  } catch (e) {
    finishOp(c, opId, "failed", undefined, `index: ${String(e).slice(0, 200)}`);
    return { ok: false, deleted: [], error: "index", objects: 0 };
  }
  setPhase(c, opId, "plan");
  if (o.dryRun) {
    finishOp(c, opId, "done", { dryRun: true, plan });
    return { ok: true, deleted: [], plan, objects: 0 };
  }
  setPhase(c, opId, "delete");
  const deleted: number[] = [];
  let objects = 0;
  for (const gen of plan.delete.slice(0, GC_MAX_PER_RUN)) {
    const prefix = `r/${c.inst}/g${gen}/`;
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const r = await c.bucket.list({ prefix, cursor, limit: 1000 });
        if (r.objects.length) {
          await c.bucket.delete(r.objects.map((x) => x.key));
          objects += r.objects.length;
        }
        if (!r.truncated) break;
        cursor = r.cursor;
      }
    } catch (e) {
      finishOp(c, opId, "failed", { deleted }, `r2 g${gen}: ${String(e).slice(0, 200)}`);
      ring(c, "gc", "failed", { gen, error: String(e).slice(0, 200) });
      return { ok: false, deleted, plan, error: "r2", objects };
    }
    c.db.tx(() => {
      c.db.run("UPDATE gendb SET state = 'deleted' WHERE gen = ?", gen);
      c.db.run("DELETE FROM ltx WHERE gen = ?", gen);
      c.db.run(
        "UPDATE gens SET state = 'deleted', ended_at = COALESCE(ended_at, ?) WHERE gen = ?",
        c.now(),
        gen,
      );
    });
    deleted.push(gen);
  }
  const more = plan.delete.length > GC_MAX_PER_RUN;
  // More than one run's worth: the alarm runs GC again soon (spec §13.4 caps a run, not a day).
  if (more) c.db.setMeta("gcMore", 1);
  else c.db.delMeta("gcMore");
  finishOp(c, opId, "done", { deleted, objects, more });
  ring(c, "gc", "done", { deleted, objects, more });
  return { ok: true, deleted, plan, objects, more };
}
