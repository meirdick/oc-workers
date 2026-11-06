// Runtime guard façade: wires memwatch, the restart scheduler (uptime limit, windows), the
// cron-stalled check, the Proactive override and the plugin retry to ocsup's core.
// The core passes its own functions; this module owns only timers and policy.
import { cgMem, cgroupKill, cpuSeconds } from "./cgroups.mjs";
import { createCronCheck } from "./cronstall.mjs";
import { createMaint, MAINT } from "./maint.mjs";
import { createMemwatch } from "./memwatch.mjs";
import { createPluginRetry } from "./plugins.mjs";
import { applyProactive } from "./proactive.mjs";
import { anonBytes } from "./procs.mjs";
import { readText } from "./sysfs.mjs";

export const OPENCLAW_ENTRY = "/app/openclaw.mjs";

/**
 * Adapter: the guard modules pass OpenClaw CLI args (["cron", "status", "--json"]); the core's
 * runCli takes node args. Prefix the entry unless args[0] is already a script path. env given by a
 * module (OPENCLAW_CONFIG_PATH for Doctor) is merged over baseEnv(), not used alone.
 */
export function openclawCli(runCli, baseEnv) {
  if (!runCli) return runCli;
  return (args, o = {}) => {
    const a =
      /\.(m?js)$/.test(args[0] || "") || String(args[0]).startsWith("-") ? args : [OPENCLAW_ENTRY, ...args];
    const env = o.env && baseEnv ? { ...baseEnv(), ...o.env } : o.env;
    return runCli(a, { ...o, env });
  };
}

/** VM MemAvailable and MemTotal in bytes. */
export function meminfo(procRoot = "/proc") {
  const mi = readText(`${procRoot}/meminfo`) || "";
  const kb = (k) => {
    const m = new RegExp(`${k}:\\s+(\\d+) kB`).exec(mi);
    return m ? Number(m[1]) * 1024 : null;
  };
  return { total: kb("MemTotal"), avail: kb("MemAvailable") };
}

/**
 * deps (from the core):
 *  dirs: setupCgroups().dirs; plan: boot plan; now(); log(ev, f); alert(cls, sev, detail);
 *  gatewayPid() -> pid|0; gatewayUptimeMs() -> ms|null;
 *  restartGateway({reason, forced, hard}) -> Promise  (graceful SIGTERM 330 s, reap, start; no Doctor)
 *  maintWindow(key) -> Promise  (plan §4.7 window steps 3-7; default restartGateway)
 *  isIdle() -> Promise<{idle, why}>  (suspend.prepare ready + no cron run < 6 h)
 *  runCli(args, o) -> Promise<{code, out}>  (uid 1000, role cli)
 *  readProactive() -> Promise<{receipts, jobs}|null>  (ocio cron-read proactive)
 *  heap() -> Promise<{used, limit}|null>  (optional; gateway RPC); heapOverride() -> {used, limit}|null (test)
 *  pluginManifest, missingPlugins: from the boot check; onPluginInstalled(id) -> Promise
 *  canAct() -> bool  (false while draining, fenced, in a sleep op or a stop)
 */
export function createRuntimeGuard(deps0) {
  const deps = { ...deps0, runCli: openclawCli(deps0.runCli, deps0.cliEnv) };
  const now = deps.now || Date.now;
  const rt = deps.plan?.runtime || {};
  const timers = [];
  let heapCache = null;

  const maint = createMaint(
    {
      now,
      gatewayUptimeMs: deps.gatewayUptimeMs,
      heapAborts: () => rt.heapAborts || [],
      isIdle: deps.isIdle,
      restart: (x) => deps.restartGateway(x),
      windowRun: deps.maintWindow,
      maintenanceHour: rt.maintenanceHour ?? 4,
      tz: rt.tz || "UTC",
      log: deps.log,
    },
    rt.maxUptimeHours ? { ...MAINT, uptimeHours: rt.maxUptimeHours } : MAINT,
  );

  const mw = createMemwatch({
    sample() {
      const pid = deps.gatewayPid();
      if (!pid) return null;
      const m = cgMem(deps.dirs.gw);
      const vm = meminfo();
      // heapOverride: ocsupctl test fault `heap <pct>` (harness H1); else the 5-min RPC reading.
      // A heap figure is valid only for the gateway it was read from: one read before the current
      // gateway started would restart the new gateway again and again (M1 integration finding).
      const up = deps.gatewayUptimeMs?.();
      const startedAt = Number.isFinite(up) ? now() - up : 0;
      const fresh = (x) => x && (x.at ?? 0) >= startedAt && now() - x.at < 6 * 60_000;
      const ov = deps.heapOverride?.();
      const h = fresh(ov) ? ov : fresh(heapCache) ? heapCache : null;
      return {
        now: now(),
        vmTotal: vm.total,
        vmAvail: vm.avail,
        gwCurrent: m.current,
        gwMax: m.max || vm.total,
        heapUsed: h?.used,
        heapLimit: h?.limit,
        anon: anonBytes(pid),
      };
    },
    idleRestart: (why) => maint.request(`memwatch:${why}`),
    restartNow: async (why) => {
      deps.alert?.("memwatch-restart", "warn", why);
      await deps.restartGateway({ reason: `memwatch:${why}`, forced: true });
    },
    hardKill: async (why) => {
      deps.alert?.("memwatch-restart", "high", `hard:${why}`);
      deps.beforeHardKill?.(); // the gateway exit that follows is planned, not a crash
      const k = await cgroupKill(deps.dirs.gw, { capMs: 10_000 });
      deps.log?.("memwatch-hard-kill", { why, ...k });
      await deps.restartGateway({ reason: `memwatch-hard:${why}`, forced: true, hard: true });
    },
    log: deps.log,
  });

  const cron = createCronCheck({
    runCli: deps.runCli,
    alert: deps.alert,
    requestRestart: (r) => maint.request(r),
    log: deps.log,
    now,
  });

  const plugins = createPluginRetry(deps.pluginManifest, deps.missingPlugins || [], {
    runCli: deps.runCli,
    onInstalled: async (id) => {
      await deps.onPluginInstalled?.(id);
      maint.request(`plugin-installed:${id}`);
    },
    log: deps.log,
    now,
  });

  const every = (ms, fn) => {
    const t = setInterval(() => {
      if (deps.canAct && !deps.canAct()) return;
      Promise.resolve(fn()).catch((e) =>
        deps.log?.("guard-error", { err: String(e?.stack || e).slice(0, 500) }),
      );
    }, ms);
    t.unref?.();
    timers.push(t);
  };

  return {
    maint,
    memwatch: mw,
    cron,
    plugins,
    /** Start the timers (after the first gateway spawn). */
    start() {
      every(1000, () => mw.tick());
      every(60_000, () => maint.tick());
      every(60_000, () => plugins.tick());
      if (deps.heap)
        every(5 * 60_000, async () => {
          const h = await deps.heap();
          if (h) heapCache = { ...h, at: now() };
        });
    },
    /** Call on each /startupz. */
    async onStartupz() {
      mw.reset();
      cron.start();
      if ((rt.sleepMode ?? "auto") === "auto" && deps.readProactive)
        return applyProactive(rt.proactive || "2h@08-22", rt.tz || "UTC", {
          read: deps.readProactive,
          runCli: deps.runCli,
          alert: deps.alert,
          log: deps.log,
        });
      return null;
    },
    /** Heartbeat fields (contract §4: mem, cpuS). */
    heartbeat() {
      const vm = meminfo();
      return {
        mem: {
          vmAvail: vm.avail,
          vmTotal: vm.total,
          gw: cgMem(deps.dirs.gw),
          sys: cgMem(deps.dirs.sys),
          projectedMs: Number.isFinite(mw.state.projectedMs) ? mw.state.projectedMs : null,
          heap: heapCache,
        },
        cpuS: cpuSeconds(deps.dirs.root),
        restartPending: maint.state.pending?.reason || null,
        pluginsMissing: plugins.missing(),
      };
    },
    stop() {
      for (const t of timers.splice(0)) clearInterval(t);
      cron.stop();
    },
  };
}

/**
 * Heap source (plan §4.6; M1 fact): 2026.10.9 `gateway call system.info --json` has
 * processMemory.heapUsedBytes but no limit. The limit is the V8 heap_size_limit of a plain node in
 * ocrt/gw/main (2240 MiB at 6 GiB, measured in M1; addendum §4). Returns used bytes or null.
 */
export function heapUsedFromSystemInfo(out) {
  const s = String(out || "");
  const i = s.indexOf("{");
  if (i < 0) return null;
  try {
    const n = JSON.parse(s.slice(i)).processMemory?.heapUsedBytes;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** heap() dep for createRuntimeGuard: one CLI call per read (about 1-2 s CPU; run every 5 min). */
export function makeHeapReader(runCli, limitBytes) {
  return async () => {
    const r = await runCli(["gateway", "call", "system.info", "--json"], { timeoutMs: 30_000, role: "cli" });
    const used = r.code === 0 ? heapUsedFromSystemInfo(r.out) : null;
    return used === null ? null : { used, limit: limitBytes };
  };
}
