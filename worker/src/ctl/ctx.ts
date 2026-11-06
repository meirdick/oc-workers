// Context shared by the Control DO modules. Everything time-, storage- or network-shaped comes in here,
// so the logic runs in vitest on node:sqlite with a fake clock, fake R2 and a fake Runtime DO.
import type { Timers } from "../core/timers";
import { defaultsFlat, expand } from "../core/tunables";
import type { BucketLike, RuntimeRpc } from "../core/types";
import type { DrillArgs, DrillReport } from "./drill";
import type { Db } from "./sql";

export interface Settings {
  sleep: {
    mode: "auto" | "off";
    idleMinutes: number;
    /** Stay awake at least this long after /startupz (timers.minAwakeMs). */
    minAwakeMinutes: number;
    minSleepMinutes: number;
    uiIdleMinutes: number;
    uiMaxMinutes: number;
    /** Uptime limit in the boot plan (plan.runtime.maxUptimeHours). */
    maxAwakeHours: number;
    costGuard: "auto" | "off";
    snapshotCostUsd: number;
    proactive: string;
    /**
     * N11: OpenClaw job classes the owner wants to wake the install while asleep (`heartbeat`, `proactive`).
     * Default none: the heartbeat never wakes; the Proactive check wakes unless `proactive` is off.
     */
    wakeOn?: string[];
  };
  runtime: { maintenanceHour: number; tz: string };
  alerts: { minSeverity: "info" | "warn" | "high"; dedupeMinutes: number };
  checkpoint: { intervalMinutes: number; maxPerDay: number };
  snapshots: { maxPerDay: number };
  /** Cadence in hours, minutes and days (core/tunables.ts); `archive-policy.ts` also takes raw ms keys. */
  archive: {
    everyHours: number;
    minGapMinutes: number;
    maxPerDay: number;
    drillEveryDays: number;
  } & Record<string, number>;
  chain: { rebaseAfterHours: number; rebaseAfterSnapshots: number; tagWarn: number };
  gens: { churnPerDay: number };
  storage: { pruneAtMb: number; refuseAtMb: number };
  cost: { releaseBelowPct: number };
  login: {
    sessionDays: number;
    maxSessions: number;
    codeMinutes: number;
    rateLimits: { windowMinutes: number; ipFail: number; ipTry: number; allFail: number; maxCodes: number };
  };
  idle: { doubleCapMinutes: number };
  cron: { tailSeconds: number; leadSeconds: number };
  inbox: { holdHours: number; deadHours: number };
  /** Env-owned (OC_SETTINGS at deploy), not in the settings document. */
  telegram?: { wakeProgress?: "delete" | "ready" | "off" };
  /** Public origin of the Worker (for the managed Telegram webhook URL check). */
  publicOrigin?: string;
  /** Env-owned (ACCESS_DOMAIN): `https://<custom domain>` when Access is on. The Control UI's active origin. */
  uiOrigin?: string;
  /** R2 bucket name sent in the plan's replica block. */
  bucket?: string;
  /** getTcpPort source CIDRs for gateway.trustedProxies. CF: 10.1.0.0/32 (M0 T2 item 3); wrangler dev: 127.0.0.1/32. */
  trustedProxies?: string[];
  /** Path B of §12.4 (gate records mark rows replicated). Off until T7b item 9. */
  inboxReplicatedByGate: boolean;
  /** docs/12: agent exec and file tools in the SandboxSession container. Default off. Env-owned (deploy). */
  sandbox?: "on" | "off";
}

/** Settings built from the tunables table (core/tunables.ts defaults) plus the env-only fields. */
export const DEFAULT_SETTINGS: Settings = {
  ...(expand(defaultsFlat()) as Omit<Settings, "inboxReplicatedByGate">),
  inboxReplicatedByGate: false,
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function deepMerge(base: Record<string, any>, over: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

/** Older OC_SETTINGS carried the uptime limit as runtime.maxUptimeHours; it is sleep.maxAwakeHours now. */
export function normalizeSettings(over: unknown): Record<string, any> {
  if (!isObj(over)) return {};
  const o = structuredClone(over) as Record<string, any>;
  if (isObj(o.runtime) && "maxUptimeHours" in o.runtime) {
    if (!(isObj(o.sleep) && "maxAwakeHours" in o.sleep))
      o.sleep = { ...(isObj(o.sleep) ? o.sleep : {}), maxAwakeHours: o.runtime.maxUptimeHours };
    delete o.runtime.maxUptimeHours;
  }
  return o;
}

export function mergeSettings(base: Settings, over: unknown): Settings {
  if (!isObj(over)) return base;
  return deepMerge(base, normalizeSettings(over)) as Settings;
}

export interface Secrets {
  webhookSecret?: string;
  webhookSecretPrev?: string;
  alertUrl?: string;
  alertToken?: string;
  /** Telegram bot token (Worker secret). Cold-path typing only. */
  botToken?: string;
  /** Inbox adapter secrets (ctl/adapters): platform signing secrets, env NAME → value. */
  platform?: Record<string, string | undefined>;
}

export interface Ctx {
  db: Db;
  inst: string;
  now(): number;
  timers: Timers;
  bucket: BucketLike;
  rt(epoch: number): RuntimeRpc;
  settings(): Settings;
  /** OC_SETTINGS (normalized): seeds settings version 1 when there is none (ctl/settings.ts). */
  settingsSeed?: unknown;
  secrets: Secrets;
  test: boolean;
  instance: string | undefined;
  codeVersion: string;
  /** CF_VERSION.id of the Worker version this DO was built with (older than the live one after a deploy). */
  buildVersion?: string;
  fetch: typeof fetch;
  /** M4 restore drill: a throw-away Control DO instance by name (do.ts); absent → the drill reports "no target". */
  drill?: (name: string) => { drillRestore(a: DrillArgs): Promise<DrillReport> };
}

export const STATE_DB = "state/openclaw.sqlite";
export const DAY = 86_400_000;
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Ring buffer of events and log lines, cap 500 rows (amend §2 row 24). */
export function ring(c: Ctx, src: string, kind: string, detail?: unknown): void {
  const d = detail === undefined ? null : typeof detail === "string" ? detail : JSON.stringify(detail);
  c.db.run(
    "INSERT INTO ring (at, src, kind, detail) VALUES (?, ?, ?, ?)",
    c.now(),
    src,
    kind,
    d === null ? null : d.slice(0, 4000),
  );
  c.db.run("DELETE FROM ring WHERE id <= (SELECT MAX(id) FROM ring) - 500");
}
