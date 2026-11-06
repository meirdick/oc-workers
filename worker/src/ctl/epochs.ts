// Epoch pointer and the retire/flip ops (spec §6.1). One epoch is active per install; meta.pointer changes only
// in the flip transaction. Ops: code-roll, reslot (stuck slot §9.4), cutover/rollback (M6).
import { rtName } from "../core/types";
import { alert } from "./alerts";
import { type Ctx, ring } from "./ctx";
import { finishOp, getOp, type Op, openOp, openOps, setPhase } from "./journal";
import type { EpochRow } from "./plan";

export interface ImageRef {
  imageKey: string;
  digest: string;
  codeVersion?: string;
  stateSchema?: number | null;
  agentSchema?: number | null;
  schemaSha?: string | null;
}

export function epochRow(c: Ctx, n: number): EpochRow | null {
  return c.db.one<EpochRow>("SELECT * FROM epochs WHERE n = ?", n);
}

export function activeEpoch(c: Ctx): EpochRow | null {
  const p = c.db.meta("pointer");
  if (p === null) return null;
  const e = epochRow(c, Number(p));
  return e && e.status === "active" ? e : null;
}

export function pointer(c: Ctx): number | null {
  const p = c.db.meta("pointer");
  return p === null ? null : Number(p);
}

function noteImage(c: Ctx, img: ImageRef): void {
  if (img.stateSchema != null || img.agentSchema != null || img.schemaSha != null)
    c.db.setMeta(`image:${img.digest}`, {
      stateSchema: img.stateSchema ?? null,
      agentSchema: img.agentSchema ?? null,
      schemaSha: img.schemaSha ?? null,
    });
}

/** First epoch (`install` event). No-op when an epoch exists. */
export function install(c: Ctx, img: ImageRef): EpochRow {
  return c.db.tx(() => {
    const any = c.db.one<EpochRow>("SELECT * FROM epochs ORDER BY n DESC LIMIT 1");
    if (any) return activeEpoch(c) ?? any;
    c.db.run(
      `INSERT INTO epochs (n, image_key, digest, code_version, status, reason, created_at)
       VALUES (1, ?, ?, ?, 'active', 'install', ?)`,
      img.imageKey,
      img.digest,
      img.codeVersion ?? c.codeVersion,
      c.now(),
    );
    c.db.setMeta("pointer", 1);
    c.db.setMeta("inst", c.inst);
    noteImage(c, img);
    ring(c, "epoch", "install", { n: 1, digest: img.digest });
    return epochRow(c, 1) as EpochRow;
  });
}

export interface EpochOpArgs {
  from: number;
  reason: "code-roll" | "reslot" | "cutover" | "rollback";
  image?: ImageRef;
  /** ms: phase 3 waits until this time when the stop was unconfirmed. */
  waitUntil?: number;
}

const EPOCH_KINDS = ["code-roll", "reslot", "cutover", "rollback"];

/** Start (or attach to) a retire + flip op. Refuses when another epoch op is open. */
export function startEpochOp(
  c: Ctx,
  opId: string,
  a: EpochOpArgs,
): { op: Op<EpochOpArgs>; attached: boolean } | { error: string } {
  return c.db.tx(() => {
    const same = getOp<EpochOpArgs>(c, opId);
    if (same) return { op: same, attached: true };
    const open = openOps(c).filter((o) => EPOCH_KINDS.includes(o.kind));
    if (open.length) return { error: "epoch-op-open" };
    const e = epochRow(c, a.from);
    if (!e || e.status === "retired") return { error: "epoch-not-active" };
    return openOp<EpochOpArgs>(c, opId, a.reason, a, "retiring");
  });
}

/**
 * Drive an epoch op through its phases: retiring (persist) → stopped (rt.retire) → waited (unconfirmed wait)
 * → released → flipped. Resumable at each phase after a DO restart. Returns the op state.
 */
export async function runEpochOp(
  c: Ctx,
  opId: string,
): Promise<{ state: string; phase: string; next?: number }> {
  let op = getOp<EpochOpArgs>(c, opId);
  if (!op) return { state: "missing", phase: "" };
  if (op.state !== "open") return { state: op.state, phase: op.phase };
  const a = op.args;
  if (op.phase === "retiring") {
    c.db.tx(() => {
      c.db.run("UPDATE epochs SET status = 'retiring' WHERE n = ? AND status = 'active'", a.from);
      setPhase(c, opId, "retire-call");
    });
    op = getOp<EpochOpArgs>(c, opId) as Op<EpochOpArgs>;
  }
  if (op.phase === "retire-call") {
    let res: { settled: boolean; lastHbAt?: number };
    try {
      res = await c.rt(a.from).retire();
    } catch (e) {
      ring(c, "epoch", "retire-rpc-failed", String(e).slice(0, 200));
      return { state: "open", phase: op.phase, next: c.now() + c.timers.opTickMs };
    }
    const waitUntil = res.settled ? 0 : (res.lastHbAt ?? c.now()) + c.timers.unconfirmedWaitMs;
    setPhase(c, opId, "wait", { ...a, waitUntil });
    op = getOp<EpochOpArgs>(c, opId) as Op<EpochOpArgs>;
  }
  if (op.phase === "wait") {
    const until = op.args.waitUntil ?? 0;
    if (c.now() < until) return { state: "open", phase: "wait", next: until };
    c.db.tx(() => {
      c.db.run("UPDATE epochs SET status = 'retired', retired_at = ? WHERE n = ?", c.now(), a.from);
      c.db.run("UPDATE snapshots SET lease_epoch = NULL WHERE lease_epoch = ?", a.from);
      setPhase(c, opId, "flip");
    });
    op = getOp<EpochOpArgs>(c, opId) as Op<EpochOpArgs>;
  }
  if (op.phase === "flip") {
    const out = c.db.tx(() => {
      const from = epochRow(c, a.from) as EpochRow;
      const n = (c.db.one<{ m: number }>("SELECT MAX(n) AS m FROM epochs")?.m ?? a.from) + 1;
      const img = a.image ?? { imageKey: from.image_key, digest: from.digest, codeVersion: c.codeVersion };
      c.db.run(
        `INSERT INTO epochs (n, image_key, digest, code_version, status, reason, created_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        n,
        img.imageKey,
        img.digest,
        img.codeVersion ?? c.codeVersion,
        a.reason,
        c.now(),
      );
      noteImage(c, img);
      c.db.setMeta("pointer", n);
      setPhase(c, opId, "flipped");
      finishOp(c, opId, "done", { from: a.from, to: n, name: rtName(c.inst, n) });
      ring(c, "epoch", "flip", { from: a.from, to: n, reason: a.reason });
      return n;
    });
    if (a.reason === "reslot") alert(c, "reslot", "warn", `epoch e${a.from} → e${out} (stuck slot)`);
    // Start the new epoch now instead of waiting for the */5 cron (§11.3 ensure on a `new` Runtime DO).
    try {
      await c.rt(out).ensure();
    } catch (e) {
      ring(c, "epoch", "ensure-after-flip-failed", String(e).slice(0, 200));
    }
    return { state: "done", phase: "flipped" };
  }
  return { state: op.state, phase: op.phase };
}

/** Open epoch ops (resumed by the alarm). */
export function openEpochOps(c: Ctx): Op[] {
  return openOps(c).filter((o) => EPOCH_KINDS.includes(o.kind));
}
