// SIGTERM state machine (plan §4.5; amend §1.5 F1.7, §2 row 2, §3 rows "T7e row 8", "T7e row 14";
// scope §1.1 "Signals"). The caller sets sigtermSeen synchronously in the signal handler, then calls
// drain(). Litestream and ocio run with SIGTERM ignored (wrapper), so a SIGTERM to every process
// (inactivity stop) leaves them alive for the final sync.
//
// Steps: 1 event `sigterm` (no await) -> 2 by phase -> 3 gateway SIGTERM (cap 330 s), tree TERM, reap
// -> 4 Litestream lag 0 (cap 30 s), SIGINT, clean exit (F1.6) -> 5 creds flush (30 s), sync ->
// 6 event `drained {unclean}`, /v1/final-snapshot (120 s) -> 7 exit 0.
// No suspend.prepare: with no open sleep op ocsup assumes the kill comes in <= 4 s (amend §2 row 2).

export const PRESTART_PHASES = new Set(["boot", "restore", "doctor", "lock", "replica"]);

/**
 * Where to start, from the phase and the sleep op state (pure).
 * Returns {prestart, skipGateway, awaitInflight, skipLitestream, skipCreds}.
 */
export function drainPlan(phase, sleepInt = {}, { gatewayRunning = true, fenced = false } = {}) {
  if (PRESTART_PHASES.has(phase) && !gatewayRunning) return { prestart: true };
  const p = {
    prestart: false,
    skipGateway: false,
    awaitInflight: false,
    skipLitestream: false,
    skipCreds: false,
  };
  if (sleepInt.open) {
    // phases 1-3: gateway SIGTERM inside the lease (no suspend.resume). 4 and 5: let the call finish.
    if (sleepInt.phase === "stop-gateway" || sleepInt.phase === "flush") p.awaitInflight = true;
  }
  if (sleepInt.flushed) Object.assign(p, { skipGateway: true, skipLitestream: true, skipCreds: true });
  else if (sleepInt.gwStopped || fenced || !gatewayRunning) p.skipGateway = true;
  if (sleepInt.lsStopped) p.skipLitestream = true;
  return p;
}

/**
 * drain(deps) -> {code, reason, steps[]}. deps:
 *  phase(); event(kind, extra); log(ev, f); setPhase(p); now();
 *  abortPrestart() (kill the prestart child); reap(why) -> {ok, reason};
 *  gateway: {running(), stop({capMs, why}) -> {clean, code, signal}}; fenced();
 *  sleepInterrupt() -> sleepOps.interruptBySigterm() result;
 *  replica: {running(), waitLagZero(capMs) -> {ok}, stopFinal({capMs}) -> {clean, detail}};
 *  creds: {flush({capMs}) -> {ok}}; sync(); finalSnapshot(unclean) -> {ok, snapshotId}; hang() -> bool
 */
export async function drain(deps) {
  const steps = [];
  const now = deps.now || Date.now;
  const step = async (name, fn) => {
    const t = now();
    let r;
    try {
      r = await fn();
    } catch (e) {
      r = { error: String(e?.message || e) };
    }
    const rec = { step: name, ms: now() - t, ...(r && typeof r === "object" ? r : {}) };
    steps.push(rec);
    deps.log?.("drain-step", rec);
    return r || {};
  };
  const from = deps.phase();
  void deps.event("sigterm", { phase: from });
  deps.setPhase?.("draining");
  const si = deps.sleepInterrupt ? deps.sleepInterrupt() : {};
  const plan = drainPlan(from, si, { gatewayRunning: deps.gateway.running(), fenced: deps.fenced?.() });
  deps.log?.("drain-plan", { from, sleep: { open: !!si.open, phase: si.phase ?? null }, ...plan });

  if (plan.prestart) {
    await step("abort-prestart", async () => deps.abortPrestart?.() || {});
    const rp = await step("reap", () => deps.reap("sigterm-prestart"));
    if (deps.replica.running())
      await step("litestream-final", () => deps.replica.stopFinal({ capMs: 10_000 }));
    deps.setPhase?.("drained");
    return { code: 0, reason: `sigterm:${from}`, steps, reap: rp };
  }

  const unclean = [];
  if (plan.awaitInflight && si.inflight)
    await step("await-sleep-phase", async () => {
      await si.inflight.catch(() => null);
      return {};
    });

  if (!plan.skipGateway && deps.gateway.running()) {
    const g = await step("gateway-stop", () => deps.gateway.stop({ capMs: 330_000, why: "sigterm" }));
    if (!g.clean) unclean.push("gateway");
  } else {
    await step("reap", () => deps.reap("sigterm"));
    // SIGTERM to every process: the gateway may have exited on its own signal before this step.
    if (!plan.skipGateway && deps.gatewayExitUnclean?.()) unclean.push("gateway");
  }

  if (!plan.skipLitestream && deps.replica.running()) {
    const lag = await step("litestream-lag", () => deps.replica.waitLagZero(30_000));
    const fin = await step("litestream-final", () => deps.replica.stopFinal({ capMs: 10_000 }));
    if (!lag.ok || !fin.clean) unclean.push("litestream");
  }
  if (!plan.skipCreds && deps.creds) {
    const c = await step("creds-flush", () => deps.creds.flush({ capMs: 30_000 }));
    if (!c.ok) unclean.push("creds");
  }
  await step("sync", async () => (await deps.sync?.()) || {});
  deps.setPhase?.("drained");
  await deps.event("drained", { unclean: unclean.length ? unclean : null });
  await step("final-snapshot", async () => {
    try {
      return await deps.finalSnapshot(unclean.length ? unclean : null);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  return { code: 0, reason: "sigterm", unclean, steps };
}
