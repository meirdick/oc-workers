// Runtime DO storage (spec 08 §4): kv (JSON values), ops (op journal, §7), stops (ring, 500 rows).
// Synchronous SQL; one storage write per call. Callers group effect + phase in transactionSync.

export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}
export interface StorageLike {
  sql: SqlLike;
  transactionSync<T>(fn: () => T): T;
}

export const RT_SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ops (op_id TEXT PRIMARY KEY, kind TEXT NOT NULL, reason TEXT, args TEXT NOT NULL,
  phase TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
  phase_at TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS stops (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, gen INTEGER,
  cls TEXT NOT NULL, esc TEXT NOT NULL, state_fault INTEGER NOT NULL, confirmed INTEGER NOT NULL,
  exit_code INTEGER, reason TEXT, raw TEXT, hb_at INTEGER, op_id TEXT);
`;

export type OpKind = "start" | "sleep" | "stop" | "retire" | "replace" | "maint" | "checkpoint";
export type OpState = "open" | "done" | "failed" | "aborted" | "interrupted:sigterm";

export interface OpRow {
  opId: string;
  kind: OpKind;
  reason: string | null;
  args: Record<string, unknown>;
  phase: string;
  state: OpState;
  attempt: number;
  result: unknown;
  error: string | null;
  phaseAt: Record<string, number>;
  createdAt: number;
  updatedAt: number;
}

export interface StopRow {
  at: number;
  gen: number | null;
  cls: string;
  esc: string;
  stateFault: boolean;
  confirmed: boolean;
  exitCode: number | null;
  reason: string | null;
  raw: string;
  hbAt: number | null;
  opId: string | null;
}

const OPS_KEEP_MS = 7 * 24 * 3600_000;
const STOPS_KEEP = 500;

export class RtStore {
  constructor(
    private s: StorageLike,
    private now: () => number,
  ) {
    for (const q of RT_SCHEMA.split(";")) if (q.trim()) s.sql.exec(q);
  }

  tx<T>(fn: () => T): T {
    return this.s.transactionSync(fn);
  }

  get<T>(k: string): T | undefined {
    const row = this.s.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
    return row ? (JSON.parse(String(row.v)) as T) : undefined;
  }
  put(k: string, v: unknown): void {
    this.s.sql.exec(
      "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k,
      JSON.stringify(v),
    );
  }
  del(k: string): void {
    this.s.sql.exec("DELETE FROM kv WHERE k = ?", k);
  }

  // ---- ops ----
  private toOp(r: Record<string, unknown>): OpRow {
    return {
      opId: String(r.op_id),
      kind: r.kind as OpKind,
      reason: (r.reason as string | null) ?? null,
      args: JSON.parse(String(r.args)),
      phase: String(r.phase),
      state: r.state as OpState,
      attempt: Number(r.attempt),
      result: r.result ? JSON.parse(String(r.result)) : null,
      error: (r.error as string | null) ?? null,
      phaseAt: JSON.parse(String(r.phase_at)),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }
  op(opId: string): OpRow | undefined {
    const r = this.s.sql.exec("SELECT * FROM ops WHERE op_id = ?", opId).toArray()[0];
    return r ? this.toOp(r) : undefined;
  }
  openOps(): OpRow[] {
    return this.s.sql
      .exec("SELECT * FROM ops WHERE state = 'open' ORDER BY created_at, op_id")
      .toArray()
      .map((r) => this.toOp(r));
  }
  openOp(kind?: OpKind): OpRow | undefined {
    return this.openOps().find((o) => !kind || o.kind === kind);
  }
  ops(limit = 50): OpRow[] {
    return this.s.sql
      .exec("SELECT * FROM ops ORDER BY created_at DESC, op_id DESC LIMIT ?", limit)
      .toArray()
      .map((r) => this.toOp(r));
  }
  /** Create an op, or return the open one with the same id (attach, never run twice). */
  createOp(o: {
    opId: string;
    kind: OpKind;
    reason?: string | null;
    args?: Record<string, unknown>;
    phase: string;
  }) {
    const old = this.op(o.opId);
    if (old) return { op: old, attached: true };
    const now = this.now();
    this.s.sql.exec(
      "INSERT INTO ops (op_id, kind, reason, args, phase, state, phase_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)",
      o.opId,
      o.kind,
      o.reason ?? null,
      JSON.stringify(o.args ?? {}),
      o.phase,
      JSON.stringify({ [o.phase]: now }),
      now,
      now,
    );
    return { op: this.op(o.opId) as OpRow, attached: false };
  }
  setPhase(opId: string, phase: string, patch: { args?: Record<string, unknown>; attempt?: number } = {}) {
    const op = this.op(opId);
    if (!op) return;
    const now = this.now();
    op.phaseAt[phase] = now;
    this.s.sql.exec(
      "UPDATE ops SET phase = ?, phase_at = ?, args = ?, attempt = ?, updated_at = ? WHERE op_id = ?",
      phase,
      JSON.stringify(op.phaseAt),
      JSON.stringify(patch.args ?? op.args),
      patch.attempt ?? op.attempt,
      now,
      opId,
    );
  }
  endOp(
    opId: string,
    state: Exclude<OpState, "open">,
    o: { result?: unknown; error?: string | null; phase?: string } = {},
  ) {
    const op = this.op(opId);
    if (!op) return;
    const now = this.now();
    if (o.phase) op.phaseAt[o.phase] = now;
    this.s.sql.exec(
      "UPDATE ops SET state = ?, phase = ?, phase_at = ?, result = ?, error = ?, updated_at = ? WHERE op_id = ?",
      state,
      o.phase ?? op.phase,
      JSON.stringify(op.phaseAt),
      o.result === undefined ? null : JSON.stringify(o.result),
      o.error ?? null,
      now,
      opId,
    );
    this.s.sql.exec("DELETE FROM ops WHERE state != 'open' AND updated_at < ?", now - OPS_KEEP_MS);
  }

  // ---- stops ring ----
  addStop(s: StopRow) {
    this.s.sql.exec(
      "INSERT INTO stops (at, gen, cls, esc, state_fault, confirmed, exit_code, reason, raw, hb_at, op_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      s.at,
      s.gen,
      s.cls,
      s.esc,
      s.stateFault ? 1 : 0,
      s.confirmed ? 1 : 0,
      s.exitCode,
      s.reason,
      s.raw.slice(0, 2000),
      s.hbAt,
      s.opId,
    );
    this.s.sql.exec("DELETE FROM stops WHERE id <= (SELECT MAX(id) FROM stops) - ?", STOPS_KEEP);
  }
  stops(limit = 50): StopRow[] {
    return this.s.sql
      .exec("SELECT * FROM stops ORDER BY id DESC LIMIT ?", limit)
      .toArray()
      .map((r) => ({
        at: Number(r.at),
        gen: r.gen === null ? null : Number(r.gen),
        cls: String(r.cls),
        esc: String(r.esc),
        stateFault: Number(r.state_fault) === 1,
        confirmed: Number(r.confirmed) === 1,
        exitCode: r.exit_code === null ? null : Number(r.exit_code),
        reason: (r.reason as string | null) ?? null,
        raw: String(r.raw ?? ""),
        hbAt: r.hb_at === null ? null : Number(r.hb_at),
        opId: (r.op_id as string | null) ?? null,
      }));
  }
}
