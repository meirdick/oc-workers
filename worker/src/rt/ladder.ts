// Backoff tables and the restart ladder (spec 08 §9.2-§9.4, C5). Pure; the Runtime DO persists `Ladder`
// in kv `ladder`. The ladder never parks: every path ends with a nextStartAt. L5 is never automatic.
import type { Timers } from "../core/timers";
import type { LadderLevel } from "../core/types";
import type { StopClass, Table } from "./classify";

export interface Ladder {
  level: LadderLevel;
  /** State faults at the current level. */
  stateFaults: number;
  /** Times of L1 state faults (L1 → L2 needs 3 in l2WindowMs). */
  faultTimes: number[];
  attemptsAtLevel: number;
  nextStartAt: number;
  firstFailAt: number | null;
  lastClass: string | null;
  classStreak: number;
  /** Stuck-slot counter (§9.4): hung destroy/inspect/start or label-mismatched already-running in a row. */
  hungDestroys: number;
  lastL5PendingAt: number | null;
  slowSince: number | null;
  lastSlowAlertAt: number | null;
  capacitySince: number | null;
  infraAlertedAt: number | null;
  /** SQLite evidence count while in slow (§9.3 l5-pending). */
  sqliteEvidence: number;
  mismatchCount: number;
  /** doctor-required seen: next plan has runDoctor; a second in a row → doctor-failed (§8.5). */
  doctorPending: boolean;
  /** The last boot ran with runDoctor because of doctor-required. */
  doctorRan: boolean;
  /** Snapshot the last L1 boot used (L3 picks an older one). */
  l1SnapshotId: string | null;
  /** §8.5 M6: digest of the last Doctor boots that exited doctor-failed, and how many in a row. */
  doctorFailDigest?: string | null;
  doctorFails?: number;
  /** F3: when the last failure was recorded and which delay table it used (read by `wakeRetryAt`). */
  failedAt?: number | null;
  failedTable?: Table | null;
  /** Earliest start the unconfirmed-stop wait allows (0 when the stop was confirmed). */
  unconfirmedUntil?: number;
}

export const newLadder = (): Ladder => ({
  level: 1,
  stateFaults: 0,
  faultTimes: [],
  attemptsAtLevel: 0,
  nextStartAt: 0,
  firstFailAt: null,
  lastClass: null,
  classStreak: 0,
  hungDestroys: 0,
  lastL5PendingAt: null,
  slowSince: null,
  lastSlowAlertAt: null,
  capacitySince: null,
  infraAlertedAt: null,
  sqliteEvidence: 0,
  mismatchCount: 0,
  doctorPending: false,
  doctorRan: false,
  l1SnapshotId: null,
  doctorFailDigest: null,
  doctorFails: 0,
});

const S = 1000;
const MIN = 60 * S;
/** §9.2 `infra`: 5 s, 30 s, 2 min, 5 min (cap). */
export const INFRA_DELAYS = [5 * S, 30 * S, 2 * MIN, 5 * MIN];
/** §9.2 `fault`: "per ladder level": L1 0, L2 5 s, L3 30 s, L4 2 min, slow 10 min (slow state faults use slowMs). */
export const FAULT_DELAYS = [0, 5 * S, 30 * S, 2 * MIN, 10 * MIN];
export const INFRA_ALERT_MS = 15 * MIN;
export const SLOW_ALERT_MS = 6 * 60 * MIN;
export const UPGRADE_REGRESSION_MS = 24 * 60 * MIN;
/** §8.5 M6 (oc-m6-polish live: doctor-failed on gens 3-6, no end): after this many Doctor failures on one
 * digest, boots on that digest run without Doctor and the owner gets one `doctor-failed` alert. */
export const DOCTOR_SKIP_AFTER = 2;

/** Count one Doctor boot that exited doctor-failed. Returns true when this failure reaches the skip count. */
export function noteDoctorFail(l: Ladder, digest: string): boolean {
  l.doctorFails = l.doctorFailDigest === digest ? (l.doctorFails ?? 0) + 1 : 1;
  l.doctorFailDigest = digest;
  return l.doctorFails === DOCTOR_SKIP_AFTER;
}

/** The digest whose boots skip Doctor, or undefined. */
export function skipDoctorDigest(l: Ladder): string | undefined {
  return l.doctorFailDigest && (l.doctorFails ?? 0) >= DOCTOR_SKIP_AFTER ? l.doctorFailDigest : undefined;
}
/**
 * F3 (red-team reconciliation): the infra table caps at 5 min, so a user message that lands in a long backoff waited
 * up to 5 min. A wake request now brings the retry forward to this long after the last failure, never sooner (and
 * never before an unconfirmed stop's wait ends), so a chatty chat cannot make a crash loop. Infra failures at L1 only: state faults keep their ladder delays and a
 * `slow` or guard stop (restore-blocked) keeps its own.
 */
export const WAKE_RETRY_MIN_MS = 30 * S;

/** The earlier nextStartAt a wake request sets, or null when the backoff stays as it is. */
export function wakeRetryAt(l: Ladder, now: number): number | null {
  if (l.level !== 1 || l.stateFaults !== 0 || l.failedTable !== "infra" || l.failedAt == null) return null;
  // An unconfirmed stop still waits until the old container can be gone.
  const at = Math.max(now, l.failedAt + WAKE_RETRY_MIN_MS, l.unconfirmedUntil ?? 0);
  return at < l.nextStartAt ? at : null;
}

/** F3: snapshot misses in one start op before the replan drops snapshots (archive or restore-blocked). */
export const SNAPSHOT_REPLAN_CAP = 3;
/** F1: restore stalls fail to the next ladder step at once (no 3-in-30-min wait at L1): the DO restore budget
 * (`budget:restore`) and ocsup's own step bound (exit 75 `restore-timeout`). */
export const ESCALATE_NOW: ReadonlySet<string> = new Set(["budget:restore", "restore-timeout"]);

export function delayFor(table: Table, l: Ladder, now: number, t: Timers): number {
  const i = Math.max(0, l.classStreak - 1);
  switch (table) {
    case "none":
    case "zero":
      return 0;
    case "capacity":
      return l.capacitySince !== null && now - l.capacitySince >= t.capacityFastForMs
        ? t.capacitySlowMs
        : t.capacityFastMs;
    case "infra":
      return INFRA_DELAYS[Math.min(i, INFRA_DELAYS.length - 1)] as number;
    case "fault": {
      const li = l.level === "slow" ? 4 : l.level - 1;
      return FAULT_DELAYS[li] as number;
    }
    case "slow":
      return t.slowMs;
  }
}

export interface FailureCtx {
  now: number;
  /** State fault per §9.3 (evidence + healthy R2 probe and hello). */
  stateFault: boolean;
  lastHbAt: number | null;
  t: Timers;
}

export interface FailureOut {
  ladder: Ladder;
  delayMs: number;
  alerts: { class: string; severity: "info" | "warn" | "high"; detail?: string }[];
}

/** Apply one failed start or unplanned stop. Returns the new ladder and nextStartAt (in ladder). */
export function applyFailure(prev: Ladder, sc: StopClass, c: FailureCtx): FailureOut {
  const l: Ladder = { ...prev, faultTimes: [...prev.faultTimes] };
  const alerts: FailureOut["alerts"] = [];
  l.classStreak = l.lastClass === sc.cls ? l.classStreak + 1 : 1;
  l.lastClass = sc.cls;
  l.firstFailAt ??= c.now;
  if (sc.cls === "capacity") l.capacitySince ??= c.now;
  else l.capacitySince = null;
  if (sc.cls === "restore-blocked:mismatch") l.mismatchCount++;
  let table = sc.table;
  if (c.stateFault) {
    l.stateFaults++;
    l.attemptsAtLevel++;
    const now = ESCALATE_NOW.has(sc.cls);
    if (l.level === 1) {
      l.faultTimes = [...l.faultTimes.filter((x) => c.now - x < c.t.l2WindowMs), c.now];
      if (l.faultTimes.length >= 3 || now) enter(l, 2, c.now, alerts);
    } else if (l.level === 2 && (l.stateFaults >= 2 || now)) enter(l, 3, c.now, alerts);
    else if (l.level === 3 && (l.stateFaults >= 2 || now)) enter(l, 4, c.now, alerts);
    else if (l.level === 4 && l.stateFaults >= 1) enter(l, "slow", c.now, alerts);
    if (l.level === "slow") table = "slow";
  }
  let delay = delayFor(table, l, c.now, c.t);
  // C5/§9.3: slow runs L4 every 30 min; alert every 6 h.
  if (l.level === "slow" && c.stateFault) {
    delay = c.t.slowMs;
    if (l.lastSlowAlertAt === null || c.now - l.lastSlowAlertAt >= SLOW_ALERT_MS) {
      l.lastSlowAlertAt = c.now;
      if (prev.level === "slow") alerts.push({ class: "ladder-slow", severity: "high", detail: sc.cls });
    }
  }
  if (table === "infra" && l.firstFailAt !== null && c.now - l.firstFailAt >= INFRA_ALERT_MS) {
    if (l.infraAlertedAt === null) {
      l.infraAlertedAt = c.now;
      alerts.push({ class: `restart-${sc.cls}`, severity: "warn", detail: `failing ${sc.cls} for 15 min` });
    }
  }
  l.failedAt = c.now;
  const unconfirmedAt = sc.confirmed ? 0 : (c.lastHbAt ?? c.now) + c.t.unconfirmedWaitMs;
  l.failedTable = table;
  l.unconfirmedUntil = unconfirmedAt;
  l.nextStartAt = Math.max(c.now + delay, unconfirmedAt);
  return { ladder: l, delayMs: delay, alerts };
}

function enter(l: Ladder, level: LadderLevel, now: number, alerts: FailureOut["alerts"]) {
  l.level = level;
  l.stateFaults = 0;
  l.attemptsAtLevel = 0;
  l.faultTimes = [];
  if (level === 3) alerts.push({ class: "ladder-l3", severity: "warn" });
  if (level === 4) alerts.push({ class: "ladder-l4", severity: "high" });
  if (level === "slow") {
    l.slowSince = now;
    l.lastSlowAlertAt = now;
    alerts.push({ class: "ladder-slow", severity: "high" });
  }
}

/** §9.3: reset after ladderResetMs in `running`. Returns null when nothing changes. */
export function maybeReset(l: Ladder, now: number, runningSince: number | null, t: Timers): Ladder | null {
  if (runningSince === null || now - runningSince < t.ladderResetMs) return null;
  return resetLadder(l);
}

/**
 * M3 e2e: a settled sleep op (gateway ran, final flush, snapshot saved) also resets the ladder. Under the
 * duty cycle the install sleeps long before ladderResetMs of `running`, so a ladder in `slow` stayed there:
 * every wake took the archive path and ran Doctor, and a stale archive then blocked each boot.
 */
export function resetLadder(l: Ladder): Ladder | null {
  if (l.level === 1 && l.stateFaults === 0 && l.classStreak === 0 && l.firstFailAt === null) return null;
  return {
    ...newLadder(),
    hungDestroys: l.hungDestroys,
    l1SnapshotId: l.l1SnapshotId,
    doctorPending: l.doctorPending,
    doctorRan: l.doctorRan,
    doctorFailDigest: l.doctorFailDigest ?? null,
    doctorFails: l.doctorFails ?? 0,
  };
}

/** §9.3 l5-pending: in slow for l5PendingMs with SQLite evidence and healthy probes. Alert only (C5). */
export function l5Due(l: Ladder, now: number, healthy: boolean, t: Timers): boolean {
  if (l.level !== "slow" || l.slowSince === null) return false;
  if (now - l.slowSince < t.l5PendingMs) return false;
  const evidence = l.sqliteEvidence > 0 || l.mismatchCount >= 3;
  if (!evidence || !healthy) return false;
  return l.lastL5PendingAt === null || now - l.lastL5PendingAt >= SLOW_ALERT_MS;
}
