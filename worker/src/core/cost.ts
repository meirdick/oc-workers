// Cost guard and cost meter (spec §16, add §2.3, §2.5 rule 9, amend §2 row 11).
// Rates: Workers Containers, per second. vCPU is billed on active CPU (cpuS), memory and disk per awake second.

export const RATE = Object.freeze({
  memGiBs: 0.0000025,
  diskGBs: 0.00000007,
  vcpuS: 0.00002,
});
/** Default snapshot cost per sleep (mid guess, add §1.2); `settings.sleep.snapshotCostUsd` overrides. */
export const SNAP_COST_DEFAULT = 0.0045;
/** Boot + sleep awake-equivalent seconds and vCPU-s of one cycle (add §2.3). */
export const CYCLE_AWAKE_S = 37;
export const CYCLE_CPU_S = 28;
/** Always-on CPU share used for the comparison (amend §2 row 11). */
export const ALWAYS_CPU_SHARE = 0.1;
/** Snapshots per day an always-on install takes anyway (checkpoints + maint, §15.1). */
export const ALWAYS_SNAPS = 26;

export interface InstanceShape {
  vcpu: number;
  memoryMib: number;
  diskMb: number;
}
export const DEFAULT_INSTANCE: InstanceShape = { vcpu: 2, memoryMib: 6144, diskMb: 20000 };

/** Memory + disk price per awake second. 2/6/20 → 0.0000164 (spec §16.1). */
export function awakeRate(i: InstanceShape = DEFAULT_INSTANCE): number {
  return (i.memoryMib / 1024) * RATE.memGiBs + (i.diskMb / 1000) * RATE.diskGBs;
}

export function parseInstance(s: string | undefined): InstanceShape {
  try {
    const o = s ? (JSON.parse(s) as Partial<InstanceShape>) : {};
    if (typeof o.memoryMib === "number" && typeof o.diskMb === "number")
      return { vcpu: o.vcpu ?? 2, memoryMib: o.memoryMib, diskMb: o.diskMb };
  } catch {}
  return DEFAULT_INSTANCE;
}

export interface WakeSpan {
  wakeAt: number;
  /** null = still awake. */
  sleptAt: number | null;
  cpuS: number | null;
  /** 1 when the period ended in a sleep snapshot. */
  slept: boolean;
}

export interface CostInputs {
  now: number;
  spans: WakeSpan[];
  instance?: InstanceShape;
  snapCost?: number;
}

/** Spend over the last 24 h: awake seconds overlapping the window, CPU of those spans (pro rata), sleeps. */
export function spend24(x: CostInputs): { usd: number; awakeS: number; cpuS: number; sleeps: number } {
  const from = x.now - 86_400_000;
  let awakeS = 0;
  let cpuS = 0;
  let sleeps = 0;
  for (const s of x.spans) {
    const end = s.sleptAt ?? x.now;
    const a = Math.max(s.wakeAt, from);
    const b = Math.min(end, x.now);
    if (b <= a) continue;
    const full = Math.max(1, end - s.wakeAt);
    const part = (b - a) / 1000;
    awakeS += part;
    cpuS += (s.cpuS ?? 0) * ((b - a) / full);
    if (s.slept && s.sleptAt !== null && s.sleptAt >= from) sleeps++;
  }
  const rate = awakeRate(x.instance);
  const snap = x.snapCost ?? SNAP_COST_DEFAULT;
  return { usd: awakeS * rate + cpuS * RATE.vcpuS + sleeps * snap, awakeS, cpuS, sleeps };
}

export function always24(instance?: InstanceShape, snapCost = SNAP_COST_DEFAULT): number {
  return 86_400 * awakeRate(instance) + ALWAYS_CPU_SHARE * 86_400 * RATE.vcpuS + ALWAYS_SNAPS * snapCost;
}

export function cycleCost(instance?: InstanceShape, snapCost = SNAP_COST_DEFAULT): number {
  return CYCLE_AWAKE_S * awakeRate(instance) + CYCLE_CPU_S * RATE.vcpuS + snapCost;
}

/**
 * Guard decision with hysteresis (§16.1): refuse when spend24 + cycle > always24; once refused, hold until
 * spend24 < `releaseBelow` (0.8) × always24.
 */
export function costGuard(x: CostInputs & { holding: boolean; releaseBelow?: number }): {
  allow: boolean;
  holding: boolean;
  spend24: number;
  always24: number;
  cycle: number;
} {
  const s = spend24(x).usd;
  const a = always24(x.instance, x.snapCost);
  const c = cycleCost(x.instance, x.snapCost);
  let holding = x.holding;
  if (holding && s < (x.releaseBelow ?? 0.8) * a) holding = false;
  if (!holding && s + c > a) holding = true;
  return { allow: !holding, holding, spend24: s, always24: a, cycle: c };
}

/** Cost meter for /ops/status: 24 h spend, 30-day projection, and the always-on comparison. */
export function costMeter(x: CostInputs): {
  spend24Usd: number;
  awakeS24: number;
  sleeps24: number;
  monthUsd: number;
  alwaysOnMonthUsd: number;
  savedPct: number;
} {
  const s = spend24(x);
  const a = always24(x.instance, x.snapCost);
  return {
    spend24Usd: round(s.usd),
    awakeS24: Math.round(s.awakeS),
    sleeps24: s.sleeps,
    monthUsd: round(s.usd * 30),
    alwaysOnMonthUsd: round(a * 30),
    savedPct: a > 0 ? Math.round((1 - s.usd / a) * 100) : 0,
  };
}
const round = (n: number) => Math.round(n * 10_000) / 10_000;
