// Clean-marker guard on the ocsup side (add §2.6 phases 5-6, §2.8; amend §1.5 F1.6, F1.7; contract
// `sleep-flush`, `drained {unclean}`). The Control DO writes the marker in phase 6 from the flush reply,
// so ocsup must answer `ok:true` ONLY after a confirmed flush:
//   - every managed DB lag 0 (level-0000 records, F1.5) and no log fault,
//   - Litestream final stop clean (exit 0 within 10 s of SIGINT, no `shutdown sync failed`, F1.6),
//   - credsync flush ok (full reconcile scan + empty queue),
//   - shadow copies of changed files ok.
// The confirmation is single-use per op: a second flush call for the same op returns the stored reply,
// any later write path (resume, Litestream start, SIGTERM) voids it, and a void reply is never `ok`.
import { SleepFlushRes, validate } from "./contract.mjs";

export class MarkerGuard {
  constructor({ now } = {}) {
    this.now = now || Date.now;
    this.ops = new Map(); // opId -> {reply, state: confirmed|void, at}
    this.current = null;
  }

  /**
   * Build the flush verdict. in: {opId, lag:[{db, lag, localTxid, fault}], ls: stopFinal result,
   * creds: flush result, shadows: [{ok}], bytesPerDb?, lastWriteAtPerDb?, nextWakeAtMs?, archive?}
   */
  flush(i) {
    const prev = this.ops.get(i.opId);
    if (prev) return prev.reply; // idempotent per op id
    const why = [];
    for (const d of i.lag || [])
      if (d.lag !== 0)
        why.push(`lag:${d.db}:${d.lag === null ? "inf" : d.lag}${d.fault ? `:${d.fault}` : ""}`);
    if (!i.ls?.clean) why.push(`litestream:${i.ls?.reason || "not-clean"}`);
    if (!i.creds?.ok) why.push(`creds:${i.creds?.why || "not-flushed"}`);
    for (const s of i.shadows || []) if (!s.ok) why.push(`shadow:${s.rel}:${s.why}`);
    let reply;
    if (why.length) reply = { ok: false, error: "sleep-flush-failed", detail: why };
    else {
      reply = {
        ok: true,
        nextWakeAtMs: i.nextWakeAtMs ?? null,
        txidPerDb: Object.fromEntries((i.lag || []).map((d) => [d.db, d.localTxid])),
        bytesPerDb: i.bytesPerDb || {},
        lastWriteAtPerDb: i.lastWriteAtPerDb || {},
        archive: i.archive ?? null,
      };
      const errs = validate(SleepFlushRes, reply);
      if (errs.length) reply = { ok: false, error: "sleep-flush-failed", detail: [`shape:${errs[0]}`] };
    }
    this.ops.set(i.opId, { reply, state: reply.ok ? "confirmed" : "void", at: this.now() });
    if (reply.ok) this.current = i.opId;
    return reply;
  }

  /** Any write after the flush (resume-after-sleep, Litestream start, SIGTERM, abort) voids it. */
  void(why) {
    if (!this.current) return null;
    const rec = this.ops.get(this.current);
    rec.state = "void";
    rec.voidWhy = why;
    rec.reply = { ok: false, error: "sleep-flush-failed", detail: [`void:${why}`] };
    const id = this.current;
    this.current = null;
    return id;
  }

  /** Is a confirmed (not void) flush held for this op? */
  confirmed(opId) {
    return this.ops.get(opId)?.state === "confirmed";
  }

  /** Drain report (F1.7, §3 row 8): the unclean parts. Empty array = clean. */
  static drainUnclean({ ls, gatewayClean, creds }) {
    const u = [];
    if (!ls?.clean) u.push("litestream");
    if (gatewayClean === false) u.push("gateway");
    if (creds && !creds.ok) u.push("creds");
    return u;
  }
}
