// Runtime DO kv records (spec 08 §4 `kv` keys). Every record carries v; readers are forward-tolerant.
import type { Mode, RtState } from "../core/types";

export type Desired = "running" | "asleep" | "stopped" | "retired";

export interface Rec {
  v: 1;
  inst: string;
  epoch: number;
  desired: Desired | null;
  state: RtState;
  stateAt: number;
  /** Last machine row taken (§5.2), for /ops/status and tests. */
  row: number | null;
  degraded: boolean;
  degradedWhy: string[];
  epochStatus: "active" | "retiring" | "retired" | "none" | "unknown";
  epochCheckedAt: number;
  runningSince: number | null;
  /** DO-side activity: wake, replay accept, owner op, proxied request (§10.1 rule 3). */
  lastActivityAt: number;
}

export interface Boot {
  v: 1;
  opId: string;
  gen: number;
  iid?: string | null;
  secret: string;
  restoreGens: number[];
  mode: Mode;
  labels: Record<string, string>;
  planKind: string;
  markerId?: string | null;
  snapshotId?: string | null;
  /** L2: plan rootfs time; the checkpoint clock counts from it (null: from the boot). */
  rootfsAt?: number | null;
  imageKey: string;
  digest: string;
  reason: string;
  runDoctor: boolean;
  /** Wake log: start op created. */
  wakeAt: number;
  startedAt?: number | null;
  aliveAt?: number | null;
  startupzAt?: number | null;
  ingressReadyAt?: number | null;
  /** ocsup phase from the heartbeat and when it began (phase budgets, §8.6). */
  phase: string;
  phaseAt: number;
  destroyedAt?: number | null;
  finalDone?: boolean;
  lastExit?: { code: number; reason: string | null; at: number; out?: string | null } | null;
  gatewayExitAt?: number | null;
  settledAt?: number | null;
}

export interface Hb {
  at: number;
  seq: number;
  phase: string;
  draining: boolean;
  gen: number;
  lastActivityAt: number | null;
  cpuS: number | null;
  sleepOp: unknown;
  rpo: string | null;
  tier: string | null;
}

export interface Drain {
  sigtermAt: number;
  gen: number | null;
  drainedAt?: number | null;
  unclean?: string[] | null;
  finalSnapshotId?: string | null;
}

export interface SleepRec {
  snapshotId: string | null;
  markerId: string | null;
  wakeAt: number | null;
  wakeReason: string | null;
  lastSleepAt: number | null;
  lastWakeAt: number | null;
  nextWakeAtMs: number | null;
  leadMs: number | null;
  /** Adaptive idle (§10.1). null = base. */
  idleMs: number | null;
  cronOnly: boolean;
  abortsLastHour: number[];
  snapshotFailsToday: number;
  failDay: string | null;
  retryAt: number | null;
  noSleepUntil: number | null;
  /** 3 snapshot fails in a day: awake to the next maintenance. */
  stayAwakeUntilMaint: boolean;
  /** Measured alarm-to-/startupz ms of cron wakes (lead, §11.2). */
  leadSamples: number[];
  lastMaintAt: number | null;
  blockedSince: number | null;
  blockedOn: string | null;
  thrashAlertDay: string | null;
}

export const newSleep = (): SleepRec => ({
  snapshotId: null,
  markerId: null,
  wakeAt: null,
  wakeReason: null,
  lastSleepAt: null,
  lastWakeAt: null,
  nextWakeAtMs: null,
  leadMs: null,
  idleMs: null,
  cronOnly: false,
  abortsLastHour: [],
  snapshotFailsToday: 0,
  failDay: null,
  retryAt: null,
  noSleepUntil: null,
  stayAwakeUntilMaint: false,
  leadSamples: [],
  lastMaintAt: null,
  blockedSince: null,
  blockedOn: null,
  thrashAlertDay: null,
});

export interface Liveness {
  healthzFails: number;
  lastIdentityAt: number | null;
  lastReadyzAt: number | null;
  readyzBadSince: number | null;
}

export const K = {
  rec: "rec",
  boot: "boot",
  ladder: "ladder",
  hb: "hb",
  drain: "drain",
  snapshotInFlight: "snapshotInFlight",
  wakeRequested: "wakeRequested",
  sleep: "sleep",
  liveness: "liveness",
  timers: "timers",
  zombieSince: "zombieSince",
  /** F12: {digest, at, pullMs}: this epoch's image answered an exec once (no cold pull any more). */
  imageKnown: "imageKnown",
  /** A4: {lastAt, lastId, day, n, lastSkipAt, lastSkip}. */
  checkpoint: "checkpoint",
} as const;

/** A4 checkpoint record (K.checkpoint). */
export interface CkptRec {
  lastAt: number | null;
  lastId: string | null;
  day: string | null;
  n: number;
  /** Last due check that found nothing dirty: next check after another checkpointMs. */
  lastCheckAt: number | null;
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
