// Runtime core: the state machine behind the Runtime DO (spec 08 §4, §5, §7-§11). Pure over injected
// deps (container port, storage, clock, Control DO RPC), so the fake container drives it in tests.
// One op runs at a time (§7). Heartbeats and events only record; ops and ticks act.
import type { Clock, ContainerPort } from "../core/container-port";
import { withTimeout } from "../core/container-port";
import type { Timers } from "../core/timers";
import type {
  BeginBootResult,
  ControlForRuntime,
  InstanceSpec,
  Mode,
  RtState,
  Severity,
  WakeReason,
} from "../core/types";
import { AWAKE_STATES } from "../core/types";
import { ALREADY_RE, CAPACITY_RE, classifyStop, errorText, SNAPSHOT_RE, type StopClass } from "./classify";
import { ExclusiveQueue } from "./exclusive";
import { type Faults, setFault } from "./faults";
import {
  applyFailure,
  DOCTOR_SKIP_AFTER,
  type Ladder,
  l5Due,
  maybeReset,
  newLadder,
  noteDoctorFail,
  SLOW_ALERT_MS,
  SNAPSHOT_REPLAN_CAP,
  skipDoctorDigest,
  UPGRADE_REGRESSION_MS,
  wakeRetryAt,
} from "./ladder";
import { row } from "./machine";
import {
  type Boot,
  type CkptRec,
  type Desired,
  type Drain,
  type Hb,
  K,
  type Liveness,
  newSleep,
  type Rec,
  type SleepRec,
  utcDay,
} from "./records";
import { DEFAULT_RT_TIMERS, type RtTimers } from "./rt-timers";
import { runSleep, sleepGate } from "./sleep";
import { type OpKind, type OpRow, RtStore, type StorageLike } from "./store";

export const GATEWAY_PORT = 18789;
export const CONTROL_ADDR = "15.0.0.1:80";
export const REPLICA_ADDR = "15.0.0.2:80";
export const CAP_ADDR = "15.0.0.3:80";
export const SBX_ADDR = "15.0.0.4:80";
export const ROOT = "0:0";
/** Absolute paths only (F-SEC-1). */
/** S0.3: heartbeat phases in which the gateway is stopping, stopped or starting (image/ocrt/lib/main.mjs). */
export const GATEWAY_DOWN_PHASES = ["gateway-restart", "gateway-start", "asleep-ready", "exit", "fenced"];
export const OCSUPCTL = ["/usr/local/bin/node", "/opt/ocrt/ocsupctl.mjs"];
export const BOOT_JSON = "/run/ocrt/boot.json";

export interface GateProps {
  v: 1;
  inst: string;
  epoch: number;
  gen: number;
  mode: Mode;
  bootSecret: string;
  restoreGens: number[];
  test?: boolean;
}

export interface AlarmPort {
  set(at: number): Promise<void> | void;
  get(): Promise<number | null> | number | null;
  delete(): Promise<void> | void;
}

export interface RtDeps {
  inst: string;
  epoch: number;
  container: ContainerPort;
  storage: StorageLike;
  clock: Clock;
  timers: Timers;
  ctl: ControlForRuntime;
  gates: {
    control(p: GateProps): Fetcher;
    replica(p: GateProps): Fetcher;
    /** CapGate at 15.0.0.3 (D14). Optional: a failed registration never blocks start. */
    cap?(p: GateProps): Fetcher;
    /** SandboxGate at 15.0.0.4 (docs/12). Optional like cap. */
    sbx?(p: GateProps): Fetcher;
    /** Test groups only: HTTPS intercepts host → fake (api.telegram.org, LLM host). */
    test?: Record<string, (p: GateProps) => Fetcher>;
  };
  /** /ops/fault hooks (OC_TEST=1). */
  faults?: Faults;
  alarm: AlarmPort;
  instance: InstanceSpec;
  /** OC_* SecretRefs and other env passed to start() (never stored). */
  secretEnv(): Record<string, string>;
  codeVersion: string;
  /** C15: exitCode rejects count as confirmed (false until T1). */
  exitCodeConfirms?: boolean;
  /** Bridged WS count (sleep gate rule 2). */
  bridges?: () => number;
  /** Close bridged WS with 1012 (stop, sleep). */
  closeBridges?: (code: number, reason: string) => void;
  /** M4 timers (rt/rt-timers.ts); defaults when absent. */
  rtTimers?: Partial<RtTimers>;
  /** docs/12: the install sleeps → the sandbox backs up and sleeps too. Best effort, never awaited by the op. */
  sandboxSleep?: () => void;
  /** A Worker deploy came after this DO was built (its container image map is old). rt/runtime.ts buildStale. */
  buildStale?: () => boolean;
  /** Reset this DO instance so the next one reads the deployed code, env and image map (ctx.abort). */
  recycle?: () => void;
}

type Settle = { gen: number; outcome: "resolved" | "rejected"; err?: unknown; at: number };
type OpResult = "done" | "failed" | "aborted" | "interrupted:sigterm" | "waiting";

/** Runtime DO re-reads the settings document at most this often (ms). */
export const SETTINGS_CACHE_MS = 10_000;

const SLEEP_LIKE = new Set(["sleep", "stop", "retire", "replace"]);

export class RuntimeCore {
  readonly store: RtStore;
  readonly queue = new ExclusiveQueue();
  /** In-memory op runner (one at a time). */
  active: { opId: string; kind: OpKind; p: Promise<OpResult> } | null = null;
  /** Pre-emption request for the active/open start op (§7). */
  preempt: "retire" | "stop" | null = null;
  private monitorGen: number | null = null;
  private settled: Settle | null = null;
  private pendingSettle: Settle | null = null;
  private settleWaiters: ((s: Settle) => void)[] = [];
  private snapshotMutex: Promise<unknown> = Promise.resolve();
  private tickRunning = false;
  /** Set by halt(): this instance is gone (tests model a DO restart); loops stop at the next await. */
  halted = false;
  readonly t: Timers;
  readonly rt: RtTimers;
  /** Timers before the settings document (env, test preset); the document overlays them. */
  private readonly t0: Timers;
  private readonly rt0: RtTimers;
  private settingsAt = Number.NEGATIVE_INFINITY;
  private settingsVer = -1;

  constructor(readonly d: RtDeps) {
    this.t = d.timers;
    this.rt = { ...DEFAULT_RT_TIMERS, ...(d.rtTimers ?? {}) };
    this.t0 = { ...this.t };
    this.rt0 = { ...this.rt };
    this.store = new RtStore(d.storage, () => d.clock.now());
  }

  now() {
    return this.d.clock.now();
  }

  /**
   * Settings document → timers, at the start of every op and alarm tick. Cached SETTINGS_CACHE_MS. The Control
   * DO is the source; when it does not answer the last values stay. Mutates `t` and `rt` in place, so the
   * WS bridge watch that holds `rt` sees a change too.
   */
  async refreshSettings(): Promise<void> {
    const now = this.now();
    if (!this.d.ctl.settingsView || now - this.settingsAt < SETTINGS_CACHE_MS) return;
    this.settingsAt = now;
    try {
      const v = await this.d.ctl.settingsView();
      if (v.ver === this.settingsVer) return;
      this.settingsVer = v.ver;
      Object.assign(this.t, this.t0, v.t);
      Object.assign(this.rt, this.rt0, v.rt);
      this.ring("rt", "settings", { ver: v.ver });
    } catch {
      // Control DO unavailable: keep the last values; the next op asks again
      this.settingsAt = Number.NEGATIVE_INFINITY;
    }
  }

  /** Test hook for a DO restart: the old instance stops acting. */
  halt() {
    this.halted = true;
  }

  /** clock.sleep that ends the caller when the instance halted. */
  async sleep(ms: number): Promise<void> {
    await this.d.clock.sleep(ms);
    if (this.halted) throw new Halted();
  }

  // ---------------------------------------------------------------- records

  rec(): Rec {
    const r = this.store.get<Rec>(K.rec);
    if (r) return r;
    return {
      v: 1,
      inst: this.d.inst,
      epoch: this.d.epoch,
      desired: null,
      state: "new",
      stateAt: this.now(),
      row: null,
      degraded: false,
      degradedWhy: [],
      epochStatus: "unknown",
      epochCheckedAt: 0,
      runningSince: null,
      lastActivityAt: this.now(),
    };
  }
  putRec(r: Rec) {
    this.store.put(K.rec, r);
  }
  patchRec(p: Partial<Rec>) {
    const r = { ...this.rec(), ...p };
    this.putRec(r);
    return r;
  }
  boot(): Boot | undefined {
    return this.store.get<Boot>(K.boot);
  }
  patchBoot(p: Partial<Boot>) {
    const b = this.boot();
    if (b) this.store.put(K.boot, { ...b, ...p });
  }
  ladder(): Ladder {
    return { ...newLadder(), ...(this.store.get<Ladder>(K.ladder) ?? {}) };
  }
  putLadder(l: Ladder) {
    this.store.put(K.ladder, l);
  }
  hb(): Hb | undefined {
    return this.store.get<Hb>(K.hb);
  }
  drain(): Drain | undefined {
    return this.store.get<Drain>(K.drain);
  }
  sleepRec(): SleepRec {
    return { ...newSleep(), ...(this.store.get<SleepRec>(K.sleep) ?? {}) };
  }
  patchSleep(p: Partial<SleepRec>) {
    const s = { ...this.sleepRec(), ...p };
    this.store.put(K.sleep, s);
    return s;
  }
  liveness(): Liveness {
    return {
      healthzFails: 0,
      lastIdentityAt: null,
      lastReadyzAt: null,
      readyzBadSince: null,
      ...(this.store.get<Liveness>(K.liveness) ?? {}),
    };
  }
  wakeRequested(): { reason: string; at: number } | undefined {
    return this.store.get(K.wakeRequested);
  }

  /** Take machine row `id` (§5.2): set the state to the row's next (or `to` when the row has several). */
  tr(id: number, to?: RtState, p: Partial<Rec> = {}): Rec {
    const rw = row(id);
    const next = to ?? (rw.next === "*" ? undefined : rw.next);
    if (!next) throw new Error(`row ${id} needs a target state`);
    const r = this.rec();
    const out: Rec = { ...r, ...p, row: id };
    if (next !== r.state) {
      out.state = next;
      out.stateAt = this.now();
    }
    if (next === "running" && r.state !== "running") out.runningSince ??= this.now();
    if (next !== "running" && next !== "maintenance") out.runningSince = null;
    this.putRec(out);
    this.ring("rt", "row", { row: id, from: r.state, to: next });
    if (next !== r.state && this.d.ctl.noteRtState) {
      try {
        void Promise.resolve(this.d.ctl.noteRtState(this.d.epoch, next)).catch(() => undefined);
      } catch {
        // fire-and-forget
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- side channels (never throw)

  ring(src: string, kind: string, detail?: unknown) {
    void this.d.ctl.ring({ src, kind, detail }).catch(() => undefined);
  }
  alert(cls: string, severity: Severity, detail?: string) {
    void this.d.ctl.alert({ class: cls, severity, detail }).catch(() => undefined);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Constructor work (blockConcurrencyWhile). §5.2 rows 35, 48, 58; §10.3; §11.6. */
  async init(): Promise<void> {
    const r = this.rec();
    if (!this.store.get(K.rec)) this.putRec(r);
    const c = this.d.container;
    // DO (re)start marker: shows a deploy or eviction restart and which ops resume (§10.3).
    this.ring("rt", "init", {
      state: r.state,
      running: c.running,
      codeVersion: this.d.codeVersion,
      ops: this.store.openOps().map((o) => `${o.kind}:${o.phase}`),
    });
    // §11.6: set the inactivity timeout in the constructor.
    if (c.running) await this.inactivity();
    // §10.3 phase 7 / §11.1 step 3: a snapshot call cannot survive a restart.
    const inflight = this.store.get<{ startedAt: number; kind: string; opId?: string }>(K.snapshotInFlight);
    if (inflight) {
      this.store.del(K.snapshotInFlight);
      this.ring("rt", "orphan?", inflight);
    }
    const boot = this.boot();
    // Row 58: persisted epoch status retiring/retired and a running container.
    if ((r.epochStatus === "retiring" || r.epochStatus === "retired") && r.state !== "retired") {
      if (c.running) await this.destroyFor("retired");
      this.tr(58, "retired", { desired: "retired" });
      await this.arm();
      return;
    }
    if (r.state === "asleep" && c.running) {
      // Row 48: zombie, never adopted (add §2.9).
      await this.destroyFor("stale");
      this.store.put(K.zombieSince, this.now());
      this.tr(48);
    } else if (r.state === "draining" && !c.running) {
      // Row 35.
      this.recordStop(this.mkClass("platform", "zero", "drained while the DO was down", true), false);
      this.setNextStart(this.now());
      this.tr(35);
    } else if (c.running && boot) {
      this.armMonitor(boot.gen);
    }
    const r1 = this.rec();
    if (r1.state === "stopped" && r1.desired === "running" && !this.store.openOp("start")) {
      // A restart cut by a DO reset after row 53 (live oc-host 2026-11-10). Journal the start; the tick runs it.
      this.startOp("user", "running");
      this.ring("rt", "restart-resumed", { at: "init" });
    }
    await this.arm(this.store.openOps().length ? this.now() + this.t.opTickMs : undefined);
  }

  // ---------------------------------------------------------------- container helpers

  async inactivity(): Promise<void> {
    try {
      await this.d.container.setInactivityTimeout(this.t.inactivityMs);
    } catch (e) {
      this.ring("rt", "inactivity-set-failed", errorText(e));
    }
  }

  armMonitor(gen: number) {
    if (this.monitorGen === gen) return;
    this.monitorGen = gen;
    this.settled = null;
    let p: Promise<void>;
    try {
      p = this.d.container.monitor();
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      () => this.onSettle({ gen, outcome: "resolved", at: this.now() }),
      (err) => this.onSettle({ gen, outcome: "rejected", err, at: this.now() }),
    );
  }

  private onSettle(s: Settle) {
    const boot = this.boot();
    if (!boot || boot.gen !== s.gen) {
      this.ring("rt", "settle-stale", { gen: s.gen, text: errorText(s.err) });
      return;
    }
    this.settled = s;
    this.monitorGen = null;
    this.patchBoot({ settledAt: s.at });
    const w = this.settleWaiters.splice(0);
    for (const f of w) f(s);
    // An active op handles its own settle; else handle it here. If the op ends without handling it
    // (it had passed its last check), kick() runs it from pendingSettle.
    if (this.active) this.pendingSettle = s;
    else this.queueSettle(s);
  }

  private queueSettle(s: Settle) {
    this.pendingSettle = null;
    void this.queue.run(() => this.handleSettle(s)).catch((e) => this.ring("rt", "error", errorText(e)));
  }

  /** The settle of the current boot, if any. */
  settleOf(gen: number | undefined): Settle | null {
    return this.settled && this.settled.gen === gen ? this.settled : null;
  }

  /** Wait for a settle of the current boot up to ms. */
  async waitSettle(gen: number, ms: number): Promise<Settle | null> {
    const s = this.settleOf(gen);
    if (s) return s;
    if (!this.d.container.running && this.monitorGen === null) return null;
    const p = new Promise<Settle>((res) => this.settleWaiters.push(res));
    const r = await withTimeout(this.d.clock, p, ms);
    return r.timeout ? this.settleOf(gen) : r.value;
  }

  /** destroy() with the 30 s timer and the stuck-slot count (§9.4). Returns settled. */
  async destroyFor(reason: string): Promise<boolean> {
    const boot = this.boot();
    if (boot) this.patchBoot({ destroyedAt: this.now() });
    this.d.closeBridges?.(1012, reason);
    let r: { timeout: boolean };
    try {
      r = await withTimeout(this.d.clock, this.d.container.destroy(reason), this.t.destroyTimeoutMs);
    } catch (e) {
      this.ring("rt", "destroy-error", errorText(e));
      r = { timeout: false };
    }
    if (r.timeout) {
      this.ring("rt", "destroy-timeout", { reason });
      await this.stuck("destroy");
      return false;
    }
    if (!this.d.container.running) return true;
    const s = boot ? await this.waitSettle(boot.gen, this.t.settleCapMs) : null;
    return !!s || !this.d.container.running;
  }

  /** §9.4 stuck-slot escape: 3 in a row → Control DO reslot. */
  async stuck(what: string): Promise<boolean> {
    const l = this.ladder();
    l.hungDestroys++;
    this.putLadder(l);
    this.ring("rt", "stuck", { what, count: l.hungDestroys });
    if (l.hungDestroys < 3) return false;
    l.hungDestroys = 0;
    this.putLadder(l);
    this.alert("reslot", "high", `stuck slot: ${what}`);
    // Not awaited: the Control DO's reslot op calls this DO's retire(), which waits for the running op.
    void Promise.resolve()
      .then(() => this.d.ctl.reslot({ epoch: this.d.epoch, why: `stuck:${what}` }))
      .catch((e) => this.ring("rt", "reslot-failed", errorText(e)));
    return true;
  }

  async exec(cmd: string[], timeoutMs = this.t.execTimeoutMs) {
    if (this.halted) throw new Halted();
    const r = await withTimeout(
      this.d.clock,
      this.d.container.exec(cmd, { user: ROOT, timeoutMs }),
      timeoutMs,
    );
    if (this.halted) throw new Halted();
    if (r.timeout) throw new Error(`exec timeout: ${cmd.slice(-3).join(" ")}`);
    return r.value;
  }

  /** `ocsupctl <op> --op-id <id> [--json args]` as root. Answer JSON; ok:false on exec error. */
  async ocsupctl(op: string, opId?: string, args?: Record<string, unknown>, timeoutMs?: number) {
    const cmd = [...OCSUPCTL, op];
    if (opId) cmd.push("--op-id", opId);
    if (args) cmd.push("--json", JSON.stringify(args));
    try {
      const r = await this.exec(cmd, timeoutMs);
      const line = r.stdout.trim().split("\n").pop() ?? "";
      try {
        return JSON.parse(line) as Record<string, unknown> & { ok: boolean; error?: string };
      } catch {
        return {
          ok: false,
          error: "failed",
          detail: `exit ${r.exitCode}: ${r.stderr.slice(0, 200)}`,
          execFailed: true,
        };
      }
    } catch (e) {
      if (e instanceof Halted) throw e;
      return { ok: false, error: "exec", detail: errorText(e), execFailed: true };
    }
  }

  /** One snapshotContainer at a time (§15.1): in-memory mutex + persisted snapshotInFlight. */
  async snapshot(kind: string, opId: string | null, timeoutMs = this.t.finalSnapshotMs) {
    const run = async () => {
      this.store.put(K.snapshotInFlight, { startedAt: this.now(), kind, opId });
      try {
        const r = await withTimeout(
          this.d.clock,
          this.d.container.snapshot(`oc-${kind}-${this.now()}`),
          timeoutMs,
        );
        if (r.timeout) throw new Error("snapshot timeout");
        return r.value;
      } finally {
        this.store.del(K.snapshotInFlight);
      }
    };
    const p = this.snapshotMutex.then(run, run);
    this.snapshotMutex = p.catch(() => undefined);
    return p;
  }

  // ---------------------------------------------------------------- ops

  /** Journal an op (attach when the id is open) and run it when free. */
  openOp(kind: OpKind, reason: string | null, args: Record<string, unknown> = {}, opId?: string): OpRow {
    // Random part first: the Control DO derives marker ids from an op id prefix.
    const id = opId ?? `${kind}-${crypto.randomUUID().replace(/-/g, "")}`;
    const first =
      kind === "start" ? "phase0" : kind === "sleep" ? "check" : kind === "checkpoint" ? "dirty" : "preempt";
    const { op } = this.store.createOp({
      opId: id,
      kind,
      reason,
      args,
      phase: kind === "maint" ? "probe" : first,
    });
    return op;
  }

  /** Start the first open op if none runs. Waiting-capacity start ops wait for nextStartAt. */
  kick(): Promise<OpResult> | null {
    if (this.active) return this.active.p;
    const open = this.store.openOps();
    const r = this.rec();
    const op =
      open.find((o) => o.kind === "retire") ??
      open.find((o) => o.kind === "stop") ??
      open.find(
        (o) =>
          !(o.kind === "start" && r.state === "waiting-capacity" && this.now() < this.ladder().nextStartAt),
      );
    if (!op) return null;
    const p = this.queue
      .run(() => this.runOp(op))
      .catch((e): OpResult => {
        if (e instanceof Halted) return "waiting";
        this.ring("rt", "op-crash", { opId: op.opId, err: errorText(e) });
        // A crashed op must not loop: end it and take the failure path (the ladder never parks).
        try {
          this.store.endOp(op.opId, "failed", { error: `crash: ${errorText(e).slice(0, 300)}` });
          const st = this.rec().state;
          if (op.kind === "start" && st === "starting")
            this.failure(this.mkClass("op-crash", "infra", errorText(e)), false, 11);
          else if (op.kind === "sleep" && st === "quiescing") {
            this.patchSleep({ retryAt: this.now() + this.t.sleepRetryMs });
            this.tr(39, "running", { desired: "running", lastActivityAt: this.now() });
          }
        } catch (e2) {
          this.ring("rt", "op-crash-handler", errorText(e2));
        }
        return "failed";
      })
      .finally(() => {
        if (this.active?.opId === op.opId) this.active = null;
        if (this.halted) return;
        // Storage can be gone here (DO reset during the op); never leave a floating rejection.
        try {
          const ps = this.pendingSettle;
          if (ps && this.boot()?.gen === ps.gen) this.queueSettle(ps);
          else this.pendingSettle = null;
          this.arm().catch(() => undefined);
          if (this.store.openOps().some((o) => o.opId !== op.opId)) this.kick();
        } catch (e) {
          try {
            this.ring("rt", "op-finally", errorText(e));
          } catch {
            // storage gone: the next DO instance resumes the op from the journal
          }
        }
      });
    this.active = { opId: op.opId, kind: op.kind, p };
    return p;
  }

  /** Wait for every queued op and settle handler (tests and RPCs that need the result). */
  async drainOps(maxRounds = 50): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const a = this.active;
      if (a) await a.p;
      await this.queue.run(async () => undefined);
      if (!this.active) return;
    }
  }

  private async runOp(op: OpRow): Promise<OpResult> {
    await this.refreshSettings();
    const cur = this.store.op(op.opId);
    if (cur?.state !== "open") return "done";
    switch (cur.kind) {
      case "start":
        return this.runStart(cur);
      case "sleep":
        return runSleep(this, cur);
      case "stop":
        return this.runStop(cur);
      case "retire":
        return this.runRetire(cur);
      case "maint":
        return this.runMaint(cur);
      case "replace":
        return this.runReplace(cur);
      case "checkpoint":
        return this.runCheckpoint(cur);
      default:
        this.store.endOp(cur.opId, "failed", { error: `unknown kind ${cur.kind}` });
        return "failed";
    }
  }

  // ---------------------------------------------------------------- start op (§8)

  /** Journal a start op unless one is open; desired as given. */
  startOp(reason: string, desired: Desired, extra: Record<string, unknown> = {}): OpRow {
    const open = this.store.openOp("start");
    if (open) return open;
    this.patchRec({ desired });
    const op = this.openOp("start", reason, { reason, ...extra });
    if (reason.startsWith("wake:")) this.adaptIdle(reason);
    return op;
  }

  /** Adaptive idle (§10.1): a demand wake < 10 min after the last sleep doubles idleMs (cap 60 min);
   * a sleep > 60 min resets it. Once per sleep period; maintenance wakes do not count. */
  adaptIdle(reason: string) {
    if (reason === "wake:maint") return;
    const s = this.sleepRec();
    const adapted = this.store.get<number>("idleAdaptedFor");
    if (s.lastSleepAt === null || adapted === s.lastSleepAt) {
      if (reason !== "wake:cron") this.patchSleep({ cronOnly: false });
      return;
    }
    const base = this.t.idleMs;
    let idle = s.idleMs ?? base;
    const asleepFor = this.now() - s.lastSleepAt;
    if (asleepFor < 10 * 60_000) idle = Math.min(idle * 2, this.t.idleCapMs);
    else if (asleepFor > 60 * 60_000) idle = base;
    this.store.put("idleAdaptedFor", s.lastSleepAt);
    this.patchSleep({ idleMs: idle, cronOnly: reason === "wake:cron", wakeReason: reason });
  }

  private async runStart(op: OpRow): Promise<OpResult> {
    let phase = op.phase;
    const args = op.args as Record<string, unknown> & {
      replan?: boolean;
      missed?: string[];
      noSnapshot?: boolean;
    };
    const reason = String(op.reason ?? args.reason ?? "user");
    const c = this.d.container;
    if (this.rec().state !== "starting") this.tr(this.startRowFor(reason), "starting");
    // Each replan costs ~5 rounds; SNAPSHOT_REPLAN_CAP misses then the no-snapshot plan fit well inside.
    for (let guard = 0; guard < 40; guard++) {
      if (this.halted) throw new Halted();
      if (this.preempt) return this.abortStart(op, this.preempt);
      if (this.drain()?.sigtermAt && this.boot()?.gen && this.drain()?.gen === this.boot()?.gen) {
        if (phase === "armed" || phase === "ready") return this.sigtermDuringStart(op);
      }
      switch (phase) {
        case "phase0": {
          if (c.running) {
            const ins = await withTimeout(this.d.clock, c.inspect(), this.t.inspectTimeoutMs);
            if (ins.timeout) {
              await this.stuck("inspect");
              return this.failStart(op, this.mkClass("hung-inspect", "infra"), false);
            }
            const boot = this.boot();
            if (ins.value && boot && labelsEq(ins.value.labels, boot.labels)) {
              if (boot.startupzAt && !this.settleOf(boot.gen)) {
                // §8.1 phase 0: live boot already running → no-op.
                this.armMonitor(boot.gen);
                this.store.del(K.wakeRequested);
                this.store.endOp(op.opId, "done", { phase: "done", result: { noop: true } });
                this.tr(3, "running");
                return "done";
              }
              this.armMonitor(boot.gen);
              phase = "armed";
              this.store.setPhase(op.opId, phase);
              continue;
            }
            // A container with other labels: rows 8-9 shape before any plan.
            return this.staleSlot(op);
          }
          phase = "plan";
          this.store.setPhase(op.opId, phase);
          continue;
        }
        case "plan": {
          const l = this.ladder();
          let res: BeginBootResult;
          try {
            res = await this.d.ctl.beginBoot({
              epoch: this.d.epoch,
              mode: "prod",
              opId: op.opId,
              reason,
              replan: !!args.replan,
              ladder: l.level,
              runDoctor: l.doctorPending,
              skipDoctorDigest: skipDoctorDigest(l),
              missed: args.missed ?? [],
              l1SnapshotId: l.l1SnapshotId ?? undefined,
              rebase: !!args.rebase,
              noSnapshot: !!args.noSnapshot,
              liveImages: this.liveImages(),
            });
          } catch (e) {
            return this.failStart(op, this.mkClass("ctl-unavailable", "infra", errorText(e)), false);
          }
          if (res.error === "epoch-not-active") {
            this.store.endOp(op.opId, "aborted", { error: res.error });
            this.patchRec({ epochStatus: "retired", desired: "retired" });
            this.tr(2, "retired");
            return "aborted";
          }
          const skip = skipDoctorDigest(l);
          const runDoctor = !!res.plan?.runDoctor || (l.doctorPending && skip !== res.digest);
          const labels = {
            inst: this.d.inst,
            epoch: String(this.d.epoch),
            gen: String(res.gen),
            mode: "prod",
          };
          const prev = this.boot();
          const boot: Boot = {
            v: 1,
            opId: op.opId,
            gen: res.gen,
            iid: prev?.gen === res.gen ? prev.iid : null,
            secret: res.secret,
            restoreGens: res.restoreGens,
            mode: "prod",
            labels,
            planKind: res.plan?.sqlite?.kind ?? "unknown",
            markerId: res.markerId ?? null,
            ...(res.adoptedEnv ? { adoptedEnv: res.adoptedEnv } : {}),
            snapshotId:
              res.plan?.rootfs?.kind === "snapshot" ? (res.plan.rootfs.snapshotId ?? res.snapshotId) : null,
            rootfsAt: typeof res.plan?.rootfs?.at === "number" ? res.plan.rootfs.at : null,
            imageKey: res.imageKey,
            digest: res.digest,
            reason,
            runDoctor,
            wakeAt: op.createdAt,
            phase: "boot",
            phaseAt: this.now(),
          };
          // §8.4: persist boot before any platform call.
          this.store.tx(() => {
            if (prev && prev.digest !== boot.digest) this.store.put("digestChangedAt", this.now());
            this.store.put(K.boot, boot);
            this.store.del(K.drain);
            this.store.del(K.hb);
            this.store.setPhase(op.opId, "persist", {
              args: { ...args, gen: res.gen, rootfs: res.plan?.rootfs },
            });
          });
          if (res.plan?.sqlite?.kind === "restore-blocked") {
            // Row 10 (C24): no start(); class = reason.
            const why = (res.plan.sqlite as { reason: string }).reason;
            if (args.noSnapshot)
              this.alert("snapshots-lost", "high", (res.plan.sqlite as { detail?: string }).detail ?? why);
            const sc = classifyStop({ outcome: "rejected", exitEvent: { code: 75, reason: why } });
            this.alert("restore-blocked", "high", why);
            return this.failStart(op, sc, sc.esc === true, 10);
          }
          phase = "persist";
          continue;
        }
        case "persist":
          phase = "intercepts";
          this.store.setPhase(op.opId, phase);
          continue;
        case "intercepts":
          await this.registerIntercepts();
          phase = "start";
          this.store.setPhase(op.opId, phase);
          continue;
        case "start": {
          const out = await this.callStart(op, args);
          if (out === "armed") {
            phase = "armed";
            continue;
          }
          if (out === "replan") {
            phase = "plan";
            args.replan = true;
            continue;
          }
          return out;
        }
        case "armed":
        case "ready":
          return this.readiness(op, phase);
        default:
          this.store.endOp(op.opId, "failed", { error: `bad phase ${phase}` });
          return "failed";
      }
    }
    return this.failStart(op, this.mkClass("start-loop", "infra"), false);
  }

  private startRowFor(reason: string): number {
    const st = this.rec().state;
    if (st === "new") return 1;
    if (st === "waiting-capacity") return 5;
    if (st === "backoff") return reason.startsWith("wake") ? 14 : 13;
    if (st === "asleep") return 43;
    if (st === "stopped") return 55;
    return 1;
  }

  async registerIntercepts(): Promise<void> {
    const b = this.boot();
    if (!b) return;
    const props: GateProps = {
      v: 1,
      inst: this.d.inst,
      epoch: this.d.epoch,
      gen: b.gen,
      mode: b.mode,
      bootSecret: b.secret,
      restoreGens: b.restoreGens,
    };
    await this.d.container.interceptOutboundHttp(CONTROL_ADDR, this.d.gates.control(props));
    await this.d.container.interceptOutboundHttp(REPLICA_ADDR, this.d.gates.replica(props));
    if (this.d.gates.cap) {
      try {
        await this.d.container.interceptOutboundHttp(CAP_ADDR, this.d.gates.cap(props));
      } catch (e) {
        this.ring("rt", "cap-intercept-skipped", { err: errorText(e) });
      }
    }
    if (this.d.gates.sbx) {
      try {
        await this.d.container.interceptOutboundHttp(SBX_ADDR, this.d.gates.sbx(props));
      } catch (e) {
        this.ring("rt", "sbx-intercept-skipped", { err: errorText(e) });
      }
    }
    for (const [host, mk] of Object.entries(this.d.gates.test ?? {})) {
      try {
        await this.d.container.interceptOutboundHttps?.(host, mk(props));
      } catch (e) {
        this.ring("rt", "test-intercept-skipped", { host, err: errorText(e) });
      }
    }
  }

  /** Phase `start` (§8.4). */
  private async callStart(
    op: OpRow,
    args: Record<string, unknown> & { missed?: string[] },
  ): Promise<OpResult | "armed" | "replan"> {
    const b = this.boot();
    if (!b) return this.failStart(op, this.mkClass("no-boot", "infra"), false);
    const c = this.d.container;
    const images = c.images();
    if (!(b.imageKey in images)) {
      // §9.1 image-key-missing: slow + high alert, no ladder level change.
      this.alert("image-key-missing", "high", b.imageKey);
      return this.failStart(op, this.mkClass("image-key-missing", "slow"), false);
    }
    // start() takes the image reference (images()[key]), not the key: "No such image available named oc"
    // under wrangler dev with the key (spike rt/core.ts does the same lookup).
    const source = b.snapshotId ? { snapshotId: b.snapshotId } : { image: images[b.imageKey] ?? b.imageKey };
    try {
      const r = await withTimeout(
        this.d.clock,
        Promise.resolve(
          c.start({
            source,
            instance: this.d.instance,
            enableInternet: b.mode === "prod",
            env: {
              // Adopted channel credentials first: a Worker secret of the same name wins.
              ...(b.adoptedEnv ?? {}),
              ...this.d.secretEnv(),
              OCRT_INST: this.d.inst,
              OCRT_GEN: String(b.gen),
              OCRT_EPOCH: String(this.d.epoch),
              OCRT_BOOT_SECRET: b.secret,
              OCRT_DIGEST: b.digest,
              OCRT_MODE: b.mode,
              ...(b.snapshotId ? { OCRT_SNAPSHOT_ID: b.snapshotId } : {}),
            },
            labels: b.labels,
          }),
        ),
        this.startTimeout(b),
      );
      if (r.timeout) {
        await this.stuck("start");
        return this.failStart(op, this.mkClass("hung-start", "infra"), false);
      }
    } catch (e) {
      const text = errorText(e);
      if (CAPACITY_RE.test(text)) return this.capacity(op);
      if (SNAPSHOT_RE.test(text)) return this.snapshotLost(op, args, b.snapshotId ?? "");
      if (ALREADY_RE.test(text)) {
        const ins = await withTimeout(this.d.clock, c.inspect(), this.t.inspectTimeoutMs);
        if (!ins.timeout && ins.value && labelsEq(ins.value.labels, b.labels)) {
          // Row 8: adopt.
          this.ring("rt", "row", { row: 8 });
        } else {
          return this.staleSlot(op);
        }
      } else {
        return this.failStart(op, classifyStop({ outcome: "rejected", err: e }), false, 11);
      }
    }
    // §8.4 at once after: intercepts again, monitor, inactivity, alarm 5 s.
    // Phase budgets count from the start() that took (capacity retries do not eat the boot budget).
    this.patchBoot({ startedAt: this.now(), phase: "boot", phaseAt: this.now() });
    await this.registerIntercepts();
    this.armMonitor(b.gen);
    await this.inactivity();
    this.store.setPhase(op.opId, "armed");
    await this.d.alarm.set(this.now() + this.t.opTickMs);
    return "armed";
  }

  /** Rows 9 and the phase-0 label mismatch: destroy("stale"), failed start, not a state fault. */
  private async staleSlot(op: OpRow): Promise<OpResult> {
    const ok = await this.destroyFor("stale");
    if (ok) {
      const l = this.ladder();
      l.hungDestroys++;
      this.putLadder(l);
      if (l.hungDestroys >= 3) await this.stuck("label-mismatch");
    }
    return this.failStart(op, this.mkClass("already-running", "infra"), false, 9);
  }

  /** Row 4: capacity. Gen kept (C13); the op stays open at phase start. */
  private async capacity(op: OpRow): Promise<OpResult> {
    const sc = this.mkClass("capacity", "capacity", "", true);
    const l = this.ladder();
    const out = applyFailure(l, sc, { now: this.now(), stateFault: false, lastHbAt: null, t: this.t });
    this.putLadder(out.ladder);
    this.store.setPhase(op.opId, "start");
    this.tr(4);
    this.ring("rt", "capacity", { nextStartAt: out.ladder.nextStartAt });
    return "waiting";
  }

  /** O1: deployed image map; empty on error (the epoch digest then stays as it is). */
  private liveImages(): Record<string, string> {
    try {
      return { ...this.d.container.images() };
    } catch {
      return {};
    }
  }

  /** Row 7 / §15.2: snapshot miss → suspect/bad, replan in the same op; marker source dropped. After
   * SNAPSHOT_REPLAN_CAP misses in one op the replan takes no snapshot (archive, else restore-blocked + alert):
   * F3, never one gen per op forever. */
  private async snapshotLost(
    op: OpRow,
    args: Record<string, unknown> & { missed?: string[]; noSnapshot?: boolean },
    id: string,
  ) {
    const b = this.boot();
    try {
      await this.d.ctl.snapshotMiss(id);
    } catch (e) {
      this.ring("rt", "snapshot-miss-rpc", errorText(e));
    }
    if (b?.markerId)
      await this.d.ctl.markerVoid({ id: b.markerId, reason: "snapshot-lost" }).catch(() => undefined);
    this.recordStop(this.mkClass("snapshot-lost", "zero", "", true), false);
    const missed = [...(args.missed ?? []), id];
    args.missed = missed;
    args.replan = true;
    if (missed.length >= SNAPSHOT_REPLAN_CAP) {
      args.noSnapshot = true;
      this.ring("rt", "replan-cap", { missed: missed.length });
    }
    this.store.setPhase(op.opId, "plan", { args: { ...args, missed, replan: true } });
    this.ring("rt", "row", { row: 7 });
    return "replan" as const;
  }

  /** Phases armed → ready → done (§8.6). */
  private async readiness(op: OpRow, phase0: string): Promise<OpResult> {
    let phase = phase0;
    const c = this.d.container;
    for (;;) {
      if (this.halted) throw new Halted();
      const b = this.boot();
      if (!b) return this.failStart(op, this.mkClass("no-boot", "infra"), false);
      if (this.preempt) return this.abortStart(op, this.preempt);
      const d = this.drain();
      if (d?.sigtermAt && d.gen === b.gen) return this.sigtermDuringStart(op);
      const s = this.settleOf(b.gen) ?? (!c.running ? this.lostSettle(b.gen) : null);
      if (s) {
        const text = errorText(s.err);
        if (s.outcome === "rejected" && CAPACITY_RE.test(text)) return this.capacity(op);
        if (s.outcome === "rejected" && SNAPSHOT_RE.test(text)) {
          const out = await this.snapshotLost(op, op.args as never, b.snapshotId ?? "");
          if (out === "replan") return this.runStart(this.store.op(op.opId) as OpRow);
        }
        const sc = this.classifySettle(s);
        return this.failStart(op, sc, await this.isStateFault(sc), 11);
      }
      const now = this.now();
      // Phase budgets and hb gap (§8.6).
      const hb = this.hb();
      if (hb && hb.gen === b.gen && now - hb.at > this.t.hbLostMs) {
        await this.destroyFor("hb-gap");
        return this.failStart(op, this.mkClass("lost", "infra"), false, 11);
      }
      const ph = b.phase;
      const budget = this.budget(ph, !!b.snapshotId);
      // A budget miss needs a live reporter: with heartbeats gone, the hb-gap rule decides (class lost).
      const hbLive = !hb || hb.gen !== b.gen || now - hb.at <= 2 * this.t.hbMs;
      // F12: before the first exec answers, the start timeout owns the window (an image pull can take minutes);
      // the boot budget counts from the later of the phase start and the first exec answer.
      const from = ph === "boot" ? Math.max(b.phaseAt, b.aliveAt ?? 0) : b.phaseAt;
      if (budget !== null && hbLive && b.aliveAt && now - from > budget) {
        await this.destroyFor(`budget:${ph}`);
        const sc = this.mkClass(`budget:${ph}`, "fault");
        // F1: a restore that misses its budget fails to the next ladder step (ladder ESCALATE_NOW), when the
        // R2 probe and hello were healthy (§9.3); gateway-start keeps its evidence rule.
        sc.esc = ph === "gateway-start" || ph === "restore" ? "evidence" : false;
        const sf = (ph === "gateway-start" || ph === "restore") && (await this.isStateFault(sc, true));
        return this.failStart(op, sc, sf, 11);
      }
      // §8.4 / §9.4: start() returned but the container never answers its first exec within
      // startTimeoutMs → hung start (stuck-slot count). guess: platform start() is sync, so the 30 s timer
      // applies to the first exec; T1/L-1 settles it.
      // F12: the first start of this epoch's image pulls it (35-56 s on CF): the cold budget applies.
      if (phase === "armed" && b.startedAt && now - b.startedAt > this.startTimeout(b) && !b.aliveAt) {
        await this.stuck("start");
        await this.destroyFor("hung-start");
        return this.failStart(op, this.mkClass("hung-start", "infra"), false, 11);
      }
      if (phase === "armed") {
        try {
          const r = await withTimeout(this.d.clock, c.exec(["true"], { user: ROOT }), this.t.execTimeoutMs);
          if (!r.timeout) {
            this.patchBoot({ aliveAt: this.now() });
            this.noteImageKnown(b);
            phase = "ready";
            this.store.setPhase(op.opId, phase);
          }
        } catch {
          // not up yet
        }
      }
      if (phase === "ready") {
        const st = await this.startupz();
        if (st === "started") return this.onStarted(op);
      }
      await this.sleep(this.t.readyPollMs);
    }
  }

  /** F12: has this epoch's image answered an exec once? Per Runtime DO = per epoch (one image). */
  imageKnown(digest: string): boolean {
    const k = this.store.get<{ digest: string }>(K.imageKnown);
    return !!k && k.digest === digest;
  }

  /** F12: start budget: startTimeoutMs, or coldStartTimeoutMs until the image is known (first pull). */
  startTimeout(b: Pick<Boot, "digest">): number {
    return this.imageKnown(b.digest)
      ? this.t.startTimeoutMs
      : Math.max(this.t.startTimeoutMs, this.rt.coldStartTimeoutMs);
  }

  private noteImageKnown(b: Boot) {
    if (this.imageKnown(b.digest)) return;
    const pullMs = b.startedAt ? this.now() - b.startedAt : null;
    this.store.put(K.imageKnown, { digest: b.digest, at: this.now(), pullMs });
    this.ring("rt", "image-known", { digest: b.digest.slice(0, 19), firstAliveMs: pullMs });
  }

  private budget(phase: string, fromSnapshot: boolean): number | null {
    switch (phase) {
      case "boot":
        return this.t.budgetBootMs;
      case "restore":
        return fromSnapshot ? this.t.budgetRestoreSnapMs : this.t.budgetRestoreImageMs;
      case "doctor":
        return this.t.budgetDoctorMs;
      case "replica":
      case "lock":
        return this.t.budgetReplicaMs;
      case "gateway-start":
        return this.t.budgetGatewayStartMs;
      default:
        return null;
    }
  }

  /** GET /startupz on 18789; the UI catch-all answers 200, so the JSON body decides (§8.6). */
  async startupz(): Promise<"started" | "not-ready" | "down"> {
    try {
      const r = await withTimeout(
        this.d.clock,
        this.d.container.getTcpPort(GATEWAY_PORT).fetch("http://container/startupz"),
        this.t.execTimeoutMs,
      );
      if (r.timeout) return "down";
      const j = (await r.value.json().catch(() => null)) as { status?: string } | null;
      return j?.status === "started" ? "started" : "not-ready";
    } catch {
      return "down";
    }
  }

  /** §8.6 on-started. Row 3. */
  private async onStarted(op: OpRow): Promise<OpResult> {
    const b = this.boot() as Boot;
    const now = this.now();
    this.patchBoot({ startupzAt: now });
    const l = this.ladder();
    l.doctorRan = b.runDoctor && l.doctorPending;
    l.doctorPending = false;
    l.hungDestroys = 0;
    if (l.level === 1 && b.snapshotId) l.l1SnapshotId = b.snapshotId;
    l.capacitySince = null;
    this.putLadder(l);
    const s = this.sleepRec();
    // Lead samples: alarm-to-/startupz of cron wakes (§11.2).
    const samples = b.reason === "wake:cron" ? [...s.leadSamples, now - b.wakeAt].slice(-50) : s.leadSamples;
    this.patchSleep({ lastWakeAt: now, leadSamples: samples, wakeAt: null });
    this.store.del(K.wakeRequested);
    this.store.endOp(op.opId, "done", { phase: "done", result: { gen: b.gen } });
    this.tr(3, "running", { desired: "running", lastActivityAt: now });
    this.patchRec({ runningSince: now });
    try {
      await this.d.ctl.onStarted({
        epoch: this.d.epoch,
        gen: b.gen,
        opId: op.opId,
        reason: b.reason,
        digest: b.digest,
        snapshotId: b.snapshotId ?? null,
        wakeAt: b.wakeAt,
        aliveMs: b.aliveAt ? b.aliveAt - b.wakeAt : null,
        startupzMs: now - b.wakeAt,
        doctorRan: !!l.doctorRan,
      });
    } catch (e) {
      this.ring("rt", "onStarted-failed", errorText(e));
    }
    await this.d.alarm.set(now + this.t.reconcileMs);
    return "done";
  }

  /** Row 12: sigterm during a start op. */
  private sigtermDuringStart(op: OpRow): OpResult {
    this.store.endOp(op.opId, "interrupted:sigterm");
    if (this.rec().state !== "draining") this.tr(12, "draining");
    return "interrupted:sigterm";
  }

  /** §7 pre-emption: a retire or stop aborts a queued or waiting start (rows 6, 57). */
  private async abortStart(op: OpRow, by: "retire" | "stop"): Promise<OpResult> {
    const b = this.boot();
    this.store.endOp(op.opId, "aborted", { error: `pre-empted by ${by}` });
    if (b && b.opId === op.opId && !b.startupzAt) {
      await this.d.ctl.endBoot({ gen: b.gen, opId: op.opId, why: `pre-empted:${by}` }).catch(() => undefined);
    }
    return "aborted";
  }

  /** A failed start → record stop, ladder, backoff (rows 9, 10, 11). */
  async failStart(op: OpRow, sc: StopClass, stateFault: boolean, rowId = 11): Promise<OpResult> {
    const b = this.boot();
    this.store.endOp(op.opId, "failed", { error: sc.cls, result: { cls: sc.cls } });
    if (b && b.opId === op.opId) {
      await this.d.ctl.endBoot({ gen: b.gen, opId: op.opId, why: sc.cls }).catch(() => undefined);
    }
    // A container left running after a failed start is destroyed first (no two live boots).
    if (this.d.container.running && !b?.destroyedAt) await this.destroyFor(`failed:${sc.cls}`);
    this.failure(sc, stateFault, rowId);
    return "failed";
  }

  // ---------------------------------------------------------------- stops, ladder (§9)

  mkClass(cls: string, table: StopClass["table"], text = "", confirmed = false): StopClass {
    return { cls, table, esc: false, confirmed, code: null, reason: null, text };
  }

  lostSettle(gen: number): Settle | null {
    // running=false with no settle (inactivity-stop shape): treat as a "none" outcome.
    if (this.d.container.running) return null;
    return { gen, outcome: "resolved", at: this.now(), err: "__none__" };
  }

  classifySettle(s: Settle): StopClass {
    const b = this.boot();
    const open = this.store.openOps().find((o) => SLEEP_LIKE.has(o.kind));
    const d = this.drain();
    const hb = this.hb();
    const outcome = s.err === "__none__" ? "none" : s.outcome;
    let sc = classifyStop({
      outcome,
      err: outcome === "none" ? undefined : s.err,
      exitEvent: b?.lastExit ? { code: b.lastExit.code, reason: b.lastExit.reason } : null,
      openOp: open?.kind ?? null,
      draining: !!(d?.sigtermAt && d.gen === b?.gen) || !!(hb?.draining && hb.gen === b?.gen),
      destroyed: !!b?.destroyedAt,
      exitCodeConfirms: this.d.exitCodeConfirms,
      epochRetired: this.rec().epochStatus === "retired",
    });
    // §8.5: a second doctor-required in a row → doctor-failed (escalates). "In a row" includes a boot that
    // ran Doctor and still failed before /startupz (oc-m3-rt live: 32 gens of doctor-required, never failed).
    // §8.5 M6: on a digest that skips Doctor, doctor-required cannot get its Doctor boot: it is doctor-failed.
    const skip = skipDoctorDigest(this.ladder());
    if (
      sc.cls === "doctor-required" &&
      (this.ladder().doctorRan || b?.runDoctor === true || (!!skip && skip === b?.digest))
    ) {
      sc = { ...sc, cls: "doctor-failed", esc: true, table: "fault", runDoctor: false };
    }
    return sc;
  }

  /** §9.3 state-fault evidence. `budgetMiss` = gateway phase budget missed. */
  async isStateFault(sc: StopClass, budgetMiss = false): Promise<boolean> {
    if (sc.esc === false) return false;
    const b = this.boot();
    if (sc.esc === "evidence") {
      const gwEvidence =
        budgetMiss ||
        (!!b?.gatewayExitAt &&
          (!b.startupzAt ||
            (b.gatewayExitAt >= b.startupzAt && b.gatewayExitAt - b.startupzAt < 10 * 60_000)));
      if (!gwEvidence) return false;
    }
    if (!b) return false;
    try {
      return await this.d.ctl.bootHealthy({ gen: b.gen, since: b.startedAt ?? b.wakeAt });
    } catch {
      return false;
    }
  }

  recordStop(sc: StopClass, stateFault: boolean) {
    const b = this.boot();
    const hb = this.hb();
    this.store.addStop({
      at: this.now(),
      gen: b?.gen ?? null,
      cls: sc.cls,
      esc: String(sc.esc),
      stateFault,
      confirmed: sc.confirmed,
      exitCode: sc.code,
      reason: sc.reason,
      raw: sc.text,
      hbAt: hb?.at ?? null,
      opId: this.store.openOps()[0]?.opId ?? null,
    });
  }

  setNextStart(at: number) {
    const l = this.ladder();
    l.nextStartAt = at;
    this.putLadder(l);
  }

  /** Unplanned stop or failed start: record, ladder, backoff. The ladder never parks. */
  failure(sc: StopClass, stateFault: boolean, rowId: number) {
    this.recordStop(sc, stateFault);
    if (sc.alert) this.alert(sc.alert.class, sc.alert.severity, sc.text.slice(0, 300));
    const hb = this.hb();
    const l = this.ladder();
    const out = applyFailure(l, sc, { now: this.now(), stateFault, lastHbAt: hb?.at ?? null, t: this.t });
    if (sc.runDoctor) {
      out.ladder.doctorPending = true;
      void Promise.resolve(this.d.ctl.noteDoctorRequired?.(this.d.epoch)).catch(() => undefined);
    }
    if (sc.cls === "doctor-failed") out.ladder.doctorPending = false;
    // §8.5 M6: Doctor failed on the same digest DOCTOR_SKIP_AFTER times → next boots skip Doctor; one alert
    // with Doctor's output tail (exit event `out`).
    const b = this.boot();
    if (sc.cls === "doctor-failed" && b?.runDoctor && b.digest && noteDoctorFail(out.ladder, b.digest)) {
      const tail = b.lastExit?.out ? `: ${b.lastExit.out.slice(-400)}` : "";
      this.alert(
        "doctor-failed",
        "high",
        `Doctor failed ${DOCTOR_SKIP_AFTER}x on ${b.digest.slice(0, 19)}; booting without Doctor${tail}`.slice(
          0,
          500,
        ),
      );
    }
    if (stateFault) {
      const changed = this.store.get<number>("digestChangedAt");
      if (changed && this.now() - changed < UPGRADE_REGRESSION_MS)
        this.alert("upgrade-regression", "high", sc.cls);
    }
    this.putLadder(out.ladder);
    for (const a of out.alerts) this.alert(a.class, a.severity, a.detail);
    if (out.ladder.level === "slow") void this.slowCheck().catch(() => undefined);
    const r = this.rec();
    this.tr(rowId, "backoff", { desired: r.desired === "asleep" ? "asleep" : (r.desired ?? "running") });
  }

  /** Handle a settle no op is waiting for (rows 22, 29, 31, 32, 36, 42, 49). */
  async handleSettle(s: Settle): Promise<void> {
    const r = this.rec();
    const b = this.boot();
    if (!b || b.gen !== s.gen) return;
    switch (r.state) {
      case "running":
      case "maintenance": {
        const sc = this.classifySettle(s);
        if (sc.cls === "planned") return;
        const id = r.state === "maintenance" ? 31 : sc.cls === "fenced" ? 29 : 22;
        this.failure(sc, await this.isStateFault(sc), id);
        await this.arm();
        await this.tickBackoff();
        return;
      }
      case "draining":
        return this.drainSettled(s);
      case "quiescing": {
        // Row 42 when the sleep op is not running in memory (resumed later).
        const op = this.store.openOp("sleep");
        if (op && op.phase !== "destroy") {
          this.store.endOp(op.opId, "failed", { error: "settle before destroy" });
          const m = this.sleepRec().markerId;
          if (m) await this.d.ctl.markerVoid({ id: m, reason: "settle" }).catch(() => undefined);
          const sc = this.classifySettle({ ...s });
          this.failure(sc.cls === "planned" ? this.mkClass("unknown-platform", "infra") : sc, false, 42);
          await this.arm();
        }
        return;
      }
      case "asleep-unconfirmed":
        return this.unconfirmedTick();
      case "starting": {
        if (this.store.openOp("start")) return; // the op handles it when it resumes
        const sc = this.classifySettle(s);
        this.failure(sc, await this.isStateFault(sc), 11);
        await this.arm();
        return;
      }
      default:
        return;
    }
  }

  /** Rows 32, 36: drain end. */
  private async drainSettled(_s: Settle | null): Promise<void> {
    const sleepOp = this.store.ops(5).find((o) => o.kind === "sleep" && o.state === "interrupted:sigterm");
    const d = this.drain();
    if (this.rec().desired === "asleep" && sleepOp && d && sleepOp.updatedAt >= d.sigtermAt - 1) {
      // Row 36 (§10.5): asleep with the final snapshot, else the newest earlier one.
      const m = this.sleepRec().markerId;
      if (m) await this.d.ctl.markerVoid({ id: m, reason: "sigterm" }).catch(() => undefined);
      this.patchSleep({
        snapshotId: d.finalSnapshotId ?? this.sleepRec().snapshotId,
        markerId: null,
        lastSleepAt: this.now(),
      });
      this.store.endOp(sleepOp.opId, "interrupted:sigterm");
      this.tr(36, "asleep");
      await this.scheduleAsleep();
      if (this.wakeRequested()) await this.wakeFromAsleep(this.wakeRequested()?.reason ?? "webhook");
      return;
    }
    const sc = this.mkClass("platform", "zero", "drain end", true);
    this.recordStop(sc, false);
    this.setNextStart(this.now());
    this.tr(32, "backoff", { desired: this.rec().desired === "asleep" ? "asleep" : "running" });
    await this.tickBackoff();
  }

  // ---------------------------------------------------------------- RPCs

  /** §10.7 requestWake. Records activity; never waits for the container. */
  async requestWake(reason: WakeReason): Promise<{ state: RtState; action: string }> {
    await this.refreshSettings();
    const now = this.now();
    const r = this.rec();
    if (this.d.faults && this.d.faults.dropWake > 0) {
      // M4 S8 fault: this requestWake is lost; the Control DO inbox retry must wake the install.
      this.d.faults.dropWake--;
      this.ring("rt", "fault", { name: "drop-wake", reason, state: r.state });
      return { state: r.state, action: "dropped" };
    }
    switch (r.state) {
      case "asleep": {
        if (this.resumeStopOp()) return { state: r.state, action: "after-stop" };
        this.store.put(K.wakeRequested, { reason, at: now });
        if (this.store.openOp("start")) {
          this.adaptIdle(`wake:${reason}`);
          return { state: r.state, action: "queued" };
        }
        await this.wakeFromAsleep(reason);
        return { state: this.rec().state, action: "start" };
      }
      case "new":
        if (!(await this.epochActive())) {
          this.tr(2, "retired");
          return { state: "retired", action: "none" };
        }
        this.store.put(K.wakeRequested, { reason, at: now });
        this.startOp(`wake:${reason}`, "running");
        this.tr(1);
        this.kick();
        return { state: "starting", action: "start" };
      case "asleep-unconfirmed":
        this.store.put(K.wakeRequested, { reason, at: now });
        this.ring("rt", "row", { row: 52 });
        return { state: r.state, action: "after-settle" };
      case "quiescing":
        this.store.put(K.wakeRequested, { reason, at: now });
        this.ring("rt", "row", { row: 40 });
        return { state: r.state, action: "flag" };
      case "backoff":
        this.store.put(K.wakeRequested, { reason, at: now });
        this.ring("rt", "row", { row: 15 });
        {
          // F3: a message brings a long infra backoff forward (30 s after the failure at the earliest).
          const at = wakeRetryAt(this.ladder(), now);
          if (at !== null) {
            this.ring("rt", "wake-shortens-backoff", { was: this.ladder().nextStartAt, at });
            this.setNextStart(at);
          }
        }
        await this.tickBackoff();
        return { state: this.rec().state, action: "flag" };
      case "waiting-capacity":
        this.store.put(K.wakeRequested, { reason, at: now });
        return { state: r.state, action: "flag" };
      case "running":
        this.store.del(K.wakeRequested);
        // A message or the UI during a timer wake: the short cron tail no longer applies (normal idle).
        if (["webhook", "ui", "cli"].includes(reason) && this.sleepRec().cronOnly)
          this.patchSleep({ cronOnly: false });
        this.tr(27, "running", { lastActivityAt: now });
        return { state: r.state, action: "none" };
      case "starting":
      case "maintenance":
      case "draining":
        this.patchRec({ lastActivityAt: now });
        if (r.state === "starting") this.adaptIdle(`wake:${reason}`);
        if (r.state === "draining") this.store.put(K.wakeRequested, { reason, at: now });
        return { state: r.state, action: "none" };
      case "stopped":
        if (this.startStopped()) return { state: this.rec().state, action: "start" };
        this.ring("rt", "row", { row: 56 });
        return { state: r.state, action: "none" };
      case "stopping":
        this.ring("rt", "row", { row: 56 });
        return { state: r.state, action: "none" };
      case "retired":
        return { state: r.state, action: "none" };
    }
  }

  async wakeFromAsleep(reason: string) {
    const due = reason.startsWith("wake:") ? reason : `wake:${reason}`;
    this.startOp(due, "asleep");
    this.tr(43, "starting");
    this.kick();
  }

  /** §11.3 ensure (5-min cron via the Control DO). */
  async ensure(): Promise<{ state: RtState }> {
    const r = this.rec();
    const now = this.now();
    switch (r.state) {
      case "new":
        if (!(await this.epochActive())) {
          this.tr(2, "retired");
          break;
        }
        this.startOp("user", "running");
        this.tr(1);
        this.kick();
        break;
      case "backoff":
      case "waiting-capacity":
        await this.tickBackoff();
        break;
      case "asleep": {
        if (this.resumeStopOp()) break;
        const s = this.sleepRec();
        let pending = 0;
        try {
          pending = await this.d.ctl.inboxPending();
        } catch {
          pending = 0;
        }
        if (s.wakeAt !== null && now >= s.wakeAt + 2 * 60_000) {
          this.startOp("wake:cron", "asleep");
          this.tr(45, "starting");
          this.kick();
        } else if (pending > 0) {
          this.startOp("wake:inbox", "asleep");
          this.tr(46, "starting");
          this.kick();
        } else {
          this.ring("rt", "row", { row: 47 });
          await this.scheduleAsleep();
        }
        break;
      }
      case "asleep-unconfirmed":
        await this.unconfirmedTick();
        break;
      case "stopped":
        if (!this.startStopped()) this.ring("rt", "row", { row: 56 });
        break;
      case "retired":
        break;
      default:
        if (!this.active && this.store.openOps().length) this.kick();
        await this.arm();
    }
    return { state: this.rec().state };
  }

  async epochActive(): Promise<boolean> {
    const r = this.rec();
    const now = this.now();
    if (now - r.epochCheckedAt <= this.t.epochCacheMs && r.epochStatus !== "unknown")
      return r.epochStatus === "active";
    try {
      const s = await this.d.ctl.epochStatus(this.d.epoch);
      this.patchRec({ epochStatus: s.status, epochCheckedAt: now });
      return s.status === "active";
    } catch {
      // C14: keep the persisted status on an RPC error.
      return r.epochStatus === "active" || r.epochStatus === "unknown";
    }
  }

  /** §9.3 l5-pending check while in slow: R2 probes healthy since slowSince. Alert only (C5). */
  async slowCheck(): Promise<void> {
    const l = this.ladder();
    if (l.level !== "slow" || l.slowSince === null) return;
    let healthy = false;
    try {
      healthy = await this.d.ctl.bootHealthy({ gen: this.boot()?.gen ?? 0, since: l.slowSince });
    } catch {
      healthy = false;
    }
    this.l5Check(healthy);
  }

  /** Backoff / waiting-capacity: start when now ≥ nextStartAt (rows 5, 13, 14). */
  async tickBackoff(): Promise<void> {
    const r = this.rec();
    if (r.state !== "backoff" && r.state !== "waiting-capacity") return;
    await this.slowCheck();
    const l = this.ladder();
    if (this.now() < l.nextStartAt) {
      await this.arm();
      return;
    }
    if (r.state === "waiting-capacity") {
      this.tr(5, "starting");
      this.kick();
      return;
    }
    if (r.desired === "stopped" || r.desired === "retired") return;
    const w = this.wakeRequested();
    if (r.desired === "asleep") {
      this.startOp(`wake:${w?.reason ?? "cron"}`, "asleep");
      this.tr(14, "starting");
    } else {
      this.startOp("ladder", "running");
      this.tr(13, "starting");
    }
    this.kick();
  }

  // ---------------------------------------------------------------- owner ops

  async ownerStart(): Promise<{ ok: boolean; state: RtState }> {
    const r = this.rec();
    if (r.state === "retired") return { ok: false, state: r.state };
    this.patchRec({ desired: "running", lastActivityAt: this.now() });
    if (this.store.openOp("stop")) {
      // Restart (§19.2): journal the start op now. The stop op runs first (kick order) and starts it when
      // done. `desired` alone is not enough: the sleep op overwrites it (rows 37, 39), and a DO reset can come
      // at any point between here and the start.
      this.startOp("user", "running");
      this.ring("rt", "restart-queued", { state: r.state });
      this.kick();
    } else if (r.state === "stopped" || r.state === "new" || r.state === "asleep") {
      this.startOp("user", "running");
      this.tr(r.state === "stopped" ? 55 : r.state === "asleep" ? 43 : 1, "starting");
      this.kick();
    } else if (r.state === "backoff") {
      this.setNextStart(this.now());
      await this.tickBackoff();
    }
    return { ok: true, state: this.rec().state };
  }

  /** Row 55 without an owner call (tick, ensure, wake): `stopped` with an open start op or desired=running is
   * a restart whose start leg a DO reset cut. An owner stop (desired=stopped, no start op) stays: row 56. */
  startStopped(): boolean {
    const r = this.rec();
    if (r.state !== "stopped" || this.active) return false;
    if (!this.store.openOp("start")) {
      if (r.desired !== "running") return false;
      this.startOp("user", "running");
      this.ring("rt", "restart-resumed", {});
    }
    this.tr(55, "starting");
    this.kick();
    return true;
  }

  /** A stop op left open in `asleep` (DO reset after row 37): run it. tick and ensure in `asleep` do not
   * resume ops otherwise. */
  resumeStopOp(): boolean {
    if (this.active || !this.store.openOp("stop")) return false;
    this.kick();
    return true;
  }

  /** Owner stop (row 26, §10.6). Pre-empts a queued or waiting start. */
  async ownerStop(): Promise<{ ok: boolean; state: RtState }> {
    const r = this.rec();
    if (r.state === "retired" || r.state === "stopped") return { ok: true, state: r.state };
    this.patchRec({ desired: "stopped" });
    const start = this.store.openOp("start");
    if (start && (this.active?.opId !== start.opId || r.state === "waiting-capacity")) {
      await this.abortStart(start, "stop");
    } else if (start) this.preempt = "stop";
    if (!this.d.container.running && !this.store.openOps().some((o) => o.kind !== "stop")) {
      this.tr(r.state === "waiting-capacity" ? 6 : 53, "stopped");
      this.preempt = null;
      await this.arm();
      return { ok: true, state: "stopped" };
    }
    this.openOp("stop", "owner");
    if (r.state === "running") this.tr(26);
    else this.tr(26, "stopping");
    this.kick();
    return { ok: true, state: this.rec().state };
  }

  /** Retire this epoch DO (rows 6, 16, 28, 57). Resolves after destroy + settle. */
  async retire(): Promise<{ settled: boolean; lastHbAt?: number }> {
    const r = this.rec();
    if (r.state === "retired") return { settled: !this.d.container.running, lastHbAt: this.hb()?.at };
    this.patchRec({ desired: "retired", epochStatus: "retiring", epochCheckedAt: this.now() });
    const start = this.store.openOp("start");
    if (start) {
      if (this.active?.opId === start.opId) this.preempt = "retire";
      else await this.abortStart(start, "retire");
    }
    if (r.state === "waiting-capacity") this.ring("rt", "row", { row: 6 });
    const op = this.openOp("retire", "retire");
    const p = this.kick();
    await p;
    await this.drainOps();
    const done = this.store.op(op.opId);
    return { settled: done?.state === "done" && !this.d.container.running, lastHbAt: this.hb()?.at };
  }

  private async runRetire(op: OpRow): Promise<OpResult> {
    this.preempt = null;
    const r = this.rec();
    let settled = true;
    if (this.d.container.running) {
      settled = await this.destroyFor("retired");
      this.recordStop(this.mkClass("planned", "none", "retire", settled), false);
    }
    this.store.endOp(op.opId, "done", { phase: "done", result: { settled } });
    const id = r.state === "running" ? 28 : r.state === "waiting-capacity" ? 6 : 57;
    this.tr(id, "retired", { desired: "retired", epochStatus: "retiring" });
    await this.d.alarm.delete();
    return "done";
  }

  /** Planned stop op (§10.6). */
  private async runStop(op: OpRow): Promise<OpResult> {
    this.preempt = null;
    const b = this.boot();
    const c = this.d.container;
    this.d.closeBridges?.(1012, "stop");
    let markerId: string | null = null;
    if (c.running && b) {
      this.store.setPhase(op.opId, "quiesce");
      const first = await this.ocsupctl("stop", op.opId);
      let quiesced = false;
      let unclean: unknown[] = [];
      const deadline = this.now() + this.t.quiesceCapMs;
      if (first.ok) {
        while (this.now() < deadline && c.running) {
          const st = await this.ocsupctl("stop-status", op.opId);
          if (st.ok && (st.state === "quiesced" || st.quiesced === true)) {
            quiesced = true;
            unclean = Array.isArray(st.unclean) ? st.unclean : [];
            break;
          }
          await this.sleep(this.t.readyPollMs);
        }
      }
      if (quiesced && unclean.length === 0 && b.mode === "prod") {
        this.store.setPhase(op.opId, "marker");
        try {
          const m = await this.d.ctl.markerPending({
            opId: op.opId,
            gen: b.gen,
            epoch: this.d.epoch,
            digest: b.digest,
            txid: {},
            bytes: {},
            lastWriteAt: {},
          });
          markerId = m.id;
        } catch (e) {
          this.ring("rt", "marker-failed", errorText(e));
        }
      }
      if (c.running) {
        this.store.setPhase(op.opId, "snapshot");
        try {
          const h = await this.snapshot("planned", op.opId);
          await this.d.ctl.snapshotSaved({
            id: h.id,
            size: h.size,
            digest: b.digest,
            imageKey: b.imageKey,
            gen: b.gen,
            epoch: this.d.epoch,
            kind: "planned",
            opId: op.opId,
            parentId: b.snapshotId ?? null,
          });
          if (markerId) await this.d.ctl.markerValid({ id: markerId, snapshotId: h.id });
          this.patchSleep({ snapshotId: h.id, markerId });
        } catch (e) {
          this.ring("rt", "planned-snapshot-failed", errorText(e));
          if (markerId)
            await this.d.ctl.markerVoid({ id: markerId, reason: "snapshot-failed" }).catch(() => undefined);
        }
      }
      this.store.setPhase(op.opId, "destroy");
    }
    const settled = c.running ? await this.destroyFor("stop") : true;
    if (b) this.recordStop(this.mkClass("planned", "none", "owner stop", settled), false);
    this.store.endOp(op.opId, "done", { phase: "done", result: { settled } });
    // A sleep op cut by a DO reset is still open: this stop replaces it. Left open, it would run after the
    // stop and move `stopped` back to quiescing.
    for (const s of this.store.openOps().filter((o) => o.kind === "sleep")) {
      const m = (s.args as { markerId?: string }).markerId;
      if (m) await this.d.ctl.markerVoid({ id: m, reason: "owner-stop" }).catch(() => undefined);
      this.store.endOp(s.opId, "aborted", { error: "owner stop", phase: "aborted" });
    }
    // §19.2 restart = stop + start: an owner start while the stop op was open journaled a start op. Not
    // `desired`: the sleep op sets it (row 37 asleep, row 39 running) while the stop op waits.
    const restart = !!this.store.openOp("start");
    this.tr(settled ? 53 : 54, "stopped", { desired: restart ? "running" : "stopped" });
    if (!settled) this.ring("rt", "stop-unconfirmed", {});
    if (restart) {
      // Row 55 via runStart (same path as /ops/start in `stopped`).
      this.startOp("user", "running");
      this.ring("rt", "restart-after-stop", { settled });
      // A deploy came after this instance was built: ctx.container.images() is as old as the instance, so a start
      // here would boot the old image (M7 sandbox F3, M6 F1: the new image needed a sleep and an eviction). The
      // start op is journaled; reset the instance and the next one resumes it with the deployed image map, so
      // beginBoot sees the new digest and takes the image path with a new gen.
      if (this.d.buildStale?.() && this.d.recycle) {
        this.ring("rt", "recycle", { why: "redeploy" });
        await this.arm(); // the open start op arms the alarm; the next instance's tick resumes it
        this.halt();
        this.d.recycle();
        throw new Halted();
      }
    }
    return "done";
  }

  /** Replace = destroy + settle, then a new start op (row 20 exec fail, §10.4 resume fail). */
  private async runReplace(op: OpRow): Promise<OpResult> {
    await this.destroyFor("replace");
    this.store.endOp(op.opId, "done", { phase: "done" });
    return "done";
  }

  /** Maintenance op (§11.4). M2: R2 probe + flags; the rest log skipped:M4. */
  private async runMaint(op: OpRow): Promise<OpResult> {
    const [p, st] = await Promise.all([
      this.d.ctl.r2Probe().catch((e) => ({ ok: false, err: errorText(e) })),
      this.d.container.running
        ? this.ocsupctl("status")
        : Promise.resolve({ ok: false, error: "not-running" }),
    ]);
    const b = this.boot();
    const settled = b ? (this.settleOf(b.gen) ?? this.lostSettle(b.gen)) : null;
    if (settled) {
      // Row 31: settle during maintenance.
      this.store.endOp(op.opId, "failed", { error: "settle during maintenance" });
      const sc = this.classifySettle(settled);
      this.failure(sc, await this.isStateFault(sc), 31);
      return "failed";
    }
    this.ring("rt", "maint-status", { ok: st.ok });
    this.store.setPhase(op.opId, "verify");
    this.ring("rt", "maint", { probe: p, verify: "skipped:M4", archive: "skipped:M4" });
    this.store.setPhase(op.opId, "rebase-flag");
    this.patchSleep({ lastMaintAt: this.now(), stayAwakeUntilMaint: false });
    this.store.endOp(op.opId, "done", { phase: "done", result: p });
    if (this.rec().state === "maintenance") this.tr(30, "running");
    return "done";
  }

  // ---------------------------------------------------------------- gate RPCs

  /** Heartbeat (§17.2). Records; draining → row 23. */
  async onHeartbeat(
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; gen: number | null; stop?: boolean }> {
    if (this.d.faults && this.now() < this.d.faults.hbDropUntil) throw new Error("hb-drop fault");
    const b = this.boot();
    const gen = typeof body.gen === "number" ? body.gen : null;
    const r = this.rec();
    if (!b || gen !== b.gen) return { ok: false, gen: b?.gen ?? null };
    if (this.d.ctl.noteHeartbeat) {
      const h = {
        gen,
        cpuS: typeof body.cpuS === "number" ? body.cpuS : null,
        telegramSecretVersion:
          typeof body.telegramSecretVersion === "number" ? body.telegramSecretVersion : null,
        channels: Array.isArray(body.channels) ? (body.channels as never[]) : undefined,
        rpo: typeof body.rpo === "string" ? body.rpo : null,
        eventJobs: Array.isArray(body.eventJobs) ? (body.eventJobs as never[]) : undefined,
      };
      try {
        void Promise.resolve(this.d.ctl.noteHeartbeat(h)).catch(() => undefined);
      } catch {
        // fire-and-forget
      }
    }
    const now = this.now();
    const phase = typeof body.phase === "string" ? body.phase : "unknown";
    const hb: Hb = {
      at: now,
      seq: Number(body.seq ?? 0),
      phase,
      draining: body.draining === true,
      gen,
      lastActivityAt: typeof body.lastActivityAt === "number" ? body.lastActivityAt : null,
      cpuS: typeof body.cpuS === "number" ? body.cpuS : null,
      sleepOp: body.sleepOp ?? null,
      rpo: typeof body.rpo === "string" ? body.rpo : null,
      tier:
        typeof (body.litestream as { tier?: unknown } | undefined)?.tier === "string"
          ? String((body.litestream as { tier: string }).tier)
          : null,
    };
    this.store.tx(() => {
      this.store.put(K.hb, hb);
      if (phase !== b.phase) this.patchBoot({ phase, phaseAt: now });
    });
    if (hb.draining && !this.drain()) this.markSigterm(gen);
    // §9.2: a heartbeat after an unconfirmed stop means the old container still runs: wait from it.
    if (r.state === "backoff" || r.state === "waiting-capacity") {
      const last = this.store.stops(1)[0];
      if (last && !last.confirmed && last.gen === gen) {
        const l = this.ladder();
        const at = now + this.t.unconfirmedWaitMs;
        if (l.nextStartAt < at) this.putLadder({ ...l, nextStartAt: at });
      }
    }
    if (r.state === "asleep-unconfirmed") {
      this.ring("rt", "row", { row: 51 });
      return { ok: true, gen, stop: true };
    }
    return { ok: true, gen };
  }

  private markSigterm(gen: number) {
    if (this.drain()?.gen === gen) return;
    this.store.put(K.drain, { sigtermAt: this.now(), gen } satisfies Drain);
    const r = this.rec();
    if (r.state === "running" || r.state === "maintenance") this.tr(23, "draining");
    else if (r.state === "starting") {
      // Row 12. An active start op sees the drain at its next poll and ends interrupted.
      if (!this.active) {
        const op = this.store.openOp("start");
        if (op) this.store.endOp(op.opId, "interrupted:sigterm");
      }
      this.tr(12, "draining");
    } else if (r.state === "quiescing") {
      // Row 41: no more ocsupctl calls; the active sleep op stops at its next edge.
      if (!this.active) {
        const op = this.store.openOp("sleep");
        if (op) this.store.endOp(op.opId, "interrupted:sigterm");
      }
      this.tr(41, "draining", { desired: "asleep" });
    }
  }

  /** Event (§17.2 /v1/event). */
  async onEvent(body: Record<string, unknown>): Promise<{ ok: boolean }> {
    const b = this.boot();
    const gen = typeof body.gen === "number" ? body.gen : null;
    if (!b || gen !== b.gen) return { ok: false };
    const kind = String(body.kind ?? "");
    const now = this.now();
    switch (kind) {
      case "sigterm":
        this.markSigterm(gen);
        break;
      case "drained": {
        const d = this.drain() ?? { sigtermAt: now, gen };
        const unclean = Array.isArray(body.unclean) ? (body.unclean as string[]) : [];
        this.store.put(K.drain, { ...d, drainedAt: now, unclean });
        const m = this.sleepRec().markerId;
        if (unclean.length && m)
          await this.d.ctl.markerVoid({ id: m, reason: "drained-unclean" }).catch(() => undefined);
        break;
      }
      case "exit":
        this.patchBoot({
          lastExit: {
            code: Number(body.code ?? -1),
            reason: (body.reason as string | null) ?? null,
            at: now,
            out: typeof body.out === "string" ? body.out.slice(-2048) : null,
          },
        });
        break;
      case "gateway-exit":
        this.patchBoot({ gatewayExitAt: now });
        break;
      case "ingress-ready":
        this.patchBoot({ ingressReadyAt: now });
        break;
      case "replica-down":
      case "admission-close":
        this.setDegraded(kind, true);
        break;
      case "replica-up":
      case "admission-open":
        this.setDegraded(kind === "replica-up" ? "replica-down" : "admission-close", false);
        break;
      default:
        break;
    }
    // N1+N2 (M4b): SQLite evidence from the exit reason or its detail (ocsup `sqlite-corrupt` after a failed
    // quick_check; a restore's quick_check text; a Doctor failure on a poisoned schema).
    const reasonText = typeof body.reason === "string" ? body.reason : "";
    const detailText = typeof body.detail === "string" ? body.detail : "";
    if (sqliteEvidence(reasonText, detailText)) {
      const l = this.ladder();
      l.sqliteEvidence++;
      // ocsup proved the corruption (quick_check failed): tell the owner now, with the evidence; same
      // l5-pending class as the slow rule, at most once per SLOW_ALERT_MS (alert only, C5).
      const proven = reasonText === "sqlite-corrupt";
      if (proven && (l.lastL5PendingAt === null || now - l.lastL5PendingAt >= SLOW_ALERT_MS)) {
        l.lastL5PendingAt = now;
        this.alert(
          "l5-pending",
          "high",
          `sqlite-corrupt: ${detailText || "quick_check failed"}`.slice(0, 500),
        );
      }
      this.putLadder(l);
    }
    return { ok: true };
  }

  setDegraded(why: string, on: boolean) {
    const r = this.rec();
    const set = new Set(r.degradedWhy);
    if (on) set.add(why);
    else set.delete(why);
    this.patchRec({ degradedWhy: [...set], degraded: set.size > 0 });
  }

  /** /v1/final-snapshot (§15.1, §17.2): 1 per boot, handle saved before the answer. */
  async finalSnapshot(_body: Record<string, unknown>) {
    const b = this.boot();
    if (!b || !this.d.container.running) return { status: 200, ok: false, error: "not-running" };
    if (b.finalDone) return { status: 409, ok: false, error: "done" };
    this.patchBoot({ finalDone: true });
    // Wait ≤ finalWaitMs for an in-flight snapshot, then run (§15.1).
    const inflight = this.snapshotMutex;
    await withTimeout(this.d.clock, inflight, this.t.finalWaitMs);
    try {
      const h = await withTimeout(
        this.d.clock,
        this.d.container.snapshot(`oc-final-${this.now()}`),
        this.t.finalSnapshotMs,
      );
      if (h.timeout) return { status: 200, ok: false, error: "timeout" };
      await this.d.ctl.snapshotSaved({
        id: h.value.id,
        size: h.value.size,
        digest: b.digest,
        imageKey: b.imageKey,
        gen: b.gen,
        epoch: this.d.epoch,
        kind: "final",
        parentId: b.snapshotId ?? null,
      });
      const d = this.drain() ?? { sigtermAt: this.now(), gen: b.gen };
      this.store.put(K.drain, { ...d, finalSnapshotId: h.value.id });
      return { status: 200, ok: true, snapshotId: h.value.id };
    } catch (e) {
      return { status: 200, ok: false, error: errorText(e).slice(0, 200) };
    }
  }

  async currentBoot() {
    const b = this.boot();
    const r = this.rec();
    return { gen: b?.gen ?? null, mode: b?.mode ?? null, epochStatus: r.epochStatus, state: r.state };
  }

  async bootBound(a: { gen: number; iid: string }) {
    const b = this.boot();
    if (b && b.gen === a.gen) this.patchBoot({ iid: a.iid });
  }

  /** Replay one inbox row (§12.3) through 18789. */
  async deliver(req: {
    path: string;
    body: string;
    headers: Record<string, string>;
    okIsDurable?: boolean;
    quiet?: boolean;
  }) {
    if (this.rec().state !== "running" || !this.d.container.running)
      return { status: 503, durable: false, error: "not-running" };
    // S0.3: ocsup reports the gateway down or coming up: its route answers 404. Hold the row (503 = retry).
    // `gateway-start` counts only when reported after this boot's /startupz (a restart), not the boot's own start.
    const hb = this.store.get<{ phase?: string; gen?: number; at?: number }>(K.hb);
    const b = this.boot();
    const down =
      GATEWAY_DOWN_PHASES.includes(String(hb?.phase)) &&
      (hb?.phase !== "gateway-start" || (hb.at ?? 0) > (b?.startupzAt ?? Number.POSITIVE_INFINITY));
    if (hb && hb.gen === b?.gen && down) return { status: 503, durable: false, error: "gateway-stopping" };
    // §12.3: one AbortSignal per delivery; a POST that never answers ends as a timeout (retry, queue moves).
    const ac = new AbortController();
    try {
      const r = await withTimeout(
        this.d.clock,
        Promise.resolve(
          this.d.container.getTcpPort(GATEWAY_PORT).fetch(`http://container${req.path}`, {
            method: "POST",
            headers: req.headers,
            body: req.body,
            signal: ac.signal,
          }),
        ),
        this.t.deliverTimeoutMs,
      );
      if (r.timeout) {
        ac.abort();
        this.ring("rt", "deliver-timeout", { ms: this.t.deliverTimeoutMs });
        return { status: 0, durable: false, error: "timeout" };
      }
      const res = r.value;
      const durable =
        res.headers.get("x-openclaw-delivery-accepted") === "durable" || !!(req.okIsDurable && res.ok);
      if (res.ok && durable) {
        if (!req.quiet) this.patchRec({ lastActivityAt: this.now() });
        if (!this.boot()?.ingressReadyAt) this.patchBoot({ ingressReadyAt: this.now() });
      }
      return { status: res.status, durable };
    } catch (e) {
      return { status: 0, durable: false, error: errorText(e).slice(0, 200) };
    }
  }

  /**
   * N7: restore probe of this boot's gen (ocsupctl verify-gen). `verified` true/false is a verdict; null = no
   * verdict (not running, another gen, exec error or timeout): the Control DO leaves the gen `complete`.
   */
  async verifyGen(a: { gen: number; dbs: string[]; timeoutMs?: number }) {
    const b = this.boot();
    if (this.rec().state !== "running" || !this.d.container.running || b?.gen !== a.gen)
      return { verified: null, why: "not-running" };
    const t = a.timeoutMs ?? 40_000;
    const r = await this.ocsupctl(
      "verify-gen",
      undefined,
      { gen: a.gen, dbs: a.dbs, timeoutMs: t },
      t + 5_000,
    );
    if (!r.ok || typeof r.verified !== "boolean") return { verified: null, why: String(r.detail ?? r.error) };
    // An infra failure (R2, gate, timeout) says nothing about the gen.
    if (!r.verified && r.reason !== "bad") return { verified: null, why: String(r.why ?? r.reason) };
    return { verified: r.verified, why: r.verified ? null : `${r.rel ?? ""} ${r.why ?? ""}`.trim() };
  }

  /** Proxy gate (§19.1): serve only in `running`; else 503 and wake reason ui. activity false (latched session,
   * health probe): no idle-timer reset. wake false (latched session): no wake (add §2.5). */
  async proxyAllowed(
    o: { activity?: boolean; wake?: boolean } = {},
  ): Promise<"serve" | "retired" | "waking"> {
    const r = this.rec();
    if (r.state === "retired") return "retired";
    if (r.state === "running" && this.d.container.running) {
      if (o.activity !== false) this.patchRec({ lastActivityAt: this.now() });
      return "serve";
    }
    if (o.wake !== false) await this.requestWake("ui");
    return "waking";
  }

  /** /ops/fault (OC_TEST=1 only; the Worker checks the flag). */
  fault(name: string, params: Record<string, unknown>): { ok: boolean; error?: string } {
    if (!this.d.faults) return { ok: false, error: "faults off" };
    if (name === "sigkill") {
      // docker-kill equivalent (L-1): SIGKILL to the container's main process. No Runtime state change here;
      // the monitor() settle and the alarm restart it with no inbound traffic.
      if (!this.d.container.running) return { ok: false, error: "not running" };
      this.ring("rt", "fault", { name, at: this.now(), gen: this.boot()?.gen });
      this.d.container.signal(9);
      return { ok: true };
    }
    if (name === "destroy") {
      // Soak (drill A): destroy() on the running container; monitor() settles and the restart path takes over.
      if (!this.d.container.running) return { ok: false, error: "not running" };
      this.ring("rt", "fault", { name, at: this.now(), gen: this.boot()?.gen });
      void this.d.container.destroy("soak fault").catch(() => undefined);
      return { ok: true };
    }
    if (name === "signal") {
      const sig = typeof params.sig === "number" ? Math.floor(params.sig) : 15;
      if (!this.d.container.running) return { ok: false, error: "not running" };
      this.ring("rt", "fault", { name, sig, at: this.now(), gen: this.boot()?.gen });
      this.d.container.signal(sig);
      return { ok: true };
    }
    if (name === "abort") {
      // Deploy stand-in (spike soak `deploy`): a Worker cannot deploy itself; a deploy restarts the busy Runtime
      // DO (T6e), so ctx.abort() after `ms` (default 2 s) with the container left running.
      const ms = typeof params.ms === "number" ? Math.max(0, params.ms) : 2000;
      const abort = this.d.faults.abort;
      if (!abort) return { ok: false, error: "no abort hook" };
      this.ring("rt", "fault", { name, ms, at: this.now(), gen: this.boot()?.gen });
      setTimeout(() => abort("soak deploy stand-in"), ms);
      return { ok: true };
    }
    const err = setFault(this.d.faults, name, params, this.now());
    this.ring("rt", "fault", { name, params, err });
    return err ? { ok: false, error: err } : { ok: true };
  }

  // ---------------------------------------------------------------- deploy skew gate

  /** /ops/idle (§19.2). */
  idleInfo() {
    const r = this.rec();
    return {
      asleep: r.state === "asleep" || r.state === "stopped" || r.state === "retired",
      opOpen: this.store.openOps().map((o) => o.kind),
      codeVersion: this.d.codeVersion,
      state: r.state,
    };
  }

  /** /ops/deploy-check (scope [Z0.7], amend §2 row 21c): 409 when a sleep/stop/start op is open or the
   * live CODE_VERSION ≠ the posted head. */
  deployCheck(head: string | null): {
    status: number;
    reason?: string;
    codeVersion: string;
    opOpen: string[];
  } {
    const open = this.store
      .openOps()
      .filter((o) => o.kind === "sleep" || o.kind === "stop" || o.kind === "start");
    const opOpen = open.map((o) => o.kind);
    if (open.length) return { status: 409, reason: "op-open", codeVersion: this.d.codeVersion, opOpen };
    if (head && head !== this.d.codeVersion)
      return { status: 409, reason: "code-version", codeVersion: this.d.codeVersion, opOpen };
    return { status: 200, codeVersion: this.d.codeVersion, opOpen };
  }

  /** /ops/sleep: run the sleep gate now; force skips rules 3, 4, 7. */
  async sleepNow(o: { force: boolean }): Promise<{ ok: boolean; reason?: string; opId?: string }> {
    await this.refreshSettings();
    const r = this.rec();
    if (r.state !== "running") return { ok: false, reason: `state ${r.state}` };
    const g = await sleepGate(this, { force: o.force });
    if (!g.ok) return { ok: false, reason: g.rule };
    const op = this.openOp("sleep", o.force ? "owner-force" : "owner", { force: o.force });
    this.patchRec({ desired: "asleep" });
    this.tr(24);
    this.kick();
    return { ok: true, opId: op.opId };
  }

  async status() {
    const r = this.rec();
    const b = this.boot();
    const l = this.ladder();
    const s = this.sleepRec();
    return {
      state: r.state,
      // Owner status page (ingress/routes.ts): when this state began, DO-side activity.
      stateAt: r.stateAt,
      lastActivityAt: r.lastActivityAt,
      desired: r.desired ?? undefined,
      row: r.row,
      gen: b?.gen,
      epoch: this.d.epoch,
      degraded: r.degraded,
      degradedWhy: r.degradedWhy,
      ladder: {
        level: l.level,
        stateFaults: l.stateFaults,
        nextStartAt: l.nextStartAt,
        lastClass: l.lastClass,
      },
      sleep: {
        idleMs: s.idleMs ?? this.t.idleMs,
        wakeAt: s.wakeAt,
        nextWakeAtMs: s.nextWakeAtMs,
        snapshotId: s.snapshotId,
        blockedOn: s.blockedOn,
      },
      awakeReason: s.blockedOn ?? undefined,
      blockers: s.blockedOn ? [s.blockedOn] : [],
      hb: this.hb(),
      ops: this.store.openOps().map((o) => ({ kind: o.kind, phase: o.phase })),
      codeVersion: this.d.codeVersion,
    };
  }

  // ---------------------------------------------------------------- alarm (§11)

  /** Set the next alarm for the state (§11.1 step 11, §11.2). */
  async arm(hint?: number): Promise<void> {
    const r = this.rec();
    const now = this.now();
    let at: number | null = null;
    if (this.active || this.store.openOps().length) at = now + this.t.opTickMs;
    if ((r.state === "backoff" || r.state === "waiting-capacity") && !this.active)
      at = Math.max(now, this.ladder().nextStartAt);
    else if (r.state === "asleep") at = min(at, this.sleepRec().wakeAt);
    else if ((AWAKE_STATES as readonly string[]).includes(r.state)) at = min(at, now + this.t.reconcileMs);
    if (hint !== undefined) at = min(at, hint);
    if (at === null) await this.d.alarm.delete();
    else await this.d.alarm.set(at);
  }

  /** Alarm handler. Never throws (each step in try/catch). */
  async alarm(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      await this.refreshSettings();
      await this.tick();
    } catch (e) {
      this.ring("rt", "alarm-error", errorText(e));
    } finally {
      this.tickRunning = false;
      try {
        await this.arm();
      } catch {
        // alarm set failed; cron ensure re-arms
      }
    }
  }

  private async step(name: string, fn: () => Promise<unknown> | unknown): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.ring("rt", "tick-error", { step: name, err: errorText(e) });
    }
  }

  private async tick(): Promise<void> {
    const r0 = this.rec();
    const awake = (AWAKE_STATES as readonly string[]).includes(r0.state);
    // 1. inactivity first, before any other await (amend §2 row 2).
    if (awake || this.d.container.running) await this.inactivity();
    if (r0.state === "retired") return;
    if (r0.state === "asleep") {
      if (this.resumeStopOp()) return;
      const s = this.sleepRec();
      if (s.wakeAt !== null && this.now() >= s.wakeAt) {
        this.startOp(s.wakeReason ?? "wake:cron", "asleep");
        this.tr(44, "starting");
        this.kick();
      }
      return;
    }
    if (r0.state === "backoff" || r0.state === "waiting-capacity") return this.tickBackoff();
    if (r0.state === "stopped") {
      this.startStopped();
      return;
    }
    if (r0.state === "new") return;
    // 2. epoch check (cached).
    let active = true;
    await this.step("epoch", async () => {
      active = await this.epochActive();
    });
    // 3. orphan snapshotInFlight.
    await this.step("orphan", () => {
      const f = this.store.get<{ startedAt: number }>(K.snapshotInFlight);
      if (f && this.now() - f.startedAt > 120_000 && !this.active) {
        this.store.del(K.snapshotInFlight);
        this.ring("rt", "orphan?", f);
      }
    });
    if (!active) {
      // Row 16 / 58.
      await this.queue.run(async () => {
        if (this.d.container.running) await this.destroyFor("retired");
        this.tr(16, "retired", { desired: "retired" });
      });
      return;
    }
    // Open op not running in memory: resume it (constructor/alarm resume, §7.1).
    if (!this.active && this.store.openOps().length) {
      this.kick();
      return;
    }
    if (this.active) return;
    const r = this.rec();
    if (r.state === "asleep-unconfirmed") return this.unconfirmedTick();
    // 4. draining rules (rows 32-34).
    if (r.state === "draining") return this.queue.run(() => this.drainTick());
    if (r.state !== "running" && r.state !== "maintenance") return;
    await this.queue.run(() => this.runningTick());
  }

  private async drainTick(): Promise<void> {
    const d = this.drain();
    const b = this.boot();
    const settled = this.settleOf(b?.gen);
    if (!this.d.container.running || settled) return this.drainSettled(settled);
    if (d && this.now() - d.sigtermAt > this.t.drainCapMs) {
      await this.destroyFor("drain-cap");
      const sc = this.mkClass("lost", "infra", "drain cap");
      this.failure(sc, false, 33);
      return;
    }
    this.ring("rt", "row", { row: 34 });
  }

  /** §11.1 steps 5-10 in `running`. */
  private async runningTick(): Promise<void> {
    const b = this.boot();
    const c = this.d.container;
    if (!b) return;
    // 5. reconcile running vs desired (row 21).
    if (!c.running && !this.settleOf(b.gen)) {
      const sc = this.classifySettle({ gen: b.gen, outcome: "resolved", err: "__none__", at: this.now() });
      this.failure(sc, false, 21);
      return;
    }
    if (this.rec().state !== "running") return;
    const now = this.now();
    // Ladder reset after 10 min running.
    const reset = maybeReset(this.ladder(), now, this.rec().runningSince, this.t);
    if (reset) this.putLadder(reset);
    // 6. liveness.
    const hb = this.hb();
    const hbAt = hb && hb.gen === b.gen ? hb.at : (b.startupzAt ?? now);
    if (now - hbAt > this.t.hbLostMs) {
      await this.destroyFor("lost");
      this.alert("hb-lost", "warn", `no heartbeat for ${Math.round((now - hbAt) / 1000)} s`);
      this.failure(this.mkClass("lost", "infra"), false, 17);
      return;
    }
    const lv = this.liveness();
    if (lv.lastIdentityAt === null || now - lv.lastIdentityAt >= this.t.identityEveryMs) {
      const id = await this.identity(b);
      if (id === "mismatch") {
        await this.destroyFor("stale");
        const l = this.ladder();
        this.putLadder({ ...l, level: 1 });
        this.failure(this.mkClass("stale", "infra"), false, 18);
        return;
      }
      if (id === "ok") lv.lastIdentityAt = now;
      else this.ring("rt", "row", { row: 19 });
    }
    const hz = await this.healthz();
    lv.healthzFails = hz ? 0 : lv.healthzFails + 1;
    if (lv.healthzFails >= 5) {
      lv.healthzFails = 0;
      const rg = await this.ocsupctl("restart-gateway");
      this.ring("rt", "row", { row: 20, ok: rg.ok });
      if (!rg.ok) {
        this.store.put(K.liveness, lv);
        await this.destroyFor("replace");
        const sc = this.mkClass("exit:70", "fault");
        sc.esc = "evidence";
        this.failure(sc, false, 20);
        return;
      }
    }
    // 7. readyz every 5 min, status only.
    if (lv.lastReadyzAt === null || now - lv.lastReadyzAt >= this.t.readyzEveryMs) {
      lv.lastReadyzAt = now;
      const ok = await this.portOk("/readyz");
      if (ok) {
        lv.readyzBadSince = null;
        this.setDegraded("readyz", false);
      } else {
        lv.readyzBadSince ??= now;
        if (now - lv.readyzBadSince > this.t.readyzBadMs && !this.rec().degradedWhy.includes("readyz")) {
          this.setDegraded("readyz", true);
          this.alert("readyz", "warn", "not ready > 10 min");
        }
      }
    }
    this.store.put(K.liveness, lv);
    // l5-pending check while running is moot (slow only); ladder slow is checked at each failure.
    // §11.4: a maintenance wake runs the maint op before the sleep gate decides.
    const s0 = this.sleepRec();
    if (b.reason === "wake:maint" && (s0.lastMaintAt === null || s0.lastMaintAt < (b.startupzAt ?? 0))) {
      this.openOp("maint", "wake", {});
      this.tr(25);
      this.kick();
      return;
    }
    // 8. sleep gate.
    const g = await sleepGate(this, { force: false });
    if (g.ok) {
      this.openOp("sleep", "idle", {});
      this.patchRec({ desired: "asleep" });
      this.tr(24);
      this.kick();
      return;
    }
    // 9. maintenance due.
    const s = this.sleepRec();
    const lastMaint = s.lastMaintAt ?? b.startupzAt ?? now;
    if (now - lastMaint >= this.t.maintEveryMs) {
      this.openOp("maint", "due", {});
      this.tr(25);
      this.kick();
      return;
    }
    // 10. checkpoint due (A4; spec 08 §11.1 step 10, §15.1).
    if (this.checkpointDue(b, now)) {
      this.openOp("checkpoint", "hourly", { sinceMs: this.ckptSince(b) });
      this.kick();
    }
  }

  ckptRec(): CkptRec {
    return (
      this.store.get<CkptRec>(K.checkpoint) ?? {
        lastAt: null,
        lastId: null,
        day: null,
        n: 0,
        lastCheckAt: null,
      }
    );
  }

  /** Rootfs bulk since this time is not in any snapshot: the boot's rootfs time or the last checkpoint. */
  private ckptSince(b: Boot): number {
    const c = this.ckptRec();
    return Math.max(c.lastAt ?? 0, b.startedAt ?? b.wakeAt ?? 0);
  }

  /**
   * Hourly from the oldest rootfs write that is in no snapshot, inside the day cap. L2 (M4): the clock counts from
   * the plan's rootfs time (the snapshot a crash restart booted again), not from this boot's /startupz, so a crash
   * loop with lives under checkpointMs still checkpoints. A first boot from a sleep or planned snapshot counts from
   * the boot (duty cycle: the sleep snapshot covers shorter awake periods).
   */
  checkpointDue(b: Boot, now: number): boolean {
    const c = this.ckptRec();
    const from = Math.max(c.lastAt ?? 0, c.lastCheckAt ?? 0, b.rootfsAt ?? b.wakeAt ?? now);
    if (now - from < this.rt.checkpointMs) return false;
    const day = utcDay(now);
    return !(c.day === day && c.n >= this.rt.checkpointsPerDay);
  }

  /** Op `checkpoint` (spec 08 §7.2): dirty, shadow, sync, snapshot, save. Live and best effort (plan §6.1 row 6). */
  private async runCheckpoint(op: OpRow): Promise<OpResult> {
    const b = this.boot();
    const args = op.args as { sinceMs?: number };
    const fail = (error: string): OpResult => {
      this.store.endOp(op.opId, "failed", { error });
      this.ring("rt", "checkpoint-failed", { error });
      return "failed";
    };
    if (!b || this.rec().state !== "running" || !this.d.container.running) return fail("not-running");
    const since = Number(args.sinceMs) || 0;
    const d = await this.ocsupctl("dirty", op.opId, { sinceMs: since }, 90_000);
    const dirty = d.ok ? d.dirty !== false : true; // unknown answer → take it (RPO first)
    if (!dirty) {
      this.store.put(K.checkpoint, { ...this.ckptRec(), lastCheckAt: this.now() });
      this.store.endOp(op.opId, "done", { phase: "done", result: { dirty: false } });
      this.ring("rt", "checkpoint-skip", { since, why: "clean" });
      return "done";
    }
    this.store.setPhase(op.opId, "shadow");
    const sh = await this.ocsupctl("shadow-backup", op.opId, undefined, 120_000);
    this.store.setPhase(op.opId, "sync");
    try {
      await this.exec(["/bin/sync"], 60_000);
    } catch (e) {
      if (e instanceof Halted) throw e;
    }
    this.store.setPhase(op.opId, "snapshot");
    const t0 = this.now();
    let h: { id: string; size: number };
    try {
      h = await this.snapshot("checkpoint", op.opId, this.rt.checkpointSnapshotMs);
    } catch (e) {
      if (e instanceof Halted) throw e;
      // Counts in the day budget (spec 08 §7.2) so a failing snapshot does not retry every tick.
      this.countCkpt(null);
      return fail(`snapshot: ${errorText(e).slice(0, 200)}`);
    }
    this.store.setPhase(op.opId, "save");
    await this.d.ctl.snapshotSaved({
      id: h.id,
      size: h.size,
      digest: b.digest,
      imageKey: b.imageKey,
      gen: b.gen,
      epoch: this.d.epoch,
      kind: "checkpoint",
      opId: op.opId,
      parentId: this.ckptRec().lastId ?? b.snapshotId ?? null,
    });
    this.countCkpt(h.id);
    const res = {
      id: h.id,
      size: h.size,
      ms: this.now() - t0,
      dirtyCount: d.count ?? null,
      dirtyBytes: d.bytes ?? null,
      shadowOk: sh.ok,
    };
    this.store.endOp(op.opId, "done", { phase: "done", result: res });
    this.ring("rt", "checkpoint", res);
    return "done";
  }

  private countCkpt(id: string | null) {
    const c = this.ckptRec();
    const now = this.now();
    const day = utcDay(now);
    const n = c.day === day ? c.n + 1 : 1;
    this.store.put(K.checkpoint, {
      ...c,
      day,
      n,
      lastAt: id ? now : c.lastAt,
      lastId: id ?? c.lastId,
      lastCheckAt: now,
    });
  }

  /** A user-intent WS frame (add §2.5 rule 3): activity for the idle timer. */
  noteUiIntent() {
    if (this.rec().state === "running") this.patchRec({ lastActivityAt: this.now() });
  }

  /** Identity check of /run/ocrt/boot.json (§13.1 layer 5). */
  private async identity(b: Boot): Promise<"ok" | "mismatch" | "error"> {
    try {
      const r = await this.exec(["/bin/cat", BOOT_JSON]);
      if (r.exitCode !== 0) return "error";
      const j = JSON.parse(r.stdout) as { gen?: number; epoch?: number; iid?: string; secretHash?: string };
      const want = await sha256Hex(b.secret);
      if (j.gen !== b.gen || j.epoch !== this.d.epoch || j.secretHash !== want) return "mismatch";
      if (b.iid && j.iid !== b.iid) return "mismatch";
      return "ok";
    } catch {
      return "error";
    }
  }

  private async healthz(): Promise<boolean> {
    return this.portOk("/healthz");
  }

  private async portOk(path: string): Promise<boolean> {
    try {
      const r = await withTimeout(
        this.d.clock,
        this.d.container.getTcpPort(GATEWAY_PORT).fetch(`http://container${path}`),
        5000,
      );
      return !r.timeout && r.value.ok;
    } catch {
      return false;
    }
  }

  /** Rows 49-50, 52. */
  async unconfirmedTick(): Promise<void> {
    const b = this.boot();
    const now = this.now();
    if (!this.d.container.running || this.settleOf(b?.gen)) {
      this.store.del(K.zombieSince);
      this.tr(49, "asleep");
      await this.scheduleAsleep();
      const w = this.wakeRequested();
      if (w) await this.wakeFromAsleep(w.reason);
      return;
    }
    const since = this.store.get<number>(K.zombieSince) ?? now;
    if (!this.store.get(K.zombieSince)) this.store.put(K.zombieSince, now);
    if (now - since >= this.t.zombieAlertMs)
      this.alert("zombie", "high", `container alive ${Math.round((now - since) / 1000)} s after destroy`);
    // Row 52: a flagged wake starts after lastHb + 200 s even without a settle.
    const w = this.wakeRequested();
    const hb = this.hb();
    if (w && hb && now >= hb.at + this.t.unconfirmedWaitMs) {
      this.ring("rt", "row", { row: 52 });
      this.setNextStart(now);
      this.tr(52, "backoff", { desired: "asleep" });
      await this.tickBackoff();
      return;
    }
    if (b) this.armMonitor(b.gen);
    this.ring("rt", "row", { row: 50 });
    void withTimeout(this.d.clock, this.d.container.destroy("zombie"), this.t.destroyTimeoutMs).catch(
      () => undefined,
    );
  }

  /** §11.2: one alarm at wakeAt = min(nextWakeAtMs − leadMs, maintenanceDue, ttlGuard). */
  async scheduleAsleep(): Promise<void> {
    const s0 = this.sleepRec();
    const now = this.now();
    // A job time already past is stale or overdue (OpenClaw runs an overdue job at the next start anyway). As a
    // wake time it gave an alarm in the past: sleep, wake at once, repeat (oc-m3-rt live: every 1.5 min).
    const s = {
      ...s0,
      nextWakeAtMs: s0.nextWakeAtMs !== null && s0.nextWakeAtMs > now ? s0.nextWakeAtMs : null,
    };
    if (this.d.ctl.wakePlan) {
      try {
        const p = await this.d.ctl.wakePlan({ nextWakeAtMs: s.nextWakeAtMs, lastWakeAt: s.lastWakeAt });
        this.patchSleep({
          wakeAt: p.wakeAt,
          wakeReason: p.reason === "cron" ? "wake:cron" : "wake:maint",
          leadMs: p.leadMs,
        });
        await this.d.alarm.set(Math.max(now, p.wakeAt));
        return;
      } catch (e) {
        this.ring("rt", "wake-plan-failed", errorText(e));
      }
    }
    const lead = this.leadMs(s);
    let wakeAt = Number.POSITIVE_INFINITY;
    let reason = "wake:cron";
    if (s.nextWakeAtMs !== null) wakeAt = s.nextWakeAtMs - lead;
    let oldestHeld: number | null = null;
    try {
      oldestHeld = (await this.d.ctl.sleepInputs()).oldestHeldAt ?? null;
    } catch {
      oldestHeld = null;
    }
    const maint = Math.min(
      (s.lastWakeAt ?? now) + this.t.maintEveryMs,
      oldestHeld !== null ? oldestHeld + this.t.heldMaxMs : Number.POSITIVE_INFINITY,
    );
    if (maint < wakeAt) {
      wakeAt = maint;
      reason = "wake:maint";
    }
    const ttl = (s.lastSleepAt ?? now) + 28 * 24 * 3600_000;
    if (ttl < wakeAt) {
      wakeAt = ttl;
      reason = "wake:maint";
    }
    this.patchSleep({ wakeAt, wakeReason: reason, leadMs: lead });
    await this.d.alarm.set(Math.max(now, wakeAt));
  }

  /** Lead (§11.2): 120 s; after 20 wakes p95 of alarm-to-/startupz + 30 s, clamped 60-300 s. */
  leadMs(s: SleepRec): number {
    if (s.leadSamples.length < 20) return this.t.leadMs;
    const xs = [...s.leadSamples].sort((a, b) => a - b);
    const p95 = xs[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)] as number;
    const lo = Math.min(60_000, this.t.leadMs);
    return Math.min(300_000, Math.max(lo, p95 + Math.min(30_000, this.t.leadMs)));
  }

  /** §10.4: 3 aborts in 1 h → alert, no sleep for 1 h. */
  noteAbort() {
    const now = this.now();
    const s = this.sleepRec();
    const xs = [...s.abortsLastHour.filter((x) => now - x < 3600_000), now];
    const p: Partial<SleepRec> = { abortsLastHour: xs };
    if (xs.length >= 3) {
      p.noSleepUntil = now + this.t.abortHoldMs;
      p.abortsLastHour = [];
      this.alert("sleep-aborted", "warn", "3 sleep aborts in 1 h");
    }
    this.patchSleep(p);
  }

  /** Close the day counter (§10.2 phase 7 fails/day). */
  snapshotFailed() {
    const now = this.now();
    const s = this.sleepRec();
    const day = utcDay(now);
    const n = s.failDay === day ? s.snapshotFailsToday + 1 : 1;
    const p: Partial<SleepRec> = { snapshotFailsToday: n, failDay: day, retryAt: now + this.t.sleepRetryMs };
    if (n >= 3) {
      p.stayAwakeUntilMaint = true;
      this.alert("sleep-snapshot-failed", "high", `${n} sleep snapshot failures today`);
    }
    this.patchSleep(p);
  }

  l5Check(healthy: boolean) {
    const l = this.ladder();
    if (l5Due(l, this.now(), healthy, this.t)) {
      l.lastL5PendingAt = this.now();
      this.putLadder(l);
      this.alert("l5-pending", "high", "slow for 2 h with SQLite evidence; owner restore needed");
    }
  }
}

/** N1+N2 (M4b): an ocsup event that is SQLite evidence for the l5-pending rule (plan §9.3). */
export function sqliteEvidence(reason: string, detail: string): boolean {
  if (reason === "sqlite-corrupt" || reason === "doctor-failed") return true;
  return /quick_check|SQLITE_CORRUPT|SQLITE_NOTADB|malformed|file is not a database/i.test(
    `${reason} ${detail}`,
  );
}

export class Halted extends Error {
  constructor() {
    super("halted");
  }
}

function min(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

export function labelsEq(a: Record<string, string>, b: Record<string, string>): boolean {
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of ks) if (a[k] !== b[k]) return false;
  return true;
}

export async function sha256Hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
