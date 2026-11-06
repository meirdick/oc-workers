// The settings document: every tunable key with its default, floor and cap. One table for the Worker (validates
// PUT /ops/settings, builds the timers) and the CLI (validates oc-host.jsonc). No platform imports.
// Paths are the Worker's dotted paths. `file` is the oc-host.jsonc path when it differs.

export interface Spec {
  path: string;
  kind: "int" | "num" | "enum" | "str";
  def: number | string;
  min?: number;
  max?: number;
  values?: readonly string[];
  pattern?: RegExp;
  /** oc-host.jsonc path, when it is not `path`. */
  file?: string;
}

const int = (path: string, def: number, min: number, max: number): Spec => ({
  path,
  kind: "int",
  def,
  min,
  max,
});
const en = (path: string, def: string, values: readonly string[]): Spec => ({
  path,
  kind: "enum",
  def,
  values,
});

export const PROACTIVE_RE =
  /^(off|openclaw|(30m|1h|2h|3h|4h|6h|12h)(@([01]\d|2[0-3])-([01]\d|2[0-4]))?|(\S+\s+){4}\S+)$/;

export const SPECS: readonly Spec[] = Object.freeze([
  en("sleep.mode", "auto", ["auto", "off"]),
  int("sleep.idleMinutes", 5, 1, 60),
  int("sleep.minAwakeMinutes", 2, 1, 60),
  int("sleep.minSleepMinutes", 10, 1, 720),
  int("sleep.uiIdleMinutes", 15, 1, 240),
  int("sleep.uiMaxMinutes", 60, 5, 1440),
  int("sleep.maxAwakeHours", 16, 6, 72),
  en("sleep.costGuard", "auto", ["auto", "off"]),
  { path: "sleep.snapshotCostUsd", kind: "num", def: 0.0045, min: 0, max: 1 },
  { path: "sleep.proactive", kind: "str", def: "2h@08-22", pattern: PROACTIVE_RE },
  { path: "runtime.maintenanceHour", kind: "int", def: 4, min: 0, max: 23, file: "maintenance.hour" },
  { path: "runtime.tz", kind: "str", def: "UTC", file: "timezone" },
  int("checkpoint.intervalMinutes", 60, 10, 1440),
  int("checkpoint.maxPerDay", 30, 0, 96),
  int("snapshots.maxPerDay", 40, 10, 200),
  int("archive.everyHours", 6, 1, 168),
  int("archive.minGapMinutes", 15, 5, 1440),
  int("archive.maxPerDay", 24, 1, 96),
  int("archive.drillEveryDays", 30, 1, 365),
  int("chain.rebaseAfterHours", 24, 1, 720),
  int("chain.rebaseAfterSnapshots", 40, 5, 500),
  int("chain.tagWarn", 100, 10, 2000),
  int("alerts.dedupeMinutes", 60, 1, 1440),
  en("alerts.minSeverity", "high", ["info", "warn", "high"]),
  int("gens.churnPerDay", 10, 1, 200),
  int("storage.pruneAtMb", 1024, 64, 8192),
  int("storage.refuseAtMb", 2048, 128, 9000),
  int("cost.releaseBelowPct", 80, 10, 99),
  int("login.sessionDays", 30, 1, 365),
  int("login.maxSessions", 20, 1, 200),
  int("login.codeMinutes", 5, 1, 60),
  int("login.rateLimits.windowMinutes", 10, 1, 1440),
  int("login.rateLimits.ipFail", 5, 1, 1000),
  int("login.rateLimits.ipTry", 20, 1, 10_000),
  int("login.rateLimits.allFail", 30, 1, 10_000),
  int("login.rateLimits.maxCodes", 10, 1, 100),
  int("idle.doubleCapMinutes", 60, 5, 1440),
  int("cron.tailSeconds", 120, 10, 3600),
  int("cron.leadSeconds", 120, 10, 600),
  int("inbox.holdHours", 20, 1, 168),
  int("inbox.deadHours", 23, 2, 336),
]);

const BY_PATH = new Map(SPECS.map((s) => [s.path, s]));
export const specOf = (path: string): Spec | undefined => BY_PATH.get(path);
/** The Spec for an oc-host.jsonc path. */
export const specOfFile = (file: string): Spec | undefined => SPECS.find((s) => (s.file ?? s.path) === file);
export const fileOf = (s: Spec): string => s.file ?? s.path;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Nested object → { "a.b": leaf }. Arrays and scalars are leaves. */
export function flatten(o: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (!isObj(o)) return out;
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) flatten(v, p, out);
    else out[p] = v;
  }
  return out;
}

/** Path segments that would reach Object.prototype through `obj[k]`. */
const UNSAFE_KEY = new Set(["__proto__", "constructor", "prototype"]);

/** { "a.b": leaf } → nested object. A path with an unsafe segment is dropped (validateDoc refuses it first). */
export function expand(flat: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [path, v] of Object.entries(flat)) {
    const ks = path.split(".");
    if (ks.some((k) => UNSAFE_KEY.has(k))) continue;
    let cur = out;
    for (const k of ks.slice(0, -1)) {
      if (!isObj(cur[k])) cur[k] = {};
      cur = cur[k] as Record<string, any>;
    }
    cur[ks[ks.length - 1] as string] = v;
  }
  return out;
}

export function defaultsFlat(): Record<string, number | string> {
  return Object.fromEntries(SPECS.map((s) => [s.path, s.def]));
}

/** null when `v` is fine for the spec, else a short reason with the allowed range. */
export function checkValue(s: Spec, v: unknown): string | null {
  const name = s.file ?? s.path;
  if (s.kind === "enum")
    return typeof v === "string" && s.values?.includes(v)
      ? null
      : `${name} must be ${s.values?.join(" or ")}`;
  if (s.kind === "str") {
    if (typeof v !== "string" || !v) return `${name} must be a string`;
    return s.pattern && !s.pattern.test(v) ? `${name} ${JSON.stringify(v)} is not valid` : null;
  }
  if (typeof v !== "number" || !Number.isFinite(v) || (s.kind === "int" && !Number.isInteger(v)))
    return `${name} must be ${s.kind === "int" ? "a whole number" : "a number"}`;
  if (v < (s.min ?? -Infinity) || v > (s.max ?? Infinity)) return `${name} must be ${s.min} to ${s.max}`;
  return null;
}

/** Rules between keys, checked on the effective values (defaults under the document). */
export function checkRelations(eff: Record<string, unknown>): string[] {
  const n = (p: string) => Number(eff[p] ?? specOf(p)?.def);
  const out: string[] = [];
  if (n("storage.refuseAtMb") <= n("storage.pruneAtMb"))
    out.push("storage.refuseAtMb must be above storage.pruneAtMb");
  if (n("inbox.holdHours") >= n("inbox.deadHours")) out.push("inbox.holdHours must be below inbox.deadHours");
  if (n("snapshots.maxPerDay") < n("checkpoint.maxPerDay") + 2)
    out.push("snapshots.maxPerDay must be at least checkpoint.maxPerDay + 2");
  if (n("idle.doubleCapMinutes") < n("sleep.idleMinutes"))
    out.push("idle.doubleCapMinutes must be at least sleep.idleMinutes");
  if (n("sleep.uiMaxMinutes") < n("sleep.uiIdleMinutes"))
    out.push("sleep.uiMaxMinutes must be at least sleep.uiIdleMinutes");
  return out;
}

/** All problems of a (partial) settings document. Unknown keys count. Empty = valid. */
export function validateDoc(doc: unknown): string[] {
  if (!isObj(doc)) return ["settings must be an object"];
  const flat = flatten(doc);
  const out: string[] = [];
  for (const [p, v] of Object.entries(flat)) {
    const s = specOf(p);
    if (!s) out.push(`unknown setting ${p}`);
    else {
      const bad = checkValue(s, v);
      if (bad) out.push(bad);
    }
  }
  if (!out.length) out.push(...checkRelations({ ...defaultsFlat(), ...flat }));
  return out;
}

// ---- timers from settings ----

type TimerMap = [path: string, key: string, ms: number];
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const T_MAP: TimerMap[] = [
  ["sleep.idleMinutes", "idleMs", MIN],
  ["sleep.minSleepMinutes", "minSleepMs", MIN],
  ["sleep.minAwakeMinutes", "minAwakeMs", MIN],
  ["idle.doubleCapMinutes", "idleCapMs", MIN],
  ["cron.tailSeconds", "cronTailMs", S],
  ["cron.leadSeconds", "leadMs", S],
  ["chain.rebaseAfterHours", "rebaseEveryMs", H],
  ["chain.rebaseAfterSnapshots", "rebaseChainMax", 1],
  ["alerts.dedupeMinutes", "alertDedupeMs", MIN],
  ["inbox.holdHours", "heldMaxMs", H],
  ["inbox.deadHours", "inboxDeadMs", H],
];
const RT_MAP: TimerMap[] = [
  ["sleep.uiIdleMinutes", "uiIdleMs", MIN],
  ["sleep.uiMaxMinutes", "uiMaxMs", MIN],
  ["checkpoint.intervalMinutes", "checkpointMs", MIN],
  ["checkpoint.maxPerDay", "checkpointsPerDay", 1],
];

export interface TimerOverlay {
  t: Record<string, number>;
  rt: Record<string, number>;
}

/**
 * Settings values → timer overrides. `changedOnly` (OC_TEST worlds) skips values that equal their default, so
 * the short test timers stay unless a test sets a key.
 */
export function timerOverlay(flat: Record<string, unknown>, changedOnly: boolean): TimerOverlay {
  const out: TimerOverlay = { t: {}, rt: {} };
  const take = (map: TimerMap[], into: Record<string, number>) => {
    for (const [path, key, ms] of map) {
      const v = flat[path];
      if (typeof v !== "number" || (changedOnly && v === specOf(path)?.def)) continue;
      into[key] = v * ms;
    }
  };
  take(T_MAP, out.t);
  take(RT_MAP, out.rt);
  // A held row is kept one hour past its dead time (24 h with the 23 h default).
  const dead = flat["inbox.deadHours"];
  if (typeof dead === "number" && !(changedOnly && dead === specOf("inbox.deadHours")?.def))
    out.t.inboxKeepMs = (dead + 1) * H;
  return out;
}
