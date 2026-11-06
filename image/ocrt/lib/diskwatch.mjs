// Disk watch (plan §4.12 "Disk watch"; scope §1.1 row "Disk"; contract alert `disk-full`).
// ENOSPC / EDQUOT / SQLITE_FULL from ANY child maps to `disk-full` BEFORE any replica-* class (Z0.4):
// a full disk is never `replica-down`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BIN } from "./bins.mjs";

export const RESERVE_BYTES = 512 * 1024 * 1024;
export const LEVELS = Object.freeze({ alert: 80, clean: 90, full: 95 });
const DISK_RE =
  /ENOSPC|EDQUOT|no space left on device|disk quota exceeded|SQLITE_FULL|database or disk is full|disk full/i;

/** Is this error (Error, code or text) a full disk? */
export function isDiskFull(e) {
  if (!e) return false;
  if (typeof e === "string") return DISK_RE.test(e);
  return DISK_RE.test(`${e.code || ""} ${e.message || ""} ${e.errcode || ""}`);
}

/**
 * Pick the class of a fault from all evidence. disk-full wins over every replica class.
 * classes: e.g. ["replica-crash", "disk-full"] → "disk-full".
 */
export function faultClass(classes, texts = []) {
  if (classes.includes("disk-full") || texts.some((t) => isDiskFull(t))) return "disk-full";
  for (const c of ["replica-oom", "replica-crash", "replica-down:infra", "replica-down:local"])
    if (classes.includes(c)) return c;
  return classes[0] || null;
}

/** statfs → {usedPct, inodesPct, freeBytes, totalBytes}. */
export function usage(p = "/") {
  const s = fs.statfsSync(p);
  const total = s.blocks * s.bsize;
  const free = s.bavail * s.bsize;
  const usedPct = total ? 100 * (1 - s.bavail / s.blocks) : 0;
  const inodesPct = s.files ? 100 * (1 - s.ffree / s.files) : 0;
  return {
    usedPct: +usedPct.toFixed(2),
    inodesPct: +inodesPct.toFixed(2),
    freeBytes: free,
    totalBytes: total,
  };
}

export class DiskWatch {
  /**
   * o: {path="/", varDir, alert(cls, sev, detail), cleanup?: async () => {freed}, onDegraded?(bool),
   *     statfs?: () => usage, reserveBytes?, fallocate?: (file, bytes) => bool}
   */
  constructor(o) {
    this.o = { path: "/", reserveBytes: RESERVE_BYTES, ...o };
    this.stat = o.statfs || (() => usage(this.o.path));
    this.reserve = path.join(o.varDir, "reserve");
    this.level = "ok";
    this.degraded = false;
    this.low = false;
    this.last = null;
  }

  /**
   * M4b N3: free space (without the reserve file) under the reserve → low. While low, ocsup runs no archive,
   * no shadow and no Litestream compaction, and raises disk-full once; the gateway stays up. Off again at
   * 2× the reserve free, then the reserve file is made again (N9).
   */
  #lowRule(u) {
    const free = u.freeBytes;
    if (!this.low && free < this.o.reserveBytes) {
      this.low = true;
      this.o.onLow?.(true, u);
      return "low";
    }
    if (this.low && free >= 2 * this.o.reserveBytes) {
      this.low = false;
      this.o.onLow?.(false, u);
      return "low-off";
    }
    return null;
  }

  /** After the restore (scope: reserve made after restore, only if free > 2x reserve). */
  makeReserve() {
    if (fs.existsSync(this.reserve)) return { made: false, why: "exists" };
    const u = this.stat();
    if (u.freeBytes <= 2 * this.o.reserveBytes)
      return { made: false, why: "low-free", freeBytes: u.freeBytes };
    const ok = (this.o.fallocate || ((f, n) => spawnSync(BIN.fallocate, ["-l", String(n), f]).status === 0))(
      this.reserve,
      this.o.reserveBytes,
    );
    if (ok) fs.chmodSync(this.reserve, 0o600);
    return { made: ok };
  }

  /** One check. Returns {level, usedPct, inodesPct, actions[]}. */
  async check() {
    const u = this.stat();
    const pct = Math.max(u.usedPct, u.inodesPct);
    const actions = [];
    let level = "ok";
    if (pct >= LEVELS.alert) level = "alert";
    if (pct >= LEVELS.clean) level = "clean";
    if (pct >= LEVELS.full) level = "full";
    if (level !== "ok" && this.level === "ok") {
      this.o.alert?.("disk-high", "warn", `used ${u.usedPct}% inodes ${u.inodesPct}%`);
      actions.push("alert");
    }
    if (level === "clean" || level === "full") {
      const r = (await this.o.cleanup?.()) || {};
      actions.push(`cleanup:${r.freed ?? "?"}`);
    }
    if (level === "full") {
      if (fs.existsSync(this.reserve)) {
        fs.rmSync(this.reserve, { force: true });
        actions.push("reserve-freed");
      }
      if (!this.degraded) {
        this.degraded = true;
        this.o.onDegraded?.(true);
        this.o.alert?.("disk-full", "high", `used ${u.usedPct}% inodes ${u.inodesPct}%`);
        actions.push("disk-full");
      }
    } else if (this.degraded && pct < LEVELS.clean) {
      this.degraded = false;
      this.o.onDegraded?.(false);
      actions.push("recovered");
    }
    const lr = this.#lowRule(u);
    if (lr) actions.push(lr);
    if (level === "ok" && !this.low && !fs.existsSync(this.reserve)) {
      const m = this.makeReserve();
      if (m.made) actions.push("reserve-made");
    }
    this.level = level;
    this.last = { level, ...u, actions };
    return this.last;
  }

  /** Any child error that is a full disk → the same path as level `full`. Returns true if handled. */
  async onChildError(e) {
    if (!isDiskFull(e)) return false;
    if (!this.degraded) {
      this.degraded = true;
      this.o.onDegraded?.(true);
      this.o.alert?.("disk-full", "high", String(e.message || e).slice(0, 300));
    }
    return true;
  }

  /** Heartbeat field (contract HeartbeatReq.disk). */
  hb() {
    return this.last ? { usedPct: this.last.usedPct, inodesPct: this.last.inodesPct } : null;
  }
}
