// Gateway restart policy inside the container (plan §4.7, scope §1.1 row "In-container restarts").
// - Idle restarts: memwatch tier 1, uptime limit, cron-stalled, plugin retry. Wait for an idle
//   point (suspend.prepare ready, no active cron run), retry every 5 min, force after 2 h.
// - Uptime limit: 16 h; each heap-abort in the last 7 d lowers it by 25%, floor 6 h.
// - Maintenance windows: two per day at maintenanceHour H and H+12 local time. Skipped when gateway
//   uptime < 8 h. A busy window is retried every 5 min for 60 min, not skipped at once.

export const MAINT = Object.freeze({
  uptimeHours: 16,
  minUptimeHours: 6,
  abortStep: 0.75,
  abortMemoryMs: 7 * 86400_000,
  windowMinUptimeMs: 8 * 3600_000,
  retryMs: 5 * 60_000,
  windowRetryForMs: 60 * 60_000,
  forceAfterMs: 2 * 3600_000,
  cronStaleMs: 6 * 3600_000,
});

const H = 3600_000;

/** Active uptime limit in ms. heapAborts = timestamps of class heap-abort. */
export function uptimeLimitMs(now, heapAborts = [], cfg = MAINT) {
  const n = heapAborts.filter((t) => now - t < cfg.abortMemoryMs).length;
  return Math.max(cfg.uptimeHours * cfg.abortStep ** n, cfg.minUptimeHours) * H;
}

/** Local {key, hour} for a time in a time zone. key = YYYY-MM-DDTHH. */
export function localHour(now, tz = "UTC") {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  return { key: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`, hour: Number(parts.hour) };
}

/** Is `now` inside a window hour (H or H+12 local)? Returns the window key or null. */
export function windowKey(now, maintenanceHour, tz) {
  const { key, hour } = localHour(now, tz);
  const a = ((maintenanceHour % 24) + 24) % 24;
  return hour === a || hour === (a + 12) % 24 ? key : null;
}

/**
 * The cron-busy rule: a `running` receipt younger than 6 h blocks; older ones are stale and are
 * ignored (scope §1.1 [Z1.m13]). rows = [{status, started_at_ms}].
 */
export function cronBusy(rows, now, cfg = MAINT) {
  return rows.some((r) => r.status === "running" && now - Number(r.started_at_ms) < cfg.cronStaleMs);
}

/**
 * Scheduler. deps: {now(), gatewayUptimeMs(), heapAborts(), isIdle() -> {idle, why},
 * restart({reason, forced}) -> Promise, log, maintenanceHour, tz, windowRun?(key) -> Promise}.
 * windowRun runs the full window steps (plan §4.7 steps 3-7); default = restart.
 * Call tick() every 60 s. sigterm/draining: the caller stops calling tick.
 */
export function createMaint(deps, cfg = MAINT) {
  const st = {
    pending: null, // {reason, since, lastTry, forceAt, giveUpAt, kind: idle|window}
    doneWindows: new Set(),
    missed: [],
  };
  const log = deps.log || (() => {});

  function request(reason, o = {}) {
    const now = deps.now();
    if (st.pending && st.pending.kind === "idle") {
      log("restart-request-merged", { reason, pending: st.pending.reason });
      return false;
    }
    st.pending = {
      kind: o.kind || "idle",
      reason,
      since: now,
      lastTry: 0,
      forceAt: o.force === false ? null : now + (o.forceAfterMs ?? cfg.forceAfterMs),
      giveUpAt: o.giveUpAfterMs ? now + o.giveUpAfterMs : null,
      key: o.key,
    };
    log("restart-requested", st.pending);
    return true;
  }

  async function tick() {
    const now = deps.now();
    const up = deps.gatewayUptimeMs();
    // Uptime limit: forced at the next idle point, forced after 2 h.
    const lim = uptimeLimitMs(now, deps.heapAborts?.() || [], cfg);
    if (up !== null && up >= lim && !st.pending) request(`uptime>=${Math.round(lim / H)}h`);
    // Windows.
    const wk = windowKey(now, deps.maintenanceHour ?? 4, deps.tz || "UTC");
    if (wk && !st.doneWindows.has(wk) && !st.pending) {
      st.doneWindows.add(wk);
      if (up !== null && up < cfg.windowMinUptimeMs) log("maint-window-skip", { key: wk, uptimeMs: up });
      else
        request("maint-window", {
          kind: "window",
          force: false,
          giveUpAfterMs: cfg.windowRetryForMs,
          key: wk,
        });
    }
    const p = st.pending;
    if (!p) return null;
    if (p.lastTry && now - p.lastTry < cfg.retryMs) return null;
    p.lastTry = now;
    const forced = p.forceAt !== null && now >= p.forceAt;
    if (!forced) {
      const idle = await deps.isIdle();
      if (!idle.idle) {
        if (p.giveUpAt && now >= p.giveUpAt) {
          st.missed.push({ key: p.key, at: now, why: idle.why });
          log("maint-window-missed", { key: p.key, why: idle.why });
          st.pending = null;
          return { action: "missed", why: idle.why };
        }
        log("restart-busy", { reason: p.reason, why: idle.why });
        return { action: "busy", why: idle.why };
      }
    }
    st.pending = null;
    if (p.kind === "window" && deps.windowRun) await deps.windowRun(p.key);
    else await deps.restart({ reason: p.reason, forced });
    return { action: p.kind === "window" ? "window" : "restart", reason: p.reason, forced };
  }

  return { request, tick, state: st };
}
