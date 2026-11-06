// Test world for the Runtime core: port-level fake container (core/fake-container.ts), fake clock,
// SQLite storage on node:sqlite, a scripted Control DO (FakeCtl) and a scripted ocsup (ocsupctl execs,
// boot.json, the gateway port). No real sleeps: the fake clock jumps when the loop is idle.
import { DatabaseSync } from "node:sqlite";
import { FakeClock, FakeContainer, settle } from "../../src/core/fake-container";
import { TEST_TIMERS, type Timers } from "../../src/core/timers";
import type {
  BeginBootArgs,
  BeginBootResult,
  BootPlan,
  ControlForRuntime,
  MarkerPendingArgs,
  SleepInputs,
  SnapshotHandle,
} from "../../src/core/types";
import { RuntimeCore, sha256Hex } from "../../src/rt/core";
import { type RtTimers, TEST_RT_TIMERS } from "../../src/rt/rt-timers";
import type { StorageLike } from "../../src/rt/store";

export class SqlStore implements StorageLike {
  db = new DatabaseSync(":memory:");
  sql = {
    exec: (q: string, ...b: unknown[]) => {
      const st = this.db.prepare(q);
      const isRead = /^\s*(SELECT|WITH)/i.test(q);
      let rows: Record<string, unknown>[] = [];
      if (isRead) rows = st.all(...(b as never[])) as Record<string, unknown>[];
      else st.run(...(b as never[]));
      return { toArray: () => rows };
    },
  };
  transactionSync<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT tx");
    try {
      const r = fn();
      this.db.exec("RELEASE tx");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK TO tx");
      this.db.exec("RELEASE tx");
      throw e;
    }
  }
}

export interface CtlCall {
  m: string;
  a: unknown;
}

/** Scripted Control DO. Gens are issued once per opId (C13); markers and snapshots are kept in maps. */
export class FakeCtl implements ControlForRuntime {
  calls: CtlCall[] = [];
  epoch: "active" | "retiring" | "retired" | "none" = "active";
  genCounter = 0;
  gens = new Map<string, { gen: number; secret: string }>();
  /** Newest-first snapshot ids the plan may use. */
  snapshots: { id: string; state: string; kind: string }[] = [];
  markers = new Map<string, { state: string; snapshotId?: string; opId: string }>();
  alerts: { class: string; severity: string; detail?: string }[] = [];
  rings: { kind: string; detail?: unknown }[] = [];
  /** Next plan sqlite kind override (restore-blocked etc.). */
  planOverride: Partial<BootPlan> | null = null;
  settingsView?: ControlForRuntime["settingsView"];
  inputs: SleepInputs = { mode: "auto", blockers: [], inboxBusy: 0, costOk: true, oldestHeldAt: null };
  pending = 0;
  healthy = true;
  reslots = 0;
  started: number[] = [];
  slept: number[] = [];
  beginBootThrows = 0;
  private mk = 0;

  private log(m: string, a: unknown) {
    this.calls.push({ m, a });
  }
  count(m: string) {
    return this.calls.filter((c) => c.m === m).length;
  }
  async epochStatus() {
    this.log("epochStatus", null);
    return { status: this.epoch };
  }
  async beginBoot(a: BeginBootArgs): Promise<BeginBootResult> {
    this.log("beginBoot", a);
    if (this.beginBootThrows > 0) {
      this.beginBootThrows--;
      throw new Error("ctl down");
    }
    if (this.epoch !== "active") return { error: "epoch-not-active" } as BeginBootResult;
    let g = this.gens.get(a.opId);
    if (!g) {
      g = { gen: ++this.genCounter, secret: `secret-${this.genCounter}` };
      this.gens.set(a.opId, g);
    }
    const missed = new Set(a.missed ?? []);
    const snap = this.snapshots.find((s) => (s.state === "ok" || s.state === "suspect") && !missed.has(s.id));
    const valid = [...this.markers.entries()].find(
      ([, m]) => m.state === "valid" && m.snapshotId === snap?.id,
    );
    let sqlite: BootPlan["sqlite"] = { kind: "fresh" };
    let markerId: string | undefined;
    if (valid && a.ladder === 1) {
      markerId = valid[0];
      valid[1].state = "consumed";
      sqlite = { kind: "marker", markerId, snapshotId: snap?.id ?? "", gen: g.gen - 1, txid: {} };
    } else if (this.genCounter > 1) sqlite = { kind: "gen", gen: g.gen - 1 };
    const plan = {
      v: 1,
      mode: a.mode,
      inst: "t1",
      epoch: a.epoch,
      gen: g.gen,
      rootfs: snap ? { kind: "snapshot", snapshotId: snap.id, digest: "sha256:beef" } : { kind: "image" },
      sqlite,
      archive: null,
      dbs: [],
      restoreGens: [],
      runDoctor: !!a.runDoctor || a.ladder === 2 || a.ladder === 4,
      lockMode: "auto",
      ...(this.planOverride ?? {}),
    } as unknown as BootPlan;
    return {
      gen: g.gen,
      secret: g.secret,
      restoreGens: [],
      plan,
      digest: "sha256:beef",
      imageKey: "oc",
      snapshotId: snap?.id,
      markerId,
    };
  }
  async endBoot(a: { gen: number; opId: string; why: string }) {
    this.log("endBoot", a);
  }
  async onStarted(a: { gen: number }) {
    this.log("onStarted", a);
    this.started.push(a.gen);
  }
  async onSlept(a: { gen: number }) {
    this.log("onSlept", a);
    this.slept.push(a.gen);
  }
  async snapshotSaved(h: SnapshotHandle) {
    this.log("snapshotSaved", h);
    this.snapshots.unshift({ id: h.id, state: "ok", kind: h.kind });
  }
  async snapshotMiss(id: string) {
    this.log("snapshotMiss", id);
    const s = this.snapshots.find((x) => x.id === id);
    if (!s) return { state: "unknown" as const };
    s.state = s.state === "suspect" ? "bad" : "suspect";
    for (const m of this.markers.values()) if (m.snapshotId === id && m.state === "valid") m.state = "void";
    return { state: s.state as "suspect" | "bad" };
  }
  async markerPending(a: MarkerPendingArgs) {
    this.log("markerPending", a);
    for (const [id, m] of this.markers) if (m.opId === a.opId) return { id };
    const id = `mk-${++this.mk}`;
    this.markers.set(id, { state: "pending", opId: a.opId });
    return { id };
  }
  async markerValid(a: { id: string; snapshotId: string }) {
    this.log("markerValid", a);
    const m = this.markers.get(a.id);
    if (m && m.state === "pending") Object.assign(m, { state: "valid", snapshotId: a.snapshotId });
  }
  async markerVoid(a: { id: string; reason: string }) {
    this.log("markerVoid", a);
    const m = this.markers.get(a.id);
    if (m && m.state !== "consumed") m.state = "void";
  }
  async markReplicated(a: { upTo: number }) {
    this.log("markReplicated", a);
    return { count: 0 };
  }
  async inboxPending() {
    return this.pending;
  }
  async sleepInputs() {
    return { ...this.inputs };
  }
  async bootHealthy() {
    return this.healthy;
  }
  async r2Probe() {
    this.log("r2Probe", null);
    return { ok: true };
  }
  async reslot(a: { epoch: number; why: string }) {
    this.log("reslot", a);
    this.reslots++;
    return { ok: true, epoch: a.epoch + 1 };
  }
  async alert(a: { class: string; severity: "info" | "warn" | "high"; detail?: string }) {
    this.alerts.push(a);
  }
  async ring(a: { src: string; kind: string; detail?: unknown }) {
    this.rings.push(a);
  }
  alerted(cls: string) {
    return this.alerts.filter((a) => a.class === cls).length;
  }
}

export type CtlScript = Record<string, (args: { opId?: string; json?: unknown }) => unknown>;

/** Scripted ocsup answers for `ocsupctl <op>` and boot.json. */
export class FakeOcsup {
  ctl: CtlScript = {
    "sleep-check": () => ({ ok: true, blockers: [], nextWakeAtMs: null, eventJobs: [], channels: [] }),
    "sleep-prepare": () => ({ ok: true, status: "ready", retryAfterMs: null }),
    "sleep-cancel": () => ({ ok: true }),
    "sleep-stop-gateway": () => ({ ok: true, clean: true, code: 0, ms: 10, openRows: 0, eventJobs: [] }),
    "sleep-flush": () => ({
      ok: true,
      nextWakeAtMs: null,
      txidPerDb: { "state/openclaw.sqlite": 42 },
      bytesPerDb: { "state/openclaw.sqlite": 4096 },
      lastWriteAtPerDb: { "state/openclaw.sqlite": 1 },
      archive: null,
    }),
    "resume-after-sleep": () => ({ ok: true, startupzMs: 10 }),
    stop: () => ({ ok: true, state: "quiescing" }),
    "stop-status": () => ({ ok: true, state: "quiesced", unclean: [] }),
    "restart-gateway": () => ({ ok: true }),
  };
  ops: string[] = [];
  /** boot.json override (identity mismatch). */
  bootJson: Record<string, unknown> | null = null;
  identityFails = false;
}

export interface WorldOpts {
  timers?: Partial<Timers>;
  rtTimers?: Partial<RtTimers>;
  readyAfterMs?: number;
}

export function world(o: WorldOpts = {}) {
  const clock = new FakeClock();
  const c = new FakeContainer(clock);
  const ctl = new FakeCtl();
  const ocsup = new FakeOcsup();
  let storage = new SqlStore();
  const alarm = { at: null as number | null };
  let bridges = 0;
  const timers = { ...TEST_TIMERS, ...(o.timers ?? {}) };
  c.readyAfterMs = o.readyAfterMs ?? 0;
  c.handler = async (cmd) => {
    if (cmd[0] === "true") return { exitCode: 0 };
    if (cmd[0] === "/bin/cat") {
      if (ocsup.identityFails) return { exitCode: 1, stderr: "no file" };
      const b = core.boot();
      const body = ocsup.bootJson ?? {
        gen: b?.gen,
        epoch: 1,
        iid: b?.iid ?? "i".repeat(32),
        secretHash: await sha256Hex(b?.secret ?? ""),
      };
      return JSON.stringify(body);
    }
    if (cmd[1] === "/opt/ocrt/ocsupctl.mjs") {
      const op = cmd[2] as string;
      ocsup.ops.push(op);
      const i = cmd.indexOf("--op-id");
      const f = ocsup.ctl[op];
      const j = cmd.indexOf("--json");
      const json = j > 0 ? JSON.parse(cmd[j + 1] as string) : undefined;
      const ans = f ? f({ opId: i > 0 ? cmd[i + 1] : undefined, json }) : { ok: false, error: "unknown-op" };
      if (ans === "hang") return new Promise(() => {});
      return JSON.stringify(ans);
    }
    return { exitCode: 127 };
  };
  const mkCore = () =>
    new RuntimeCore({
      inst: "t1",
      epoch: 1,
      container: c,
      storage,
      clock,
      timers,
      ctl,
      gates: { control: () => ({}) as Fetcher, replica: () => ({}) as Fetcher },
      alarm: {
        set: (at) => {
          alarm.at = at;
        },
        get: () => alarm.at,
        delete: () => {
          alarm.at = null;
        },
      },
      instance: { vcpu: 2, memoryMib: 6144, diskMb: 20000 },
      secretEnv: () => ({ ANTHROPIC_API_KEY: "k" }),
      codeVersion: "cv-1",
      bridges: () => bridges,
      rtTimers: { ...TEST_RT_TIMERS, ...(o.rtTimers ?? {}) },
    });
  let core = mkCore();
  const w = {
    clock,
    c,
    ctl,
    ocsup,
    alarm,
    timers,
    get core() {
      return core;
    },
    get storage() {
      return storage;
    },
    setBridges(n: number) {
      bridges = n;
    },
    /** DO restart: new core on the same storage and container; monitor waiters of the old life are gone. */
    async restart() {
      core.halt();
      c.dropWaiters();
      core = mkCore();
      await core.init();
      return core;
    },
    /** New storage (Control DO rewound etc. is ctl-side; this is a fresh Runtime DO). */
    freshStorage() {
      storage = new SqlStore();
      core = mkCore();
    },
    state() {
      return core.rec().state;
    },
    /** Run every queued op and settle. */
    async idle() {
      await settle();
      await core.drainOps();
      await settle();
    },
    /** Fire the alarm if due (or now), then wait for ops. */
    async tick(advanceTo?: number) {
      if (advanceTo !== undefined && advanceTo > clock.now()) await clock.advance(advanceTo - clock.now());
      await core.alarm();
      await w.idle();
    },
    /** Advance to the stored alarm time and fire it, n times. */
    async runAlarms(n = 1) {
      for (let i = 0; i < n; i++) {
        if (alarm.at === null) return;
        await w.tick(alarm.at);
      }
    },
    /** Fire alarms until pred holds (max n). */
    async until(pred: () => boolean, n = 20) {
      for (let i = 0; i < n && !pred(); i++) {
        if (alarm.at === null) return;
        await w.tick(alarm.at);
      }
    },
    /** Heartbeat for the current boot. */
    async hb(p: Record<string, unknown> = {}) {
      const b = core.boot();
      return core.onHeartbeat({ gen: b?.gen, seq: 1, phase: "running", draining: false, ...p });
    },
    async event(kind: string, p: Record<string, unknown> = {}) {
      const b = core.boot();
      return core.onEvent({ gen: b?.gen, kind, ts: clock.now(), ...p });
    },
    rows(): number[] {
      return ctl.rings.filter((r) => r.kind === "row").map((r) => (r.detail as { row: number }).row);
    },
    /** Start from new to running. */
    async boot() {
      await core.init();
      await core.ensure();
      await w.idle();
      return core.rec().state;
    },
  };
  return w;
}

export type World = ReturnType<typeof world>;
