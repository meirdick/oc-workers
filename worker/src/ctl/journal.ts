// Control DO op journal (spec §7). One row per op; phase = last phase whose effect is persisted.
// A second open with the same op id attaches to the open op and never runs it twice.
import { hashInputs } from "../core/ids";
import type { Ctx } from "./ctx";
import { j, pj } from "./sql";

export type OpState = "open" | "done" | "failed" | "aborted" | "interrupted:sigterm";

export interface OpRow {
  op_id: string;
  kind: string;
  args: string;
  phase: string;
  state: OpState;
  attempt: number;
  result: string | null;
  error: string | null;
  phase_at: string;
  created_at: number;
  updated_at: number;
}

export interface Op<A = Record<string, unknown>> {
  opId: string;
  kind: string;
  args: A;
  phase: string;
  state: OpState;
  attempt: number;
  result: unknown;
  error: string | null;
  createdAt: number;
}

export function toOp<A>(r: OpRow): Op<A> {
  return {
    opId: r.op_id,
    kind: r.kind,
    args: pj<A>(r.args, {} as A),
    phase: r.phase,
    state: r.state,
    attempt: r.attempt,
    result: pj(r.result, null),
    error: r.error,
    createdAt: r.created_at,
  };
}

export async function opIdFor(c: Ctx, kind: string, args: unknown): Promise<string> {
  return hashInputs(kind, args, c.now());
}

/** Open (or attach to) an op. Sync: run inside a transaction when needed. */
export function openOp<A>(
  c: Ctx,
  opId: string,
  kind: string,
  args: A,
  firstPhase: string,
): {
  op: Op<A>;
  attached: boolean;
} {
  const row = c.db.one<OpRow>("SELECT * FROM ops WHERE op_id = ?", opId);
  if (row) return { op: toOp<A>(row), attached: true };
  const now = c.now();
  c.db.run(
    `INSERT INTO ops (op_id, kind, args, phase, state, attempt, phase_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', 0, ?, ?, ?)`,
    opId,
    kind,
    j(args),
    firstPhase,
    j({ [firstPhase]: now }),
    now,
    now,
  );
  return {
    op: toOp<A>(c.db.one<OpRow>("SELECT * FROM ops WHERE op_id = ?", opId) as OpRow),
    attached: false,
  };
}

export function getOp<A>(c: Ctx, opId: string): Op<A> | null {
  const r = c.db.one<OpRow>("SELECT * FROM ops WHERE op_id = ?", opId);
  return r ? toOp<A>(r) : null;
}

export function setPhase(c: Ctx, opId: string, phase: string, args?: unknown): void {
  const r = c.db.one<OpRow>("SELECT phase_at FROM ops WHERE op_id = ?", opId);
  const pa = pj<Record<string, number>>(r?.phase_at ?? "{}", {});
  pa[phase] = c.now();
  if (args === undefined)
    c.db.run(
      "UPDATE ops SET phase = ?, phase_at = ?, updated_at = ? WHERE op_id = ?",
      phase,
      j(pa),
      c.now(),
      opId,
    );
  else
    c.db.run(
      "UPDATE ops SET phase = ?, phase_at = ?, args = ?, updated_at = ? WHERE op_id = ?",
      phase,
      j(pa),
      j(args),
      c.now(),
      opId,
    );
}

export function bumpAttempt(c: Ctx, opId: string): void {
  c.db.run("UPDATE ops SET attempt = attempt + 1, updated_at = ? WHERE op_id = ?", c.now(), opId);
}

export function finishOp(
  c: Ctx,
  opId: string,
  state: Exclude<OpState, "open">,
  result?: unknown,
  error?: string,
) {
  c.db.run(
    "UPDATE ops SET state = ?, result = ?, error = ?, updated_at = ? WHERE op_id = ?",
    state,
    result === undefined ? null : j(result),
    error ?? null,
    c.now(),
    opId,
  );
}

export function openOps(c: Ctx, kind?: string): Op[] {
  const rows = kind
    ? c.db.all<OpRow>("SELECT * FROM ops WHERE state = 'open' AND kind = ? ORDER BY created_at", kind)
    : c.db.all<OpRow>("SELECT * FROM ops WHERE state = 'open' ORDER BY created_at");
  return rows.map((r) => toOp(r));
}

/** Rows kept 7 d (§7.1). */
export function pruneOps(c: Ctx): number {
  const before = c.now() - 7 * 86_400_000;
  const n = c.db.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM ops WHERE state != 'open' AND updated_at < ?",
    before,
  )?.n;
  c.db.run("DELETE FROM ops WHERE state != 'open' AND updated_at < ?", before);
  return n ?? 0;
}
