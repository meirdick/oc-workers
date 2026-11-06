// Gate types shared by ControlGate, ReplicaGate, the fakes and the intercept module.
import type { Mode, RuntimeGateRpc } from "../core/types";
import type { GatePort } from "./ledger";

/** Entrypoint props (spec §8.4). Set by the Runtime DO when it registers the intercepts. */
export interface GateProps {
  v: 1;
  inst: string;
  epoch: number;
  gen: number;
  mode: Mode;
  bootSecret: string;
  restoreGens: number[];
  /** Test groups only (OC_TEST=1): enables the fakes. Not a security boundary. */
  test?: boolean;
}

/** Runtime DO methods a gate calls (core/types.ts RuntimeGateRpc). */
export type RtGatePort = Pick<RuntimeGateRpc, "onHeartbeat" | "onEvent" | "finalSnapshot" | "bootBound"> & {
  /** /v1/maint-snapshot (M4). Absent → 403. */
  maintSnapshot?(
    body: Record<string, unknown>,
  ): Promise<{ status: number; ok: boolean; snapshotId?: string; error?: string }>;
};

/** Per-isolate caches (spec §13.1 layer 3: 5 s cache of the current gen; §17.1 hello 1/s per isolate). */
export class GateCache {
  current = new Map<string, { at: number; v: { current: boolean; iid: string | null; why?: string } }>();
  hello = new Map<string, { at: number; tokens: number }>();
  /** sec F7: bad signatures counted per isolate, flushed to the Control DO at most every BADSIG_FLUSH_MS. */
  badSig = new Map<number, { n: number; flushedAt: number }>();
  constructor(readonly ttlMs = 5_000) {}
}

export interface GateDeps {
  props: GateProps;
  ctl: GatePort;
  rt: RtGatePort;
  bucket: R2Bucket;
  /** Bucket name Litestream uses in the path (plan.replica.bucket). */
  bucketName: string;
  now: () => number;
  cache: GateCache;
  waitUntil?: (p: Promise<unknown>) => void;
}
