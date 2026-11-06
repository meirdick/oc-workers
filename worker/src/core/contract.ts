// TypeScript face of the shared ocsup <-> Worker contract (image/ocrt/lib/contract.mjs, docs/07-gate-contract.md).
// The .mjs is the source of truth for wire shapes; this file re-exports it with types and adds the M2
// additions of docs/08-control-plane-spec.md §23 until they land in contract.mjs.
// test/core/contract.test.ts compares the route list here with the .mjs and with the doc table.
import * as C from "../../../image/ocrt/lib/contract.mjs";

export type Schema = Record<string, unknown> & { t: string };
export interface Route {
  m: "GET" | "PUT" | "POST" | "DELETE";
  path: string;
  auth: "none" | "secret" | "secret+iid";
  body?: Schema;
  res?: Schema;
  raw?: boolean;
  query?: string[];
  rate?: string;
  once?: string;
  modes?: string[];
  timeoutMs?: number;
}

export const PV: number = C.PV;
export const GATE = C.GATE;
export const HDR = C.HDR;
export const DOMAIN = C.DOMAIN;
export const EXIT = C.EXIT;
export const MODES: string[] = C.MODES;
export const SQLITE_KINDS: string[] = C.SQLITE_KINDS;
export const TIERS = C.TIERS as readonly Tier[];
export const SYNC_INTERVAL = C.SYNC_INTERVAL as Record<Tier, string>;
export const EVENT_KINDS: string[] = C.EVENT_KINDS;
export const OCSUP_STATES: string[] = C.OCSUP_STATES;
export const ALERT_SEVERITY = C.ALERT_SEVERITY as readonly Severity[];
export const S3_OPS = C.S3_OPS;
export const LOG_MAX_BODY: number = C.LOG_MAX_BODY;
export const ARCHIVE_PART_MAX: number = C.ARCHIVE_PART_MAX;
export const SHADOW_SINGLE_MAX: number = C.SHADOW_SINGLE_MAX;
export const REPLICA_HELLO_PATH: string = C.REPLICA_HELLO_PATH;
export const PATTERNS = C.PATTERNS as Record<"hex64" | "iid" | "relpath" | "inst" | "credPath", RegExp>;

export type Tier = "normal" | "slow" | "slower";
export type Severity = "info" | "warn" | "high";

export interface LtxKey {
  inst: string;
  gen: number;
  db: string;
  level: number;
  minTxid: number;
  maxTxid: number;
}
export interface SeedState {
  l0Seen: boolean;
  l0SeedBytes: number;
  compactSeedBytes: number;
}

export const validate = C.validate as (schema: Schema, value: unknown, path?: string) => string[];
export const assertValid = C.assertValid as <T>(schema: Schema, value: T, what?: string) => T;
export const exitCodeFor = C.exitCodeFor as (reason: string) => number;
export const classifyExit = C.classifyExit as (
  code: number,
  reason?: string | null,
) => { cls: string; esc: boolean | "evidence" };
export const parseLtxKey = C.parseLtxKey as (key: string) => LtxKey | null;
export const ltxName = C.ltxName as (minTxid: number, maxTxid: number) => string;
export const genPrefix = C.genPrefix as (inst: string, gen: number) => string;
export const replicaAccessKeyId = C.replicaAccessKeyId as (gen: number, iid: string) => string;
export const replicaKeyMessage = C.replicaKeyMessage as (gen: number, iid: string) => string;
export const replicaAccess = C.replicaAccess as (
  props: { inst: string; gen: number; restoreGens?: number[]; mode: string },
  op: string,
  key: string | null,
  prefix?: string | null,
) => { allow: boolean; status?: number; why?: string; scope?: string; checkEach?: string };
export const filesPrefix = C.filesPrefix as (inst: string) => string;
export const isFilesTarget = C.isFilesTarget as (
  op: string,
  key: string | null,
  prefix?: string | null,
) => boolean;
export const filesAccess = C.filesAccess as (
  props: { inst: string; mode: string },
  op: string,
  key: string | null,
  prefix?: string | null,
) => { allow: boolean; status?: number; why?: string; scope?: string };
export const seedClass = C.seedClass as (
  parsed: LtxKey | null,
  bytes: number,
  state: SeedState,
) => "seed" | "reseed" | "other";
export const s3OpOf = C.s3OpOf as (method: string, q: URLSearchParams) => string | null;

// Schemas used by the Worker (opaque objects for validate()).
export const S = {
  Envelope: C.Envelope,
  HelloReq: C.HelloReq,
  BootReq: C.BootReq,
  BootPlan: C.BootPlan,
  HeartbeatReq: C.HeartbeatReq,
  EventReq: C.EventReq,
  AlertReq: C.AlertReq,
  LogReq: C.LogReq,
  CredPut: C.CredPut,
  CredDel: C.CredDel,
  CredManifest: C.CredManifest,
  CredGetRes: C.CredGetRes,
  ConfigProposal: C.ConfigProposal,
  ConfigGetRes: C.ConfigGetRes,
  PluginManifest: C.PluginManifest,
  FinalSnapshotReq: C.FinalSnapshotReq,
  ArchiveStart: C.ArchiveStart,
  ArchiveComplete: C.ArchiveComplete,
  SleepCheckRes: C.SleepCheckRes,
  SleepFlushRes: C.SleepFlushRes,
} as Record<string, Schema>;

// ---- M2 additions (spec §23): now in contract.mjs. The lists stay for callers; both are empty. ----

export const WakeAllowReq = C.WakeAllowReq as Schema;

/** §23: routes the Worker serves that contract.mjs does not list. Empty: wake-allow moved to the .mjs. */
export const M2_ROUTES: readonly Route[] = Object.freeze([] as Route[]);

/** §23 / C24: exit reasons not in contract.mjs. Empty: restore-blocked:rewound moved to the .mjs. */
export const M2_EXIT_REASONS: Readonly<Record<string, number>> = Object.freeze({});

export const ROUTES: readonly Route[] = Object.freeze([...(C.ROUTES as Route[]), ...M2_ROUTES]);
export const CONTRACT_ROUTES: readonly Route[] = C.ROUTES as Route[];

/** routeFor() over ROUTES (contract.mjs routes + M2 additions). */
export function routeFor(method: string, pathname: string): Route | null {
  const exact = ROUTES.find((r) => r.m === method && r.path === pathname);
  if (exact) return exact;
  for (const r of ROUTES) {
    if (r.m !== method || !r.path.includes("/:")) continue;
    const pre = r.path.split("/:")[0] as string;
    if (pathname.startsWith(`${pre}/`) && pathname.length > pre.length + 1) return r;
  }
  return null;
}

/** Exit code for a reason, M2 additions included. */
export function exitCode(reason: string): number {
  return M2_EXIT_REASONS[reason] ?? exitCodeFor(reason);
}
