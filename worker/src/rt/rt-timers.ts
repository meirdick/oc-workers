// Runtime DO timers added in M4 (rt only; core/timers.ts holds the M2 set). Defaults are the real values.
// OC_TIMERS overrides them only when OC_TEST == "1" (same rule as timersFrom), so a live drill can run an
// hourly checkpoint every few minutes.

export interface RtTimers {
  /** A4: dirty-only checkpoint when an awake period (or the last checkpoint) is this old (plan §5.4 step 8). */
  checkpointMs: number;
  /** A4: checkpoints per UTC day before they stop (spec 08 §15.1: stops at 30). */
  checkpointsPerDay: number;
  /** A4: snapshot timeout of a live checkpoint. */
  checkpointSnapshotMs: number;
  /** F12: start budget while this epoch's image never answered an exec (cold pull). M3 e2e: pulls 35-56 s. */
  coldStartTimeoutMs: number;
  /** WS bridge watch round (session check, 24 h cap, idle-close). */
  wsCheckMs: number;
  /** Plan §7: a bridged WS closes at most 24 h after the upgrade. */
  wsMaxAgeMs: number;
  /** Add §2.5 rule 2: `sleep.uiIdleMinutes` 15, `sleep.uiMaxMinutes` 60. */
  uiIdleMs: number;
  uiMaxMs: number;
}

const S = 1000;
const M = 60 * S;
export const DEFAULT_RT_TIMERS: RtTimers = Object.freeze({
  checkpointMs: 60 * M,
  checkpointsPerDay: 30,
  checkpointSnapshotMs: 300 * S,
  coldStartTimeoutMs: 300 * S,
  wsCheckMs: 15 * S,
  wsMaxAgeMs: 24 * 60 * M,
  uiIdleMs: 15 * M,
  uiMaxMs: 60 * M,
});

/** vitest and `preset: "test"` worlds: no extra cold budget; checkpoints and WS caps stay long so
 * tests that do not ask for them see none. */
export const TEST_RT_TIMERS: RtTimers = Object.freeze({
  ...DEFAULT_RT_TIMERS,
  coldStartTimeoutMs: 1 * S, // = TEST startTimeoutMs: tests that do not ask see no cold budget
  checkpointSnapshotMs: 5 * S,
  wsCheckMs: 100,
});

/** Effective rt timers from the Worker env (OC_TIMERS only under OC_TEST=1). */
export function rtTimersFrom(env: { OC_TEST?: string; OC_TIMERS?: string }): RtTimers {
  if (env.OC_TEST !== "1") return { ...DEFAULT_RT_TIMERS };
  let over: Record<string, unknown> = {};
  try {
    over = env.OC_TIMERS ? (JSON.parse(env.OC_TIMERS) as Record<string, unknown>) : {};
  } catch {
    over = {};
  }
  const base: RtTimers = over.preset === "test" ? { ...TEST_RT_TIMERS } : { ...DEFAULT_RT_TIMERS };
  for (const [k, v] of Object.entries(over))
    if (k in base && typeof v === "number" && Number.isFinite(v) && v >= 0)
      (base as unknown as Record<string, number>)[k] = v;
  return base;
}
