// DO-driven sleep op (spec 08 §10): gate (§10.1), 8 phases (§10.2), resume (§10.3), abort path
// (§10.4), platform SIGTERM (§10.5). Phases 1-6 can abort; from phase 7 the op runs to the end.

import { errorText } from "./classify";
import { Halted, type RuntimeCore } from "./core";
import { resetLadder } from "./ladder";
import { utcDay } from "./records";
import type { OpRow } from "./store";

type OpResult = "done" | "failed" | "aborted" | "interrupted:sigterm" | "waiting";

export const SLEEP_PHASES = [
  "check",
  "prepare",
  "edge",
  "stop-gateway",
  "flush",
  "marker",
  "snapshot",
  "destroy",
] as const;
export type SleepPhase = (typeof SLEEP_PHASES)[number];
const STATE_DB = "state/openclaw.sqlite";
const BLOCKED_ALERT_MS = 2 * 3600_000;

export interface GateResult {
  ok: boolean;
  /** First rule that failed: "1:<blocker>", "2:ws", "3:idle", ... (§10.1 numbering). */
  rule?: string;
}

/** §10.1: every rule must hold. force skips rules 3, 4, 7 (/ops/sleep?force=1). */
export async function sleepGate(
  core: RuntimeCore,
  o: { force: boolean; inOp?: boolean },
): Promise<GateResult> {
  const now = core.now();
  const t = core.t;
  const r = core.rec();
  const b = core.boot();
  const hb = core.hb();
  const s = core.sleepRec();
  const fail = (rule: string): GateResult => {
    if (s.blockedOn !== rule) core.patchSleep({ blockedOn: rule, blockedSince: now });
    else if (s.blockedSince !== null && now - s.blockedSince >= BLOCKED_ALERT_MS && rule.startsWith("1:")) {
      core.alert("sleep-blocked", "info", rule);
      core.patchSleep({ blockedSince: now });
    }
    return { ok: false, rule };
  };
  if (!b || (!o.inOp && r.state !== "running")) return fail("0:state");
  // 8. no other op open (the sleep op itself is open when the op re-checks in phase 1).
  if (!o.inOp && (core.store.openOps().length || core.active)) return fail("8:op-open");
  let inputs: Awaited<ReturnType<RuntimeCore["d"]["ctl"]["sleepInputs"]>>;
  try {
    inputs = await core.d.ctl.sleepInputs();
  } catch (e) {
    return fail(`1:ctl-unavailable ${errorText(e).slice(0, 60)}`);
  }
  // 1. mode and blockers.
  if (inputs.mode !== "auto") return fail("1:mode-off");
  if (inputs.blockers.length) return fail(`1:${inputs.blockers[0]}`);
  // 2. no bridged WS.
  if ((core.d.bridges?.() ?? 0) > 0) return fail("2:ws");
  // 3. idle.
  if (!o.force) {
    const last = Math.max(
      r.lastActivityAt,
      hb?.gen === b.gen ? (hb.lastActivityAt ?? 0) : 0,
      b.startupzAt ?? 0,
    );
    const idle = s.cronOnly ? t.cronTailMs : (s.idleMs ?? inputs.idleBaseMs ?? t.idleMs);
    if (now - last < idle) return fail("3:idle");
    // 4. min awake.
    if (
      b.startupzAt === null ||
      b.startupzAt === undefined ||
      now - b.startupzAt < (inputs.minAwakeMs ?? t.minAwakeMs)
    )
      return fail("4:min-awake");
  }
  // 5. inbox.
  if (inputs.inboxBusy > 0) return fail("5:inbox");
  // 7. next wake far enough (cached from the last sleep-check; phase 1 re-checks). The alarm fires leadMs
  // before the job (§11.2), so the sleep is nextWakeAtMs − leadMs − now long (B2).
  if (!o.force && nextWakeTooSoon(core, s.nextWakeAtMs, now)) return fail("7:next-wake");
  // 9. cost guard.
  if (!inputs.costOk) {
    const day = utcDay(now);
    if (s.thrashAlertDay !== day) {
      core.alert("sleep-thrash", "warn", inputs.costWhy ?? "cost guard");
      core.patchSleep({ thrashAlertDay: day });
    }
    return fail("9:cost-guard");
  }
  // 10. retry waits.
  if (s.stayAwakeUntilMaint) return fail("10:snapshot-failed");
  if (s.retryAt !== null && now < s.retryAt) return fail("10:snapshot-retry");
  if (s.noSleepUntil !== null && now < s.noSleepUntil) return fail("10:abort-hold");
  // 11. replica state.
  if (hb?.gen === b.gen && (hb.rpo === "seeding" || hb.tier === "slower"))
    return fail(hb.rpo === "seeding" ? "11:seeding" : "11:tier-slower");
  if (s.blockedOn) core.patchSleep({ blockedOn: null, blockedSince: null });
  return { ok: true };
}

/** §10.1 rule 7: the sleep before the pre-wake alarm (nextWakeAtMs − leadMs) is ≤ minSleepMs. A job time
 * already past does not hold the install awake (a stuck job would block sleep forever). */
export function nextWakeTooSoon(core: RuntimeCore, next: number | null, now: number): boolean {
  if (next === null || next <= now) return false;
  return next - core.leadMs(core.sleepRec()) - now <= core.t.minSleepMs;
}

interface Flags {
  wake: boolean;
  inbox: boolean;
  sigterm: boolean;
}

async function flags(core: RuntimeCore): Promise<Flags> {
  const b = core.boot();
  const d = core.drain();
  let inbox = 0;
  try {
    inbox = await core.d.ctl.inboxPending();
  } catch {
    inbox = 0;
  }
  return {
    wake: !!core.wakeRequested(),
    inbox: inbox > 0,
    sigterm: !!(d?.sigtermAt && d.gen === b?.gen) || core.rec().state === "draining",
  };
}

/** Run or resume the sleep op from its persisted phase. */
export async function runSleep(core: RuntimeCore, op0: OpRow): Promise<OpResult> {
  try {
    return await runSleepPhases(core, op0);
  } catch (e) {
    if (e instanceof Halted) throw e;
    // An unexpected error (RPC failure, bug): never leave the gateway stopped. Resume when the op got as
    // far as stop-gateway, else cancel; retry the sleep after sleepRetryMs.
    const cur = core.store.op(op0.opId);
    if (cur?.state !== "open") throw e;
    core.ring("rt", "sleep-error", { phase: cur.phase, err: errorText(e) });
    const idx = SLEEP_PHASES.indexOf(cur.phase as SleepPhase);
    const m = (cur.args as { markerId?: string }).markerId;
    if (m) await core.d.ctl.markerVoid({ id: m, reason: "error" }).catch(() => undefined);
    if (idx >= 3 && core.d.container.running) await core.ocsupctl("resume-after-sleep", op0.opId);
    else if (idx >= 1 && core.d.container.running) await core.ocsupctl("sleep-cancel", op0.opId);
    core.store.endOp(op0.opId, "failed", { error: `error at ${cur.phase}: ${errorText(e).slice(0, 200)}` });
    core.patchSleep({ retryAt: core.now() + core.t.sleepRetryMs, markerId: null });
    core.noteAbort();
    if (core.rec().state === "quiescing")
      core.tr(39, "running", { desired: "running", lastActivityAt: core.now() });
    return "failed";
  }
}

async function runSleepPhases(core: RuntimeCore, op0: OpRow): Promise<OpResult> {
  const op = op0;
  const args = { ...(op.args as Record<string, unknown>) };
  const force = args.force === true;
  let phase = op.phase as SleepPhase;
  const c = core.d.container;
  const b = core.boot();
  if (core.rec().state !== "quiescing") core.tr(24, "quiescing", { desired: "asleep" });
  if (!b || !c.running) {
    core.store.endOp(op.opId, "failed", { error: "not running" });
    if (b) {
      const s = core.settleOf(b.gen) ?? core.lostSettle(b.gen);
      if (s) {
        core.failure(core.classifySettle(s), false, 42);
        return "failed";
      }
    }
    core.tr(39, "running", { desired: "running" });
    return "failed";
  }
  const save = (p: SleepPhase, extra: Record<string, unknown> = {}) => {
    Object.assign(args, extra);
    core.store.setPhase(op.opId, p, { args });
    phase = p;
  };
  const markerId = () => (typeof args.markerId === "string" ? args.markerId : null);
  // Journal the first phase as an update too, so a restart cut at `check` resumes it (§10.3).
  if (phase === "check" && !op.phaseAt.check_run) {
    core.store.setPhase(op.opId, "check");
  }

  const finishAbort = async (why: string, counted: boolean): Promise<OpResult> => {
    // A container that died under the op is row 42, not an abort.
    const early = await settledEarly();
    if (early) return early;
    if (core.rec().state === "draining") return sigterm();
    core.ring("rt", "sleep-abort", { phase, why: why.slice(0, 300), counted });
    core.store.endOp(op.opId, "aborted", { error: why, phase: "aborted" });
    if (counted) core.noteAbort();
    core.tr(39, "running", { desired: "running", lastActivityAt: core.now() });
    core.store.del("wakeRequested");
    return "aborted";
  };
  const abortCancel = async (why: string): Promise<OpResult> => {
    const early = await settledEarly();
    if (early) return early;
    await core.ocsupctl("sleep-cancel", op.opId);
    return finishAbort(why, true);
  };
  const abortResume = async (why: string): Promise<OpResult> => {
    const early = await settledEarly();
    if (early) return early;
    const m = markerId();
    if (m) await core.d.ctl.markerVoid({ id: m, reason: why }).catch(() => undefined);
    core.patchSleep({ markerId: null });
    save(phase, { resumeFrom: phase });
    core.store.setPhase(op.opId, "resume", { args });
    const deadline = core.now() + core.t.resumeCapMs;
    let ok = false;
    while (core.now() < deadline && c.running) {
      const r = await core.ocsupctl("resume-after-sleep", op.opId, undefined, core.t.execTimeoutMs);
      if (r.ok) {
        ok = true;
        break;
      }
      if (r.error === "draining") break;
      await core.sleep(core.t.readyPollMs);
    }
    if (ok) {
      // §10.4: wait for /startupz again within the cap.
      ok = false;
      while (core.now() < deadline && c.running) {
        if ((await core.startupz()) === "started") {
          ok = true;
          break;
        }
        await core.sleep(core.t.readyPollMs);
      }
    }
    if (ok) return finishAbort(why, true);
    // §10.4: resume failed → replace through the ladder (class exit:70, evidence per §9.3).
    core.store.endOp(op.opId, "failed", { error: `resume failed after ${why}`, phase: "resume" });
    core.noteAbort();
    await core.destroyFor("resume-failed");
    const sc = core.mkClass("exit:70", "fault", `resume-after-sleep failed (${why})`);
    sc.esc = "evidence";
    core.failure(sc, await core.isStateFault(sc), 42);
    return "failed";
  };
  const sigterm = async (): Promise<OpResult> => {
    // §10.5 / row 41: stop issuing ocsupctl; no marker; state draining.
    const m = markerId();
    if (m) await core.d.ctl.markerVoid({ id: m, reason: "sigterm" }).catch(() => undefined);
    core.patchSleep({ markerId: null });
    core.store.endOp(op.opId, "interrupted:sigterm", { phase });
    if (core.rec().state !== "draining") core.tr(41, "draining", { desired: "asleep" });
    return "interrupted:sigterm";
  };
  const settledEarly = async (): Promise<OpResult | null> => {
    const s = core.settleOf(b.gen) ?? core.lostSettle(b.gen);
    if (!s) return null;
    // Row 42: settle before phase destroy.
    const m = markerId();
    if (m) await core.d.ctl.markerVoid({ id: m, reason: "settle" }).catch(() => undefined);
    core.store.endOp(op.opId, "failed", { error: "settle before destroy", phase });
    const sc = core.classifySettle(s);
    core.failure(
      sc.cls === "planned" ? core.mkClass("unknown-platform", "infra", sc.text) : sc,
      await core.isStateFault(sc),
      42,
    );
    return "failed";
  };

  for (let guard = 0; guard < 40; guard++) {
    if (core.halted) throw new Halted();
    const idx = SLEEP_PHASES.indexOf(phase);
    if (idx < 0) {
      core.store.endOp(op.opId, "failed", { error: `bad phase ${phase}` });
      core.tr(39, "running", { desired: "running" });
      return "failed";
    }
    await sleepAtFault(core, phase);
    // Phase edge flags (phases 1-6 only; from 7 the op runs to the end).
    if (idx <= 6) {
      const early = await settledEarly();
      if (early) return early;
      const f = await flags(core);
      if (f.sigterm) return sigterm();
      if (f.wake || f.inbox) {
        const why = f.wake ? "wake" : "inbox";
        // Abort path by the last phase done: only check → none; prepare/edge → sleep-cancel;
        // stop-gateway or later → resume-after-sleep (§10.4).
        if (idx <= 1) return finishAbort(why, false);
        if (idx <= 3) return abortCancel(why);
        return abortResume(why);
      }
    }
    switch (phase) {
      case "check": {
        const g = await sleepGate(core, { force, inOp: true });
        if (!g.ok) return finishAbort(`gate ${g.rule}`, false);
        const r = await core.ocsupctl("sleep-check", op.opId);
        if (!r.ok) return finishAbort(`sleep-check ${r.error}`, false);
        const blockers = Array.isArray(r.blockers) ? r.blockers : [];
        const next = typeof r.nextWakeAtMs === "number" ? r.nextWakeAtMs : null;
        core.patchSleep({ nextWakeAtMs: next });
        if (blockers.length) {
          const k = (blockers[0] as { kind?: string }).kind ?? "busy";
          core.patchSleep({ blockedOn: `6:${k}`, blockedSince: core.sleepRec().blockedSince ?? core.now() });
          return finishAbort(`blocker ${k}`, false);
        }
        if (!force && nextWakeTooSoon(core, next, core.now())) return finishAbort("7:next-wake", false);
        save("prepare");
        continue;
      }
      case "prepare": {
        let tries = 0;
        for (;;) {
          const r = await core.ocsupctl("sleep-prepare", op.opId);
          if (r.ok && r.status === "ready") break;
          if (r.ok && r.status === "busy" && tries++ < 3) {
            await core.sleep(Math.min(Number(r.retryAfterMs ?? 1000), 30_000));
            const f = await flags(core);
            if (f.sigterm) return sigterm();
            if (f.wake || f.inbox) return abortCancel(f.wake ? "wake" : "inbox");
            continue;
          }
          return abortCancel(`sleep-prepare ${r.error ?? r.status}`);
        }
        save("edge");
        continue;
      }
      case "edge":
        save("stop-gateway");
        continue;
      case "stop-gateway": {
        const r = await pollPhase(core, "sleep-stop-gateway", op.opId, core.t.stopGatewayCapMs);
        const jobs = Array.isArray(r.eventJobs) ? r.eventJobs.length : 0;
        if (r.ok && r.clean === true && Number(r.openRows ?? 0) === 0 && jobs === 0) {
          if (typeof r.nextWakeAtMs === "number") core.patchSleep({ nextWakeAtMs: r.nextWakeAtMs });
          save("flush");
          continue;
        }
        if (r.error === "draining") return sigterm();
        if (r.error === "sleep-unclean-exit" || !r.ok)
          core.alert("sleep-unclean-exit", "warn", String(r.detail ?? r.error));
        return abortResume(r.ok ? "open-rows" : String(r.error));
      }
      case "flush": {
        const r = await pollPhase(core, "sleep-flush", op.opId, core.t.flushCapMs);
        if (!r.ok) {
          if (r.error === "draining") return sigterm();
          core.alert("sleep-flush-failed", "warn", String(r.detail ?? r.error));
          return abortResume(String(r.error));
        }
        const flush = {
          nextWakeAtMs: typeof r.nextWakeAtMs === "number" ? r.nextWakeAtMs : null,
          txid: (r.txidPerDb ?? {}) as Record<string, number>,
          bytes: (r.bytesPerDb ?? {}) as Record<string, number>,
          lastWriteAt: (r.lastWriteAtPerDb ?? {}) as Record<string, number | null>,
        };
        core.patchSleep({ nextWakeAtMs: flush.nextWakeAtMs });
        save("marker", { flush });
        continue;
      }
      case "marker": {
        const flush = args.flush as {
          txid: Record<string, number>;
          bytes: Record<string, number>;
          lastWriteAt: Record<string, number | null>;
        };
        const m = await core.d.ctl.markerPending({
          opId: op.opId,
          gen: b.gen,
          epoch: core.d.epoch,
          digest: b.digest,
          txid: flush?.txid ?? {},
          bytes: flush?.bytes ?? {},
          lastWriteAt: flush?.lastWriteAt ?? {},
        });
        const upTo = flush?.lastWriteAt?.[STATE_DB];
        if (typeof upTo === "number") await core.d.ctl.markReplicated({ upTo });
        core.patchSleep({ markerId: m.id });
        save("snapshot", { markerId: m.id });
        // A flag set while the marker was written aborts here (§10.2 row 6).
        const f = await flags(core);
        if (f.sigterm) return sigterm();
        if (f.wake || f.inbox) return abortResume(f.wake ? "wake" : "inbox");
        continue;
      }
      case "snapshot": {
        let attempt = Number(args.snapAttempt ?? 0);
        let handle: { id: string; size: number } | null = null;
        while (attempt < 3 && !handle) {
          attempt++;
          save("snapshot", { snapAttempt: attempt });
          try {
            handle = await core.snapshot("sleep", op.opId);
          } catch (e) {
            core.ring("rt", "sleep-snapshot-failed", { attempt, err: errorText(e) });
            if (!c.running) break;
            await core.sleep(Math.min(2000 * attempt, core.t.snapshotRetryCapMs));
          }
        }
        if (!handle) {
          core.snapshotFailed();
          if (!c.running) {
            const early = await settledEarly();
            if (early) return early;
          }
          return abortResume("snapshot-failed");
        }
        // Save the handle BEFORE destroy; marker → valid.
        await core.d.ctl.snapshotSaved({
          id: handle.id,
          size: handle.size,
          digest: b.digest,
          imageKey: b.imageKey,
          gen: b.gen,
          epoch: core.d.epoch,
          kind: "sleep",
          opId: op.opId,
          parentId: b.snapshotId ?? null,
        });
        const m = markerId();
        if (m) await core.d.ctl.markerValid({ id: m, snapshotId: handle.id });
        core.patchSleep({ snapshotId: handle.id, markerId: m });
        save("destroy", { snapshotId: handle.id, snapshotBytes: handle.size });
        continue;
      }
      case "destroy": {
        core.d.closeBridges?.(1012, "sleep");
        // docs/12: the sandbox sleeps with the install (it backs up /workspace first). Not awaited.
        core.d.sandboxSleep?.();
        const settled = await core.destroyFor("sleep");
        core.recordStop(core.mkClass("planned", "none", "sleep", settled), false);
        const now = core.now();
        core.store.endOp(op.opId, "done", {
          phase: "done",
          result: { settled, snapshotId: args.snapshotId },
        });
        core.patchSleep({ lastSleepAt: now, cronOnly: false });
        if (settled) {
          const reset = resetLadder(core.ladder());
          if (reset) core.putLadder(reset);
          core.tr(37, "asleep", { desired: "asleep" });
        } else {
          core.store.put("zombieSince", now);
          core.tr(38, "asleep-unconfirmed", { desired: "asleep" });
        }
        const hb = core.hb();
        await core.d.ctl
          .onSlept({
            gen: b.gen,
            sleptAt: now,
            snapshotBytes: typeof args.snapshotBytes === "number" ? args.snapshotBytes : null,
            sleepMs: now - op.createdAt,
            cpuS: hb?.gen === b.gen ? hb.cpuS : null,
          })
          .catch(() => undefined);
        if (settled) {
          await core.scheduleAsleep();
          const w = core.wakeRequested();
          if (w) await core.wakeFromAsleep(w.reason);
        }
        return "done";
      }
    }
  }
  core.store.endOp(op.opId, "failed", { error: "phase loop" });
  return "failed";
}

/** Long phases poll the same idempotent call (§10.2): an exec timeout means "ask again". */
async function pollPhase(core: RuntimeCore, op: string, opId: string, capMs: number) {
  const deadline = core.now() + capMs;
  let last: Record<string, unknown> & { ok: boolean; error?: string } = { ok: false, error: "timeout" };
  while (core.now() < deadline) {
    last = await core.ocsupctl(op, opId);
    if (!(last as { execFailed?: boolean }).execFailed && last.error !== "busy") return last;
    if (!core.d.container.running) return { ok: false, error: "not-running" };
    await core.sleep(core.t.readyPollMs);
  }
  return last;
}

/** M4 drills (OC_TEST only): kill, signal or hold the op when it reaches `phase`. One shot. */
async function sleepAtFault(core: RuntimeCore, phase: SleepPhase): Promise<void> {
  const f = core.d.faults;
  const x = f?.sleepAt;
  if (!f || !x || x.phase !== phase) return;
  f.sleepAt = null;
  core.ring("rt", "fault", { name: "sleep-at", phase, action: x.action, at: core.now() });
  const c = core.d.container;
  if (x.action === "hold") await core.sleep(x.ms);
  else if (x.action === "sigterm") c.signal(15);
  else {
    c.signal(9);
    if (x.action !== "hostkill") return;
    // Host loss: the container dies and the DO restarts with it. Wait for the kill to land (and the ring row
    // to reach the Control DO) before the abort; storage writes not yet confirmed are lost, as on a host loss.
    const t0 = core.now();
    while (c.running && core.now() - t0 < 10_000) await core.sleep(250);
    await core.sleep(1000);
    f.abort?.("hostkill fault");
  }
}
