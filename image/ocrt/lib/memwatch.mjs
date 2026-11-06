// memwatch (plan §4.6 as cut by scope §1.1 row "memwatch"; addendum §4 "Heap").
// Tiers, worst input wins:
//   1 idle restart:  VM avail < 25% or gw headroom < 25% for 30 s; heap > 80% of the limit;
//                    or the anon slope reaches the abort point in < 4 h (anon ≥ 50 % of it first)
//   2 restart now:   VM or gw < 12%; heap > 90%; or a projected abort in < 30 min
//   3 hard kill:     VM or gw < 6%: cgroup.kill of ocrt/gw, then start the gateway again
// No Chromium cooldown (no browser cgroup in v1). No process-wide heap flag (addendum §4).

export const MW = Object.freeze({
  t1: 0.25,
  t1HoldMs: 30_000,
  t2: 0.12,
  t3: 0.06,
  heapT1: 0.8,
  heapT2: 0.9,
  slopeT1Ms: 4 * 3600_000,
  slopeT2Ms: 30 * 60_000,
  slopeWindowMs: 3600_000,
  slopeSampleMs: 5 * 60_000,
  slopeMinSamples: 4,
  // The slope counts only once anon RSS is at this fraction of the abort point. Below it the growth is the
  // gateway warming up, not a leak (M8 live: 284 slope<4h restarts at ~500 MB on a 2.6 GB budget).
  slopeMinFrac: 0.5,
  // Addendum §4: main isolate cap 2240 MiB at 4-12 GiB (Node v24.22.1 in the image). ocsup probes
  // the real value at boot (heapLimitProbe); this is the fallback.
  heapLimitBytes: 2240 * 1024 ** 2,
  // guess: off-heap base of the gateway at the abort point (plan §4.6 "Fallback").
  offHeapBaseBytes: 400 * 1024 ** 2,
});

/** Least-squares slope (bytes/ms) and intercept over [{t, v}]. null if < 2 points or flat time. */
export function fit(samples) {
  const n = samples.length;
  if (n < 2) return null;
  let st = 0;
  let sv = 0;
  for (const s of samples) {
    st += s.t;
    sv += s.v;
  }
  const mt = st / n;
  const mv = sv / n;
  let num = 0;
  let den = 0;
  for (const s of samples) {
    num += (s.t - mt) * (s.v - mv);
    den += (s.t - mt) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den;
  return { slope, intercept: mv - slope * mt };
}

/** ms until the fitted line reaches `limit` from time `now`; Infinity if flat or falling. */
export function projectMs(samples, limit, now) {
  const f = fit(samples);
  if (!f || f.slope <= 0) return Number.POSITIVE_INFINITY;
  const tHit = (limit - f.intercept) / f.slope;
  return Math.max(0, tHit - now);
}

/**
 * Pure tier decision. sample = {now, vmAvail, vmTotal, gwCurrent, gwMax, heapUsed?, heapLimit?,
 * anon?}. state is mutated: {lowSince, anon: [{t, v}], lastAnonAt}. Returns {tier, reasons}.
 */
export function decide(sample, state, cfg = MW) {
  const reasons = [];
  const now = sample.now;
  const vmFrac = sample.vmTotal > 0 ? sample.vmAvail / sample.vmTotal : 1;
  const gwFrac = sample.gwMax > 0 ? 1 - sample.gwCurrent / sample.gwMax : 1;
  const head = Math.min(vmFrac, gwFrac);
  const src = vmFrac <= gwFrac ? "vm" : "gw";
  let tier = 0;
  const up = (t, why) => {
    reasons.push(why);
    if (t > tier) tier = t;
  };
  if (head < cfg.t3) up(3, `${src}<${cfg.t3 * 100}%`);
  else if (head < cfg.t2) up(2, `${src}<${cfg.t2 * 100}%`);
  if (head < cfg.t1) {
    state.lowSince ??= now;
    if (now - state.lowSince >= cfg.t1HoldMs) up(1, `${src}<${cfg.t1 * 100}% 30s`);
  } else state.lowSince = null;

  const limit = sample.heapLimit || cfg.heapLimitBytes;
  if (Number.isFinite(sample.heapUsed)) {
    const h = sample.heapUsed / limit;
    if (h > cfg.heapT2) up(2, `heap>${cfg.heapT2 * 100}%`);
    else if (h > cfg.heapT1) up(1, `heap>${cfg.heapT1 * 100}%`);
  }
  if (Number.isFinite(sample.anon)) {
    // Slope (fallback when no heap figure; also runs beside it): one anon sample per 5 min, fit over 1 h.
    state.anon ??= [];
    if (!state.lastAnonAt || now - state.lastAnonAt >= cfg.slopeSampleMs) {
      state.anon.push({ t: now, v: sample.anon });
      state.lastAnonAt = now;
    }
    state.anon = state.anon.filter((s) => now - s.t <= cfg.slopeWindowMs);
    const abortAt = limit + cfg.offHeapBaseBytes;
    if (state.anon.length >= cfg.slopeMinSamples && sample.anon >= cfg.slopeMinFrac * abortAt) {
      const ms = projectMs(state.anon, abortAt, now);
      state.projectedMs = ms;
      if (ms < cfg.slopeT2Ms) up(2, "slope<30min");
      else if (ms < cfg.slopeT1Ms) up(1, "slope<4h");
    }
  }
  return { tier, reasons, vmFrac, gwFrac };
}

/** True if argv or env would set a process-wide V8 heap flag on the gateway (addendum §4). */
export function hasHeapFlag(argv = [], env = {}) {
  const re = /--max-old-space-size|--max-semi-space-size|--max-heap-size/;
  return argv.some((a) => re.test(a)) || re.test(env.NODE_OPTIONS || "");
}

/**
 * Runner. deps: {sample() -> sample, idleRestart(reason), restartNow(reason), hardKill(reason), log}.
 * The actions are idempotent on the caller side; the runner also latches tier 1 until the gateway
 * restarts (call reset() after each gateway start).
 */
export function createMemwatch(deps, cfg = MW) {
  const state = {};
  let latched1 = false;
  let busy = false;
  let hardBusy = false;
  let lastSampleLog = 0;
  return {
    state,
    reset() {
      latched1 = false;
      state.lowSince = null;
      state.anon = [];
      state.lastAnonAt = 0;
    },
    async tick() {
      if (hardBusy) return null;
      const s = deps.sample();
      if (!s) return null;
      const d = decide(s, state, cfg);
      // H21: a tier-2 graceful restart can take minutes; a hog that keeps growing in the meantime
      // must still meet tier 3, so tier 3 runs even while a lower-tier action is in flight.
      if (busy) {
        if (d.tier !== 3) return null;
        deps.log?.("memwatch", { ...d, sample: s, during: "restart" });
        hardBusy = true;
        try {
          await deps.hardKill(d.reasons.join(","));
        } finally {
          hardBusy = false;
        }
        return d;
      }
      const t = s.now ?? Date.now();
      if (d.tier >= 2 || (d.tier === 1 && !latched1)) deps.log?.("memwatch", { ...d, sample: s });
      else if (t - lastSampleLog >= (cfg.sampleLogMs ?? 60_000)) {
        lastSampleLog = t;
        deps.log?.("memwatch-sample", { tier: d.tier, vmFrac: d.vmFrac, gwFrac: d.gwFrac });
      }
      busy = true;
      try {
        if (d.tier === 3) {
          hardBusy = true;
          try {
            await deps.hardKill(d.reasons.join(","));
          } finally {
            hardBusy = false;
          }
        } else if (d.tier === 2) await deps.restartNow(d.reasons.join(","));
        else if (d.tier === 1 && !latched1) {
          latched1 = true;
          await deps.idleRestart(d.reasons.join(","));
        }
      } finally {
        busy = false;
      }
      return d;
    },
  };
}
