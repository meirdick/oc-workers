// Wake log (spec §16.2), cost guard and cost meter glue (§16.1, core/cost.ts).
import { costGuard, costMeter, parseInstance, type WakeSpan } from "../core/cost";
import { alert } from "./alerts";
import { type Ctx, DAY, utcDay } from "./ctx";

export interface WakeRow {
  id: number;
  gen: number | null;
  reason: string;
  wake_at: number;
  alive_ms: number | null;
  startupz_ms: number | null;
  first_replay_ms: number | null;
  slept_at: number | null;
  awake_s: number | null;
  cpu_s: number | null;
  snapshot_bytes: number | null;
  sleep_ms: number | null;
}

/** The boot slept: close the row (snapshot size, sleep op ms, last hb cpuS). */
export function wakeSlept(
  c: Ctx,
  x: {
    gen: number;
    sleptAt?: number;
    cpuS?: number | null;
    snapshotBytes?: number | null;
    sleepMs?: number | null;
  },
): void {
  const at = x.sleptAt ?? c.now();
  c.db.run(
    `UPDATE wake_log SET slept_at = ?, awake_s = (? - wake_at) / 1000, cpu_s = COALESCE(?, cpu_s),
       snapshot_bytes = COALESCE(?, snapshot_bytes), sleep_ms = COALESCE(?, sleep_ms)
     WHERE id = (SELECT MAX(id) FROM wake_log WHERE gen = ?)`,
    at,
    at,
    x.cpuS ?? null,
    x.snapshotBytes ?? null,
    x.sleepMs ?? null,
    x.gen,
  );
}

/** Heartbeat cpuS for the open row (cost guard uses the newest value). */
export function wakeCpu(c: Ctx, gen: number, cpuS: number): void {
  c.db.run(
    "UPDATE wake_log SET cpu_s = ? WHERE id = (SELECT MAX(id) FROM wake_log WHERE gen = ?)",
    cpuS,
    gen,
  );
}

export function wakeSpans(c: Ctx, sinceMs: number): WakeSpan[] {
  const rows = c.db.all<WakeRow>(
    "SELECT * FROM wake_log WHERE COALESCE(slept_at, ?) >= ? ORDER BY id",
    Number.MAX_SAFE_INTEGER,
    sinceMs,
  );
  // An open row followed by a newer row ended (crash or restart without a sleep) at the newer wake.
  return rows.map((r, i) => {
    const next = rows[i + 1];
    const end = r.slept_at ?? (next ? next.wake_at : null);
    return { wakeAt: r.wake_at, sleptAt: end, cpuS: r.cpu_s, slept: r.slept_at !== null };
  });
}

/** Sleep gate rule 9 (§16.1). Persists the hold flag; `sleep-thrash` once per UTC day. */
export function costCheck(c: Ctx): ReturnType<typeof costGuard> {
  const now = c.now();
  const s = c.settings();
  const off = s.sleep.costGuard === "off";
  const r = costGuard({
    now,
    spans: wakeSpans(c, now - DAY),
    instance: parseInstance(c.instance),
    snapCost: s.sleep.snapshotCostUsd,
    holding: !off && c.db.meta("costHold") === "1",
    releaseBelow: s.cost.releaseBelowPct / 100,
  });
  // costGuard off: the numbers still show in status; nothing holds the install awake.
  if (off) {
    r.allow = true;
    r.holding = false;
  }
  c.db.setMeta("costHold", r.holding ? "1" : "0");
  if (r.holding && c.db.meta("thrashDay") !== utcDay(now)) {
    c.db.setMeta("thrashDay", utcDay(now));
    alert(
      c,
      "sleep-thrash",
      "warn",
      `cost guard holds the container awake (24 h spend ${r.spend24.toFixed(4)} USD)`,
    );
  }
  return r;
}

export function meter(
  c: Ctx,
): ReturnType<typeof costMeter> & { wakes24: number; p50StartupzMs: number | null } {
  const now = c.now();
  const m = costMeter({
    now,
    spans: wakeSpans(c, now - DAY),
    instance: parseInstance(c.instance),
    snapCost: c.settings().sleep.snapshotCostUsd,
  });
  const rows = c.db.all<{ startupz_ms: number | null }>(
    "SELECT startupz_ms FROM wake_log WHERE wake_at > ? ORDER BY id",
    now - DAY,
  );
  const z = rows
    .map((r) => r.startupz_ms)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  return {
    ...m,
    wakes24: rows.length,
    p50StartupzMs: z.length ? (z[Math.floor(z.length / 2)] as number) : null,
  };
}

/** Kept 30 d (§16.2). */
export function pruneWakeLog(c: Ctx): void {
  c.db.run("DELETE FROM wake_log WHERE wake_at < ?", c.now() - 30 * DAY);
}
