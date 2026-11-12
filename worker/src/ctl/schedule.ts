// Cron pre-wake scheduling (spec §11.2, add §2.3): one alarm while asleep at
// wakeAt = min(nextWakeAtMs − leadMs, maintenanceDue, ttlGuard). nextWakeAtMs comes from the sleep phase 4/5
// reply (ocsup reads cron_jobs nextRunAtMs after the gateway exits; cron.status is blocked during the lease).
import { type Ctx, DAY, type Settings } from "./ctx";
import { type SnapRow, ttlEnd } from "./snapshots";

const H = 3_600_000;

/** Lead: default 120 s; after 20 wakes, p95 of alarm-to-/startupz + 30 s, clamped 60-300 s (add §2.3, guess rule). */
export function leadMs(c: Ctx): number {
  const t = c.timers;
  const rows = c.db
    .all<{ startupz_ms: number | null }>(
      "SELECT startupz_ms FROM wake_log WHERE reason = 'wake:cron' AND startupz_ms IS NOT NULL ORDER BY id DESC LIMIT 100",
    )
    .map((r) => r.startupz_ms as number);
  if (rows.length < 20) return t.leadMs;
  rows.sort((a, b) => a - b);
  const p95 = rows[Math.min(rows.length - 1, Math.ceil(0.95 * rows.length) - 1)] as number;
  const pad = Math.round(t.leadMs / 4); // 30 s at the 120 s default
  return Math.max(t.leadMinMs, Math.min(t.leadMaxMs, p95 + pad));
}

/** Hour (0-23) at ms in an IANA time zone. */
export function hourIn(ms: number, tz: string): number {
  try {
    const h = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(
      ms,
    );
    return Number.parseInt(h, 10) % 24;
  } catch {
    return new Date(ms).getUTCHours();
  }
}

/**
 * maintenanceDue = min(lastWakeAt + 24 h, oldestHeld + 20 h). If `maintenanceHour` falls in the next 4 h after
 * that time, use it, but never later than 1 h before a held row's dead line.
 */
export function maintenanceDue(
  c: Ctx,
  x: { lastWakeAt: number | null; oldestHeldAt: number | null },
): number {
  const t = c.timers;
  const cands: number[] = [];
  if (x.lastWakeAt !== null) cands.push(x.lastWakeAt + t.maintEveryMs);
  if (x.oldestHeldAt !== null) cands.push(x.oldestHeldAt + t.heldMaxMs);
  if (!cands.length) return Number.POSITIVE_INFINITY;
  const due = Math.min(...cands);
  if (t.maintEveryMs < 2 * H) return due; // test timers: no hour snapping
  const { maintenanceHour, tz } = c.settings().runtime;
  const limit = x.oldestHeldAt !== null ? x.oldestHeldAt + t.inboxDeadMs - H : Number.POSITIVE_INFINITY;
  for (let at = Math.ceil(due / H) * H; at <= due + 4 * H; at += H)
    if (hourIn(at, tz) === maintenanceHour) return at <= limit ? at : due;
  return due;
}

export interface WakePlan {
  wakeAt: number;
  reason: "cron" | "maint" | "ttl";
  leadMs: number;
  nextWakeAtMs: number | null;
  maintenanceDue: number | null;
  ttlGuard: number | null;
}

/** ctl.wakePlan (§11.2). */
export function wakePlan(c: Ctx, x: { nextWakeAtMs: number | null; lastWakeAt?: number | null }): WakePlan {
  const lead = leadMs(c);
  const lastWakeAt =
    x.lastWakeAt ?? c.db.one<{ m: number | null }>("SELECT MAX(wake_at) AS m FROM wake_log")?.m ?? null;
  const oldestHeldAt =
    c.db.one<{ m: number | null }>(
      "SELECT MIN(received_at) AS m FROM inbox WHERE state = 'held' AND quiet = 0",
    )?.m ?? null;
  const maint = maintenanceDue(c, { lastWakeAt, oldestHeldAt });
  const snap = c.db.one<SnapRow>(
    "SELECT * FROM snapshots WHERE state IN ('ok', 'suspect') ORDER BY created_at DESC LIMIT 1",
  );
  // N4: floor at half the TTL after the snapshot: with snapshotTtlMs ≤ 2 d, ttlEnd − 2 d is already past and
  // every sleep woke at once (5 loops in 15 min). 30 d default: ttlEnd − 2 d as before.
  const ttl = snap
    ? Math.max(ttlEnd(c, snap) - 2 * DAY, ttlEnd(c, snap) - c.timers.snapshotTtlMs / 2)
    : Number.POSITIVE_INFINITY;
  const cron = x.nextWakeAtMs !== null ? x.nextWakeAtMs - lead : Number.POSITIVE_INFINITY;
  const wakeAt = Math.min(cron, maint, ttl);
  const reason = wakeAt === cron ? "cron" : wakeAt === maint ? "maint" : "ttl";
  return {
    wakeAt: Number.isFinite(wakeAt) ? wakeAt : c.now() + c.timers.maintEveryMs,
    reason: Number.isFinite(wakeAt) ? reason : "maint",
    leadMs: lead,
    nextWakeAtMs: x.nextWakeAtMs,
    maintenanceDue: Number.isFinite(maint) ? maint : null,
    ttlGuard: Number.isFinite(ttl) ? ttl : null,
  };
}

/** Sleep gate rule 7 (§10.1): no sleep when the next known wake is ≤ minSleepMs away. */
export function sleepWorthIt(c: Ctx, nextWakeAtMs: number | null): boolean {
  return nextWakeAtMs === null || nextWakeAtMs - c.now() > c.timers.minSleepMs;
}

/**
 * N11 (M4 backup): OpenClaw's default `heartbeat:main` job (every 30 min) woke an asleep install every 30 min.
 * Wake-source filter: the cron job classes ocsup leaves out of nextWakeAtMs (ocio/sleep-read.mjs classifies each
 * job). `heartbeat` (job id or name `heartbeat*`, or payload kind heartbeat) never wakes unless the owner set
 * `sleep.proactive: "openclaw"` or `sleep.wakeOn` has it. `proactive` (the "Proactive check" job) wakes unless
 * `sleep.proactive` is "off" and `sleep.wakeOn` does not have it. Any other job wakes.
 */
export const WAKE_CLASSES = ["heartbeat", "proactive"] as const;
export function wakeIgnore(s: { sleep: Pick<Settings["sleep"], "proactive" | "wakeOn"> }): string[] {
  const on = new Set((s.sleep.wakeOn ?? []).map(String));
  const out: string[] = [];
  // An interval spec is the heartbeat's own cadence (heartbeatManaged): its ticks wake.
  if (s.sleep.proactive !== "openclaw" && !on.has("heartbeat") && !heartbeatSpec(s.sleep.proactive))
    out.push("heartbeat");
  if (s.sleep.proactive === "off" && !on.has("proactive")) out.push("proactive");
  return out;
}

/**
 * `sleep.proactive` as a heartbeat cadence (docs/04 "Heartbeat in duty-cycle"): "2h@08-22" → every 2 h between
 * 08:00 and 22:00; "1h" → every hour, all day. null = not an interval (off, openclaw, a cron expression).
 */
export function heartbeatSpec(
  proactive: string,
): { every: string; from: number | null; to: number | null } | null {
  const m = /^(30m|1h|2h|3h|4h|6h|12h)(?:@(\d{2})-(\d{2}))?$/.exec(proactive ?? "");
  if (!m) return null;
  const from = m[2] === undefined ? null : Number(m[2]);
  const to = m[3] === undefined ? null : Number(m[3]);
  if (from !== null && to !== null && (from > 23 || to > 24 || from >= to)) return null;
  return { every: m[1] as string, from, to };
}

const hhmm = (h: number) => `${String(h).padStart(2, "0")}:00`;

/**
 * Managed OpenClaw keys for the heartbeat (plan.managed; they win over the owner version). The heartbeat is
 * OpenClaw's own main-session automation; oc-host sets only its cadence and hours, so it does not wake the
 * install every 30 min. Interval spec → `every` and, with hours, `activeHours` in the install time zone.
 * "off" → "0m" (the recurring tick is off; event-driven heartbeat turns still run). "openclaw", a cron
 * expression, or `sleep.wakeOn` with heartbeat → nothing: the owner version decides (heartbeatDefault).
 */
export function heartbeatManaged(s: {
  sleep: Pick<Settings["sleep"], "proactive" | "wakeOn">;
  runtime: Pick<Settings["runtime"], "tz">;
}): { path: string; value: unknown }[] {
  if ((s.sleep.wakeOn ?? []).includes("heartbeat")) return [];
  if (s.sleep.proactive === "off") return [{ path: "agents.defaults.heartbeat.every", value: "0m" }];
  const h = heartbeatSpec(s.sleep.proactive);
  if (!h) return [];
  const out: { path: string; value: unknown }[] = [
    { path: "agents.defaults.heartbeat.every", value: h.every },
  ];
  if (h.from !== null && h.to !== null)
    out.push({
      path: "agents.defaults.heartbeat.activeHours",
      value: { start: hhmm(h.from), end: hhmm(h.to), timezone: s.runtime.tz },
    });
  return out;
}

/**
 * Hours in which a heartbeat tick may wake the install (plan.wakeHours). OpenClaw skips a tick outside
 * `activeHours`, so a wake for it does no work: ocio sleep-read steps to the first tick inside the window.
 */
export function wakeHours(s: {
  sleep: Pick<Settings["sleep"], "proactive" | "wakeOn">;
  runtime: Pick<Settings["runtime"], "tz">;
}): { heartbeat?: { from: number; to: number; tz: string } } {
  if ((s.sleep.wakeOn ?? []).includes("heartbeat")) return {};
  const h = heartbeatSpec(s.sleep.proactive);
  return h && h.from !== null && h.to !== null
    ? { heartbeat: { from: h.from, to: h.to, tz: s.runtime.tz } }
    : {};
}

/**
 * N11 / U2: the heartbeat default for a new owner config when `sleep.proactive` is a cron expression (the
 * "Proactive check" job path). Unless the owner set the key, `agents.defaults.heartbeat.every` is "0m" (off).
 * guess: "0m" turns the OpenClaw heartbeat off (oc:docs/gateway/heartbeat.md); live check in M4b.
 */
export function heartbeatDefault(
  doc: unknown,
  s: { sleep: Pick<Settings["sleep"], "proactive" | "wakeOn"> },
): { doc: unknown; set: boolean } {
  if (s.sleep.proactive === "openclaw" || (s.sleep.wakeOn ?? []).includes("heartbeat"))
    return { doc, set: false };
  // An interval spec or "off": the managed key sets the cadence at each render (heartbeatManaged).
  if (s.sleep.proactive === "off" || heartbeatSpec(s.sleep.proactive)) return { doc, set: false };
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { doc, set: false };
  const d = doc as Record<string, any>;
  const hb = d.agents?.defaults?.heartbeat;
  if (hb && typeof hb === "object" && "every" in hb) return { doc, set: false };
  const agents = d.agents && typeof d.agents === "object" ? d.agents : {};
  const defaults = agents.defaults && typeof agents.defaults === "object" ? agents.defaults : {};
  const heartbeat = hb && typeof hb === "object" ? hb : {};
  return {
    doc: { ...d, agents: { ...agents, defaults: { ...defaults, heartbeat: { ...heartbeat, every: "0m" } } } },
    set: true,
  };
}
