// SoakPlan runner (test installs only, OC_TEST=1). The Control DO alarm calls soakTick: it runs the active
// plan one step at a time through the step handlers (steps.ts), records each result in DO SQLite and copies it
// to R2 `results/<plan>/<step>.json` plus `results/<plan>/summary.json`. The routes (opsSoak) queue, list,
// stop and read plans. Nothing here runs when `c.test` is false.

import type { OpsReq, OpsRes } from "../control";
import type { Ctx } from "../ctx";
import type { Db } from "../sql";
import { type SoakPort, type StepCtx, type StepOut, sh } from "./lib";
import { catalog, PLANS, planByName } from "./plans";
import { procPat } from "./scripts";
import { HANDLERS, timeoutOf } from "./steps";
import {
  activePlan,
  addPlan,
  dumpSoak,
  ensureSoak,
  loadSoak,
  nextStep,
  type PlanRow,
  planRow,
  planRows,
  resultsOf,
  type StepRow,
  savePhase,
  stepRows,
} from "./store";
import type { Measure, PlanView, SoakSummary, StepResult, StepSpec, SummaryItem } from "./types";

export const RESUME_KEY = "soak-resume/dump.json";
const resultKey = (plan: string, id: string) => `results/${plan}/${id}.json`;
const dirtyKey = (plan: string) => `soak:dirty:${plan}`;
const MAX_TRIES = 3;
const TICK_BUDGET_MS = 40_000;

const ready = new WeakSet<Db>();
function ensure(db: Db) {
  if (ready.has(db)) return;
  ensureSoak(db);
  ready.add(db);
}

export const inBound = (m: Measure): boolean =>
  (m.max === undefined || m.value <= m.max) && (m.min === undefined || m.value >= m.min);

// ---------------------------------------------------------------- summary

export function buildSummary(db: Db, plan: PlanRow, now: number): SoakSummary {
  const steps = stepRows(db, plan.name);
  const results = resultsOf(db, plan.name);
  const by = new Map<string, { bound: string; unit: string; vals: number[]; over: number }>();
  for (const r of results)
    for (const m of r.measures) {
      const e = by.get(m.item) ?? { bound: m.bound, unit: m.unit, vals: [], over: 0 };
      e.vals.push(m.value);
      if (!inBound(m)) e.over++;
      by.set(m.item, e);
    }
  const items: SummaryItem[] = [...by.entries()].map(([item, e]) => {
    const s = [...e.vals].sort((a, b) => a - b);
    return {
      item,
      bound: e.bound,
      unit: e.unit,
      n: s.length,
      p50: s.length ? (s[Math.floor(s.length / 2)] as number) : null,
      max: s.length ? (s[s.length - 1] as number) : null,
      over: e.over,
      pass: e.over === 0,
    };
  });
  const failed = results.filter((r) => !r.ok);
  const state = plan.state === "done" ? "done" : plan.state === "stopped" ? "stopped" : "running";
  const pass =
    state === "running" ? null : state === "done" && failed.length === 0 && items.every((i) => i.pass);
  return {
    plan: plan.name,
    state,
    startedAt: plan.started_at ?? plan.created_at,
    updatedAt: now,
    endedAt: plan.ended_at,
    total: steps.length,
    done: steps.filter((s) => s.state === "done").length,
    failed: failed.length,
    pass,
    items,
    failedSteps: failed.map((r) => ({
      id: r.id,
      checks: [
        ...Object.entries(r.checks)
          .filter(([, v]) => !v)
          .map(([k]) => k),
        ...r.measures.filter((m) => !inBound(m)).map((m) => `bound:${m.item}`),
        ...(r.error ? [`error:${r.error}`] : []),
      ],
    })),
    skipped: results.filter((r) => r.skipped).map((r) => ({ id: r.id, why: r.skipped as string })),
  };
}

// ---------------------------------------------------------------- R2 copy

/** Copy finished steps and dirty summaries to R2. Stops at the first failure (R2 down); the next tick retries. */
export async function flush(c: Ctx): Promise<void> {
  ensure(c.db);
  const db = c.db;
  const rows = db.all<{ plan: string; idx: number; id: string; result: string }>(
    "SELECT plan, idx, id, result FROM soak_step WHERE result IS NOT NULL AND r2_at IS NULL ORDER BY plan, idx LIMIT 50",
  );
  try {
    for (const r of rows) {
      await c.bucket.put(resultKey(r.plan, r.id), r.result);
      db.run("UPDATE soak_step SET r2_at = ? WHERE plan = ? AND idx = ?", c.now(), r.plan, r.idx);
    }
    const dirty = db.all<{ k: string }>("SELECT k FROM meta WHERE k LIKE 'soak:dirty:%'");
    for (const { k } of dirty) {
      const plan = planRow(db, k.slice("soak:dirty:".length));
      if (plan)
        await c.bucket.put(resultKey(plan.name, "summary"), JSON.stringify(buildSummary(db, plan, c.now())));
      db.delMeta(k);
    }
  } catch {
    // R2 down (the r2-down fault or a real outage): rows stay unflushed
  }
}

// ---------------------------------------------------------------- tick

export interface SoakHooks {
  /** Write the soak tables to R2 for a Control DO wipe. */
  dump(): Promise<void>;
}

const unflushed = (db: Db) =>
  (db.one<{ n: number }>("SELECT COUNT(*) AS n FROM soak_step WHERE result IS NOT NULL AND r2_at IS NULL")
    ?.n ?? 0) > 0 ||
  (db.one<{ n: number }>("SELECT COUNT(*) AS n FROM meta WHERE k LIKE 'soak:dirty:%'")?.n ?? 0) > 0;

/** Earliest time the soak runner has work (null = none). */
export function soakNextAt(c: Ctx): number | null {
  if (!c.test) return null;
  ensure(c.db);
  const plan = activePlan(c.db);
  const now = c.now();
  if (!plan) return unflushed(c.db) ? now + 30_000 : null;
  const step = nextStep(c.db, plan.name);
  if (!step) return now;
  if (step.state === "pending") return Math.max(now, step.not_before);
  return Math.max(now, step.next_at ?? now + 5000);
}

export async function soakTick(c: Ctx, port: SoakPort, hooks: SoakHooks): Promise<void> {
  if (!c.test) return;
  ensure(c.db);
  await flush(c);
  const t0 = c.now();
  for (let i = 0; i < 25 && c.now() - t0 < TICK_BUDGET_MS; i++) if (!(await advance(c, port, hooks))) break;
}

function endPlan(c: Ctx, plan: PlanRow, state: "done" | "stopped") {
  c.db.run("UPDATE soak_plan SET state = ?, ended_at = ? WHERE name = ?", state, c.now(), plan.name);
  c.db.setMeta(dirtyKey(plan.name), 1);
}

/** One unit of work. Returns true when the next call should run at once. */
async function advance(c: Ctx, port: SoakPort, hooks: SoakHooks): Promise<boolean> {
  const db = c.db;
  const plan = activePlan(db);
  if (!plan) {
    await giveBackSleep(c, port);
    await flush(c);
    return false;
  }
  const now = c.now();
  if (plan.state === "queued") {
    db.run("UPDATE soak_plan SET state = 'running', started_at = ? WHERE name = ?", now, plan.name);
    db.setMeta(dirtyKey(plan.name), 1);
    plan.state = "running";
    plan.started_at = now;
  }
  const step = nextStep(db, plan.name);
  if (!step) {
    endPlan(c, plan, "done");
    await flush(c);
    return true;
  }
  const spec = JSON.parse(step.spec) as StepSpec;
  if (step.state === "pending") {
    const prev =
      step.idx > 0
        ? db.one<{ ended_at: number | null }>(
            "SELECT ended_at FROM soak_step WHERE plan = ? AND idx = ?",
            plan.name,
            step.idx - 1,
          )
        : null;
    const notBefore = (prev?.ended_at ?? 0) + (spec.after ?? 0);
    if (spec.after && now < notBefore) {
      db.run(
        "UPDATE soak_step SET not_before = ? WHERE plan = ? AND idx = ?",
        notBefore,
        plan.name,
        step.idx,
      );
      return false;
    }
    db.run(
      "UPDATE soak_step SET state = 'running', started_at = ? WHERE plan = ? AND idx = ?",
      now,
      plan.name,
      step.idx,
    );
    step.state = "running";
    step.started_at = now;
  } else if (step.next_at && now < step.next_at) return false;

  const p = (spec.params ?? {}) as Record<string, any>;
  if (step.started_at && now - step.started_at > timeoutOf(spec.type, p)) {
    await finishStep(c, plan, step, spec, {
      done: true,
      error: "step-timeout",
      checks: { completed: false },
    });
    return true;
  }
  const handler = HANDLERS[spec.type];
  if (!handler) {
    await finishStep(c, plan, step, spec, {
      done: true,
      error: `unknown step type ${spec.type}`,
      checks: { known: false },
    });
    return true;
  }
  const d = JSON.parse(step.data) as Record<string, any>;
  const x: StepCtx = {
    port,
    plan,
    step,
    spec,
    p,
    d,
    phase: step.phase ?? "start",
    now,
    save: (phase) => savePhase(db, step, phase, d),
    dumpSoak: () => hooks.dump(),
  };
  let out: StepOut;
  try {
    out = await handler(x);
  } catch (e) {
    const tries = step.tries + 1;
    const msg = String((e as Error)?.message ?? e).slice(0, 200);
    if (tries >= MAX_TRIES) {
      await finishStep(c, plan, step, spec, { done: true, error: `handler: ${msg}`, checks: { ran: false } });
      return true;
    }
    db.run(
      "UPDATE soak_step SET tries = ?, next_at = ?, data = ? WHERE plan = ? AND idx = ?",
      tries,
      c.now() + 10_000,
      JSON.stringify(d),
      plan.name,
      step.idx,
    );
    return false;
  }
  if ("done" in out) {
    await finishStep(c, plan, step, spec, out);
    return true;
  }
  const phase = out.phase ?? x.phase;
  db.run(
    "UPDATE soak_step SET phase = ?, data = ?, next_at = ?, tries = 0 WHERE plan = ? AND idx = ?",
    phase,
    JSON.stringify(d),
    c.now() + out.wait,
    plan.name,
    step.idx,
  );
  return out.wait === 0;
}

async function finishStep(
  c: Ctx,
  plan: PlanRow,
  step: StepRow,
  spec: StepSpec,
  out: Extract<StepOut, { done: true }>,
): Promise<void> {
  const checks = out.checks ?? {};
  const measures = out.measures ?? [];
  const ok = !out.error && Object.values(checks).every(Boolean) && measures.every(inBound);
  const now = c.now();
  const res: StepResult = {
    plan: plan.name,
    id: step.id,
    idx: step.idx,
    type: spec.type,
    ok,
    checks,
    measures,
    data: out.data ?? {},
    startedAt: step.started_at ?? now,
    endedAt: now,
    ...(out.error ? { error: out.error } : {}),
    ...(out.skipped ? { skipped: out.skipped } : {}),
  };
  c.db.run(
    "UPDATE soak_step SET state = 'done', ended_at = ?, result = ?, r2_at = NULL, phase = NULL WHERE plan = ? AND idx = ?",
    now,
    JSON.stringify(res),
    plan.name,
    step.idx,
  );
  c.db.setMeta(dirtyKey(plan.name), 1);
  if (!nextStep(c.db, plan.name)) endPlan(c, plan, "done");
  await flush(c);
}

/** After the last plan: sleep.mode back to what it was before the first `awake` step. */
async function giveBackSleep(c: Ctx, port: SoakPort): Promise<void> {
  const was = c.db.meta("soak:sleepWas");
  if (!was) return;
  await port.ops("settings", "POST", { set: { "sleep.mode": was }, source: "soak" });
  c.db.delMeta("soak:sleepWas");
}

// ---------------------------------------------------------------- Control DO wipe: survive through R2

export async function dumpToR2(c: Ctx, port: SoakPort): Promise<void> {
  await port.rawBucket().put(RESUME_KEY, JSON.stringify(dumpSoak(c.db)));
}

/** Constructor, after a Control DO wipe: load the plan state `ctl-wipe` left in R2. Returns true when it did. */
export async function resumeSoak(
  c: Ctx,
  bucket: { get(k: string): Promise<{ text(): Promise<string> } | null>; delete(k: string): Promise<void> },
): Promise<boolean> {
  if (!c.test) return false;
  try {
    const o = await bucket.get(RESUME_KEY);
    if (!o) return false;
    loadSoak(c.db, JSON.parse(await o.text()));
    ready.add(c.db);
    await bucket.delete(RESUME_KEY);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- /ops/soak-plan

const view = (db: Db, p: PlanRow): PlanView => {
  const steps = stepRows(db, p.name);
  const cur = p.state === "running" ? nextStep(db, p.name) : null;
  const results = resultsOf(db, p.name);
  return {
    plan: p.name,
    ord: p.ord,
    state: p.state,
    startedAt: p.started_at,
    total: steps.length,
    done: steps.filter((s) => s.state === "done").length,
    failed: results.filter((r) => !r.ok).length,
    current: cur ? { id: cur.id, type: cur.type, phase: cur.phase, startedAt: cur.started_at } : null,
    nextAt: cur ? (cur.state === "pending" ? cur.not_before : cur.next_at) : null,
  };
};

async function clearR2(c: Ctx, plan: string): Promise<void> {
  try {
    for (let i = 0; i < 5; i++) {
      const r = await c.bucket.list({ prefix: `results/${plan}/`, limit: 500 });
      if (!r.objects.length) break;
      await c.bucket.delete(r.objects.map((o) => o.key));
      if (!r.truncated) break;
    }
  } catch {
    // best effort: stale files are overwritten by the new run
  }
}

/** Lift every fault a plan may have left (stop, and before a plan is replaced). Best effort. */
async function cleanup(port: SoakPort): Promise<void> {
  await port.ctlFault("r2-up").catch(() => undefined);
  await port.ctlFault("replica-unthrottle").catch(() => undefined);
  await port.rtFault("clear").catch(() => undefined);
  await sh(
    port,
    `pkill -f ${procPat("soak-writer.mjs")}; pkill -f ${procPat("soak-churn.mjs")}; rm -rf /home/node/soak-fill; echo ok`,
    30_000,
  ).catch(() => undefined);
}

export async function opsSoak(c: Ctx, port: SoakPort, r: OpsReq): Promise<OpsRes> {
  if (!c.test) return { status: 404, body: { error: "not found" } };
  ensure(c.db);
  const db = c.db;
  const sub = r.sub[0] ?? "";
  if (r.method === "GET" && sub === "") {
    return {
      status: 200,
      body: {
        now: c.now(),
        plans: planRows(db).map((p) => view(db, p)),
        catalog: PLANS.map((p) => ({ name: p.name, steps: p.build({}).length, about: p.about })),
      },
    };
  }
  if (r.method === "GET" && sub === "results")
    return { status: 200, body: { plans: await readResults(c, r.query.plan) } };
  if (sub !== "") return { status: 404, body: { error: "not found" } };
  if (r.method === "POST") {
    const want = String(r.body.plan ?? "");
    // `custom` with `steps`: an ad-hoc plan (test and local runs). Every step needs a safe id and a known type.
    if (want === "custom") {
      const steps = r.body.steps as StepSpec[] | undefined;
      const bad =
        !Array.isArray(steps) ||
        !steps.length ||
        steps.some((s) => !/^[a-z0-9._-]{1,60}$/.test(String(s?.id)) || !HANDLERS[String(s?.type)]);
      if (bad)
        return { status: 400, body: { error: "custom needs steps [{id, type, params?}] of known types" } };
      const e = planRow(db, "custom");
      if (e && (e.state === "queued" || e.state === "running"))
        return { status: 409, body: { error: "plan-active", plan: "custom", state: e.state } };
      await clearR2(c, "custom");
      db.run("DELETE FROM meta WHERE k = ?", dirtyKey("custom"));
      addPlan(
        db,
        "custom",
        Math.max(0, ...planRows(db).map((p) => p.ord)) + 1,
        {},
        steps as StepSpec[],
        c.now(),
      );
      return { status: 202, body: { ok: true, queued: ["custom"] } };
    }
    const names = want === "all" ? PLANS.filter((p) => p.all).map((p) => p.name) : [want];
    const defs = names.map((n) => planByName(n));
    if (!want || defs.some((d) => !d))
      return {
        status: 400,
        body: { error: `unknown plan ${want || "(none)"}`, plans: catalog().map((x) => x.name) },
      };
    for (const n of names) {
      const e = planRow(db, n);
      if (e && (e.state === "queued" || e.state === "running"))
        return { status: 409, body: { error: "plan-active", plan: n, state: e.state } };
    }
    const params = (r.body.params ?? {}) as Record<string, unknown>;
    const ord0 = Math.max(0, ...planRows(db).map((p) => p.ord)) + 1;
    let ord = ord0;
    for (const d of defs) {
      const plan = d as NonNullable<typeof d>;
      await clearR2(c, plan.name);
      db.run("DELETE FROM meta WHERE k = ?", dirtyKey(plan.name));
      addPlan(db, plan.name, ord++, params, plan.build(params), c.now());
    }
    return { status: 202, body: { ok: true, queued: names } };
  }
  if (r.method === "DELETE") {
    const only = r.query.plan;
    const stopped: string[] = [];
    for (const p of planRows(db))
      if ((p.state === "queued" || p.state === "running") && (!only || only === p.name)) {
        endPlan(c, p, "stopped");
        stopped.push(p.name);
      }
    await cleanup(port);
    await giveBackSleep(c, port);
    await flush(c);
    return { status: 200, body: { ok: true, stopped } };
  }
  return { status: 404, body: { error: "not found" } };
}

/** Results for the CLI report: R2 copy first (it survives a Control DO wipe), DO rows when R2 cannot be read. */
async function readResults(c: Ctx, only?: string) {
  const db = c.db;
  const out: { plan: string; summary: SoakSummary | null; steps: StepResult[] }[] = [];
  let names: string[] = [];
  try {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await c.bucket.list({ prefix: "results/", cursor, limit: 1000 });
      for (const o of r.objects) seen.add(o.key.split("/")[1] ?? "");
      if (!r.truncated) break;
      cursor = r.cursor;
    }
    names = [...seen].filter(Boolean);
  } catch {
    names = [];
  }
  for (const p of planRows(db)) if (!names.includes(p.name)) names.push(p.name);
  for (const name of names.filter((n) => !only || n === only)) {
    let summary: SoakSummary | null = null;
    let steps: StepResult[] = [];
    try {
      const l = await c.bucket.list({ prefix: `results/${name}/`, limit: 1000 });
      const objs = await Promise.all(l.objects.map((o) => c.bucket.get(o.key)));
      const docs = await Promise.all(objs.map((o) => (o ? o.text() : Promise.resolve(""))));
      for (const t of docs) {
        if (!t) continue;
        const j = JSON.parse(t);
        if (j.items && j.plan && !j.type) summary = j as SoakSummary;
        else steps.push(j as StepResult);
      }
      steps.sort((a, b) => a.idx - b.idx);
    } catch {
      steps = [];
    }
    const row = planRow(db, name);
    if (!steps.length && row) steps = resultsOf(db, name);
    if (row) summary = buildSummary(db, row, c.now());
    out.push({ plan: name, summary, steps });
  }
  return out;
}
