// Replication lag per DB and the fault clock (plan §4.8 "Replication fault response";
// amend §1.5 F1.4, F1.5; §1.6 S4; scope §1.1 "planned restart sets a 30 s flag").
//
// Lag in TXIDs = max TXID of local level-0 files minus max TXID of the level-0000 keys that the gate
// recorded for g<gen>/<db>. Keys of other levels never count (F1.5).
// Time rule "lag > I + 10 s" = a local TXID seen at time t is not remote by t + I + 10 s.
// So a busy DB whose lag is never 0 at a sample instant is still healthy while uploads keep up.

export const PLANNED_HOLD_MS = 30_000;

/** Parse a Go duration like "1s", "10s", "1m" to ms. */
export function durMs(s) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(s));
  if (!m) throw new Error(`bad duration ${s}`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
}

/** Max TXID from LTX file names `<min16>-<max16>.ltx`. 0 for none. */
export function maxTxidOfNames(names) {
  let max = 0;
  for (const n of names) {
    const m = /^[0-9a-f]{16}-([0-9a-f]{16})\.ltx$/.exec(n);
    if (m) max = Math.max(max, Number.parseInt(m[1], 16));
  }
  return max;
}

export class LagTracker {
  /** o: {dbs:[rel], syncInterval:'1s', now?:()=>ms} */
  constructor(o) {
    this.now = o.now || Date.now;
    this.iMs = durMs(o.syncInterval || "1s");
    this.db = new Map();
    this.holdUntil = 0;
    this.holdWhy = null;
    this.setDbs(o.dbs || []);
  }
  setDbs(rels) {
    const next = new Map();
    for (const r of rels) next.set(r, this.db.get(r) || { local: 0, remote: 0, samples: [], fault: null });
    this.db = next;
  }
  /** Hold the fault rule (planned restart: 30 s; seeding: S4 cap). */
  hold(ms, why) {
    const until = this.now() + ms;
    if (until > this.holdUntil) {
      this.holdUntil = until;
      this.holdWhy = why;
    }
  }
  /** Set the hold end, also to an earlier time: the end of an admission hold (Litestream.release). */
  holdSet(ms, why) {
    this.holdUntil = this.now() + ms;
    this.holdWhy = why;
  }
  held() {
    return this.now() < this.holdUntil;
  }
  /** Local max L0 TXID of each DB (from the ocio lsmeta scan). */
  setLocal(rel, txid) {
    const d = this.db.get(rel);
    if (!d || !(txid >= 0)) return;
    if (txid > d.local) d.samples.push({ t: this.now(), txid });
    d.local = txid;
    this.#trim(d);
  }
  /** Remote level-0000 max TXID (heartbeat ack `replica.dbs[db].l0MaxTxid`, or an S3 list in tests). */
  setRemote(rel, txid) {
    const d = this.db.get(rel);
    if (!d || !(txid >= 0)) return;
    d.remote = Math.max(d.remote, txid);
    this.#trim(d);
  }
  /** F1.4: a log fault makes the lag infinite until cleared (a Litestream restart clears it). */
  setFault(rel, why) {
    const d = this.db.get(rel);
    if (d && !d.fault) d.fault = { why, since: this.now() };
  }
  clearFaults() {
    for (const d of this.db.values()) d.fault = null;
  }
  #trim(d) {
    d.samples = d.samples.filter((s) => s.txid > d.remote);
    if (d.samples.length > 600) d.samples.splice(0, d.samples.length - 600);
  }
  /** Per DB: {db, localTxid, remoteTxid, lag (null = infinite), lagSinceMs, fault}. */
  report() {
    const now = this.now();
    return [...this.db.entries()].map(([db, d]) => ({
      db,
      localTxid: d.local,
      remoteTxid: d.remote,
      lag: d.fault ? null : Math.max(0, d.local - d.remote),
      lagSinceMs: d.fault ? now - d.fault.since : d.samples.length ? now - d.samples[0].t : 0,
      fault: d.fault ? d.fault.why : null,
    }));
  }
  /** Worst lag age in ms (Infinity on a fault). */
  worstMs() {
    let w = 0;
    for (const r of this.report()) w = Math.max(w, r.lag === null ? Number.POSITIVE_INFINITY : r.lagSinceMs);
    return w;
  }
  /** True when every DB has lag 0 and no fault (sleep phase 5, drain step 4). */
  caughtUp() {
    return this.report().every((r) => r.lag === 0);
  }
  /**
   * Fault clock: ms past the I + 10 s allowance (0 = healthy or held). A log fault (F1.4, lag
   * infinite) counts from the fault line, with no allowance: Litestream said it is stuck.
   */
  overdueMs() {
    if (this.held()) return 0;
    let w = 0;
    for (const r of this.report()) {
      if (r.lag === null) w = Math.max(w, r.lagSinceMs);
      else if (r.lagSinceMs > this.iMs + 10_000) w = Math.max(w, r.lagSinceMs - (this.iMs + 10_000));
    }
    return w;
  }
}

/** Fault stage thresholds (plan §4.8). Plan field `timers.replicaFault` may shorten them (test mode). */
export const FAULT_STAGE_MS = Object.freeze({ closeMs: 5_000, stopMs: 15_000, downMs: 600_000 });

/**
 * Fault response stages (plan §4.8): from the moment the allowance is passed,
 * +5 s close admission, +15 s stop the gateway, +10 min exit 75 replica-down.
 * Pure: maps overdue ms (and whether Litestream runs) to the stage. `at` overrides the thresholds.
 */
export function faultStage(overdueMs, { lsDown = false, downForMs = 0, at = FAULT_STAGE_MS } = {}) {
  const t = Math.max(overdueMs, lsDown ? downForMs : 0);
  const a = { ...FAULT_STAGE_MS, ...at };
  if (t <= 0) return "ok";
  if (t >= a.downMs) return "replica-down";
  if (t >= a.stopMs) return "gateway-stop";
  if (t >= a.closeMs) return "admission-close";
  return "late";
}
