// Boot plan building (spec §8.3). Reads only; the caller applies side effects inside beginBoot's transaction.
import type { BeginBootArgs, BootPlan, DbPlan, SqlitePlan } from "../core/types";
import { gatewayAuthManaged, uiOrigins } from "../ingress/gateway";
import { configForBoot } from "./config";
import { type Ctx, DAY } from "./ctx";
import { latestTier } from "./records";
import { heartbeatManaged, wakeHours, wakeIgnore } from "./schedule";
import { type ArchiveRow, CONSISTENT_KINDS, type MarkerRow, type SnapRow, ttlEnd } from "./snapshots";
import { pj } from "./sql";

export interface EpochRow {
  n: number;
  image_key: string;
  digest: string;
  code_version: string;
  status: "active" | "retiring" | "retired";
  reason: string | null;
  created_at: number;
  retired_at: number | null;
  hung_count: number;
}

/** R2 facts for the `fresh` rule, read before the transaction. `error` → restore-blocked:infra. */
export interface FreshFacts {
  installed: boolean;
  archives: boolean;
  /** Gens found under r/<inst>/ (prefix listing). */
  r2Gens: number[];
  error?: string;
}

export interface ImageInfo {
  stateSchema?: number | null;
  agentSchema?: number | null;
  schemaSha?: string | null;
}

export function imageInfo(c: Ctx, digest: string): ImageInfo {
  return c.db.metaJson<ImageInfo>(`image:${digest}`, {});
}

interface GenRow {
  gen: number;
  state: string;
  state_schema: number | null;
  agent_schema: number | null;
  plan_kind: string;
  started_at: number | null;
  digest: string | null;
}

export interface PlanOut {
  plan: Omit<BootPlan, "gen">;
  restoreGens: number[];
  snapshotId?: string;
  markerId?: string;
  archiveId?: string;
  adopt: boolean;
  /** L3/L4: `ok` snapshots newer than this time on this digest become superseded. */
  supersedeAfter?: number;
}

const schemaOk = (img: ImageInfo, s: { state_schema: number | null; agent_schema: number | null }) =>
  (img.stateSchema == null || s.state_schema == null || s.state_schema <= img.stateSchema) &&
  (img.agentSchema == null || s.agent_schema == null || s.agent_schema <= img.agentSchema);

/** Rootfs candidates by §8.3 steps 1-5. */
function chooseRootfs(
  c: Ctx,
  a: BeginBootArgs,
  ep: EpochRow,
  img: ImageInfo,
): { snap?: SnapRow; archive?: ArchiveRow; supersedeAfter?: number } {
  const now = c.now();
  const missed = new Set(a.missed ?? []);
  const leasedElsewhere = (s: SnapRow) => {
    if (s.lease_epoch == null || s.lease_epoch === ep.n) return false;
    const other = c.db.one<{ status: string }>("SELECT status FROM epochs WHERE n = ?", s.lease_epoch);
    return !!other && other.status !== "retired";
  };
  const usable = (s: SnapRow) =>
    !missed.has(s.id) &&
    (s.state === "ok" || s.state === "suspect") &&
    s.digest === ep.digest &&
    ttlEnd(c, s) - DAY > now &&
    !leasedElsewhere(s);
  const snaps = c.db
    .all<SnapRow>("SELECT * FROM snapshots ORDER BY created_at DESC, id DESC")
    .filter((s) => usable(s));
  const all = c.db
    .all<ArchiveRow>("SELECT * FROM archives WHERE state = 'complete' ORDER BY created_at DESC, id DESC")
    .filter((x) => schemaOk(img, x));
  // M4 (live A A2): an archive taken while the workspace was empty or missing restores an empty workspace,
  // and a gen that attests it then blocks the boot (`workspace-missing`). Rank such archives last.
  const wsOk = (x: ArchiveRow) => !((x.ws_missing ?? 0) > 0 || x.ws_entries === 0);
  const archives = [...all.filter(wsOk), ...all.filter((x) => !wsOk(x))];
  const level = a.ladder ?? 1;

  if (a.rebase) return { archive: archives[0] };
  // F3: the op missed snapshotReplanCap snapshots → archive path only (none → restore-blocked, buildPlan).
  if (a.noSnapshot) return { archive: archives[0] };
  if (level === 4 || level === "slow") return { archive: archives[0], supersedeAfter: 0 };
  if (level === 3) {
    const l1 = a.l1SnapshotId
      ? c.db.one<SnapRow>("SELECT * FROM snapshots WHERE id = ?", a.l1SnapshotId)
      : snaps[0];
    const older = snaps.find(
      (s) => CONSISTENT_KINDS.includes(s.kind) && (!l1 || (s.created_at < l1.created_at && s.id !== l1.id)),
    );
    if (older) return { snap: older, supersedeAfter: older.created_at };
    return { archive: archives[0] };
  }
  const snap = snaps[0];
  // After a miss, snapshots and archives compete by created_at (Z0.5).
  if (missed.size && snap && archives[0] && archives[0].created_at > snap.created_at)
    return { archive: archives[0] };
  if (snap) return { snap };
  return { archive: archives[0] };
}

function genDigestDiffers(c: Ctx, gen: number, digest: string): boolean {
  const d = c.db.one<{ digest: string | null }>("SELECT digest FROM gens WHERE gen = ?", gen)?.digest;
  return !!d && d !== "unknown" && d !== digest;
}

/** Any gen or archive row: the install has state even when `initialized` is still 0 (adopt path). */
function hasData(c: Ctx): boolean {
  return !!(
    c.db.one("SELECT gen FROM gens WHERE state IN ('complete', 'verified') LIMIT 1") ||
    c.db.one("SELECT id FROM archives WHERE state = 'complete' LIMIT 1")
  );
}

/** L2: snapshot time (or archive time on the image path) the checkpoint clock counts from; null = the boot. */
export function rootfsAt(rf: { snap?: SnapRow; archive?: ArchiveRow }): number | null {
  if (rf.snap) {
    const clean =
      (rf.snap.kind === "sleep" || rf.snap.kind === "planned") && rf.snap.last_restored_at == null;
    return clean ? null : rf.snap.created_at;
  }
  return rf.archive?.created_at ?? null;
}

/** C1 (M4): newest shadow PUT (gate shadow_rate rows, kept 1 h). ocsup runs a round at start when older. */
function shadowAt(c: Ctx): number | null {
  try {
    return c.db.one<{ m: number | null }>("SELECT MAX(at) AS m FROM shadow_rate")?.m ?? null;
  } catch {
    return null; // table made by the gate ledger on first use
  }
}

export function buildPlan(c: Ctx, a: BeginBootArgs, ep: EpochRow, facts: FreshFacts | null): PlanOut {
  const img = imageInfo(c, ep.digest);
  const initialized = c.db.metaNum("initialized", 0) === 1;
  const rewound = c.db.meta("ctlState") === "ctl-rewound";
  const level = a.ladder ?? 1;
  const rf = chooseRootfs(c, a, ep, img);
  const rootfs: BootPlan["rootfs"] = rf.snap
    ? { kind: "snapshot", snapshotId: rf.snap.id, digest: rf.snap.digest }
    : { kind: "image", digest: ep.digest };
  // L2 (M4): rootfs time for the checkpoint clock. Rootfs writes after this time are in no snapshot once a boot
  // from this rootfs has ended. A sleep or planned snapshot that no boot has restored yet loses nothing before
  // this boot, so the clock starts at the boot (no `at`).
  const at = rootfsAt(rf);
  if (at !== null) rootfs.at = at;

  let adopt = false;
  let sqlite: SqlitePlan | null = null;
  let dbs: DbPlan[] = [];
  let markerId: string | undefined;
  let archive: BootPlan["archive"] = null;

  if (a.noSnapshot && !rf.archive && a.mode === "prod" && (initialized || hasData(c))) {
    // F3: every snapshot candidate of this op missed and no archive exists. No start(), high alert (caller).
    sqlite = {
      kind: "restore-blocked",
      reason: "restore-blocked:mismatch",
      detail: `snapshots-lost: ${(a.missed ?? []).length} missed in one op; no complete archive`,
    };
  } else if (rewound && a.mode === "prod") {
    sqlite = {
      kind: "restore-blocked",
      reason: "restore-blocked:rewound",
      detail: "Control DO below the R2 hwm",
    };
  } else if (!initialized) {
    if (!facts || facts.error) {
      sqlite = {
        kind: "restore-blocked",
        reason: "restore-blocked:infra",
        detail: facts?.error ?? "no R2 facts",
      };
    } else {
      const freshGens = new Set(
        c.db
          .all<GenRow>(
            "SELECT gen, plan_kind, started_at FROM gens WHERE plan_kind = 'fresh' AND started_at IS NULL",
          )
          .map((g) => g.gen),
      );
      const foreign = facts.r2Gens.some((g) => !freshGens.has(g));
      if (!facts.installed && !facts.archives && !foreign) sqlite = { kind: "fresh" };
      else adopt = true;
    }
  }

  // N1: an owner PITR request (/ops/restore pitr:<ts>) → every managed DB of that gen restored at ts. lastTxid 0:
  // the restore stops at ts, below the gen's newest txid.
  const l5 = c.db.metaJson<{ kind?: string; gen?: number; ts?: number } | null>("l5", null);
  const pitr = !sqlite && a.mode === "prod" && l5?.kind === "pitr" && l5.gen && l5.ts ? l5 : null;
  if (pitr) {
    dbs = c.db
      .all<{ db: string }>(
        "SELECT db FROM gendb WHERE gen = ? AND state = 'uploaded' ORDER BY db",
        pitr.gen as number,
      )
      .map((r) => ({ db: r.db, lastTxid: 0, bytes: 0, state: "uploaded" as const }));
    sqlite = {
      kind: "gen",
      gen: pitr.gen as number,
      ts: new Date(pitr.ts as number).toISOString(),
      dbs: dbs.map((d) => d.db),
    };
  }

  if (!sqlite) {
    const isInit = initialized || adopt;
    // marker: valid marker bound to the chosen snapshot, prod, L1.
    if (rf.snap && a.mode === "prod" && level === 1 && !a.rebase) {
      const m = c.db.one<MarkerRow>(
        "SELECT * FROM markers WHERE state = 'valid' AND snapshot_id = ?",
        rf.snap.id,
      );
      if (m) {
        const txid = pj<Record<string, number>>(m.txid, {});
        const bytes = pj<Record<string, number>>(m.bytes, {});
        sqlite = { kind: "marker", markerId: m.id, snapshotId: rf.snap.id, gen: m.gen, txid };
        dbs = Object.keys(txid).map((db) => ({
          db,
          lastTxid: txid[db] ?? 0,
          bytes: bytes[db] ?? 0,
          state: "uploaded",
        }));
        markerId = m.id;
      }
    }
    if (!sqlite) {
      const gens = c.db.all<GenRow>(
        "SELECT gen, state, state_schema, agent_schema, plan_kind, started_at, digest FROM gens WHERE state IN ('complete', 'verified') ORDER BY gen DESC",
      );
      const okGen = gens.find((g) => schemaOk(img, g));
      if (okGen) {
        sqlite = { kind: "gen", gen: okGen.gen };
        dbs = c.db
          .all<{ db: string; l0_max_txid: number | null; bytes: number | null }>(
            "SELECT db, l0_max_txid, bytes FROM gendb WHERE gen = ? AND state = 'uploaded' ORDER BY db",
            okGen.gen,
          )
          .map((r) => ({ db: r.db, lastTxid: r.l0_max_txid ?? 0, bytes: r.bytes ?? 0, state: "uploaded" }));
        (sqlite as { dbs?: string[] }).dbs = dbs.map((d) => d.db);
      } else if (rf.archive) {
        const txid = pj<Record<string, number>>(rf.archive.txid, {});
        sqlite = { kind: "archive", archiveId: rf.archive.id, txid };
        dbs = Object.keys(txid).map((db) => ({ db, lastTxid: txid[db] ?? 0, bytes: 0, state: "uploaded" }));
      } else if (gens.length || c.db.one("SELECT id FROM archives WHERE state = 'complete' LIMIT 1")) {
        sqlite = {
          kind: "restore-blocked",
          reason: "restore-blocked:schema",
          detail: "every source has a newer schema than the image",
        };
      } else if (isInit) {
        sqlite = {
          kind: "restore-blocked",
          reason: "restore-blocked:mismatch",
          detail: "initialized install with no gen and no archive",
        };
      } else {
        sqlite = { kind: "fresh" };
      }
    }
  }
  if (rf.archive && rootfs.kind === "image")
    archive = {
      archiveId: rf.archive.id,
      key: rf.archive.key,
      sha256: rf.archive.sha256 ?? "",
      size: rf.archive.size ?? 0,
    };

  const restoreGens = sqlite.kind === "gen" || sqlite.kind === "marker" ? [sqlite.gen] : [];
  // B1: workspace files live only on the rootfs. A snapshot rootfs carries them; the image path takes them from
  // the archive; with neither, ocsup refuses to start a gateway whose attested workspace is missing.
  const workspace: NonNullable<BootPlan["workspace"]> =
    rootfs.kind === "snapshot"
      ? { source: "snapshot" }
      : archive
        ? { source: "archive" }
        : { source: "none" };
  if (c.db.meta("workspaceReset")) workspace.acceptLoss = true;
  const lastDoctor = c.db.meta("lastDoctorDigest");
  const lastStopDoctor = c.db.metaNum(`doctorRequired:${ep.n}`, 0) === 1;
  const wantDoctor =
    level === 2 ||
    level === 4 ||
    level === "slow" ||
    !!a.runDoctor ||
    lastStopDoctor ||
    (rf.snap ? rf.snap.digest !== ep.digest : false) ||
    (rf.archive?.digest ? rf.archive.digest !== ep.digest : false) ||
    // O1: SQLite written by another image (the source gen's digest) → Doctor migrates it.
    (sqlite.kind === "gen" || sqlite.kind === "marker"
      ? genDigestDiffers(c, sqlite.gen, ep.digest)
      : false) ||
    (lastDoctor !== null && lastDoctor !== ep.digest);
  // §8.5 M6: Doctor failed DOCTOR_SKIP_AFTER times on this digest; boot without it (the Runtime DO alerts).
  const runDoctor = wantDoctor && a.skipDoctorDigest !== ep.digest;
  const lkg = level !== 1;
  const s = c.settings();
  const credsSeq = c.db.one<{ m: number | null }>("SELECT MAX(seq) AS m FROM creds")?.m ?? null;
  const pluginsVer = c.db.one<{ m: number | null }>("SELECT MAX(ver) AS m FROM plugins")?.m ?? null;
  const trustedProxies = s.trustedProxies?.length ? s.trustedProxies.slice(0, 8) : ["10.1.0.0/32"];
  const origins = uiOrigins(s);
  const overlay: BootPlan["overlay"] = [];
  if (a.reason === "l5" || pitr) overlay.push({ path: "cron.enabled", value: false });

  // What this boot renders; the console shows "applies at the next start" while the setting differs.
  c.db.setMeta("sandboxBooted", s.sandbox ?? "off");
  const plan: Omit<BootPlan, "gen"> = {
    v: 1,
    mode: a.mode,
    inst: c.inst,
    epoch: ep.n,
    rootfs,
    sqlite,
    archive,
    dbs,
    restoreGens,
    runDoctor,
    lockMode: "auto",
    configVer: configForBoot(c, img.schemaSha ?? null, lkg),
    pluginsVer,
    credsSeq,
    channelsOff: false,
    shadowAt: shadowAt(c),
    overlay,
    replica: {
      bucket: s.bucket ?? `oc-host-${c.inst}`,
      prefix: `r/${c.inst}/`,
      tier: latestTier(c),
      seedGateMaxBytes: 200_000_000,
    },
    timers: {
      hbMs: c.timers.hbMs,
      fenceMs: c.timers.fenceMs,
      startGateMs: c.timers.startGateMs,
      // F1: ocsup ends each restore step inside the DO's restore budget (§8.6).
      restoreMs: rootfs.kind === "snapshot" ? c.timers.budgetRestoreSnapMs : c.timers.budgetRestoreImageMs,
    },
    trustedProxies,
    workspace,
    // M3 ingress: trusted-proxy keys that match the headers the Worker sets (ingress/headers.ts).
    // The heartbeat cadence and hours follow sleep.proactive (docs/04 "Heartbeat in duty-cycle").
    managed: [...gatewayAuthManaged({ ...origins, trustedProxies }), ...heartbeatManaged(s)],
    // The Control UI origin: ocsup writes gateway.publicOrigin and controlUi.allowedOrigins from these.
    ...origins,
    runtime: {
      maintenanceHour: s.runtime.maintenanceHour,
      tz: s.runtime.tz,
      maxUptimeHours: s.sleep.maxAwakeHours,
      heapAborts: [],
      sleepMode: s.sleep.mode,
      proactive: s.sleep.proactive,
    },
    wakeIgnore: wakeIgnore(s),
    wakeHours: wakeHours(s),
    sandbox: s.sandbox === "on" || s.sandbox === "all",
    ...(s.sandbox === "all" ? { sandboxMode: "all" as const } : {}),
  };
  return {
    plan,
    restoreGens,
    snapshotId: rf.snap?.id,
    markerId,
    archiveId: rf.archive?.id,
    adopt,
    supersedeAfter: rf.supersedeAfter,
  };
}
