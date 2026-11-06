// All control-plane timers (spec 08 §20). Defaults are the real values. OC_TIMERS (JSON var) overrides
// any of them only when OC_TEST == "1". TEST holds the short values the vitest suite uses.

export interface Timers {
  reconcileMs: number;
  opTickMs: number;
  hbMs: number;
  fenceMs: number;
  startGateMs: number;
  hbLostMs: number;
  unconfirmedWaitMs: number;
  drainCapMs: number;
  inactivityMs: number;
  destroyTimeoutMs: number;
  settleCapMs: number;
  inspectTimeoutMs: number;
  startTimeoutMs: number;
  execTimeoutMs: number;
  /** Replay driver: one delivery to the gateway (§12.3); a hung POST must not stall the queue. */
  deliverTimeoutMs: number;
  /** Readiness probe interval (§8.6 "every 1 s"). */
  readyPollMs: number;
  /** Phase budgets by ocsup heartbeat phase (§8.6). */
  budgetBootMs: number;
  budgetRestoreSnapMs: number;
  budgetRestoreImageMs: number;
  budgetDoctorMs: number;
  budgetReplicaMs: number;
  budgetGatewayStartMs: number;
  idleMs: number;
  idleCapMs: number;
  cronTailMs: number;
  minAwakeMs: number;
  minSleepMs: number;
  leadMs: number;
  maintEveryMs: number;
  /** Rebase (add §2.8, ctl/chain.ts): due when the live chain root is older than this... */
  rebaseEveryMs: number;
  /** ...or the live chain has more snapshots than this (two registry tags each). */
  rebaseChainMax: number;
  /** Creds second copy `c/<inst>/<seq>.json` at most this often when changed (plan §6.1 row 2, drill L). */
  credsCopyMs: number;
  heldMaxMs: number;
  inboxDeadMs: number;
  inboxKeepMs: number;
  capacityFastMs: number;
  capacitySlowMs: number;
  capacityFastForMs: number;
  ladderResetMs: number;
  l2WindowMs: number;
  slowMs: number;
  l5PendingMs: number;
  snapshotRetryCapMs: number;
  finalSnapshotMs: number;
  /** Wait for an in-flight snapshot before a `final` one (§15.1). */
  finalWaitMs: number;
  /** sleep-stop-gateway cap (§10.2 phase 4). */
  stopGatewayCapMs: number;
  /** sleep-flush poll cap (§10.2 phase 5, lag cap 60 s + margin). */
  flushCapMs: number;
  /** resume-after-sleep cap (§10.4: no /startupz in 300 s). */
  resumeCapMs: number;
  /** Retry the sleep this long after a snapshot failure (§10.2 phase 7). */
  sleepRetryMs: number;
  /** No sleep this long after 3 aborts in an hour (§10.4). */
  abortHoldMs: number;
  /** Planned stop quiesce cap (§10.6). guess: 330 s like sleep-stop-gateway. */
  quiesceCapMs: number;
  /** Identity check (§11.1 step 6) and /readyz (step 7) intervals. */
  identityEveryMs: number;
  readyzEveryMs: number;
  readyzBadMs: number;
  zombieAlertMs: number;
  epochCacheMs: number;
  /** Control DO (ctl builder). Alert dedupe per class (§17.2). */
  alertDedupeMs: number;
  /** Control DO R2 probe while the Runtime DO is awake (§11.5). */
  r2ProbeMs: number;
  /** Driver retry steps (§12.3): 1, 2, 5, 10 s, then driverRetryCapMs after ingress-ready. */
  driverRetry1Ms: number;
  driverRetry2Ms: number;
  driverRetry3Ms: number;
  driverRetry4Ms: number;
  driverRetryCapMs: number;
  /** 401 for this long → alert inbox-blocked (§12.3). */
  driverAuthAlertMs: number;
  /** Inbox wake retry after received_at (add §2.2): +15 s, +30 s, then every 60 s. */
  inboxWakeFirstMs: number;
  inboxWakeSecondMs: number;
  inboxWakeEveryMs: number;
  /** Cron lead clamp after 20 wakes (add §2.3). */
  leadMinMs: number;
  leadMaxMs: number;
  /** Gen GC (§13.4): booting/abandoned age, complete gens' last-write age. */
  genAbandonedMs: number;
  genStaleMs: number;
  /** Snapshot TTL: max(created, lastRestored) + 30 d (§15.3). */
  snapshotTtlMs: number;
  budgetScale: number;
}

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;

export const DEFAULT_TIMERS: Readonly<Timers> = Object.freeze({
  reconcileMs: 60 * S,
  opTickMs: 5 * S,
  hbMs: 30 * S,
  fenceMs: 150 * S,
  startGateMs: 120 * S,
  hbLostMs: 180 * S,
  unconfirmedWaitMs: 200 * S,
  drainCapMs: 15 * MIN,
  inactivityMs: 6 * H,
  destroyTimeoutMs: 30 * S,
  settleCapMs: 60 * S,
  inspectTimeoutMs: 20 * S,
  startTimeoutMs: 30 * S,
  execTimeoutMs: 20 * S,
  deliverTimeoutMs: 30 * S,
  readyPollMs: 1 * S,
  budgetBootMs: 120 * S,
  budgetRestoreSnapMs: 300 * S,
  budgetRestoreImageMs: 900 * S,
  budgetDoctorMs: 600 * S,
  budgetReplicaMs: 120 * S,
  budgetGatewayStartMs: 300 * S,
  idleMs: 5 * MIN,
  idleCapMs: 60 * MIN,
  cronTailMs: 120 * S,
  minAwakeMs: 120 * S,
  minSleepMs: 10 * MIN,
  leadMs: 120 * S,
  maintEveryMs: 24 * H,
  rebaseEveryMs: 24 * H,
  rebaseChainMax: 40,
  credsCopyMs: 15 * MIN,
  heldMaxMs: 20 * H,
  inboxDeadMs: 23 * H,
  inboxKeepMs: 24 * H,
  capacityFastMs: 10 * S,
  capacitySlowMs: 60 * S,
  capacityFastForMs: 2 * MIN,
  ladderResetMs: 10 * MIN,
  l2WindowMs: 30 * MIN,
  slowMs: 30 * MIN,
  l5PendingMs: 2 * H,
  snapshotRetryCapMs: 10 * S,
  finalSnapshotMs: 120 * S,
  finalWaitMs: 60 * S,
  stopGatewayCapMs: 330 * S,
  flushCapMs: 90 * S,
  resumeCapMs: 300 * S,
  sleepRetryMs: 15 * MIN,
  abortHoldMs: 1 * H,
  quiesceCapMs: 330 * S,
  identityEveryMs: 5 * MIN,
  readyzEveryMs: 5 * MIN,
  readyzBadMs: 10 * MIN,
  zombieAlertMs: 10 * MIN,
  epochCacheMs: 30 * S,
  alertDedupeMs: 1 * H,
  r2ProbeMs: 60 * S,
  driverRetry1Ms: 1 * S,
  driverRetry2Ms: 2 * S,
  driverRetry3Ms: 5 * S,
  driverRetry4Ms: 10 * S,
  driverRetryCapMs: 30 * S,
  driverAuthAlertMs: 5 * MIN,
  inboxWakeFirstMs: 15 * S,
  inboxWakeSecondMs: 30 * S,
  inboxWakeEveryMs: 60 * S,
  leadMinMs: 60 * S,
  leadMaxMs: 300 * S,
  genAbandonedMs: 24 * H,
  genStaleMs: 7 * 24 * H,
  snapshotTtlMs: 30 * 24 * H,
  budgetScale: 1,
});

/** Test values (§20 "Test" column). Phase budgets are the defaults ÷ 60. inactivityMs is not shortened. */
export const TEST_TIMERS: Readonly<Timers> = Object.freeze({
  ...DEFAULT_TIMERS,
  reconcileMs: 1 * S,
  opTickMs: 100,
  hbMs: 1 * S,
  fenceMs: 5 * S,
  startGateMs: 5 * S,
  hbLostMs: 6 * S,
  unconfirmedWaitMs: 7 * S,
  drainCapMs: 30 * S,
  destroyTimeoutMs: 1 * S,
  settleCapMs: 2 * S,
  inspectTimeoutMs: 1 * S,
  startTimeoutMs: 1 * S,
  execTimeoutMs: 1 * S,
  deliverTimeoutMs: 1 * S,
  readyPollMs: 100,
  budgetBootMs: 2 * S,
  budgetRestoreSnapMs: 5 * S,
  budgetRestoreImageMs: 15 * S,
  budgetDoctorMs: 10 * S,
  budgetReplicaMs: 2 * S,
  budgetGatewayStartMs: 5 * S,
  idleMs: 2 * S,
  idleCapMs: 24 * S,
  cronTailMs: 1 * S,
  minAwakeMs: 1 * S,
  minSleepMs: 5 * S,
  leadMs: 1 * S,
  maintEveryMs: 60 * S,
  rebaseEveryMs: 24 * H,
  rebaseChainMax: 40,
  credsCopyMs: 5 * S,
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
  finalWaitMs: 1 * S,
  stopGatewayCapMs: 6 * S,
  flushCapMs: 2 * S,
  resumeCapMs: 5 * S,
  sleepRetryMs: 15 * S,
  abortHoldMs: 60 * S,
  quiesceCapMs: 6 * S,
  identityEveryMs: 5 * S,
  readyzEveryMs: 5 * S,
  readyzBadMs: 10 * S,
  zombieAlertMs: 10 * S,
  epochCacheMs: 1 * S,
  alertDedupeMs: 1 * H,
  r2ProbeMs: 1 * S,
  driverRetry1Ms: 10,
  driverRetry2Ms: 20,
  driverRetry3Ms: 50,
  driverRetry4Ms: 100,
  driverRetryCapMs: 300,
  driverAuthAlertMs: 3 * S,
  inboxWakeFirstMs: 150,
  inboxWakeSecondMs: 300,
  inboxWakeEveryMs: 600,
  leadMinMs: 500,
  leadMaxMs: 2 * S,
  budgetScale: 0.1,
});

/** Effective timers from the Worker env. OC_TIMERS is ignored unless OC_TEST == "1". */
export function timersFrom(env: { OC_TEST?: string; OC_TIMERS?: string }): Timers {
  if (env.OC_TEST !== "1") return { ...DEFAULT_TIMERS };
  let over: Record<string, unknown> = {};
  try {
    over = env.OC_TIMERS ? (JSON.parse(env.OC_TIMERS) as Record<string, unknown>) : {};
  } catch {
    over = {};
  }
  const base: Timers = over.preset === "test" ? { ...TEST_TIMERS } : { ...DEFAULT_TIMERS };
  for (const [k, v] of Object.entries(over)) {
    if (k in base && typeof v === "number" && Number.isFinite(v) && v >= 0) (base as any)[k] = v;
  }
  return base;
}

/** ocsup's three plan values (§8.3 `timers`). */
export function planTimers(t: Timers): { hbMs: number; fenceMs: number; startGateMs: number } {
  return { hbMs: t.hbMs, fenceMs: t.fenceMs, startGateMs: t.startGateMs };
}
