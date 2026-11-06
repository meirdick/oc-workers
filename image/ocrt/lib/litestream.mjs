// Litestream child management (plan §4.2, §4.5, §4.8; scope §1.1 rows "Signals", "Litestream";
// amend §1.5 F1.1-F1.7).
//
// - Runs as uid 1000 in leaf cgroup ocrt/sys, tracked (lib/ocio-run.mjs).
// - Restart after an unplanned exit: backoff 1, 2, 5, 10, 30 s (reset after 60 s up).
// - Exit classes: replica-oom (oom_kill rose in ocrt/sys), disk-full (ENOSPC line), replica-crash.
//   They do not escalate and are never SQLite evidence (Z0.6).
// - Planned restart (set or tier change): SIGINT + final sync, start; holds the fault rule 30 s.
// - Drain: a SIGTERM to every process also hits Litestream; the Go runtime ignores an inherited
//   SIG_IGN, so it exits after its own shutdown sync. In drain mode we respawn it at once (same gen,
//   same meta dir: the chain continues) so the gateway's last writes still replicate. stopFinal()
//   then ends it with SIGINT.
// - stopFinal(): F1.6 clean = exit 0 within 10 s of SIGINT and no `shutdown sync failed` line.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { BIN } from "./bins.mjs";
import { metaPathFor, renderConfig } from "./ls-config.mjs";
import { durMs, LagTracker, PLANNED_HOLD_MS } from "./ls-lag.mjs";
import { classifyLine, lineSplitter } from "./ls-log.mjs";
import { spawnTracked } from "./ocio-run.mjs";
import { oomFor } from "./oom.mjs";

export const BACKOFF_S = [1, 2, 5, 10, 30];
export const FINAL_EXIT_MS = 10_000;
/** A restarted Litestream counts as up (fault clock stops) only after this long without an exit. */
export const UP_OK_MS = 10_000;

/** oom_kill counter of a cgroup dir (memory.events). */
export function oomKills(cgDir) {
  try {
    const m = /^oom_kill (\d+)$/m.exec(fs.readFileSync(path.join(cgDir, "memory.events"), "utf8"));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

export class Litestream extends EventEmitter {
  /**
   * o: {state, inst, gen, s3, cfgPath, metaRoot?, preset?, syncInterval?, cgSys?, bin?, now?,
   *     spawn?: (argv0, args, opts) => ChildProcess, writeConfig?: (path, text) => void, asRoot?}
   */
  constructor(o) {
    super();
    this.o = { bin: BIN.litestream, syncInterval: "1s", preset: "lean", ...o };
    this.now = o.now || Date.now;
    this.spawnFn = o.spawn || ((c, a, so) => spawnTracked(c, a, so));
    this.writeConfig =
      o.writeConfig ||
      ((p, text) => {
        fs.writeFileSync(`${p}.tmp`, text, { mode: 0o400 });
        if (!o.asRoot) fs.chownSync(`${p}.tmp`, 1000, 1000);
        fs.renameSync(`${p}.tmp`, p);
      });
    this.dbs = [];
    this.child = null;
    this.lag = new LagTracker({ dbs: [], syncInterval: this.o.syncInterval, now: this.now });
    this.backoff = 0;
    this.restarts = 0;
    this.draining = false;
    this.stopped = false;
    this.downSince = null; // unplanned down time (fault clock), null while up or planned
    this.lastExit = null;
    this.run = null; // {pid, startedAt, unclean:false, diskFull:false, oomBefore}
    this.timer = null;
  }

  pid() {
    return this.child?.pid || 0;
  }

  /** Render + write the config for the current set. */
  writeCfg() {
    const text = renderConfig({
      state: this.o.state,
      gen: this.o.gen,
      inst: this.o.inst,
      dbs: this.dbs,
      s3: this.o.s3,
      syncInterval: this.o.syncInterval,
      preset: this.o.preset,
      metaRoot: this.o.metaRoot,
      levelsOverride: this.o.levelsOverride,
      lowDisk: !!this.o.lowDisk,
      legacyMeta: this.o.legacyMeta,
      prefix: this.o.prefix,
    });
    this.writeConfig(this.o.cfgPath, text);
    return text;
  }

  metaPaths() {
    return Object.fromEntries(this.dbs.map((r) => [r, metaPathFor(this.o.gen, r, this.o.metaRoot)]));
  }

  /** M4b N3: low-disk config (no compaction, lib/ls-config.mjs LOW_DISK); planned restart when it changes. */
  async setLowDisk(on) {
    if (!!this.o.lowDisk === !!on) return 0;
    this.o.lowDisk = !!on;
    if (!this.child || this.stopped) return 0;
    await this.plannedStop("low-disk");
    this.lag.hold(PLANNED_HOLD_MS, "planned-restart");
    return this.#spawn("low-disk");
  }

  /** Start (or planned-restart on a changed set). Returns the pid or 0. */
  async apply(dbs, { tier } = {}) {
    const next = [...new Set(dbs)].sort();
    let changed = next.join("|") !== this.dbs.join("|");
    if (tier && tier !== this.o.tier) {
      this.o.tier = tier;
      this.o.syncInterval = { normal: "1s", slow: "10s", slower: "60s" }[tier] || this.o.syncInterval;
      this.lag.iMs = durMs(this.o.syncInterval);
      changed = true;
    }
    if (!changed && this.child) return this.child.pid;
    // Same set, backoff restart pending (H15): the periodic apply must not start it early, or the
    // fault clock and the backoff reset on each 10 s discovery tick.
    if (!changed && this.timer) return 0;
    if (this.child) await this.plannedStop("set-change");
    this.dbs = next;
    this.lag.setDbs(next);
    if (!next.length || this.stopped) return 0;
    this.lag.hold(PLANNED_HOLD_MS, "planned-restart");
    return this.#spawn("apply");
  }

  #spawn(why) {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped || !this.dbs.length) return 0;
    this.writeCfg();
    const child = this.spawnFn(this.o.bin, ["replicate", "-config", this.o.cfgPath], {
      cg: this.o.cgSys,
      oom: oomFor("litestream"),
      asRoot: this.o.asRoot,
      env: this.o.env,
    });
    this.child = child;
    const run = {
      pid: child.pid,
      startedAt: this.now(),
      unclean: false,
      diskFull: false,
      stale: false,
      oomBefore: this.o.cgSys ? oomKills(this.o.cgSys) : 0,
      planned: false,
      sigint: false,
    };
    this.run = run;
    // Fault clock (H15): a backoff respawn does not stop it; only UP_OK_MS of uptime does. A planned
    // start (apply, resume, drain respawn) is not a fault.
    if (!why.startsWith("restart:")) this.downSince = null;
    else if (this.downSince !== null) {
      const t = setTimeout(() => {
        if (this.run === run && this.child === child) this.downSince = null;
      }, UP_OK_MS);
      t.unref?.();
    }
    this.lag.clearFaults();
    const onLine = (line) => this.#line(run, line);
    child.stdout?.on("data", lineSplitter(onLine));
    child.stderr?.on("data", lineSplitter(onLine));
    child.on("exit", (code, signal) => this.#exit(child, run, code, signal));
    this.emit("start", { pid: child.pid, why, dbs: this.dbs });
    return child.pid;
  }

  #line(run, line) {
    this.emit("line", line);
    const c = classifyLine(line);
    if (!c) return;
    if (c.cls === "ltx-missing" || c.cls === "sync-error") {
      if (c.cls === "ltx-missing")
        for (const rel of this.#dbsByBase(c.db)) this.lag.setFault(rel, "ltx-missing");
    }
    if (c.cls === "shutdown-sync-failed") run.unclean = true;
    if (c.cls === "disk-full") {
      run.diskFull = true;
      this.emit("disk-full", c);
    }
    if (c.cls === "gate-stale") {
      run.stale = true;
      this.emit("stale", c);
    }
    this.emit("fault-line", c);
  }

  #dbsByBase(base) {
    if (!base) return this.dbs;
    const hit = this.dbs.filter((r) => path.basename(r) === base);
    return hit.length ? hit : this.dbs;
  }

  #exit(child, run, code, signal) {
    if (this.child === child) this.child = null;
    const oom = this.o.cgSys ? oomKills(this.o.cgSys) > run.oomBefore : false;
    let cls = "replica-crash";
    if (run.planned) cls = "planned";
    else if (run.diskFull)
      cls = "disk-full"; // before replica-* (Z0.4)
    else if (oom || signal === "SIGKILL") cls = oom ? "replica-oom" : "replica-crash";
    else if (this.draining && (code === 0 || signal === "SIGTERM")) cls = "drain-term";
    const rec = { pid: run.pid, code, signal, cls, upMs: this.now() - run.startedAt, unclean: run.unclean };
    this.lastExit = rec;
    this.emit("exit", rec);
    if (cls === "planned" || this.stopped) return;
    if (cls === "drain-term") {
      // Respawn at once: SIGTERM-to-all hit Litestream before the gateway's last writes.
      this.restarts++;
      this.#spawn("drain-respawn");
      return;
    }
    if (this.downSince === null) this.downSince = this.now();
    if (rec.upMs > 60_000) this.backoff = 0;
    const wait = BACKOFF_S[Math.min(this.backoff++, BACKOFF_S.length - 1)];
    this.restarts++;
    this.emit("fault", { cls, wait });
    this.timer = setTimeout(() => this.#spawn(`restart:${cls}`), wait * 1000);
    this.timer.unref?.();
  }

  /**
   * Wait until the running Litestream has been up for `ms` (a fresh spawn has not read the WAL tail
   * yet, so its local L0 max is old and a lag of 0 means nothing). Returns true if reached, false on cap.
   */
  async waitUp(ms, capMs = 10_000) {
    const end = this.now() + capMs;
    for (;;) {
      const up = this.child && this.run ? this.now() - this.run.startedAt : -1;
      if (up >= ms) return true;
      if (this.now() >= end) return false;
      await new Promise((r) => setTimeout(r, Math.min(200, Math.max(10, ms - Math.max(up, 0)))));
    }
  }

  /** Unplanned down time in ms (0 while up or held). Feeds faultStage(). */
  downForMs() {
    return this.downSince === null ? 0 : this.now() - this.downSince;
  }

  setDraining() {
    this.draining = true;
  }

  /** Signal and wait. Returns {exited, code, signal, ms}. */
  async #signalWait(sig, ms) {
    const child = this.child;
    if (!child) return { exited: true, code: this.lastExit?.code ?? null, signal: null, ms: 0 };
    const t0 = this.now();
    const done = new Promise((r) => child.once("exit", (code, signal) => r({ exited: true, code, signal })));
    try {
      child.kill(sig);
    } catch {}
    let to;
    const res = await Promise.race([
      done,
      new Promise((r) => {
        to = setTimeout(() => r({ exited: false }), ms);
      }),
    ]);
    clearTimeout(to);
    if (!res.exited) {
      try {
        child.kill("SIGKILL");
      } catch {}
      await done;
    }
    return { ...res, ms: this.now() - t0 };
  }

  /** Planned stop for a restart: SIGINT (final sync), cap 30 s. */
  async plannedStop(why) {
    if (!this.run || !this.child) return null;
    this.run.planned = true;
    this.lag.hold(PLANNED_HOLD_MS, `planned:${why}`);
    const r = await this.#signalWait("SIGINT", 30_000);
    this.emit("planned-stop", { why, ...r });
    return r;
  }

  /**
   * Final stop (sleep phase 5, drain step 4, planned stop). No restart after it.
   * clean (F1.6) = exit code 0 within FINAL_EXIT_MS of SIGINT and no shutdown-sync-failed line.
   */
  async stopFinal(why = "final") {
    this.stopped = true;
    clearTimeout(this.timer);
    const run = this.run;
    if (!this.child || !run) {
      return {
        why,
        clean: false,
        ran: false,
        code: this.lastExit?.code ?? null,
        ms: 0,
        reason: "not-running",
      };
    }
    run.planned = true;
    run.sigint = true;
    const r = await this.#signalWait("SIGINT", FINAL_EXIT_MS);
    const clean = r.exited && r.code === 0 && !run.unclean && !run.diskFull;
    const reason = !r.exited
      ? "timeout"
      : r.code !== 0
        ? `exit:${r.code ?? r.signal}`
        : run.unclean
          ? "shutdown-sync-failed"
          : run.diskFull
            ? "disk-full"
            : null;
    const res = { why, clean, ran: true, code: r.code ?? null, signal: r.signal ?? null, ms: r.ms, reason };
    this.emit("final", res);
    return res;
  }

  /** Re-arm after stopFinal (resume-after-sleep: same gen, no new meta dir). */
  resume() {
    this.stopped = false;
    this.lag.hold(PLANNED_HOLD_MS, "resume");
    return this.#spawn("resume");
  }

  /** Kill without a final sync (self-fence). */
  async kill() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.child) await this.#signalWait("SIGKILL", 5000);
  }

  status() {
    return {
      pid: this.pid(),
      dbs: this.dbs,
      restarts: this.restarts,
      tier: this.o.tier || "normal",
      lastExit: this.lastExit,
      held: this.lag.held() ? this.lag.holdWhy : null,
      lag: this.lag.report(),
    };
  }
}
