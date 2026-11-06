// cron-stalled check (plan §4.7 "After each /startupz"; scope §1.1 row "In-container restarts").
// After /startupz and every 15 min: `openclaw cron status --json` (uid 1000, CLI role). If cron is
// enabled and nextWakeAtMs is more than 10 min in the past → alert `cron-stalled` and request one
// graceful restart (once per boot). guess: the JSON has `enabled` and `nextWakeAtMs` on 2026.10.9
// (the dist has the field name; output not recorded yet).

export const CRON = Object.freeze({ everyMs: 15 * 60_000, lateMs: 10 * 60_000 });

/** Parse the CLI output; the JSON may follow a banner line. */
export function parseStatus(out) {
  const s = String(out || "");
  const i = s.indexOf("{");
  if (i < 0) return null;
  try {
    return JSON.parse(s.slice(i));
  } catch {
    return null;
  }
}

/** Pure rule. Returns {stalled, why}. */
export function judge(st, now, cfg = CRON) {
  if (!st) return { stalled: false, why: "unknown" };
  const enabled = st.enabled ?? st.scheduler?.enabled;
  const next = st.nextWakeAtMs ?? st.scheduler?.nextWakeAtMs;
  if (enabled === false) return { stalled: false, why: "disabled" };
  if (!Number.isFinite(next)) return { stalled: false, why: "no-next" };
  const late = now - next;
  return late > cfg.lateMs
    ? { stalled: true, why: `late ${Math.round(late / 1000)}s` }
    : { stalled: false, why: "ok" };
}

/**
 * deps: {runCli(args, o), alert, requestRestart(reason), log, now}. Call start() after /startupz.
 * check() is exposed for tests. One restart per boot; later stalls only alert.
 */
export function createCronCheck(deps, cfg = CRON) {
  let restarted = false;
  let timer = null;
  const now = deps.now || Date.now;
  async function check() {
    const r = await deps.runCli(["cron", "status", "--json"], { timeoutMs: 30_000, role: "cli" });
    const j = judge(r.code === 0 ? parseStatus(r.out) : null, now(), cfg);
    deps.log?.("cron-status", { code: r.code, ...j });
    if (j.stalled) {
      deps.alert?.("cron-stalled", "warn", j.why);
      if (!restarted) {
        restarted = true;
        deps.requestRestart?.("cron-stalled");
      }
    }
    return j;
  }
  return {
    check,
    start() {
      if (timer) return;
      void check();
      timer = setInterval(check, cfg.everyMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
