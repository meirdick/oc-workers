// Control DO side of the gates (spec §17.2, §18.4-§18.6). Runs inside the Control DO on its SQLite
// (tables of spec §3.1, created by ctl/schema.ts, plus the gate-only tables in GATE_DDL below).
// Every method is synchronous: one RPC from a gate = one storage transaction, no await inside.
// The Control DO exposes it as `gateCall(method, args)` (see GATE_CALLS); the gates hold no state but caches.

import { type LtxKey, parseLtxKey, seedClass, type Tier } from "../core/contract";
import type { Severity } from "../core/types";
import { adapterByChannel } from "../ctl/adapters";
import { heldReason } from "../ctl/adopt-spec";
import {
  type ArchiveCfg,
  type ArchiveQ,
  type ArchiveRequest,
  archiveCfg,
  archiveDue,
  CADENCE_REASONS,
  dayCap,
  FORCED_REASONS,
} from "./archive-policy";
import { CAP_DDL, Caps, type CapsView, type CapTake, type CapUse, type CapVerb } from "./caps";
import {
  ackOf,
  IMPORT_META,
  type ImportRequest,
  importBundleKey,
  importIdOk,
  takeForHeartbeat,
} from "./import-policy";
import { type LtxCheck, ltxMatchesKey } from "./ltx";
import { shaInit } from "./sha256";

export type SqlValue = string | number | null | ArrayBuffer | Uint8Array;
type Row = Record<string, SqlValue>;
/** Structural twin of ctl/sql.ts StoreLike (ctx.storage or the node:sqlite fake). */
export interface GateStoreLike {
  sql: { exec(query: string, ...bindings: SqlValue[]): { toArray(): unknown[] } };
  transactionSync<T>(fn: () => T): T;
}

/** Gate-only tables (not in spec §3.1; listed in the gates report). */
export const GATE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS gate_hello (gen INTEGER NOT NULL, plane TEXT NOT NULL, n INTEGER NOT NULL,
    last_at INTEGER NOT NULL, alerted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (gen, plane))`,
  `CREATE TABLE IF NOT EXISTS gate_badsig (gen INTEGER PRIMARY KEY, n INTEGER NOT NULL)`,
  // lastWriteAt per DB and level (task: "lastWriteAt per DB and level")
  `CREATE TABLE IF NOT EXISTS gendb_level (gen INTEGER NOT NULL, db TEXT NOT NULL, level INTEGER NOT NULL,
    last_write_at INTEGER NOT NULL, max_txid INTEGER NOT NULL, bytes INTEGER NOT NULL, n INTEGER NOT NULL,
    PRIMARY KEY (gen, db, level))`,
  // R2 op classes per UTC day: class A (List, Put, multipart create/part/complete), class B (Get, Head).
  `CREATE TABLE IF NOT EXISTS replica_day (day TEXT PRIMARY KEY, class_a INTEGER NOT NULL DEFAULT 0,
    class_b INTEGER NOT NULL DEFAULT 0, free INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS archive_hash (id TEXT PRIMARY KEY, next_n INTEGER NOT NULL, state TEXT NOT NULL,
    prev_state TEXT, bytes INTEGER NOT NULL, prev_bytes INTEGER NOT NULL DEFAULT 0, parts TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shadow_rate (db TEXT PRIMARY KEY, at INTEGER NOT NULL, key TEXT, size INTEGER)`,
  `CREATE TABLE IF NOT EXISTS log_seq (gen INTEGER PRIMARY KEY, seq INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cred_del_log (at INTEGER NOT NULL)`,
  // sec F4: per-boot replica budget (request window + totals); sec F9: heartbeat seq per gen.
  `CREATE TABLE IF NOT EXISTS gate_boot (gen INTEGER PRIMARY KEY, reqs INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0, win_at INTEGER NOT NULL DEFAULT 0, win_n INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS gate_hbseq (gen INTEGER PRIMARY KEY, seq INTEGER NOT NULL, at INTEGER NOT NULL)`,
  // CapGate daily budgets (gates/caps.ts).
  ...CAP_DDL,
  // docs/11 §8 file storage: bytes per object under f/<inst>/ (the per-install cap sums them).
  `CREATE TABLE IF NOT EXISTS files_obj (key TEXT PRIMARY KEY, bytes INTEGER NOT NULL, at INTEGER NOT NULL)`,
];

/** Columns added to spec §3.1 tables (expand-only migration; ALTER only when missing). */
export const GATE_COLUMNS: readonly [string, string, string][] = [
  // sec F1: a record the gate verified from the LTX header bytes (0 = legacy row, never covers).
  ["ltx", "verified", "INTEGER NOT NULL DEFAULT 0"],
  // sec F1: two different level-0 objects overlap (chain fork) → deletes of this gen/db refused.
  ["gendb", "fork", "INTEGER NOT NULL DEFAULT 0"],
  // sec F4: level-9 bytes per gen/db (seed only up to L9_SEED_FACTOR × the DB seed size).
  ["gendb", "l9_bytes", "INTEGER NOT NULL DEFAULT 0"],
  // sec F5: hello token bucket.
  ["gate_hello", "tokens", "REAL"],
  // M4 archives: why it was taken, the newest replica write it covers, workspace facts at start, read-back
  // verification (restore or drill), and the bad mark.
  ["archives", "reason", "TEXT"],
  ["archives", "request_id", "TEXT"],
  ["archives", "src_write_at", "INTEGER"],
  ["archives", "ws_entries", "INTEGER"],
  ["archives", "ws_missing", "INTEGER"],
  ["archives", "verified_at", "INTEGER"],
  ["archives", "verified_by", "TEXT"],
  ["archives", "bad_reason", "TEXT"],
  ["archives", "deleted_at", "INTEGER"],
  // M4b L3: reply seen for an accepted inbox row; fresh-key replays after a restart.
  ["inbox", "replied_at", "INTEGER"],
  ["inbox", "replays", "INTEGER NOT NULL DEFAULT 0"],
  // S0.10: 1 = sender/group not on the wake list: never wakes, never activity, never blocks the sleep gate.
  ["inbox", "quiet", "INTEGER NOT NULL DEFAULT 0"],
];

const GiB = 1024 ** 3;
const MB = 1_000_000;
/** spec §18.6 per UTC day (×budgetScale in test mode). */
export const BUDGET = Object.freeze({
  reqs: { soft: 150_000, hard: 300_000, ceiling: 1_000_000 },
  bytes: { soft: 10 * GiB, hard: 30 * GiB, ceiling: 60 * GiB },
  seedHigh: 50 * GiB,
});
export const LOG_CAP_BYTES = 20 * MB; // amend §2 row 24
export { ARCHIVES_PER_DAY } from "./archive-policy";
export const SHADOW_EVERY_MS = 10 * 60_000;
/** sec F2 (A11): shadows per hour over all DB names. guess: ocsup's shadow scan makes a few per hour. */
export const SHADOW_PER_HOUR = 12;
export const HELLO_ALERT = 200;
export const BADSIG_ALERT = 20;
export const CREDS_BURST = 20; // deletes per minute
/**
 * sec F10: decoded bytes kept inline in the creds row; above → R2 blob (spec §17.2 said 1.9 MB). 512 KiB
 * decoded = ~700 KB base64, well under the 2 MB SQLite-backed DO row/value limit (CF docs).
 */
export const CRED_INLINE_MAX = 512 * 1024;
export const ALERT_EVERY_MS = 3_600_000;
export const RING_MAX = 500;

/** sec F2 storage bounds: keep the newest N; pruning past a cap alerts `ctl-prune` (1/h). */
/** N6: a creds tombstone older than this may be dropped when tombstones fill the 2 × cap rows. */
export const TOMBSTONE_KEEP_MS = 24 * 3_600_000;
export const CAPS = Object.freeze({
  credsHistPerPath: 20,
  credsHistDays: 30,
  credPaths: 500,
  configRows: 50,
  pluginRows: 20,
  shadowNames: 64,
  alertRows: 200,
  /** Inline creds bytes (creds + creds_hist b64) before old history goes. */
  credBytes: 64 * MB,
});
/**
 * sec F2 storage-full guard. guess: limits well under the 10 GB SQLite-backed DO cap. Above `soft` the
 * Control DO prunes hard; above `hard` it refuses growth writes (creds, config, plugins, shadows) with 507
 * `ctl-full`, so the small rows of ensure(), beginBoot and the heartbeat keep fitting.
 */
export const STORAGE = Object.freeze({ soft: 1024 * MB, hard: 2048 * MB });
export type StorageLimits = { soft: number; hard: number };

/** sec F4 per-boot replica budget. Window rate is not scaled (Litestream's rate does not scale). */
export const BOOT_BUDGET = Object.freeze({
  /** Requests per gen per minute; 500/min × 1440 = 720k/day < the 1M day ceiling. */
  perMin: 500,
  /** Share of the day ceilings one gen may use (requests and written bytes). */
  share: 0.25,
});
/** sec F4: L9 bytes count as seed up to this factor × the DB seed size (+1 MiB); the rest are tier bytes. */
export const L9_SEED_FACTOR = 2;
/** sec F5: hello token bucket (per gen and plane in the Control DO; per isolate in the gate). */
export const HELLO_BURST = 8;
export const HELLO_REFILL_MS = 250;

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface UploadRec {
  key: string;
  bytes: number;
  at?: number;
}
export interface ReplicaPreIn {
  epoch: number;
  gen: number;
  op: string;
  write: boolean;
  key?: string | null;
}
export interface ReplicaPreOut {
  current: boolean;
  why?: string;
  iid: string | null;
  tier: Tier;
  ceiling: boolean;
  reseed: boolean;
  /** Gen mode in the Control DO (S75: writes need prod here and in the props). */
  mode?: string | null;
  /** sec F4: per-boot budget refused this request; retry after N seconds (429 SlowDown). */
  limited?: { retryAfterS: number; why: string };
  /** M4 S3 test fault: R2 is "down"; the gate answers 503. */
  r2Down?: boolean;
  /** Soak test fault: ReplicaGate waits this long before it serves a write (Litestream throttle). */
  slowMs?: number;
}
/** docs/11 §8: settings files.capGb and files.maxObjectMb in bytes (decimal). */
export interface FilesLimits {
  cap: number;
  objectMax: number;
}
export const FILES_DEFAULT: FilesLimits = Object.freeze({ cap: 5e9, objectMax: 100e6 });
export const FILES_ALERT_AT = 0.8;
export interface FilesPreIn {
  epoch: number;
  gen: number;
  op: string;
  key?: string | null;
  /** PutObject: the declared body length. */
  bytes?: number;
}
export interface FilesPreOut {
  current: boolean;
  why?: string;
  iid: string | null;
  mode?: string | null;
  /** The cap refused this write: S3 status, code, message. */
  refuse?: { status: number; code: string; message: string };
}
export interface FilesView {
  used: number;
  limit: number;
  objects: number;
  objectMax: number;
  pct: number;
}
export interface ReplicaPostIn {
  gen: number;
  op: string;
  status: number;
  key?: string | null;
  bytes?: number;
  /** LTX header check of the bytes the gate wrote (sec F1/F3). Absent → the upload is not recorded. */
  ltx?: LtxCheck | null;
}
export interface CurrentOut {
  current: boolean;
  why?: string;
  iid: string | null;
  mode: string | null;
}

type Plan = Record<string, unknown>;

export class GateLedger {
  constructor(
    readonly store: GateStoreLike,
    readonly o: {
      inst: string;
      now?: () => number;
      budgetScale?: number;
      size?: () => number | null;
      /** M4 archive cadence and holds (settings `archive`); defaults when absent. */
      archive?: () => ArchiveCfg;
      /** docs/12: settings `sandbox` is "on". Absent → off. */
      sandbox?: () => boolean;
      /** Settings storage.pruneAtMb and refuseAtMb in bytes; STORAGE when absent. */
      storage?: () => StorageLimits;
      /** Settings files.capGb and files.maxObjectMb in bytes; FILES_DEFAULT when absent. */
      files?: () => FilesLimits;
    },
  ) {}

  private get archiveCfg(): ArchiveCfg {
    return this.o.archive ? this.o.archive() : archiveCfg(null);
  }
  /** Read seam for archive-policy.ts. */
  private get q(): ArchiveQ {
    return { one: <T>(q: string, ...b: (string | number | null)[]) => this.one<T>(q, ...b) };
  }
  private metaGet<T>(k: string, d: T): T {
    const v = this.one<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)?.v;
    if (v == null) return d;
    try {
      return JSON.parse(v) as T;
    } catch {
      return v as unknown as T;
    }
  }
  private metaSet(k: string, v: unknown): void {
    this.run(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k,
      typeof v === "string" ? v : JSON.stringify(v),
    );
  }

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }
  private get scale(): number {
    return this.o.budgetScale ?? 1;
  }

  // ---------- sql helpers ----------
  private all<T = Row>(q: string, ...b: (SqlValue | undefined | boolean)[]): T[] {
    return this.store.sql.exec(q, ...b.map(norm)).toArray() as T[];
  }
  private one<T = Row>(q: string, ...b: (SqlValue | undefined | boolean)[]): T | null {
    return (this.all<T>(q, ...b)[0] as T | undefined) ?? null;
  }
  private run(q: string, ...b: (SqlValue | undefined | boolean)[]): void {
    this.store.sql.exec(q, ...b.map(norm)).toArray();
  }
  private tx<T>(fn: () => T): T {
    return this.store.transactionSync(fn);
  }

  /** Create the gate-only tables. The Control DO calls it after its own DDL. */
  migrate(): void {
    for (const q of GATE_DDL) this.run(q);
    for (const [t, c, def] of GATE_COLUMNS) {
      const cols = this.all<{ name: string }>(`PRAGMA table_info(${t})`).map((r) => r.name);
      if (cols.length && !cols.includes(c)) this.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
    }
  }

  /** Storage size in bytes, when the store tells (ctx.storage.sql.databaseSize; tests inject `size`). */
  dbSize(): number | null {
    if (this.o.size) return this.o.size();
    const v = (this.store.sql as { databaseSize?: number }).databaseSize;
    return typeof v === "number" ? v : null;
  }

  /** sec F2: above STORAGE.hard → refuse growth writes (alert high, 1/h). */
  full(what: string): boolean {
    const n = this.dbSize();
    if (n === null || n < (this.o.storage?.() ?? STORAGE).hard) return false;
    this.alert("ctl-storage-full", "high", `${n} bytes; refused ${what}`);
    return true;
  }

  /** Prune note: a ring row with what went (routine bounds work, not an alert). */
  private pruned(table: string, n: number, why: string): void {
    if (n > 0) this.ring("bounds", "pruned", { table, n, why });
  }
  /** DELETE that returns how many rows went (COUNT first: portable to the workerd SQL API). */
  private del(where: string, ...b: (SqlValue | undefined | boolean)[]): number {
    const n = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${where}`, ...b)?.n ?? 0;
    if (n) this.run(`DELETE FROM ${where}`, ...b);
    return n;
  }

  // ---------- generic: alerts and ring ----------

  /** Dedupe 1 per class per hour (gate §2 /v1/alert, spec §17.2). Returns sent=true when not deduped. */
  alert(cls: string, severity: Severity, detail?: string | null): { sent: boolean } {
    const now = this.now;
    const r = this.one<{ last_sent_at: number | null }>(
      "SELECT last_sent_at FROM alerts WHERE class = ?",
      cls,
    );
    const sent = !r || r.last_sent_at === null || now - r.last_sent_at >= ALERT_EVERY_MS;
    this.run(
      `INSERT INTO alerts (class, severity, last_sent_at, count, last_detail, open) VALUES (?, ?, ?, 1, ?, 1)
       ON CONFLICT(class) DO UPDATE SET severity = excluded.severity, count = count + 1,
       last_detail = excluded.last_detail, open = 1,
       last_sent_at = CASE WHEN ? THEN excluded.last_sent_at ELSE last_sent_at END`,
      cls,
      severity,
      now,
      detail?.slice(0, 2000) ?? null,
      sent ? 1 : 0,
    );
    if (sent) this.ring("alert", cls, { severity, detail: detail?.slice(0, 500) });
    pruneAlertRows(this.store, cls);
    return { sent };
  }

  ring(src: string, kind: string, detail?: unknown): void {
    this.run(
      "INSERT INTO ring (at, src, kind, detail) VALUES (?, ?, ?, ?)",
      this.now,
      src,
      kind,
      detail === undefined ? null : JSON.stringify(detail).slice(0, 4000),
    );
    this.run("DELETE FROM ring WHERE id <= (SELECT MAX(id) FROM ring) - ?", RING_MAX);
  }

  // ---------- CapGate budgets (gates/caps.ts) ----------
  private get caps(): Caps {
    return new Caps(
      this.store,
      () => this.now,
      (c, s, d) => this.alert(c, s, d),
    );
  }
  /** Room left for `verb` today? No charge. */
  capCheck(verb: CapVerb): CapTake {
    return this.caps.check(verb);
  }
  /** Check, then charge `n` when there is room. */
  capTake(verb: CapVerb, n: number): CapTake {
    return this.caps.take(verb, n);
  }
  /** Charge `n` after the work is done (alerts at 80% and 100%; never refuses). */
  capAdd(verb: CapVerb, n: number): CapUse {
    return this.caps.add(verb, n);
  }
  /**
   * SandboxGate admission (docs/12 §4), one RPC per command: sandbox on, the caller's gen current (a fenced
   * gateway runs nothing), and the exec and sandbox budgets. No charge: the SandboxSession DO charges exec
   * seconds when a command ends and sandbox hours on its alarm.
   */
  sbxAdmit(
    epoch: number,
    gen: number,
  ): { on: boolean; current: CurrentOut; exec: CapTake; sandbox: CapTake } {
    const caps = this.caps;
    return {
      on: this.o.sandbox?.() === true,
      current: this.current(epoch, gen),
      exec: caps.check("exec"),
      sandbox: caps.check("sandbox"),
    };
  }
  /** /ops/caps GET. */
  capsView(): CapsView {
    return this.caps.view();
  }
  /** /ops/caps POST: set daily limits. Throws on a bad value. */
  capsSet(limits: Partial<Record<CapVerb, unknown>>): CapsView {
    const v = this.caps.setLimits(limits);
    this.ring("caps", "limits", limits);
    return v;
  }

  // ---------- file storage (docs/11 §8; gates/files.ts) ----------

  private get filesLimits(): FilesLimits {
    return this.o.files ? this.o.files() : FILES_DEFAULT;
  }
  private filesUsed(): { used: number; objects: number } {
    const r = this.one<{ b: number | null; n: number }>(
      "SELECT SUM(bytes) AS b, COUNT(*) AS n FROM files_obj",
    );
    return { used: Number(r?.b ?? 0), objects: Number(r?.n ?? 0) };
  }
  /** /ops/caps and the panel: bytes stored under f/<inst>/ against the cap. */
  filesView(): FilesView {
    const { used, objects } = this.filesUsed();
    const { cap, objectMax } = this.filesLimits;
    return { used, limit: cap, objects, objectMax, pct: cap > 0 ? used / cap : 1 };
  }
  /**
   * Before a files request (uncached, after the signature check): current gen and bound iid like replicaPre, and
   * for a PutObject the per-object cap and the per-install cap (an overwrite counts the new size only). A refusal
   * at the cap raises `storage-cap-100`.
   */
  filesPre(a: FilesPreIn): FilesPreOut {
    return this.tx(() => {
      const cur = this.current(a.epoch, a.gen);
      const out: FilesPreOut = { current: cur.current, why: cur.why, iid: cur.iid, mode: cur.mode };
      if (!cur.current || a.op !== "PutObject" || !a.key) return out;
      const { cap, objectMax } = this.filesLimits;
      const bytes = a.bytes ?? 0;
      if (bytes > objectMax) {
        out.refuse = {
          status: 400,
          code: "EntityTooLarge",
          message: `object ${bytes} bytes is above files.maxObjectMb (${objectMax} bytes)`,
        };
        return out;
      }
      const old = this.one<{ bytes: number }>("SELECT bytes FROM files_obj WHERE key = ?", a.key)?.bytes ?? 0;
      const used = this.filesUsed().used;
      if (used - old + bytes > cap) {
        this.alert("storage-cap-100", "high", `files ${used}/${cap} bytes; refused ${bytes} bytes`);
        out.refuse = {
          status: 403,
          code: "StorageCapExceeded",
          message: `files.capGb reached: ${used} of ${cap} bytes used; this object needs ${bytes}`,
        };
      }
      return out;
    });
  }
  /** After R2 answered a files write: record or drop the object; the write that crosses 80 % or 100 % alerts. */
  filesPost(a: { op: string; key: string; status: number; bytes?: number }): FilesView {
    return this.tx(() => {
      const before = this.filesView();
      if (a.status >= 200 && a.status < 300) {
        if (a.op === "PutObject")
          this.run(
            `INSERT INTO files_obj (key, bytes, at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET bytes = excluded.bytes, at = excluded.at`,
            a.key,
            a.bytes ?? 0,
            this.now,
          );
        else if (a.op === "DeleteObject") this.run("DELETE FROM files_obj WHERE key = ?", a.key);
      }
      const after = this.filesView();
      const line = `files ${after.used}/${after.limit} bytes (${Math.round(after.pct * 100)}%)`;
      if (before.pct < 1 && after.pct >= 1)
        this.alert("storage-cap-100", "high", `${line}; writes are refused`);
      else if (before.pct < FILES_ALERT_AT && after.pct >= FILES_ALERT_AT)
        this.alert("storage-cap-80", "warn", line);
      return after;
    });
  }
  /** `ochost destroy --delete-data` (POST /ops/files/purge): the objects are gone from R2. */
  filesForget(keys: string[] | null): void {
    if (keys === null) this.run("DELETE FROM files_obj");
    else for (const k of keys) this.run("DELETE FROM files_obj WHERE key = ?", k);
  }

  // ---------- gens: current check, hello, boot ----------

  /** spec §13.2: current = newest gen of an active epoch, not abandoned/deleted. */
  current(epoch: number, gen: number): CurrentOut {
    const g = this.one<{ epoch: number; state: string; iid: string | null; mode: string }>(
      "SELECT epoch, state, iid, mode FROM gens WHERE gen = ?",
      gen,
    );
    const no = (why: string): CurrentOut => ({
      current: false,
      why,
      iid: g?.iid ?? null,
      mode: g?.mode ?? null,
    });
    if (!g) return no("no-gen");
    if (g.epoch !== epoch) return no("epoch");
    if (g.state === "abandoned" || g.state === "deleted") return no(`gen-${g.state}`);
    const newer = this.one<{ m: number }>("SELECT MAX(gen) AS m FROM gens WHERE epoch = ?", epoch);
    if ((newer?.m ?? gen) > gen) return no("newer-gen");
    const e = this.one<{ status: string }>("SELECT status FROM epochs WHERE n = ?", epoch);
    if (e?.status !== "active") return no(`epoch-${e?.status ?? "none"}`);
    return { current: true, iid: g.iid, mode: g.mode };
  }

  /**
   * Hello counter per gen and plane (spec §17.1 step 2). sec F5: a token bucket (HELLO_BURST, +1 per
   * HELLO_REFILL_MS = 4/s) instead of a fixed 1/s slot, so a 1/s attacker loop cannot take every slot;
   * `authed` (the caller proved bootSecret with a hello MAC) is never limited. Alert hello-flood above 200.
   */
  hello(gen: number, plane: "control" | "replica", authed = false): { allow: boolean; n: number } {
    return this.tx(() => {
      const now = this.now;
      const r = this.one<{ n: number; last_at: number; alerted: number; tokens: number | null }>(
        "SELECT n, last_at, alerted, tokens FROM gate_hello WHERE gen = ? AND plane = ?",
        gen,
        plane,
      );
      const had = r ? (r.tokens ?? 0) + (now - r.last_at) / HELLO_REFILL_MS : HELLO_BURST;
      const tokens = Math.min(HELLO_BURST, had);
      if (!authed && tokens < 1) return { allow: false, n: r?.n ?? 0 };
      const n = (r?.n ?? 0) + 1;
      let alerted = r?.alerted ?? 0;
      if (n > HELLO_ALERT && !alerted) {
        this.alert("hello-flood", "warn", `gen ${gen} ${plane}: ${n} hellos`);
        alerted = 1;
      }
      this.run(
        `INSERT INTO gate_hello (gen, plane, n, last_at, alerted, tokens) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(gen, plane) DO UPDATE SET n = excluded.n, last_at = excluded.last_at,
         alerted = excluded.alerted, tokens = excluded.tokens`,
        gen,
        plane,
        n,
        now,
        alerted,
        authed ? tokens : tokens - 1,
      );
      return { allow: true, n };
    });
  }

  /** Was a hello proof served for this gen (spec §9.3 boot-healthy evidence)? */
  helloServed(gen: number): boolean {
    return !!this.one("SELECT 1 FROM gate_hello WHERE gen = ? AND n > 0", gen);
  }

  /**
   * POST /v1/boot (spec §17.2, §6.2). The gate checked the secret and the current gen.
   * First call binds the iid; the same iid gets the same plan; another iid → reboot-detected, gen abandoned.
   */
  boot(
    epoch: number,
    gen: number,
    req: { iid: string; pv: number; hostname?: string },
    pvs: number[] = [1],
  ):
    | { status: "ok"; plan: Plan; bound: boolean }
    | { status: "reboot-detected" }
    | { error: "pv" | "stale"; why?: string } {
    return this.tx(() => {
      const cur = this.current(epoch, gen);
      if (!cur.current) return { error: "stale" as const, why: cur.why };
      if (!pvs.includes(req.pv)) return { error: "pv" as const };
      const g = this.one<{ iid: string | null; plan: string }>(
        "SELECT iid, plan FROM gens WHERE gen = ?",
        gen,
      );
      if (!g) return { error: "stale" as const, why: "no-gen" };
      const plan = { ...(JSON.parse(g.plan) as Plan) };
      plan.inst ??= this.o.inst;
      plan.epoch ??= epoch;
      plan.gen ??= gen;
      if (g.iid === null) {
        this.run("UPDATE gens SET iid = ?, bound_at = ? WHERE gen = ?", req.iid, this.now, gen);
        this.ring("gate", "boot-bound", { gen, iid: req.iid, hostname: req.hostname });
        return { status: "ok" as const, plan, bound: true };
      }
      if (g.iid === req.iid) return { status: "ok" as const, plan, bound: false };
      this.run("UPDATE gens SET state = 'abandoned', ended_at = ? WHERE gen = ?", this.now, gen);
      this.ring("gate", "reboot-detected", { gen, bound: g.iid, other: req.iid });
      return { status: "reboot-detected" as const };
    });
  }

  // ---------- replica: state, tier, records ----------

  replicaState(gen: number): {
    gen: number;
    dbs: Record<string, { l0MaxTxid: number; seeded: boolean; bytes: number; lastWriteAt: number | null }>;
  } {
    const rows = this.all<{
      db: string;
      l0_max_txid: number | null;
      l0_seen: number;
      bytes: number | null;
      last_write_at: number | null;
    }>("SELECT db, l0_max_txid, l0_seen, bytes, last_write_at FROM gendb WHERE gen = ?", gen);
    const dbs: Record<
      string,
      { l0MaxTxid: number; seeded: boolean; bytes: number; lastWriteAt: number | null }
    > = {};
    for (const r of rows)
      dbs[r.db] = {
        l0MaxTxid: r.l0_max_txid ?? 0,
        seeded: r.l0_seen === 1,
        bytes: r.bytes ?? 0,
        lastWriteAt: r.last_write_at,
      };
    return { gen, dbs };
  }

  /** lastWriteAt per DB and level (gendb_level). */
  levels(
    gen: number,
  ): { db: string; level: number; lastWriteAt: number; maxTxid: number; bytes: number; n: number }[] {
    return this.all<{
      db: string;
      level: number;
      last_write_at: number;
      max_txid: number;
      bytes: number;
      n: number;
    }>(
      "SELECT db, level, last_write_at, max_txid, bytes, n FROM gendb_level WHERE gen = ? ORDER BY db, level",
      gen,
    ).map((r) => ({
      db: r.db,
      level: r.level,
      lastWriteAt: r.last_write_at,
      maxTxid: r.max_txid,
      bytes: r.bytes,
      n: r.n,
    }));
  }

  private budgetRow(day: string): {
    replica_reqs: number;
    tier_bytes: number;
    seed_bytes: number;
    tier: string;
  } {
    this.run("INSERT INTO budget_day (day) VALUES (?) ON CONFLICT(day) DO NOTHING", day);
    return this.one(
      "SELECT replica_reqs, tier_bytes, seed_bytes, tier FROM budget_day WHERE day = ?",
      day,
    ) as {
      replica_reqs: number;
      tier_bytes: number;
      seed_bytes: number;
      tier: string;
    };
  }

  /** Tier and ceiling from today's counters (spec §18.6). */
  budget(): {
    day: string;
    tier: Tier;
    ceiling: boolean;
    reqs: number;
    tierBytes: number;
    seedBytes: number;
  } {
    const day = dayOf(this.now);
    const b = this.budgetRow(day);
    const { tier, ceiling } = tierOf(b.replica_reqs, b.tier_bytes, this.scale);
    return { day, tier, ceiling, reqs: b.replica_reqs, tierBytes: b.tier_bytes, seedBytes: b.seed_bytes };
  }

  /**
   * Before an S3 request (uncached): current gen, bound iid, gen mode, tier, ceiling, reseed guard (§18.3,
   * §18.6), and the per-boot budget (sec F4). Called only after the gate checked the signature (sec F7).
   */
  replicaPre(a: ReplicaPreIn): ReplicaPreOut {
    return this.tx(() => {
      const cur = this.current(a.epoch, a.gen);
      const b = this.budget();
      let reseed = false;
      const p = a.key ? parseLtxKey(a.key) : null;
      if (
        cur.current &&
        a.write &&
        p &&
        p.gen === a.gen &&
        p.level === 0 &&
        p.minTxid === 1 &&
        (a.op === "PutObject" || a.op === "CreateMultipartUpload")
      ) {
        const d = this.one<{ l0_seen: number }>(
          "SELECT l0_seen FROM gendb WHERE gen = ? AND db = ?",
          a.gen,
          p.db,
        );
        const same = this.one(
          "SELECT 1 FROM ltx WHERE gen = ? AND db = ? AND level = 0 AND min_txid = 1 AND max_txid = ?",
          a.gen,
          p.db,
          p.maxTxid,
        );
        if (d?.l0_seen === 1 && !same) {
          reseed = true;
          this.alert("replica-reseed", "warn", a.key ?? "");
        }
      }
      const limited = cur.current ? this.bootBudget(a.gen, a.write) : undefined;
      if (!cur.current || reseed || (a.write && b.ceiling) || limited) this.bumpDay("refused");
      return {
        current: cur.current,
        why: cur.why,
        iid: cur.iid,
        mode: cur.mode,
        tier: b.tier,
        ceiling: b.ceiling,
        reseed,
        ...(limited ? { limited } : {}),
      };
    });
  }

  /**
   * sec F4: per-boot budget. A gen may make BOOT_BUDGET.perMin requests per minute, and use
   * BOOT_BUDGET.share of the day request ceiling and (writes) of the day byte ceiling. Over → 429 with
   * Retry-After and alert `replica-boot-budget`; refused requests do not reach R2 and do not count for the day,
   * so a flood from one boot can no longer reach the day ceiling and stop the next boots.
   */
  private bootBudget(gen: number, write: boolean): { retryAfterS: number; why: string } | undefined {
    const now = this.now;
    this.run("INSERT INTO gate_boot (gen) VALUES (?) ON CONFLICT(gen) DO NOTHING", gen);
    const r = this.one<{ reqs: number; bytes: number; win_at: number; win_n: number }>(
      "SELECT reqs, bytes, win_at, win_n FROM gate_boot WHERE gen = ?",
      gen,
    ) as { reqs: number; bytes: number; win_at: number; win_n: number };
    const fresh = now - r.win_at >= 60_000;
    const winAt = fresh ? now : r.win_at;
    const winN = fresh ? 0 : r.win_n;
    let why: string | null = null;
    let retryAfterS = 0;
    if (winN >= BOOT_BUDGET.perMin) {
      why = `rate ${winN}/min`;
      retryAfterS = Math.max(1, Math.ceil((winAt + 60_000 - now) / 1000));
    } else if (r.reqs >= BUDGET.reqs.ceiling * this.scale * BOOT_BUDGET.share) {
      why = `boot requests ${r.reqs}`;
      retryAfterS = 3600;
    } else if (write && r.bytes >= BUDGET.bytes.ceiling * this.scale * BOOT_BUDGET.share) {
      why = `boot bytes ${r.bytes}`;
      retryAfterS = 3600;
    }
    if (why) {
      this.run("UPDATE gate_boot SET win_at = ?, win_n = ? WHERE gen = ?", winAt, winN, gen);
      this.alert("replica-boot-budget", "warn", `gen ${gen}: ${why}`);
      return { retryAfterS, why };
    }
    this.run(
      "UPDATE gate_boot SET win_at = ?, win_n = ?, reqs = reqs + 1 WHERE gen = ?",
      winAt,
      winN + 1,
      gen,
    );
    return undefined;
  }

  private bumpDay(col: "class_a" | "class_b" | "free" | "refused", n = 1): void {
    this.run(
      `INSERT INTO replica_day (day, ${col}) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET ${col} = ${col} + ?`,
      dayOf(this.now),
      n,
      n,
    );
  }

  /**
   * After R2 answered an S3 request that reached it: counters, and the upload record on a 2xx (spec §18.4).
   * sec F1/F3: an LTX key is recorded only when the gate's own header check of the written bytes matches the
   * key name; else the key keeps no record (an older record of the same key goes: its object was replaced)
   * and its bytes count as tier bytes. Bytes of non-LTX keys count as tier bytes too (sec F4).
   */
  replicaPost(a: ReplicaPostIn): {
    recorded: boolean;
    cls?: string;
    complete?: boolean;
    voided?: number;
    why?: string;
  } {
    return this.tx(() => {
      const day = dayOf(this.now);
      this.budgetRow(day);
      this.run("UPDATE budget_day SET replica_reqs = replica_reqs + 1 WHERE day = ?", day);
      this.bumpDay(opClass(a.op));
      let out: { recorded: boolean; cls?: string; complete?: boolean; voided?: number; why?: string } = {
        recorded: false,
      };
      const ok = a.status >= 200 && a.status < 300;
      const upload = a.op === "PutObject" || a.op === "CompleteMultipartUpload" || a.op === "UploadPart";
      if (ok && upload && a.op !== "UploadPart")
        this.run("UPDATE gate_boot SET bytes = bytes + ? WHERE gen = ?", a.bytes ?? 0, a.gen);
      if (ok && (a.op === "PutObject" || a.op === "CompleteMultipartUpload") && a.key) {
        const p = parseLtxKey(a.key);
        if (p && p.gen === a.gen) {
          const chk = ltxMatchesKey(a.ltx ?? { ok: false, why: "no-header" }, p);
          if (chk.ok) out = this.recordUploadTx(p, a.bytes ?? 0);
          else {
            this.del(
              "ltx WHERE gen = ? AND db = ? AND level = ? AND min_txid = ? AND max_txid = ?",
              p.gen,
              p.db,
              p.level,
              p.minTxid,
              p.maxTxid,
            );
            this.tierBytes(day, a.bytes ?? 0);
            this.alert("replica-ltx-bad", "warn", `${a.key}: ${chk.why}`);
            out = { recorded: false, why: chk.why };
          }
        } else this.tierBytes(day, a.bytes ?? 0);
      }
      this.updateTier(day);
      return out;
    });
  }

  private tierBytes(day: string, n: number): void {
    if (n > 0) this.run("UPDATE budget_day SET tier_bytes = tier_bytes + ? WHERE day = ?", n, day);
  }

  /**
   * spec §18.4 record of one completed LTX object, for callers that verified it (tests, a trusted retry).
   * The S3 path goes through replicaPost, which verifies the header first.
   */
  recordUpload(r: UploadRec): { recorded: boolean; cls?: string; complete?: boolean; voided?: number } {
    const p = parseLtxKey(r.key);
    if (!p) return { recorded: false };
    return this.tx(() => {
      const o = this.recordUploadTx(p, r.bytes, r.at);
      this.updateTier(dayOf(this.now));
      return o;
    });
  }

  private recordUploadTx(
    p: LtxKey,
    bytes: number,
    atIn?: number,
  ): { recorded: boolean; cls: string; complete: boolean; voided: number } {
    const at = atIn ?? this.now;
    const day = dayOf(this.now);
    this.run(
      `INSERT INTO gendb (gen, db, in_boot_set, state) VALUES (?, ?, 0, 'pending') ON CONFLICT(gen, db) DO NOTHING`,
      p.gen,
      p.db,
    );
    const d = this.one<{
      l0_seen: number;
      l0_seed_bytes: number;
      compact_seed_bytes: number;
      l0_max_txid: number | null;
      l9_bytes: number;
      bytes: number | null;
    }>(
      `SELECT l0_seen, l0_seed_bytes, compact_seed_bytes, l0_max_txid, l9_bytes, bytes
       FROM gendb WHERE gen = ? AND db = ?`,
      p.gen,
      p.db,
    ) as {
      l0_seen: number;
      l0_seed_bytes: number;
      compact_seed_bytes: number;
      l0_max_txid: number | null;
      l9_bytes: number;
      bytes: number | null;
    };
    const prev = this.one<{ seed: number }>(
      "SELECT seed FROM ltx WHERE gen = ? AND db = ? AND level = ? AND min_txid = ? AND max_txid = ?",
      p.gen,
      p.db,
      p.level,
      p.minTxid,
      p.maxTxid,
    );
    // A re-put of a recorded key keeps its class and does not move the seed counters.
    const cls = prev
      ? prev.seed
        ? "seed"
        : "other"
      : seedClass(p, bytes, {
          l0Seen: d.l0_seen === 1,
          l0SeedBytes: d.l0_seed_bytes,
          compactSeedBytes: d.compact_seed_bytes,
        });
    // sec F4: level-9 bytes are seed only up to L9_SEED_FACTOR × the DB seed size (+1 MiB) per gen and DB.
    let seed = cls === "seed" ? 1 : 0;
    if (seed && !prev && p.level === 9) {
      const base = Math.max(d.l0_seed_bytes, d.bytes ?? 0);
      if (d.l9_bytes + bytes > L9_SEED_FACTOR * base + 1024 * 1024) seed = 0;
      this.run("UPDATE gendb SET l9_bytes = l9_bytes + ? WHERE gen = ? AND db = ?", bytes, p.gen, p.db);
    }
    // sec F1: chain head = the verified level-0 max. Another level-0 object that starts at or below the head
    // (not a re-put of a recorded key) is a fork: two writers in one gen. Deletes of this gen/db stop.
    const head = d.l0_max_txid ?? 0;
    const fork = p.level === 0 && !prev && head > 0 && p.minTxid <= head;
    if (fork) {
      // Report the lower head: sleep flush and lag then err on "not yet replicated" (sec F3).
      this.run(
        "UPDATE gendb SET fork = 1, l0_max_txid = MIN(l0_max_txid, ?) WHERE gen = ? AND db = ?",
        p.maxTxid,
        p.gen,
        p.db,
      );
      this.alert("replica-fork", "high", `${p.db} g${p.gen}: L0 ${p.minTxid}-${p.maxTxid} at head ${head}`);
    } else if (p.level === 0 && !prev && head > 0 && p.minTxid > head + 1)
      this.alert("replica-chain-gap", "warn", `${p.db} g${p.gen}: L0 ${p.minTxid} after head ${head}`);
    this.run(
      `INSERT INTO ltx (gen, db, level, min_txid, max_txid, bytes, seed, at, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(gen, db, level, min_txid, max_txid) DO UPDATE SET bytes = excluded.bytes, at = excluded.at,
       verified = 1`,
      p.gen,
      p.db,
      p.level,
      p.minTxid,
      p.maxTxid,
      bytes,
      seed,
      at,
    );
    if (!prev) {
      if (p.level === 0 && p.minTxid === 1 && d.l0_seen !== 1)
        this.run(
          "UPDATE gendb SET l0_seen = 1, l0_seed_bytes = ? WHERE gen = ? AND db = ?",
          bytes,
          p.gen,
          p.db,
        );
      if (seed && p.level >= 1 && p.level <= 3)
        this.run(
          "UPDATE gendb SET compact_seed_bytes = compact_seed_bytes + ? WHERE gen = ? AND db = ?",
          bytes,
          p.gen,
          p.db,
        );
    }
    // gendb: l0 max, last write, DB bytes (guess: the newest L9 size, else the seed L0 size), uploaded on L0.
    if (p.level === 0)
      this.run(
        `UPDATE gendb SET l0_max_txid = CASE WHEN ? THEN l0_max_txid ELSE MAX(COALESCE(l0_max_txid, 0), ?) END,
         state = CASE WHEN state = 'pending' THEN 'uploaded' ELSE state END WHERE gen = ? AND db = ?`,
        fork,
        p.maxTxid,
        p.gen,
        p.db,
      );
    if (p.level === 9 || (p.level === 0 && p.minTxid === 1))
      this.run(
        `UPDATE gendb SET bytes = ? WHERE gen = ? AND db = ? AND (? = 9 OR bytes IS NULL)`,
        bytes,
        p.gen,
        p.db,
        p.level,
      );
    this.run(
      "UPDATE gendb SET last_write_at = MAX(COALESCE(last_write_at, 0), ?) WHERE gen = ? AND db = ?",
      at,
      p.gen,
      p.db,
    );
    this.run(
      `INSERT INTO gendb_level (gen, db, level, last_write_at, max_txid, bytes, n) VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(gen, db, level) DO UPDATE SET last_write_at = MAX(last_write_at, excluded.last_write_at),
       max_txid = MAX(max_txid, excluded.max_txid), bytes = bytes + excluded.bytes, n = n + 1`,
      p.gen,
      p.db,
      p.level,
      at,
      p.maxTxid,
      bytes,
    );
    // Budget (§18.6): seed bytes outside the tier counter.
    this.budgetRow(day);
    if (seed) this.run("UPDATE budget_day SET seed_bytes = seed_bytes + ? WHERE day = ?", bytes, day);
    else this.run("UPDATE budget_day SET tier_bytes = tier_bytes + ? WHERE day = ?", bytes, day);
    const sb = this.one<{ seed_bytes: number }>("SELECT seed_bytes FROM budget_day WHERE day = ?", day);
    if (seed && (sb?.seed_bytes ?? 0) > BUDGET.seedHigh * this.scale)
      this.alert("replica-seed-high", "info", `seed bytes ${sb?.seed_bytes} on ${day}`);
    // Gen complete when every boot-set DB is uploaded (§6.2).
    let complete = false;
    const g = this.one<{ state: string }>("SELECT state FROM gens WHERE gen = ?", p.gen);
    if (g?.state === "booting") {
      const c = this.one<{ total: number; up: number }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'uploaded' THEN 1 ELSE 0 END) AS up
         FROM gendb WHERE gen = ? AND in_boot_set = 1`,
        p.gen,
      );
      if (c && c.total > 0 && c.up === c.total) {
        this.run("UPDATE gens SET state = 'complete', complete_at = ? WHERE gen = ?", at, p.gen);
        this.ring("gate", "gen-complete", { gen: p.gen });
        complete = true;
      }
    }
    // A pending or valid marker of this gen is void after any upload recorded at or after its creation
    // (§6.4, §14; uploads are serialized in this DO, so the same ms is later). Pending: guess, see gates report.
    const voided = this.all<{ id: string }>(
      "SELECT id FROM markers WHERE gen = ? AND state IN ('pending', 'valid') AND created_at <= ?",
      p.gen,
      at,
    );
    for (const m of voided) {
      this.run(
        "UPDATE markers SET state = 'void', void_reason = 'late-upload', updated_at = ? WHERE id = ?",
        this.now,
        m.id,
      );
      this.ring("gate", "marker-void", { id: m.id, reason: "late-upload", key: `${p.db}/${p.level}` });
    }
    return { recorded: true, cls: seed || cls !== "seed" ? cls : "other", complete, voided: voided.length };
  }

  private updateTier(day: string): void {
    const b = this.budgetRow(day);
    const { tier } = tierOf(b.replica_reqs, b.tier_bytes, this.scale);
    if (tier === b.tier) return;
    this.run("UPDATE budget_day SET tier = ? WHERE day = ?", tier, day);
    if (rank(tier) > rank(b.tier as Tier)) {
      if (tier === "slow") this.alert("replica-soft", "warn", `reqs ${b.replica_reqs} bytes ${b.tier_bytes}`);
      if (tier === "slower")
        this.alert("replica-hard", "high", `reqs ${b.replica_reqs} bytes ${b.tier_bytes}`);
    }
  }

  /** Bad SigV4 count per gen; above 20 → alert replica-badsig (§18.2). sec F7: the gate batches `n` per isolate. */
  badSig(gen: number, n = 1): { n: number } {
    const k = Math.max(1, Math.min(1_000_000, Math.floor(n) || 1));
    this.run(
      "INSERT INTO gate_badsig (gen, n) VALUES (?, ?) ON CONFLICT(gen) DO UPDATE SET n = n + ?",
      gen,
      k,
      k,
    );
    const t = this.one<{ n: number }>("SELECT n FROM gate_badsig WHERE gen = ?", gen)?.n ?? 0;
    if (t > BADSIG_ALERT) this.alert("replica-badsig", "warn", `gen ${gen}: ${t} bad signatures`);
    return { n: t };
  }

  /**
   * sec F9: heartbeat replay guard. The (gen, seq) pair is the nonce: the gen binds the boot (bootSecret, iid),
   * seq must grow. Same or older seq → fresh:false; the gate then answers without applying the heartbeat.
   */
  hbSeq(gen: number, seq: number): { fresh: boolean; last: number | null } {
    return this.tx(() => {
      const r = this.one<{ seq: number }>("SELECT seq FROM gate_hbseq WHERE gen = ?", gen);
      if (r && seq <= r.seq) {
        this.ring("gate", "hb-replay", { gen, seq, last: r.seq });
        return { fresh: false, last: r.seq };
      }
      this.run(
        `INSERT INTO gate_hbseq (gen, seq, at) VALUES (?, ?, ?)
         ON CONFLICT(gen) DO UPDATE SET seq = excluded.seq, at = excluded.at`,
        gen,
        seq,
        this.now,
      );
      return { fresh: true, last: r?.seq ?? null };
    });
  }

  /**
   * spec §18.5: a delete of an LTX key in the current gen is allowed only when a recorded key of the same
   * gen and DB covers it (same or higher level, min ≤ key.min, max ≥ key.max, not the key itself).
   * sec F1: the covering record must be one the gate verified from the written bytes (`verified = 1`), its
   * max must not pass the verified level-0 chain head, and the gen/db must have no fork. Uploader-written key
   * names alone never cover anything.
   */
  deleteCheck(gen: number, keys: string[]): { allow: boolean[] } {
    const allow = keys.map((k) => {
      const p = parseLtxKey(k);
      if (!p || p.gen !== gen) return false;
      const d = this.one<{ l0_max_txid: number | null; fork: number }>(
        "SELECT l0_max_txid, fork FROM gendb WHERE gen = ? AND db = ?",
        gen,
        p.db,
      );
      if (!d || d.fork || !d.l0_max_txid) return false;
      return !!this.one(
        `SELECT 1 FROM ltx WHERE gen = ? AND db = ? AND verified = 1 AND level >= ? AND min_txid <= ?
         AND max_txid >= ? AND max_txid <= ? AND NOT (level = ? AND min_txid = ? AND max_txid = ?) LIMIT 1`,
        gen,
        p.db,
        p.level,
        p.minTxid,
        p.maxTxid,
        d.l0_max_txid,
        p.level,
        p.minTxid,
        p.maxTxid,
      );
    });
    const refused = keys.filter((_, i) => !allow[i]);
    if (refused.length)
      this.alert(
        "replica-delete-refused",
        "warn",
        `${refused.length} key(s): ${refused.slice(0, 3).join(" ")}`,
      );
    return { allow };
  }

  /** After R2 deleted allowed keys: drop their ltx rows, count (§3.2, §18.6). */
  deleteDone(gen: number, keys: string[]): void {
    this.tx(() => {
      const day = dayOf(this.now);
      this.budgetRow(day);
      for (const k of keys) {
        const p = parseLtxKey(k);
        if (!p || p.gen !== gen) continue;
        this.run(
          "DELETE FROM ltx WHERE gen = ? AND db = ? AND level = ? AND min_txid = ? AND max_txid = ?",
          gen,
          p.db,
          p.level,
          p.minTxid,
          p.maxTxid,
        );
      }
      this.run("UPDATE budget_day SET replica_deletes = replica_deletes + ? WHERE day = ?", keys.length, day);
    });
  }

  replicaDay(): { day: string; classA: number; classB: number; free: number; refused: number } {
    const day = dayOf(this.now);
    const r = this.one<{ class_a: number; class_b: number; free: number; refused: number }>(
      "SELECT class_a, class_b, free, refused FROM replica_day WHERE day = ?",
      day,
    );
    return {
      day,
      classA: r?.class_a ?? 0,
      classB: r?.class_b ?? 0,
      free: r?.free ?? 0,
      refused: r?.refused ?? 0,
    };
  }

  // ---------- heartbeat, events ----------

  heartbeatInfo(gen: number): {
    tier: Tier;
    replica: ReturnType<GateLedger["replicaState"]>;
    import?: ReturnType<typeof ackOf>;
  } {
    const imp = this.importTake(gen);
    return { tier: this.budget().tier, replica: this.replicaState(gen), ...(imp ? { import: imp } : {}) };
  }

  // ---------- ochost import (gates/import-policy.ts) ----------

  /** The open import request for this prod gen, once per take (the ack carries it); null otherwise. */
  private importTake(gen: number): ReturnType<typeof ackOf> | null {
    const r = this.metaGet<ImportRequest | null>(IMPORT_META, null);
    if (!r || (r.state !== "pending" && r.state !== "running")) return null;
    const mode = this.one<{ mode: string }>("SELECT mode FROM gens WHERE gen = ?", gen)?.mode;
    if (mode !== "prod") return null;
    const t = takeForHeartbeat(r, gen, this.now);
    if (!t) return null;
    this.metaSet(IMPORT_META, t.next);
    this.ring("import", "taken", { id: r.id, gen, tries: t.next.tries });
    return ackOf(t.give);
  }
  /** GET /v1/import/bundle: the key and digest of the open request with this id, or null. */
  importFacts(id: string): { key: string; sha256: string; bytes: number } | null {
    const r = this.metaGet<ImportRequest | null>(IMPORT_META, null);
    if (!importIdOk(id) || !r || r.id !== id || (r.state !== "pending" && r.state !== "running")) return null;
    return { key: importBundleKey(this.o.inst, id), sha256: r.sha256, bytes: r.bytes };
  }
  /** POST /v1/import/done: ocsup's outcome. A later answer for a closed request is ignored. */
  importDone(
    gen: number,
    a: { id: string; ok: boolean; why?: string; result?: unknown },
  ): { ok: boolean; why?: string } {
    const r = this.metaGet<ImportRequest | null>(IMPORT_META, null);
    if (!r || r.id !== a.id) return { ok: false, why: "no-request" };
    if (r.state === "done" || r.state === "failed") return { ok: true, why: "closed" };
    const next: ImportRequest = {
      ...r,
      state: a.ok ? "done" : "failed",
      doneAt: this.now,
      ...(a.why ? { why: String(a.why).slice(0, 500) } : {}),
      result: a.result ?? null,
    };
    this.metaSet(IMPORT_META, next);
    this.ring("import", a.ok ? "done" : "failed", { id: a.id, gen, why: a.why ?? null });
    if (!a.ok) this.alert("import-failed", "warn", `import ${a.id}: ${String(a.why ?? "").slice(0, 300)}`);
    return { ok: true };
  }
  /** Owner upload under f/<inst>/ (ochost import): the per-object and per-install caps, no gen needed. */
  importFilePre(a: { key: string; bytes: number }): {
    refuse?: { status: number; code: string; message: string };
  } {
    const { cap, objectMax } = this.filesLimits;
    if (a.bytes > objectMax)
      return {
        refuse: {
          status: 400,
          code: "EntityTooLarge",
          message: `object ${a.bytes} bytes is above files.maxObjectMb (${objectMax} bytes)`,
        },
      };
    const old = this.one<{ bytes: number }>("SELECT bytes FROM files_obj WHERE key = ?", a.key)?.bytes ?? 0;
    const used = this.filesUsed().used;
    if (used - old + a.bytes > cap)
      return {
        refuse: {
          status: 403,
          code: "StorageCapExceeded",
          message: `files.capGb reached: ${used} of ${cap} bytes used; this object needs ${a.bytes}`,
        },
      };
    return {};
  }

  /** Control-side event hooks (spec §17.2): ring; `seeded` → gendb.seeded_at; `replica-set` → boot set. */
  event(
    gen: number,
    body: {
      kind: string;
      detail?: unknown;
      reason?: string | null;
      code?: number | null;
      out?: string | null;
    },
  ): void {
    this.tx(() => {
      this.ring("ocsup", body.kind, {
        gen,
        reason: body.reason,
        code: body.code,
        detail: body.detail,
        ...(typeof body.out === "string" && body.out ? { out: body.out.slice(-2048) } : {}),
      });
      if (body.kind === "seeded")
        this.run(
          "UPDATE gendb SET seeded_at = ? WHERE gen = ? AND l0_seen = 1 AND seeded_at IS NULL",
          this.now,
          gen,
        );
      if (body.kind === "replica-set") {
        const dbs = (body.detail as { dbs?: unknown } | undefined)?.dbs;
        const g = this.one<{ state: string }>("SELECT state FROM gens WHERE gen = ?", gen);
        if (Array.isArray(dbs) && g?.state === "booting")
          for (const db of dbs.filter((x): x is string => typeof x === "string").slice(0, 32))
            this.run(
              `INSERT INTO gendb (gen, db, in_boot_set, state) VALUES (?, ?, 1, 'pending')
               ON CONFLICT(gen, db) DO UPDATE SET in_boot_set = 1`,
              gen,
              db,
            );
      }
    });
  }

  // ---------- logs ----------

  /** /v1/log: reserve an R2 segment key or refuse at the daily cap (amend §2 row 24). */
  logReserve(
    gen: number,
    bytes: number,
    tail: string[],
  ): { ok: true; key: string } | { ok: false; capped: true } {
    return this.tx(() => {
      const day = dayOf(this.now);
      this.run("INSERT INTO budget_day (day) VALUES (?) ON CONFLICT(day) DO NOTHING", day);
      const b = this.one<{ log_bytes: number }>("SELECT log_bytes FROM budget_day WHERE day = ?", day);
      if ((b?.log_bytes ?? 0) + bytes > LOG_CAP_BYTES) {
        const a = this.one<{ last_sent_at: number | null }>(
          "SELECT last_sent_at FROM alerts WHERE class = 'log-cap'",
        );
        if (!a?.last_sent_at || dayOf(a.last_sent_at) !== day)
          this.alert("log-cap", "warn", `log bytes cap on ${day}`);
        return { ok: false as const, capped: true as const };
      }
      this.run("UPDATE budget_day SET log_bytes = log_bytes + ? WHERE day = ?", bytes, day);
      this.run(
        "INSERT INTO log_seq (gen, seq) VALUES (?, 1) ON CONFLICT(gen) DO UPDATE SET seq = seq + 1",
        gen,
      );
      const seq = this.one<{ seq: number }>("SELECT seq FROM log_seq WHERE gen = ?", gen)?.seq ?? 1;
      for (const line of tail.slice(-RING_MAX)) this.ring("log", "line", line.slice(0, 1000));
      return { ok: true as const, key: `l/${this.o.inst}/${day}/${gen}-${seq}.ndjson` };
    });
  }

  // ---------- creds (CredStore, plan §6.1 row 2) ----------

  credsManifest(): {
    seq: number;
    files: { path: string; seq: number; sha256: string; mode: number; deleted: boolean; size: number }[];
  } {
    const rows = this.all<{
      path: string;
      seq: number;
      sha256: string | null;
      mode: number | null;
      b64: string | null;
      deleted: number;
    }>(
      "SELECT path, seq, sha256, mode, b64, deleted FROM creds WHERE path NOT LIKE 'adopted/%' ORDER BY path",
    );
    const seq = this.all<{ m: number | null }>("SELECT MAX(seq) AS m FROM creds")[0]?.m ?? 0;
    return {
      seq,
      files: rows.map((r) => ({
        path: r.path,
        seq: r.seq,
        sha256: r.sha256 ?? "0".repeat(64),
        mode: r.mode ?? 0o600,
        deleted: r.deleted === 1,
        size: r.b64 ? b64len(r.b64) : 0,
      })),
    };
  }

  credsGet(path: string): {
    path: string;
    seq: number;
    sha256: string;
    mode: number;
    b64: string | null;
    r2Key: string | null;
    deleted: boolean;
  } | null {
    const r = this.one<{
      seq: number;
      sha256: string | null;
      mode: number | null;
      b64: string | null;
      r2_key: string | null;
      deleted: number;
    }>("SELECT seq, sha256, mode, b64, r2_key, deleted FROM creds WHERE path = ?", path);
    // adopted/* rows are Worker-side secrets (ctl/adopt.ts): the container never restores them from the store.
    if (!r || path.startsWith("adopted/")) return null;
    return {
      path,
      seq: r.seq,
      sha256: r.sha256 ?? "",
      mode: r.mode ?? 0o600,
      b64: r.b64,
      r2Key: r.r2_key,
      deleted: r.deleted === 1,
    };
  }

  /** PUT accepted when (gen, seq) is newer than the stored one for the path. Older → ok, applied:false. */
  credsPut(
    gen: number,
    path: string,
    v: { seq: number; sha256: string; mode: number; b64: string | null; r2Key?: string | null },
    fence = false,
  ): { ok: true; applied: boolean } | { ok: false; error: "ctl-full" | "creds-cap" | "stale" } {
    return this.tx(() => {
      const now = this.now;
      if (fence && !this.genLive(gen)) return { ok: false as const, error: "stale" as const };
      const cur = this.one<{ gen: number | null; seq: number; sha256: string | null }>(
        "SELECT gen, seq, sha256 FROM creds WHERE path = ?",
        path,
      );
      if (cur && !newer(gen, v.seq, cur.gen ?? 0, cur.seq)) return { ok: true as const, applied: false };
      if (this.full("creds")) return { ok: false as const, error: "ctl-full" as const };
      if (!cur && this.credsFull()) {
        this.alert(
          "ctl-prune",
          "warn",
          `creds: ${CAPS.credPaths} paths, new path refused: ${path.slice(0, 200)}`,
        );
        return { ok: false as const, error: "creds-cap" as const };
      }
      this.run(
        `INSERT INTO creds (path, gen, seq, sha256, mode, b64, r2_key, deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(path) DO UPDATE SET gen = excluded.gen, seq = excluded.seq, sha256 = excluded.sha256,
         mode = excluded.mode, b64 = excluded.b64, r2_key = excluded.r2_key, deleted = 0, updated_at = excluded.updated_at`,
        path,
        gen,
        v.seq,
        v.sha256,
        v.mode,
        v.b64,
        v.r2Key ?? null,
        now,
      );
      this.hist(path, gen, v.seq, v.sha256, v.mode, v.b64, v.r2Key ?? null, 0, now);
      if (cur?.sha256 === v.sha256 && path.endsWith("creds.json"))
        this.alert("creds-repeat", "info", `${path} same sha256 again`);
      return { ok: true as const, applied: true };
    });
  }

  credsDelete(
    gen: number,
    path: string,
    seq: number,
    fence = false,
  ): { ok: true; applied: boolean; burst: boolean } | { ok: false; error: "stale" } {
    return this.tx(() => {
      const now = this.now;
      if (fence && !this.genLive(gen)) return { ok: false as const, error: "stale" as const };
      this.run("INSERT INTO cred_del_log (at) VALUES (?)", now);
      this.run("DELETE FROM cred_del_log WHERE at < ?", now - 60_000);
      const n = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM cred_del_log")?.n ?? 0;
      const burst = n > CREDS_BURST;
      if (burst) this.alert("creds-burst", "warn", `${n} credential deletes in 1 min`);
      const cur = this.one<{ gen: number | null; seq: number; sha256: string | null; mode: number | null }>(
        "SELECT gen, seq, sha256, mode FROM creds WHERE path = ?",
        path,
      );
      if (cur && !newer(gen, seq, cur.gen ?? 0, cur.seq)) return { ok: true as const, applied: false, burst };
      // sec F2: a tombstone for a never-stored path is a new row; none past the path cap.
      if (!cur && this.credsFull()) return { ok: true as const, applied: false, burst };
      this.run(
        `INSERT INTO creds (path, gen, seq, sha256, mode, b64, r2_key, deleted, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?)
         ON CONFLICT(path) DO UPDATE SET gen = excluded.gen, seq = excluded.seq, b64 = NULL, r2_key = NULL,
         deleted = 1, updated_at = excluded.updated_at`,
        path,
        gen,
        seq,
        cur?.sha256 ?? null,
        cur?.mode ?? null,
        now,
      );
      this.hist(path, gen, seq, cur?.sha256 ?? null, cur?.mode ?? null, null, null, 1, now);
      return { ok: true as const, applied: true, burst };
    });
  }

  /**
   * L4 (M4 loss): a creds write from ControlGate (`fence`) is fenced in its own transaction, not by the gate's 5 s current-gen cache. A gen
   * with no row (wiped or rewound Control DO), abandoned or deleted, or with a newer gen is refused.
   */
  private genLive(gen: number): boolean {
    const g = this.one<{ state: string }>("SELECT state FROM gens WHERE gen = ?", gen);
    if (!g || g.state === "abandoned" || g.state === "deleted") return false;
    return (this.one<{ m: number }>("SELECT MAX(gen) AS m FROM gens")?.m ?? gen) <= gen;
  }

  /**
   * N6: the path cap counts live paths; tombstones do not (Baileys pre-key churn). Rows of any kind stay under
   * 2 × cap so tombstones cannot grow storage without bound.
   */
  private credsFull(): boolean {
    const count = () =>
      this.one<{ live: number; total: number }>(
        "SELECT SUM(CASE WHEN deleted = 0 THEN 1 ELSE 0 END) AS live, COUNT(*) AS total FROM creds",
      );
    let r = count();
    if ((r?.live ?? 0) >= CAPS.credPaths) return true;
    if ((r?.total ?? 0) >= 2 * CAPS.credPaths) {
      // Baileys names each pre-key and session file once, so tombstones only grow. Drop the oldest ones past
      // TOMBSTONE_KEEP_MS (their history stays in creds_hist); a burst of fresh tombstones still hits the cap.
      this.run(
        `DELETE FROM creds WHERE path IN (SELECT path FROM creds WHERE deleted = 1 AND updated_at < ?
         ORDER BY updated_at LIMIT ?)`,
        this.now - TOMBSTONE_KEEP_MS,
        CAPS.credPaths,
      );
      r = count();
    }
    return (r?.total ?? 0) >= 2 * CAPS.credPaths;
  }

  private hist(
    path: string,
    gen: number,
    seq: number,
    sha: string | null,
    mode: number | null,
    b64: string | null,
    r2Key: string | null,
    deleted: number,
    now: number,
  ): void {
    this.run(
      `INSERT INTO creds_hist (path, seq, gen, sha256, mode, b64, r2_key, deleted, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path, seq) DO UPDATE SET gen = excluded.gen, sha256 = excluded.sha256, mode = excluded.mode,
       b64 = excluded.b64, r2_key = excluded.r2_key, deleted = excluded.deleted, at = excluded.at`,
      path,
      seq,
      gen,
      sha,
      mode,
      b64,
      r2Key,
      deleted,
      now,
    );
    this.pruneCredsHist(path, now);
  }

  /**
   * sec F2: creds_hist keeps the newest CAPS.credsHistPerPath versions per path, and drops versions older than
   * CAPS.credsHistDays except the newest one. Then a global cap on inline bytes drops the oldest history rows.
   * The old rule (`at < 30 d AND seq NOT IN newest 50`) kept every version younger than 30 d (A9).
   */
  private pruneCredsHist(path: string, now: number): void {
    const capN = this.del(
      `creds_hist WHERE path = ? AND seq NOT IN
       (SELECT seq FROM creds_hist WHERE path = ? ORDER BY seq DESC LIMIT ${CAPS.credsHistPerPath})`,
      path,
      path,
    );
    this.pruned("creds_hist", capN, `newest ${CAPS.credsHistPerPath} per path`);
    this.del(
      `creds_hist WHERE path = ? AND at < ? AND seq <> (SELECT MAX(seq) FROM creds_hist WHERE path = ?)`,
      path,
      now - CAPS.credsHistDays * 86_400_000,
      path,
    );
    let total =
      this.one<{ b: number | null }>(
        "SELECT (SELECT COALESCE(SUM(LENGTH(b64)), 0) FROM creds) + (SELECT COALESCE(SUM(LENGTH(b64)), 0) FROM creds_hist) AS b",
      )?.b ?? 0;
    let n = 0;
    while (total > CAPS.credBytes) {
      const old = this.one<{ path: string; seq: number; b: number }>(
        "SELECT path, seq, LENGTH(b64) AS b FROM creds_hist WHERE b64 IS NOT NULL ORDER BY at ASC LIMIT 1",
      );
      if (!old) break;
      this.run("DELETE FROM creds_hist WHERE path = ? AND seq = ?", old.path, old.seq);
      total -= old.b;
      n++;
    }
    this.pruned("creds_hist", n, `inline bytes > ${CAPS.credBytes}`);
  }

  // ---------- config and plugins ----------

  configGet(ver: number): { ver: number; schemaSha?: string; doc: unknown } | null {
    const r = this.one<{ ver: number; schema_sha: string | null; doc: string }>(
      "SELECT ver, schema_sha, doc FROM config WHERE ver = ?",
      ver,
    );
    if (!r) return null;
    return { ver: r.ver, ...(r.schema_sha ? { schemaSha: r.schema_sha } : {}), doc: JSON.parse(r.doc) };
  }

  /** PUT /v1/config/proposal → candidate row (spec §17.2). */
  configPropose(
    gen: number,
    p: {
      source: string;
      sha: string;
      schemaSha?: string;
      darkOrigin?: boolean;
      baseVer?: number;
      doc: unknown;
    },
  ):
    | { ok: true; ver: number; sensitive: string[]; dup?: boolean; held?: boolean }
    | { ok: false; error: "webhook-transport" | "ctl-full"; detail: string } {
    return this.tx(() => {
      const bad = webhookTransport(p.doc);
      if (bad) {
        this.alert("config-webhook-refused", "warn", bad);
        return { ok: false as const, error: "webhook-transport" as const, detail: bad };
      }
      const dup = this.one<{ ver: number }>(
        "SELECT ver FROM config WHERE sha = ? ORDER BY ver DESC LIMIT 1",
        p.sha,
      );
      if (dup) return { ok: true as const, ver: dup.ver, sensitive: [], dup: true };
      if (this.full("config")) return { ok: false as const, error: "ctl-full" as const, detail: "storage" };
      // Channel adoption: a credential in clear in a UI config is held, never offered to a boot. The owner adopts
      // it (POST /ops/channels/adopt) or removes it; the gateway keeps the last good config.
      const why = heldReason(p.doc);
      if (why) {
        const hv = (this.one<{ m: number | null }>("SELECT MAX(ver) AS m FROM config")?.m ?? 0) + 1;
        this.run(
          `INSERT INTO config (ver, schema_sha, status, source, sha, dark_origin, base_ver, doc, created_at)
           VALUES (?, ?, 'held', ?, ?, 0, ?, ?, ?)`,
          hv,
          p.schemaSha ?? null,
          p.source,
          p.sha,
          p.baseVer ?? null,
          JSON.stringify(p.doc),
          this.now,
        );
        this.ring("gate", "config-held", { gen, ver: hv, source: p.source, reason: why });
        return { ok: true as const, ver: hv, sensitive: [], held: true };
      }
      const base =
        (p.baseVer !== undefined
          ? this.one<{ doc: string }>("SELECT doc FROM config WHERE ver = ?", p.baseVer)
          : null) ??
        this.one<{ doc: string }>("SELECT doc FROM config WHERE status <> 'held' ORDER BY ver DESC LIMIT 1");
      const sensitive = sensitiveChanges(base ? JSON.parse(base.doc) : {}, p.doc);
      const ver = (this.one<{ m: number | null }>("SELECT MAX(ver) AS m FROM config")?.m ?? 0) + 1;
      this.run(
        `INSERT INTO config (ver, schema_sha, status, source, sha, dark_origin, base_ver, doc, created_at)
         VALUES (?, ?, 'candidate', ?, ?, ?, ?, ?, ?)`,
        ver,
        p.schemaSha ?? null,
        p.source,
        p.sha,
        p.darkOrigin ? 1 : 0,
        p.baseVer ?? null,
        JSON.stringify(p.doc),
        this.now,
      );
      this.pruned("config", pruneConfigRows(this.store), `newest ${CAPS.configRows}`);
      this.ring("gate", "config-proposal", { gen, ver, source: p.source, sensitive });
      // Doctor is the gateway's own repair at boot, not a UI session: its changes are in the ring row only.
      if (sensitive.length && p.source !== "doctor")
        this.alert("config-sensitive", "warn", sensitive.join(","));
      return { ok: true as const, ver, sensitive };
    });
  }

  pluginsGet(): { ver: number; plugins: unknown[] } {
    const r = this.one<{ ver: number; manifest: string }>(
      "SELECT ver, manifest FROM plugins ORDER BY ver DESC LIMIT 1",
    );
    if (!r) return { ver: 0, plugins: [] };
    const m = JSON.parse(r.manifest) as { plugins?: unknown[] };
    return { ver: r.ver, plugins: Array.isArray(m.plugins) ? m.plugins : [] };
  }

  pluginsPut(
    gen: number,
    manifest: { plugins?: unknown[] },
  ): { ok: true; ver: number; changed: boolean } | { ok: false; error: "ctl-full" } {
    return this.tx(() => {
      const plugins = Array.isArray(manifest?.plugins) ? manifest.plugins : [];
      const cur = this.pluginsGet();
      if (canon(cur.plugins) === canon(plugins)) return { ok: true as const, ver: cur.ver, changed: false };
      if (this.full("plugins")) return { ok: false as const, error: "ctl-full" as const };
      const ver = cur.ver + 1;
      this.run(
        "INSERT INTO plugins (ver, manifest, created_at) VALUES (?, ?, ?)",
        ver,
        JSON.stringify({ plugins }),
        this.now,
      );
      this.alert("plugins-changed", "info", `ver ${ver} from gen ${gen}: ${plugins.length} plugin(s)`);
      this.pruned(
        "plugins",
        pruneRowsByVer(this.store, "plugins", CAPS.pluginRows),
        `newest ${CAPS.pluginRows}`,
      );
      return { ok: true as const, ver, changed: true };
    });
  }

  wakeAllow(v: { userIds: string[]; groupChatIds: string[]; configVer?: number }): { ok: true } {
    this.run(
      `INSERT INTO wake_allow (id, user_ids, group_chat_ids, config_ver, exported_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET user_ids = excluded.user_ids, group_chat_ids = excluded.group_chat_ids,
       config_ver = excluded.config_ver, exported_at = excluded.exported_at`,
      JSON.stringify(v.userIds),
      JSON.stringify(v.groupChatIds),
      v.configVer ?? null,
      this.now,
    );
    return { ok: true };
  }

  // ---------- archives (R2 multipart under a/<inst>/, hashed in order) ----------

  /**
   * Start an archive (spec §17.2). M4 rules (archive-policy.ts): a cadence poll (`reason` 6h/due/maint) gets
   * `fresh` unless an archive is due; a pending owner/pre-upgrade request is served by the next start of any
   * reason; one open archive per gen (`busy`); no start while the Runtime DO quiesces, drains or stops; day cap.
   * Open rows of an older gen or older than openMaxMs are aborted here (their container is gone); the gate
   * aborts the R2 uploads it gets back in `abortUploads`. Digest, version and schemas come from the gen and
   * image records when ocsup does not send them (A6: keys were `…-unknown-000000000000`).
   */
  archiveStart(
    gen: number,
    kind: string,
    manifest: Record<string, unknown> | undefined,
  ):
    | {
        ok: true;
        archiveId: string;
        key: string;
        reason: string;
        abortUploads: { key: string; uploadId: string }[];
      }
    | {
        ok: false;
        error: "cap" | "fresh" | "busy";
        why?: string;
        abortUploads: { key: string; uploadId: string }[];
      } {
    return this.tx(() => {
      const now = this.now;
      const cfg = this.archiveCfg;
      this.metaSet("archiveAttemptAt", now);
      this.metaSet("archiveAttemptGen", gen);
      const abortUploads: { key: string; uploadId: string }[] = [];
      for (const o of this.all<{ id: string; key: string; upload_id: string | null }>(
        "SELECT id, key, upload_id FROM archives WHERE state = 'open' AND (gen IS NOT ? OR created_at < ?)",
        gen,
        now - cfg.openMaxMs,
      )) {
        if (o.upload_id) abortUploads.push({ key: o.key, uploadId: o.upload_id });
        this.archiveFinish(o.id, false, { why: "stale-open" });
      }
      // Read after the stale-open aborts (one may send a running request back to pending).
      const req = this.metaGet<ArchiveRequest | null>("archiveRequest", null);
      const reqLive = req && (req.state === "pending" || req.state === "running") ? req : null;
      // A refused start is the last step of a pending request (the stall alert names it), not progress.
      const refuse = <E extends "busy" | "fresh" | "cap">(error: E, why?: string) => {
        if (reqLive?.state === "pending")
          this.metaSet("archiveRequest", {
            ...reqLive,
            step: `start refused: ${error}${why ? ` ${why}` : ""}`,
          });
        return { ok: false as const, error, ...(why ? { why } : {}), abortUploads };
      };
      if (this.one("SELECT id FROM archives WHERE state = 'open' AND gen = ? LIMIT 1", gen))
        return refuse("busy", "open");
      const rt = this.metaGet<string | null>("rtState", null);
      if (rt && ["quiescing", "draining", "stopping", "asleep", "asleep-unconfirmed"].includes(rt))
        return refuse("busy", `rt ${rt}`);
      const asked = String(manifest?.reason ?? "ctl").slice(0, 32);
      const reason = reqLive ? reqLive.reason : asked;
      if (!reqLive && CADENCE_REASONS.has(asked)) {
        const d = archiveDue(this.q, now, cfg);
        if (!d.due) return refuse("fresh", d.why);
      }
      const day = dayOf(now);
      this.run("INSERT INTO budget_day (day) VALUES (?) ON CONFLICT(day) DO NOTHING", day);
      const n =
        this.one<{ archives: number }>("SELECT archives FROM budget_day WHERE day = ?", day)?.archives ?? 0;
      // Owner/upgrade requests keep FORCED_EXTRA_PER_DAY starts after the cadence used its share.
      const cap = dayCap(cfg, !!reqLive || FORCED_REASONS.has(asked));
      if (n >= cap) return refuse("cap", `${n}/${cap} today`);
      const ts = new Date(now)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "Z");
      const g = this.one<{ digest: string | null; image_key: string | null }>(
        "SELECT digest, image_key FROM gens WHERE gen = ?",
        gen,
      );
      const digest =
        typeof manifest?.digest === "string" && /^sha256:[0-9a-f]{12,64}$/.test(manifest.digest)
          ? manifest.digest
          : g?.digest && g.digest !== "unknown"
            ? g.digest
            : null;
      const img = digest ? this.metaGet<Record<string, unknown>>(`image:${digest}`, {}) : {};
      const ver = String(
        manifest?.version ?? manifest?.openclawVersion ?? img.version ?? g?.image_key ?? "unknown",
      )
        .replace(/[^A-Za-z0-9._-]/g, "_")
        .slice(0, 40);
      const d12 =
        String(digest ?? "")
          .replace(/^sha256:/, "")
          .replace(/[^0-9a-f]/g, "")
          .slice(0, 12) || "000000000000";
      const id = `${ts}-${rand(8)}`;
      const key = `a/${this.o.inst}/${ts}-${ver}-${d12}.tar.gz`;
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null);
      const ws = (manifest?.workspace ?? null) as { entries?: unknown; missing?: unknown } | null;
      const src = this.one<{ m: number | null }>("SELECT MAX(last_write_at) AS m FROM gendb")?.m ?? null;
      this.run(
        `INSERT INTO archives (id, key, kind, state, version, digest, gen, created_at, reason, request_id, src_write_at,
           ws_entries, ws_missing, state_schema, agent_schema)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        key,
        kind,
        ver,
        digest,
        gen,
        now,
        reason,
        reqLive?.id ?? null,
        src,
        num(ws?.entries),
        num(ws?.missing),
        num(img.stateSchema),
        num(img.agentSchema),
      );
      if (reqLive)
        this.metaSet("archiveRequest", {
          ...reqLive,
          state: "running",
          archiveId: id,
          step: "started",
          progressAt: now,
        });
      this.run(
        "INSERT INTO archive_hash (id, next_n, state, prev_state, bytes, parts) VALUES (?, 1, ?, NULL, 0, '[]')",
        id,
        JSON.stringify(shaInit()),
      );
      this.run("UPDATE budget_day SET archives = archives + 1 WHERE day = ?", day);
      this.ring("gate", "archive-start", { id, kind, reason, gen });
      return { ok: true as const, archiveId: id, key, reason, abortUploads };
    });
  }

  archiveOpened(id: string, uploadId: string, key: string): void {
    this.run("UPDATE archives SET upload_id = ? WHERE id = ?", uploadId, id);
    this.run(
      "INSERT INTO multipart (upload_id, key, kind, created_at) VALUES (?, ?, 'archive', ?) ON CONFLICT DO NOTHING",
      uploadId,
      key,
      this.now,
    );
  }

  /**
   * Before part n: parts must come in order (n = next) or repeat the last one (n = next − 1, a retry).
   * Size cap: total ≤ 2 × the last complete archive + 1 GiB.
   */
  archivePartBegin(
    id: string,
    n: number,
    size: number,
  ):
    | { ok: true; key: string; uploadId: string; state: string; retry: boolean }
    | { ok: false; status: number; error: string } {
    const a = this.one<{ key: string; state: string; upload_id: string | null }>(
      "SELECT key, state, upload_id FROM archives WHERE id = ?",
      id,
    );
    if (!a) return { ok: false, status: 404, error: "no-archive" };
    if (a.state !== "open" || !a.upload_id) return { ok: false, status: 409, error: `archive-${a.state}` };
    const h = this.one<{
      next_n: number;
      state: string;
      prev_state: string | null;
      bytes: number;
      prev_bytes: number;
    }>("SELECT next_n, state, prev_state, bytes, prev_bytes FROM archive_hash WHERE id = ?", id);
    if (!h) return { ok: false, status: 409, error: "no-hash-state" };
    const retry = n === h.next_n - 1 && h.prev_state !== null;
    if (n !== h.next_n && !retry) return { ok: false, status: 409, error: `part-order: want ${h.next_n}` };
    const last = this.one<{ size: number | null }>(
      "SELECT size FROM archives WHERE state = 'complete' ORDER BY completed_at DESC LIMIT 1",
    );
    const cap = 2 * (last?.size ?? 0) + GiB;
    const before = retry ? h.prev_bytes : h.bytes;
    if (before + size > cap) return { ok: false, status: 413, error: "archive-size-cap" };
    return {
      ok: true,
      key: a.key,
      uploadId: a.upload_id,
      state: (retry ? h.prev_state : h.state) as string,
      retry,
    };
  }

  archivePartDone(id: string, n: number, state: string, etag: string, size: number): void {
    this.tx(() => {
      const h = this.one<{ next_n: number; state: string; bytes: number; parts: string }>(
        "SELECT next_n, state, bytes, parts FROM archive_hash WHERE id = ?",
        id,
      );
      if (!h) return;
      const parts = (JSON.parse(h.parts) as { partNumber: number; etag: string }[]).filter(
        (p) => p.partNumber !== n,
      );
      parts.push({ partNumber: n, etag });
      const req = this.metaGet<ArchiveRequest | null>("archiveRequest", null);
      if (req?.state === "running" && req.archiveId === id)
        this.metaSet("archiveRequest", { ...req, step: `part ${n}`, progressAt: this.now });
      if (n === h.next_n)
        this.run(
          `UPDATE archive_hash SET prev_state = state, prev_bytes = bytes, state = ?, bytes = bytes + ?,
           next_n = next_n + 1, parts = ? WHERE id = ?`,
          state,
          size,
          JSON.stringify(parts),
          id,
        );
      else
        this.run(
          "UPDATE archive_hash SET state = ?, bytes = prev_bytes + ?, parts = ? WHERE id = ?",
          state,
          size,
          JSON.stringify(parts),
          id,
        );
    });
  }

  archiveCompleteBegin(id: string):
    | {
        ok: true;
        key: string;
        uploadId: string;
        state: string;
        bytes: number;
        parts: { partNumber: number; etag: string }[];
      }
    | { ok: false; status: number; error: string } {
    const a = this.one<{ key: string; state: string; upload_id: string | null }>(
      "SELECT key, state, upload_id FROM archives WHERE id = ?",
      id,
    );
    if (!a) return { ok: false, status: 404, error: "no-archive" };
    if (a.state !== "open" || !a.upload_id) return { ok: false, status: 409, error: `archive-${a.state}` };
    const h = this.one<{ state: string; bytes: number; parts: string }>(
      "SELECT state, bytes, parts FROM archive_hash WHERE id = ?",
      id,
    );
    if (!h) return { ok: false, status: 409, error: "no-hash-state" };
    return {
      ok: true,
      key: a.key,
      uploadId: a.upload_id,
      state: h.state,
      bytes: h.bytes,
      parts: (JSON.parse(h.parts) as { partNumber: number; etag: string }[]).sort(
        (x, y) => x.partNumber - y.partNumber,
      ),
    };
  }

  archiveFinish(
    id: string,
    ok: boolean,
    v: { sha256?: string; size?: number; parts?: number; why?: string },
  ): void {
    this.tx(() => {
      const a = this.one<{ upload_id: string | null; kind: string }>(
        "SELECT upload_id, kind FROM archives WHERE id = ?",
        id,
      );
      this.run(
        `UPDATE archives SET state = ?, sha256 = ?, size = ?, parts = ?, completed_at = ? WHERE id = ? AND state = 'open'`,
        ok ? "complete" : "aborted",
        v.sha256 ?? null,
        v.size ?? null,
        v.parts ?? null,
        this.now,
        id,
      );
      if (a?.upload_id) this.run("DELETE FROM multipart WHERE upload_id = ?", a.upload_id);
      this.run("DELETE FROM archive_hash WHERE id = ?", id);
      // An owner/pre-upgrade request ends with its archive: done on complete (also after a stall mark), back to
      // pending on a failure (the next start serves it again until it stalls or requestHoldMs passes).
      // An archive landed: not stalled, and an earlier failure is over.
      if (ok) this.run("UPDATE alerts SET open = 0 WHERE class IN ('archive-stalled', 'archive-failed')");
      const req = this.metaGet<ArchiveRequest | null>("archiveRequest", null);
      if (req && req.archiveId === id && (req.state === "running" || (ok && req.state === "failed")))
        this.metaSet(
          "archiveRequest",
          ok
            ? { ...req, state: "done", doneAt: this.now, step: "complete", why: null }
            : {
                ...req,
                state: "pending",
                archiveId: null,
                why: v.why ?? "aborted",
                step: `aborted: ${v.why ?? "aborted"}`.slice(0, 200),
              },
        );
      this.ring("gate", ok ? "archive-complete" : "archive-aborted", { id, kind: a?.kind, ...v });
    });
  }

  /**
   * Read-back result for a complete archive (verify-on-restore at `GET /v1/archive/get`, or the restore
   * drill). ok → `verified_at`; a sha or size mismatch → state `bad` (the plan skips it) + alert.
   */
  archiveVerify(id: string, ok: boolean, by: string, why?: string): { state: string | null } {
    return this.tx(() => {
      const a = this.one<{ state: string }>("SELECT state FROM archives WHERE id = ?", id);
      if (a?.state !== "complete") return { state: a?.state ?? null };
      if (ok) {
        this.run("UPDATE archives SET verified_at = ?, verified_by = ? WHERE id = ?", this.now, by, id);
        this.ring("gate", "archive-verified", { id, by });
        return { state: "complete" };
      }
      this.run("UPDATE archives SET state = 'bad', bad_reason = ? WHERE id = ?", `${by}: ${why ?? "?"}`, id);
      this.ring("gate", "archive-bad", { id, by, why });
      this.alert("archive-bad", "high", `${id} ${by}: ${why ?? ""}`.slice(0, 300));
      return { state: "bad" };
    });
  }

  /** Index facts the gate needs to serve and check `GET /v1/archive/get`. */
  archiveFacts(id: string): { key: string; sha256: string | null; size: number | null } | null {
    return this.one<{ key: string; sha256: string | null; size: number | null }>(
      "SELECT key, sha256, size FROM archives WHERE id = ? AND state = 'complete'",
      id,
    );
  }

  /** Abort: returns the R2 upload to abort (if any). */
  archiveAbort(id: string): { key: string | null; uploadId: string | null; state: string | null } {
    const a = this.one<{ key: string; upload_id: string | null; state: string }>(
      "SELECT key, upload_id, state FROM archives WHERE id = ?",
      id,
    );
    if (a?.state === "open") this.archiveFinish(id, false, { why: "abort" });
    return { key: a?.key ?? null, uploadId: a?.upload_id ?? null, state: a?.state ?? null };
  }

  /** Drill J: index facts of a complete archive for its R2 sidecar `<key>.json` (gates/control.ts). */
  archiveSidecar(id: string): Record<string, unknown> | null {
    return this.one<Record<string, unknown>>(
      `SELECT id, key, kind, reason, sha256, size, parts, version, digest, gen, state_schema, agent_schema, txid,
         plugins_ver, ws_entries, ws_missing, src_write_at, created_at, completed_at FROM archives WHERE id = ? AND state = 'complete'`,
      id,
    );
  }

  archiveKey(id: string): string | null {
    return (
      this.one<{ key: string }>("SELECT key FROM archives WHERE id = ? AND state = 'complete'", id)?.key ??
      null
    );
  }

  // ---------- shadows ----------

  /**
   * 1 per DB per 10 min (spec §17.2). sec F2: also SHADOW_PER_HOUR shadows per hour over all names (new names
   * no longer pass at once), CAPS.shadowNames rate rows (oldest pruned), and the storage guard.
   */
  shadowCheck(db: string): { ok: true } | { ok: false; retryAfterMs: number; why?: string } {
    const now = this.now;
    if (this.full("shadow")) return { ok: false, retryAfterMs: 3_600_000, why: "ctl-full" };
    const r = this.one<{ at: number }>("SELECT at FROM shadow_rate WHERE db = ?", db);
    const wait = r ? r.at + SHADOW_EVERY_MS - now : 0;
    if (wait > 0) return { ok: false, retryAfterMs: wait };
    const hour = this.all<{ at: number }>(
      "SELECT at FROM shadow_rate WHERE at > ? ORDER BY at ASC",
      now - 3_600_000,
    );
    if (hour.length >= SHADOW_PER_HOUR) {
      this.alert("shadow-rate", "warn", `${hour.length} shadows in 1 h; refused ${db.slice(0, 200)}`);
      return { ok: false, retryAfterMs: (hour[0]?.at ?? now) + 3_600_000 - now, why: "hour" };
    }
    return { ok: true };
  }

  shadowDone(db: string, key: string, size: number): void {
    this.run(
      `INSERT INTO shadow_rate (db, at, key, size) VALUES (?, ?, ?, ?)
       ON CONFLICT(db) DO UPDATE SET at = excluded.at, key = excluded.key, size = excluded.size`,
      db,
      this.now,
      key,
      size,
    );
    const n = this.del(
      `shadow_rate WHERE db NOT IN (SELECT db FROM shadow_rate ORDER BY at DESC LIMIT ${CAPS.shadowNames})`,
    );
    this.pruned("shadow_rate", n, `newest ${CAPS.shadowNames}`);
  }
}

/** Methods a gate may call through the Control DO `gateCall(method, args)` RPC. */
export const GATE_CALLS = [
  "alert",
  "ring",
  "current",
  "hello",
  "boot",
  "hbSeq",
  "replicaState",
  "budget",
  "replicaPre",
  "replicaPost",
  "badSig",
  "deleteCheck",
  "deleteDone",
  "heartbeatInfo",
  "event",
  "logReserve",
  "credsManifest",
  "credsGet",
  "credsPut",
  "credsDelete",
  "configGet",
  "configPropose",
  "pluginsGet",
  "pluginsPut",
  "wakeAllow",
  "archiveStart",
  "archiveOpened",
  "archivePartBegin",
  "archivePartDone",
  "archiveCompleteBegin",
  "archiveFinish",
  "archiveAbort",
  "archiveKey",
  "archiveSidecar",
  "archiveVerify",
  "archiveFacts",
  "shadowCheck",
  "shadowDone",
  "capCheck",
  "capTake",
  "capAdd",
  "sbxAdmit",
  "filesPre",
  "filesPost",
  "importFacts",
  "importDone",
  "importFilePre",
] as const;
export type GateCall = (typeof GATE_CALLS)[number];
type Fn = (...a: any[]) => any;
export type GateApi = { [K in GateCall]: GateLedger[K] extends Fn ? GateLedger[K] : never };
/**
 * Control DO calls the gates make that are not ledger methods; ctl/api.ts `gateCall` serves them before
 * dispatchGateCall. noteHeartbeat carries the §23 heartbeat fields (channels, event jobs, secret version).
 */
export const CTL_EXTRA_CALLS = ["noteHeartbeat", "noteOutbound"] as const;
export interface HeartbeatNote {
  gen: number;
  cpuS?: number | null;
  telegramSecretVersion?: number | null;
  channels?: { channel: string; account: string; transport?: string; lifecycle?: string }[];
  rpo?: string | null;
  eventJobs?: { id: string; kind: string; name?: string }[];
  lastActivityAt?: number | null;
  /** ocsup DiskWatch.hb(): disk use of the state tree; closes `disk-full` and `disk-high` (ctl/disk.ts). */
  disk?: { usedPct?: number; inodesPct?: number } | null;
}
export type GateCallName = GateCall | (typeof CTL_EXTRA_CALLS)[number];
/** What the gates hold: the ledger methods as async calls (DO RPC, or a direct call in tests). */
export type GatePort = {
  [K in GateCall]: (...a: Parameters<GateApi[K]>) => Promise<ReturnType<GateApi[K]>>;
} & {
  noteHeartbeat(h: HeartbeatNote): Promise<unknown>;
  /** L3: an outbound Bot API call the gateway made (Telegram intercept), for reply tracking. */
  noteOutbound(o: { chatId: string | number | null; at: number; method: string }): Promise<unknown>;
};

/** Control DO side of the RPC: `gateCall(m, args) { return dispatchGateCall(this.ledger, m, args) }`. */
export function dispatchGateCall(l: GateLedger, m: string, args: unknown[]): unknown {
  if (!(GATE_CALLS as readonly string[]).includes(m)) throw new Error(`unknown gate call ${m}`);
  return (l[m as GateCall] as Fn).apply(l, args);
}

/** Gate side: a GatePort over `stub.gateCall(m, args)`. */
export function gatePort(call: (m: GateCallName, args: unknown[]) => Promise<unknown>): GatePort {
  const o: Record<string, unknown> = {};
  for (const m of [...GATE_CALLS, ...CTL_EXTRA_CALLS]) o[m] = (...a: unknown[]) => call(m, a);
  return o as GatePort;
}

// ---------- storage bounds (sec F2), shared with ctl/bounds.ts ----------

type Store = GateStoreLike;
const q1 = (st: Store, sql: string, ...b: SqlValue[]) =>
  (st.sql.exec(sql, ...b).toArray()[0] as Record<string, SqlValue> | undefined) ?? null;
function delCount(st: Store, where: string, ...b: SqlValue[]): number {
  const n = Number(q1(st, `SELECT COUNT(*) AS n FROM ${where}`, ...b)?.n ?? 0);
  if (n) st.sql.exec(`DELETE FROM ${where}`, ...b).toArray();
  return n;
}

/**
 * Keep the newest `keep` config versions, plus the newest `good` one (LKG) and every version a live gen's plan
 * boots with. Returns rows deleted.
 */
export function pruneConfigRows(st: Store, keep: number = CAPS.configRows): number {
  return delCount(
    st,
    `config WHERE ver NOT IN (SELECT ver FROM config ORDER BY ver DESC LIMIT ${Math.max(1, keep)})
     AND ver <> COALESCE((SELECT MAX(ver) FROM config WHERE status = 'good'), -1)
     AND ver NOT IN (SELECT CAST(json_extract(plan, '$.configVer') AS INTEGER) FROM gens
       WHERE state IN ('booting', 'complete', 'verified') AND json_extract(plan, '$.configVer') IS NOT NULL)`,
  );
}

/** Keep the newest `keep` rows of a table keyed by `ver`. */
export function pruneRowsByVer(st: Store, table: "plugins", keep: number): number {
  return delCount(
    st,
    `${table} WHERE ver NOT IN (SELECT ver FROM ${table} ORDER BY ver DESC LIMIT ${Math.max(1, keep)})`,
  );
}

/** Alerts table: one row per class; classes come from ocsup too, so keep the newest CAPS.alertRows. */
export function pruneAlertRows(st: Store, keepClass?: string): number {
  const n = Number(q1(st, "SELECT COUNT(*) AS n FROM alerts")?.n ?? 0);
  if (n <= CAPS.alertRows) return 0;
  return delCount(
    st,
    `alerts WHERE class <> ? AND class NOT IN (SELECT class FROM alerts ORDER BY open DESC,
     COALESCE(last_sent_at, 0) DESC LIMIT ${CAPS.alertRows})`,
    keepClass ?? "",
  );
}

// ---------- pure helpers ----------

function norm(v: SqlValue | undefined | boolean): SqlValue {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

const RANK: Record<Tier, number> = { normal: 0, slow: 1, slower: 2 };
const rank = (t: Tier) => RANK[t] ?? 0;

/** Tier = the higher of the request and byte counters (spec §18.6). */
export function tierOf(reqs: number, bytes: number, scale = 1): { tier: Tier; ceiling: boolean } {
  const lvl = (v: number, l: { soft: number; hard: number }) =>
    v >= l.hard * scale ? 2 : v >= l.soft * scale ? 1 : 0;
  const n = Math.max(lvl(reqs, BUDGET.reqs), lvl(bytes, BUDGET.bytes));
  const ceiling = reqs >= BUDGET.reqs.ceiling * scale || bytes >= BUDGET.bytes.ceiling * scale;
  return { tier: (["normal", "slow", "slower"] as const)[n] as Tier, ceiling };
}

/** R2 op class (R2 pricing): A = List, Put, multipart create/part/complete; B = Get, Head; free = deletes, abort. */
export function opClass(op: string): "class_a" | "class_b" | "free" {
  if (op === "GetObject" || op === "HeadObject") return "class_b";
  if (op === "DeleteObject" || op === "DeleteObjects" || op === "AbortMultipartUpload") return "free";
  return "class_a";
}

function newer(gen: number, seq: number, curGen: number, curSeq: number): boolean {
  return gen > curGen || (gen === curGen && seq > curSeq);
}

function b64len(s: string): number {
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** Same list as image/ocrt/lib/config.mjs SENSITIVE. */
export const SENSITIVE = ["models.providers", "channels", "hooks", "plugins", "gateway.auth", "tools", "mcp"];
function getPath(o: unknown, p: string): unknown {
  let cur = o;
  for (const k of p.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
export function sensitiveChanges(a: unknown, b: unknown): string[] {
  return SENSITIVE.filter((p) => canon(getPath(a, p) ?? null) !== canon(getPath(b, p) ?? null));
}

/**
 * Webhook transports other than the managed Telegram route are refused (spec §17.2, plan R2.19).
 * guess: OpenClaw keys `channels.<id>.webhookUrl|webhookPath|webhook*`; Telegram may use only a URL whose path
 * is exactly /telegram-webhook or the secret hook path `/_ochost/hook/telegram/<32 hex>` (W2, M5). Returns a
 * reason or null.
 */
export function webhookTransport(doc: unknown): string | null {
  const ch = getPath(doc, "channels");
  if (!ch || typeof ch !== "object") return null;
  for (const [id, cfg] of Object.entries(ch as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== "object") continue;
    for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
      if (!/^webhook/i.test(k) || v === undefined || v === null || v === false || v === "") continue;
      // An inbox adapter channel (Slack HTTP, SMS) may set webhookPath to its own route, nothing else.
      const ad = adapterByChannel(id);
      if (ad && k === "webhookPath" && v === ad.route) continue;
      if (id !== "telegram") return `channels.${id}.${k}`;
      if (/^webhook(secret|secretref)$/i.test(k)) continue;
      if (k === "webhookUrl") {
        let path = "";
        try {
          path = new URL(String(v)).pathname;
        } catch {
          return `channels.telegram.webhookUrl unparsable`;
        }
        if (path !== "/telegram-webhook" && !/^\/_ochost\/hook\/telegram\/[0-9a-f]{32}$/.test(path))
          return `channels.telegram.webhookUrl path ${path}`;
        continue;
      }
      if (k === "webhookPath" && v === "/telegram-webhook") continue;
      return `channels.telegram.${k}`;
    }
  }
  return null;
}

function rand(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(36).padStart(2, "0").slice(-1)).join("");
}
