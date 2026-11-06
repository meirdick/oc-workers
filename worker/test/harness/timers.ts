// Test column of spec §20, written down from the spec (not imported from src/core/timers.ts) so
// test/timers-spec.test.ts catches a drift between the spec and the module. The world sends
// OC_TIMERS {preset:"test"} and uses the module's values.
export const S = 1000;
export const MIN = 60 * S;
export const H = 60 * MIN;

export const TEST_TIMERS = {
  reconcileMs: 1 * S,
  opTickMs: 100,
  hbMs: 1 * S,
  fenceMs: 5 * S,
  startGateMs: 5 * S,
  hbLostMs: 6 * S,
  unconfirmedWaitMs: 7 * S,
  drainCapMs: 30 * S,
  inactivityMs: 6 * H,
  destroyTimeoutMs: 1 * S,
  settleCapMs: 2 * S,
  inspectTimeoutMs: 1 * S,
  startTimeoutMs: 1 * S,
  execTimeoutMs: 1 * S,
  idleMs: 2 * S,
  cronTailMs: 1 * S,
  minAwakeMs: 1 * S,
  minSleepMs: 5 * S,
  leadMs: 1 * S,
  maintEveryMs: 60 * S,
  heldMaxMs: 40 * S,
  inboxDeadMs: 30 * S,
  inboxKeepMs: 40 * S,
  capacityFastMs: 100,
  capacitySlowMs: 500,
  capacityFastForMs: 2 * S,
  ladderResetMs: 5 * S,
  l2WindowMs: 15 * S,
  slowMs: 15 * S,
  l5PendingMs: 60 * S,
  snapshotRetryCapMs: 200,
  finalSnapshotMs: 2 * S,
  budgetScale: 0.1,
} as const;

/** Real values (spec §20 default column) for the timers test values do not shorten. */
export const REAL = { inactivityMs: 6 * H, unconfirmedWaitMs: 200 * S, hbLostMs: 180 * S } as const;
