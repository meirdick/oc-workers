// SandboxSession state machine (docs/12 §3). One per install, DO name `sb:<inst>`. Owns the sandbox container:
// wake on the first exec, run commands, charge exec seconds and sandbox hours, back up /workspace to R2 with
// DirectoryBackup, and sleep on idle, on install sleep or when the sandbox budget is spent.
// Everything platform-shaped is a port, so vitest drives it with a fake container and fake backups.
import type { CapTake, CapVerb } from "../gates/caps";
import { ExclusiveQueue } from "../rt/exclusive";
import { ERR, exitFrame, frame, OUT } from "./wire";

export const sbxName = (inst: string) => `sb:${inst}`;
export const WORKSPACE = "/workspace";
/** Container image key in wrangler.jsonc `containers[SandboxSession].images`. */
export const IMAGE_KEY = "sbx";
/** guess: basic (1/4 vCPU, 1 GiB, 4 GB) fits shell, git, python; ~$0.01/h. */
export const INSTANCE = "basic";

export interface SbxTimers {
  /** Alarm period while running: charge hours, check budget and idle. */
  tickMs: number;
  /** No exec for this long → back up and sleep. */
  idleMs: number;
  /** Back up a used, running workspace at least this often (bounds loss on a platform stop). */
  backupEveryMs: number;
  /** setInactivityTimeout: a stop when the DO goes quiet without its alarm (safety net, > tickMs). */
  inactivityMs: number;
  /** Longest single command, seconds (`timeout` in the container). */
  maxExecS: number;
}
export const SBX_TIMERS: SbxTimers = {
  tickMs: 60_000,
  idleMs: 10 * 60_000,
  backupEveryMs: 30 * 60_000,
  inactivityMs: 15 * 60_000,
  maxExecS: 1800,
};
/** Backup records kept; older ones are deleted from R2. */
export const KEEP_BACKUPS = 2;
/** Failed backups in a row before a forced sleep gives up on the workspace (alert high). */
export const MAX_SAVE_FAILS = 3;

export interface BackupRecord {
  id: string;
  dir: string;
  size: number;
  sha256: string;
  format: string;
  name?: string;
}

interface Proc {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exitCode: Promise<number>;
}
/** ctx.container subset. */
export interface SbxContainer {
  readonly running: boolean;
  images(): Record<string, string>;
  start(o: { image: string; enableInternet: boolean; instance: string; entrypoint: string[] }): void;
  exec(cmd: string[], o: { stdin?: ReadableStream<Uint8Array>; cwd?: string }): Promise<Proc>;
  destroy(reason?: string): Promise<void>;
  setInactivityTimeout(ms: number): Promise<void>;
}
/** DirectoryBackup subset (@cloudflare/sandbox 1.0). */
export interface SbxBackups {
  backup(o: { dir: string; name?: string }): Promise<BackupRecord>;
  restore(r: BackupRecord): Promise<void>;
  delete(r: BackupRecord): Promise<void>;
}
/** Control DO calls (ledger, through gateCall). */
export interface SbxCtl {
  capAdd(verb: CapVerb, n: number): Promise<unknown>;
  capCheck(verb: CapVerb): Promise<CapTake>;
  ring(src: string, kind: string, detail?: unknown): Promise<unknown>;
  alert(cls: string, severity: "info" | "warn" | "high", detail?: string): Promise<unknown>;
}
export interface SbxStore {
  get<T>(k: string): Promise<T | undefined>;
  put(k: string, v: unknown): Promise<void>;
}
export interface SbxAlarm {
  set(at: number): Promise<void> | void;
  delete(): Promise<void> | void;
}

export type SbxState = "asleep" | "running";
export interface SbxRec {
  state: SbxState;
  startedAt: number | null;
  /** Sandbox hours are charged up to this time. */
  chargedTo: number | null;
  lastUseAt: number;
  lastBackupAt: number | null;
  backups: BackupRecord[];
  saveFails: number;
  wakes: number;
  /** Why the last sleep happened. */
  lastSleep: string | null;
}
const FRESH: SbxRec = {
  state: "asleep",
  startedAt: null,
  chargedTo: null,
  lastUseAt: 0,
  lastBackupAt: null,
  backups: [],
  saveFails: 0,
  wakes: 0,
  lastSleep: null,
};

export class SbxError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

export interface SbxDeps {
  container: SbxContainer;
  backups: SbxBackups;
  ctl: SbxCtl;
  store: SbxStore;
  alarm: SbxAlarm;
  now: () => number;
  timers?: Partial<SbxTimers>;
}

export type SleepReason = "idle" | "install" | "budget" | "owner";

const HOUR_MS = 3_600_000;

export class SandboxCore {
  readonly t: SbxTimers;
  private readonly q = new ExclusiveQueue();
  private rec: SbxRec = { ...FRESH };
  /** Commands running now (in memory: a DO restart ends them with the old isolate's streams). */
  inflight = 0;

  constructor(readonly d: SbxDeps) {
    this.t = { ...SBX_TIMERS, ...(d.timers ?? {}) };
  }

  private async save(): Promise<void> {
    await this.d.store.put("sbx", this.rec);
  }

  /** Load the record. A record that says running while no container runs = a platform stop (lost). */
  async init(): Promise<void> {
    this.rec = { ...FRESH, ...((await this.d.store.get<SbxRec>("sbx")) ?? {}) };
    if (this.rec.state !== "running") return;
    if (!this.d.container.running) await this.lost();
    else {
      // The inactivity timeout does not survive a DO restart (sandbox/concepts/lifetime).
      await this.d.container.setInactivityTimeout(this.t.inactivityMs);
      await this.d.alarm.set(this.d.now() + this.t.tickMs);
    }
  }

  status() {
    const r = this.rec;
    return {
      state: r.state,
      running: this.d.container.running,
      inflight: this.inflight,
      startedAt: r.startedAt,
      lastUseAt: r.lastUseAt || null,
      lastBackupAt: r.lastBackupAt,
      backups: r.backups.map((b) => ({ id: b.id, size: b.size })),
      wakes: r.wakes,
      lastSleep: r.lastSleep,
    };
  }

  /** Charge sandbox hours from the mark to `to`. */
  private async chargeHours(to: number): Promise<void> {
    const from = this.rec.chargedTo;
    this.rec.chargedTo = to;
    if (from !== null && to > from) await this.d.ctl.capAdd("sandbox", (to - from) / HOUR_MS);
  }

  /** The container stopped without us (platform stop, OOM, inactivity). Changes since the last backup are gone. */
  private async lost(): Promise<void> {
    const now = this.d.now();
    // guess: it stopped no later than the inactivity timeout after the last use.
    const end = Math.min(now, Math.max(this.rec.lastUseAt, this.rec.chargedTo ?? 0) + this.t.inactivityMs);
    await this.chargeHours(end);
    const dirty = this.rec.lastUseAt > (this.rec.lastBackupAt ?? 0);
    this.rec = { ...this.rec, state: "asleep", startedAt: null, chargedTo: null, lastSleep: "lost" };
    await this.save();
    await this.d.ctl.ring("sbx", "lost", { dirty });
    if (dirty)
      await this.d.ctl.alert("sbx-lost", "warn", "sandbox stopped before a backup; recent edits are gone");
  }

  /** Wake: start the container and restore the newest good backup. Idempotent; runs in the queue. */
  ensure(): Promise<void> {
    return this.q.run(async () => {
      const c = this.d.container;
      if (this.rec.state === "running" && c.running) return;
      if (this.rec.state === "running") await this.lost();
      const image = c.images()[IMAGE_KEY];
      if (!image) throw new SbxError(503, `image key ${IMAGE_KEY} missing`);
      try {
        c.start({ image, enableInternet: false, instance: INSTANCE, entrypoint: ["sleep", "infinity"] });
      } catch (e) {
        await this.d.ctl.ring("sbx", "start-failed", { err: String(e).slice(0, 300) });
        throw new SbxError(503, "sandbox start failed; retry");
      }
      await c.setInactivityTimeout(this.t.inactivityMs);
      const now = this.d.now();
      this.rec = { ...this.rec, state: "running", startedAt: now, chargedTo: now, lastUseAt: now };
      this.rec.wakes++;
      await this.save();
      await this.restore();
      await this.d.alarm.set(now + this.t.tickMs);
    });
  }

  /** Newest backup first; a bad one is skipped with an alert. None → an empty workspace. */
  private async restore(): Promise<void> {
    const bad: string[] = [];
    for (const b of [...this.rec.backups].reverse()) {
      try {
        await this.d.backups.restore(b);
        if (bad.length) this.rec.backups = this.rec.backups.filter((x) => !bad.includes(x.id));
        await this.save();
        return;
      } catch (e) {
        bad.push(b.id);
        await this.d.ctl.ring("sbx", "restore-failed", { id: b.id, err: String(e).slice(0, 300) });
      }
    }
    if (bad.length)
      await this.d.ctl.alert("sbx-restore-failed", "high", `no sandbox backup restored (${bad.join(", ")})`);
    const p = await this.d.container.exec(["mkdir", "-p", WORKSPACE], {});
    await p.exitCode;
  }

  /**
   * Run `cmd` under `sh -c` with `stdin`, at most `maxS` seconds. Returns the framed output stream and a promise
   * that settles when the command ended and its seconds were charged (for waitUntil).
   */
  async exec(
    cmd: string,
    stdin: ReadableStream<Uint8Array> | undefined,
    maxS: number,
  ): Promise<{ body: ReadableStream<Uint8Array>; done: Promise<void> }> {
    await this.ensure();
    const limit = Math.max(1, Math.min(Math.floor(maxS), this.t.maxExecS));
    const t0 = this.d.now();
    this.inflight++;
    this.rec.lastUseAt = t0;
    let proc: Proc;
    try {
      // -k 5: SIGKILL 5 s after SIGTERM. Exit 124 = cut by the limit.
      proc = await this.d.container.exec(["timeout", "-k", "5", String(limit), "/bin/sh", "-c", cmd], {
        stdin,
        cwd: "/",
      });
    } catch (e) {
      this.inflight--;
      throw new SbxError(503, `exec failed: ${String(e).slice(0, 200)}`);
    }
    const ts = new TransformStream<Uint8Array, Uint8Array>();
    const w = ts.writable.getWriter();
    let chain = Promise.resolve();
    const put = (b: Uint8Array) => {
      chain = chain.then(() => w.write(b)).catch(() => undefined);
      return chain;
    };
    const pump = async (s: ReadableStream<Uint8Array> | null, type: number) => {
      if (!s) return;
      const r = s.getReader();
      for (;;) {
        const x = await r.read();
        if (x.done) return;
        await put(frame(type, x.value));
      }
    };
    const done = (async () => {
      let code = 137;
      try {
        await Promise.all([pump(proc.stdout, OUT), pump(proc.stderr, ERR)]);
        code = await proc.exitCode;
        await put(exitFrame(code));
      } catch {
        // stream cut (container stopped): no exit frame; the client reports exit 125.
      } finally {
        await chain;
        await w.close().catch(() => undefined);
        this.inflight--;
        const end = this.d.now();
        this.rec.lastUseAt = end;
        await this.d.ctl.capAdd("exec", Math.max(1, Math.ceil((end - t0) / 1000)));
        await this.save();
      }
    })();
    return { body: ts.readable, done };
  }

  /** Back up /workspace. Never throws; false on failure. Caller holds the queue. */
  private async backup(why: string): Promise<boolean> {
    try {
      const r = await this.d.backups.backup({ dir: WORKSPACE, name: `${why}-${this.d.now()}` });
      const all = [...this.rec.backups, r];
      const drop = all.slice(0, Math.max(0, all.length - KEEP_BACKUPS));
      this.rec = { ...this.rec, backups: all.slice(-KEEP_BACKUPS), lastBackupAt: this.d.now(), saveFails: 0 };
      await this.save();
      for (const b of drop) await this.d.backups.delete(b).catch(() => undefined);
      return true;
    } catch (e) {
      this.rec.saveFails++;
      await this.save();
      await this.d.ctl.ring("sbx", "backup-failed", {
        why,
        n: this.rec.saveFails,
        err: String(e).slice(0, 300),
      });
      return false;
    }
  }

  /**
   * Back up, then stop the container. idle: only with no command running. A failed backup keeps the container
   * up (the alarm retries) until MAX_SAVE_FAILS; then it stops anyway with alert `sbx-workspace-lost`.
   */
  sleep(reason: SleepReason): Promise<{ slept: boolean; why?: string }> {
    return this.q.run(async () => {
      if (this.rec.state !== "running") return { slept: false, why: "asleep" };
      if (!this.d.container.running) {
        await this.lost();
        return { slept: true, why: "lost" };
      }
      if (reason === "idle" && this.inflight > 0) return { slept: false, why: "busy" };
      const ok = await this.backup(reason);
      if (!ok && this.rec.saveFails < MAX_SAVE_FAILS) return { slept: false, why: "backup-failed" };
      if (!ok)
        await this.d.ctl.alert(
          "sbx-workspace-lost",
          "high",
          `sandbox stopped after ${this.rec.saveFails} failed backups (${reason})`,
        );
      await this.d.container.destroy(`sleep:${reason}`);
      await this.chargeHours(this.d.now());
      this.rec = { ...this.rec, state: "asleep", startedAt: null, chargedTo: null, lastSleep: reason };
      await this.save();
      await this.d.alarm.delete();
      await this.d.ctl.ring("sbx", "sleep", { reason, backup: ok });
      return { slept: true };
    });
  }

  /** Alarm tick: charge hours, then sleep on a spent budget or idle; periodic backup; re-arm while running. */
  async alarm(): Promise<void> {
    if (this.rec.state !== "running") return;
    if (!this.d.container.running) {
      await this.q.run(() => this.lost());
      return;
    }
    const now = this.d.now();
    await this.chargeHours(now);
    await this.save();
    const budget = await this.d.ctl.capCheck("sandbox");
    let r: { slept: boolean } = { slept: false };
    if (!budget.ok) r = await this.sleep("budget");
    else if (this.inflight === 0 && now - this.rec.lastUseAt >= this.t.idleMs) r = await this.sleep("idle");
    else if (
      this.inflight === 0 &&
      this.rec.lastUseAt > (this.rec.lastBackupAt ?? 0) &&
      now - (this.rec.lastBackupAt ?? this.rec.startedAt ?? now) >= this.t.backupEveryMs
    )
      await this.q.run(() => this.backup("periodic"));
    if (!r.slept && this.rec.state === "running") await this.d.alarm.set(this.d.now() + this.t.tickMs);
  }
}
