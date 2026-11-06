// The settings document (core/tunables.ts keys): versioned rows in the Control DO, like config versions.
// OC_SETTINGS at deploy is the first value only: it seeds version 1 when no row exists. After that the newest
// row wins, so a later deploy never changes a value. Changes go through PUT /ops/settings and apply at the
// next op: the Control DO reads the row on every call, the Runtime and Auth DOs fetch `settingsView` with a
// short cache.
import { defaultsFlat, expand, flatten, specOf, timerOverlay, validateDoc } from "../core/tunables";
import { type Ctx, ring } from "./ctx";
import type { Db } from "./sql";

export const KEEP_VERSIONS = 20;

export interface SettingsRow {
  ver: number;
  doc: string;
  source: string;
  created_at: number;
}

export const latestSettings = (db: Db): SettingsRow | null =>
  db.one<SettingsRow>("SELECT * FROM settings ORDER BY ver DESC LIMIT 1");

const parse = (s: string): Record<string, unknown> => {
  try {
    return flatten(JSON.parse(s));
  } catch {
    return {};
  }
};

/** The tunable keys of an OC_SETTINGS object (nested), dotted. */
export function tunablesOf(o: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(flatten(o)).filter(([p]) => specOf(p)));
}

/** The env fields that deploy keeps owning: everything that is not a tunable key. */
export function withoutTunables(o: unknown): Record<string, unknown> {
  return expand(Object.fromEntries(Object.entries(flatten(o)).filter(([p]) => !specOf(p))));
}

/** Seed version 1 from the OC_SETTINGS tunables when the table is empty. */
export function seedSettings(db: Db, env: unknown, now: number): void {
  if (latestSettings(db)) return;
  const flat = tunablesOf(env);
  if (!Object.keys(flat).length || validateDoc(expand(flat)).length) return;
  db.run(
    "INSERT INTO settings (ver, doc, source, created_at) VALUES (1, ?, 'deploy', ?)",
    JSON.stringify(expand(flat)),
    now,
  );
}

export interface PutBody {
  /** Replace the whole document. */
  doc?: unknown;
  /** Dotted path → value; null removes the key (the default applies). */
  set?: Record<string, unknown>;
  baseVer?: number;
  source?: string;
}

export type PutResult =
  | { status: 200; body: { ok: true; ver: number; changed: boolean; doc: unknown } }
  | { status: 400 | 409; body: { error: string; ver?: number; problems?: string[] } };

/** Validate, then write a new version. Same document → no new version. */
export function putSettings(c: Ctx, b: PutBody): PutResult {
  const cur = latestSettings(c.db);
  const ver = cur?.ver ?? 0;
  if (b.baseVer !== undefined && b.baseVer !== ver) return { status: 409, body: { error: "stale", ver } };
  let flat: Record<string, unknown>;
  if (b.doc !== undefined) flat = flatten(b.doc);
  else if (b.set && typeof b.set === "object") {
    flat = cur ? parse(cur.doc) : {};
    for (const [p, v] of Object.entries(b.set)) {
      if (v === null) delete flat[p];
      else flat[p] = v;
    }
  } else return { status: 400, body: { error: "doc or set required" } };
  // Check the flat keys before expand: an unknown key (`__proto__.x` too) is refused, never expanded.
  const unknown = Object.keys(flat).filter((p) => !specOf(p));
  if (unknown.length) {
    const problems = unknown.map((p) => `unknown setting ${p}`);
    return { status: 400, body: { error: problems[0] as string, problems } };
  }
  const problems = validateDoc(expand(flat));
  if (problems.length) return { status: 400, body: { error: problems[0] as string, problems } };
  const doc = expand(flat);
  if (cur && JSON.stringify(doc) === JSON.stringify(expand(parse(cur.doc))))
    return { status: 200, body: { ok: true, ver, changed: false, doc } };
  const next = ver + 1;
  c.db.run(
    "INSERT INTO settings (ver, doc, source, created_at) VALUES (?, ?, ?, ?)",
    next,
    JSON.stringify(doc),
    String(b.source ?? "ops").slice(0, 40),
    c.now(),
  );
  c.db.run("DELETE FROM settings WHERE ver <= ?", next - KEEP_VERSIONS);
  ring(c, "settings", "put", { ver: next, keys: Object.keys(flat).length });
  return { status: 200, body: { ok: true, ver: next, changed: true, doc } };
}

/** GET /ops/settings: the newest (or `ver`) document, the effective values, the version list. */
export function viewSettings(c: Ctx, ver?: number): { status: number; body: unknown } {
  const row =
    ver === undefined
      ? latestSettings(c.db)
      : c.db.one<SettingsRow>("SELECT * FROM settings WHERE ver = ?", ver);
  if (ver !== undefined && !row) return { status: 404, body: { error: "no such version" } };
  const s = flatten(c.settings());
  const eff: Record<string, unknown> = {};
  for (const p of Object.keys(defaultsFlat())) eff[p] = s[p];
  return {
    status: 200,
    body: {
      ver: row?.ver ?? 0,
      source: row?.source ?? null,
      at: row?.created_at ?? null,
      doc: row ? JSON.parse(row.doc) : {},
      effective: expand(eff),
      versions: c.db
        .all<SettingsRow>("SELECT ver, source, created_at FROM settings ORDER BY ver DESC")
        .map((r) => ({ ver: r.ver, source: r.source, at: r.created_at })),
    },
  };
}

/** What the Runtime DO applies to its timers, and the login numbers the Auth DO needs. */
export interface SettingsView {
  ver: number;
  t: Record<string, number>;
  rt: Record<string, number>;
  login: {
    sessionDays: number;
    maxSessions: number;
    codeMinutes: number;
    rateLimits: { windowMinutes: number; ipFail: number; ipTry: number; allFail: number; maxCodes: number };
  };
}

export function settingsView(c: Ctx): SettingsView {
  const s = c.settings();
  const o = timerOverlay(flatten(s), c.test);
  return { ver: latestSettings(c.db)?.ver ?? 0, t: o.t, rt: o.rt, login: s.login };
}
