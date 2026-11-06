// SoakPlan wire and storage shapes (docs/17-soak-engine.md). Test installs only (OC_TEST=1).
// R2 layout: results/<plan>/<step>.json (StepResult), results/<plan>/summary.json (SoakSummary).

/** One measured value with its bound. `item` is the report row (e.g. "sqlite-loss"); many steps feed one item. */
export interface Measure {
  item: string;
  name: string;
  value: number;
  unit: string;
  /** Pass when value ≤ max (and ≥ min when set). */
  max?: number;
  min?: number;
  /** Bound in words for the report, e.g. "≤ 3 s per kill". */
  bound: string;
}

export interface StepResult {
  plan: string;
  id: string;
  idx: number;
  type: string;
  ok: boolean;
  /** Assertions computed in the Worker from ring events, tables and R2. */
  checks: Record<string, boolean>;
  measures: Measure[];
  /** Facts behind the checks (times, ids, counts). No secrets. */
  data: Record<string, unknown>;
  startedAt: number;
  endedAt: number;
  error?: string;
  /** Set when the step cannot run on this install; the report lists it as not run. */
  skipped?: string;
}

export interface SummaryItem {
  item: string;
  bound: string;
  unit: string;
  n: number;
  p50: number | null;
  max: number | null;
  over: number;
  pass: boolean;
}

export interface SoakSummary {
  plan: string;
  state: "running" | "done" | "stopped";
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  total: number;
  done: number;
  failed: number;
  /** null while steps are left; false when any step failed or any item is over its bound. */
  pass: boolean | null;
  items: SummaryItem[];
  failedSteps: { id: string; checks: string[] }[];
  skipped: { id: string; why: string }[];
}

/** One step as stored in the plan. `type` selects the state machine in steps.ts. */
export interface StepSpec {
  id: string;
  type: string;
  /** Do not start before this many ms after the previous step ended. */
  after?: number;
  params?: Record<string, unknown>;
}

export interface PlanView {
  plan: string;
  ord: number;
  state: "queued" | "running" | "done" | "stopped";
  startedAt: number | null;
  total: number;
  done: number;
  failed: number;
  current: { id: string; type: string; phase: string | null; startedAt: number | null } | null;
  /** Earliest time the runner acts again. */
  nextAt: number | null;
}
