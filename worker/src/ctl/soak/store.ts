// SoakPlan tables in the Control DO SQLite (test installs only). Created lazily; `ctl-wipe` with keepSoak copies
// them across the wipe (dumpSoak/loadSoak), so a plan survives the Control DO wipe step.
import type { Db, SqlValue } from "../sql";
import type { StepResult, StepSpec } from "./types";

const DDL = [
  `CREATE TABLE IF NOT EXISTS soak_plan (name TEXT PRIMARY KEY, ord INTEGER NOT NULL, state TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS soak_step (plan TEXT NOT NULL, idx INTEGER NOT NULL, id TEXT NOT NULL,
    type TEXT NOT NULL, spec TEXT NOT NULL, state TEXT NOT NULL, not_before INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER, ended_at INTEGER, next_at INTEGER, tries INTEGER NOT NULL DEFAULT 0, phase TEXT,
    data TEXT NOT NULL DEFAULT '{}', result TEXT, r2_at INTEGER, PRIMARY KEY (plan, idx))`,
  // Fake Telegram injections and the replies the fake saw for them (gateCall noteOutbound).
  `CREATE TABLE IF NOT EXISTS soak_chat (chat_id TEXT PRIMARY KEY, plan TEXT NOT NULL, step TEXT NOT NULL,
    update_id TEXT NOT NULL, injected_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS soak_send (chat_id TEXT PRIMARY KEY, n INTEGER NOT NULL, first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL)`,
];
const TABLES = ["soak_plan", "soak_step", "soak_chat", "soak_send"] as const;

export type StepState = "pending" | "running" | "done";
export interface PlanRow {
  name: string;
  ord: number;
  state: "queued" | "running" | "done" | "stopped";
  params: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}
export interface StepRow {
  plan: string;
  idx: number;
  id: string;
  type: string;
  spec: string;
  state: StepState;
  not_before: number;
  started_at: number | null;
  ended_at: number | null;
  next_at: number | null;
  tries: number;
  phase: string | null;
  data: string;
  result: string | null;
  r2_at: number | null;
}

export function ensureSoak(db: Db): void {
  for (const q of DDL) db.run(q);
}

export function addPlan(db: Db, name: string, ord: number, params: unknown, steps: StepSpec[], now: number) {
  db.tx(() => {
    db.run("DELETE FROM soak_step WHERE plan = ?", name);
    db.run("DELETE FROM soak_plan WHERE name = ?", name);
    db.run(
      "INSERT INTO soak_plan (name, ord, state, params, created_at) VALUES (?, ?, 'queued', ?, ?)",
      name,
      ord,
      JSON.stringify(params ?? {}),
      now,
    );
    steps.forEach((s, i) => {
      db.run(
        "INSERT INTO soak_step (plan, idx, id, type, spec, state) VALUES (?, ?, ?, ?, ?, 'pending')",
        name,
        i,
        s.id,
        s.type,
        JSON.stringify(s),
      );
    });
  });
}

export const planRows = (db: Db) => db.all<PlanRow>("SELECT * FROM soak_plan ORDER BY ord");
export const planRow = (db: Db, name: string) =>
  db.one<PlanRow>("SELECT * FROM soak_plan WHERE name = ?", name) ?? null;
export const activePlan = (db: Db) =>
  db.one<PlanRow>("SELECT * FROM soak_plan WHERE state IN ('running', 'queued') ORDER BY ord LIMIT 1") ??
  null;
export const stepRows = (db: Db, plan: string) =>
  db.all<StepRow>("SELECT * FROM soak_step WHERE plan = ? ORDER BY idx", plan);
export const nextStep = (db: Db, plan: string) =>
  db.one<StepRow>("SELECT * FROM soak_step WHERE plan = ? AND state != 'done' ORDER BY idx LIMIT 1", plan) ??
  null;

export function savePhase(db: Db, s: StepRow, phase: string | null, data: unknown) {
  db.run(
    "UPDATE soak_step SET phase = ?, data = ? WHERE plan = ? AND idx = ?",
    phase,
    JSON.stringify(data),
    s.plan,
    s.idx,
  );
}

export function resultsOf(db: Db, plan: string): StepResult[] {
  return db
    .all<{ result: string }>(
      "SELECT result FROM soak_step WHERE plan = ? AND result IS NOT NULL ORDER BY idx",
      plan,
    )
    .map((r) => JSON.parse(r.result) as StepResult);
}

/** All soak rows as plain arrays, for the keepSoak wipe. */
export function dumpSoak(db: Db): Record<string, Record<string, unknown>[]> {
  ensureSoak(db);
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const t of TABLES) out[t] = db.all<Record<string, unknown>>(`SELECT * FROM ${t}`);
  return out;
}

export function loadSoak(db: Db, dump: Record<string, Record<string, unknown>[]>): void {
  ensureSoak(db);
  db.tx(() => {
    for (const t of TABLES)
      for (const row of dump[t] ?? []) {
        const cols = Object.keys(row);
        db.run(
          `INSERT OR REPLACE INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
          ...(cols.map((k) => row[k]) as SqlValue[]),
        );
      }
  });
}

/** Reply tracking: one outbound send to a soak chat (REPLY_METHODS only; the caller filters). */
export function noteSoakSend(db: Db, chatId: string, at: number): void {
  if (!db.one("SELECT 1 FROM soak_chat WHERE chat_id = ?", chatId)) return;
  db.run(
    `INSERT INTO soak_send (chat_id, n, first_at, last_at) VALUES (?, 1, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET n = n + 1, last_at = excluded.last_at`,
    chatId,
    at,
    at,
  );
}
