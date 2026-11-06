// Boot plan -> ordered pre-start steps (plan §4.14, §6.2; scope §1.1 "Hostname and lock";
// amend §1.6 S3-S4, §2 row 21b). Pure: no I/O. ocsup never guesses a source.
import { BootPlan, EXIT, exitCodeFor, validate } from "./contract.mjs";

export const SEED_GATE_MAX_BYTES = 200 * 1000 * 1000; // amend §1.6 S3 (guess value)
export const START_GATE_MS = 120_000;

const blocked = (reason, detail) => ({ exit: { code: exitCodeFor(reason), reason, detail } });

/**
 * planSteps(plan, ctx) -> {exit} | {mode, gateway, litestream, credsync, startGate, steps[]}
 * ctx: {startSnapshotId?} = snapshot id the DO passed in the start env (OCRT_SNAPSHOT_ID), if any.
 * Step names: wipe, archive-restore, workspace-restore, sqlite-fresh, sqlite-marker, sqlite-gen,
 * sqlite-pending, sqlite-archive-check, sqlite-keep, workspace, lock, ownership, creds, config, doctor,
 * litestream, start-gate, gateway.
 * Restore steps (RESTORE_STEPS) run inside plan.timers.restoreMs (M3 F1); a step past its share exits 75
 * `restore-timeout`.
 */
export function planSteps(plan, ctx = {}) {
  const errs = validate(BootPlan, plan);
  if (errs.length) return blocked("restore-blocked:infra", `bad plan: ${errs.slice(0, 3).join("; ")}`);
  const sq = plan.sqlite;
  if (sq.kind === "restore-blocked") return blocked(sq.reason, sq.detail || "plan");
  const mode = plan.mode;
  const rootfs = plan.rootfs;
  if (mode === "canary" && rootfs.kind === "snapshot")
    return blocked("restore-blocked:mismatch", "canary never boots a prod snapshot");
  if (sq.kind === "snapshot" && mode !== "files-only")
    return blocked("restore-blocked:mismatch", "sqlite=snapshot needs files-only");
  if (mode === "files-only" && rootfs.kind !== "snapshot")
    return blocked("restore-blocked:mismatch", "files-only needs a snapshot");
  if (sq.kind === "archive" && (rootfs.kind !== "image" || !plan.archive))
    return blocked("restore-blocked:mismatch", "sqlite=archive needs rootfs=image and plan.archive");
  if (rootfs.kind === "image" && sq.kind !== "archive" && sq.kind !== "fresh" && sq.kind !== "gen")
    return blocked("restore-blocked:mismatch", `rootfs=image with sqlite=${sq.kind}`);
  if (sq.kind === "marker") {
    if (rootfs.kind !== "snapshot" || rootfs.snapshotId !== sq.snapshotId)
      return blocked("restore-blocked:mismatch", "marker snapshot != rootfs snapshot");
    if (ctx.startSnapshotId && ctx.startSnapshotId !== sq.snapshotId)
      return blocked("restore-blocked:mismatch", "marker snapshot != start snapshot");
  }

  const dbs = plan.dbs || [];
  const uploaded = dbs.filter((d) => d.state !== "pending").map((d) => d.db);
  const pending = dbs.filter((d) => d.state === "pending").map((d) => d.db);
  const steps = [{ step: "wipe" }];
  // Image path with an archive: a full archive restore when SQLite comes from it (M4); with SQLite from a gen,
  // only the workspace files come from the archive (B1: the gen does not carry them).
  if (rootfs.kind === "image" && plan.archive)
    steps.push(
      sq.kind === "archive"
        ? { step: "archive-restore", archive: plan.archive }
        : { step: "workspace-restore", archive: plan.archive },
    );

  switch (sq.kind) {
    case "fresh":
      steps.push({ step: "sqlite-fresh" });
      break;
    case "marker":
      steps.push({
        step: "sqlite-marker",
        markerId: sq.markerId,
        gen: sq.gen,
        txid: sq.txid || {},
        dbs: dbs.map((d) => d.db),
      });
      break;
    case "gen":
      steps.push({
        step: "sqlite-gen",
        gen: sq.gen,
        ts: sq.ts ?? null,
        dbs: sq.dbs || uploaded,
        lastTxid: Object.fromEntries(dbs.map((d) => [d.db, d.lastTxid ?? 0])),
      });
      if (pending.length) steps.push({ step: "sqlite-pending", dbs: pending });
      break;
    case "archive":
      steps.push({ step: "sqlite-archive-check", txid: sq.txid || {} });
      break;
    case "snapshot":
      steps.push({ step: "sqlite-keep" });
      break;
  }

  const gateway = mode !== "files-only";
  const litestream = mode !== "files-only";
  // M4b N1+N2: quick_check the managed DBs the rootfs or the restore left, before the gateway opens them.
  if (gateway && sq.kind !== "fresh" && sq.kind !== "restore-blocked") steps.push({ step: "sqlite-check" });
  const credsync = mode === "prod" ? "write" : "none";
  // B1: never start a gateway whose attested workspace is missing.
  if (gateway)
    steps.push({
      step: "workspace",
      source: plan.workspace?.source ?? (rootfs.kind === "snapshot" ? "snapshot" : "none"),
      acceptLoss: plan.workspace?.acceptLoss === true,
    });
  if (gateway) steps.push({ step: "lock", lockMode: plan.lockMode });
  steps.push({ step: "ownership" });
  if (mode !== "files-only")
    steps.push({ step: "creds", seq: plan.credsSeq ?? null, readOnly: mode !== "prod" });
  if (gateway)
    steps.push({
      step: "config",
      ver: plan.configVer ?? null,
      overlay: plan.overlay || [],
      channelsOff: mode === "canary" || !!plan.channelsOff,
    });
  if (gateway && plan.runDoctor) steps.push({ step: "doctor" });

  let startGate = null;
  if (litestream) {
    steps.push({
      step: "litestream",
      prefix: plan.replica?.prefix ?? null,
      tier: plan.replica?.tier || "normal",
    });
    const setBytes = dbs.reduce((a, d) => a + (d.bytes || 0), 0);
    const max = plan.replica?.seedGateMaxBytes ?? SEED_GATE_MAX_BYTES;
    const capMs = plan.timers?.startGateMs ?? START_GATE_MS;
    // S3: a big set on a valid-marker wake starts the gateway at once in state `seeding`.
    startGate =
      sq.kind === "marker" && setBytes > max
        ? { wait: false, seeding: true, setBytes }
        : { wait: true, seeding: false, setBytes, capMs };
    steps.push({ step: "start-gate", ...startGate });
  }
  if (gateway) steps.push({ step: "gateway" });
  return { mode, gateway, litestream, credsync, startGate, steps };
}

/** Steps that run in phase `restore` and share plan.timers.restoreMs (F1). */
export const RESTORE_STEPS = new Set([
  "wipe",
  "archive-restore",
  "workspace-restore",
  "sqlite-fresh",
  "sqlite-marker",
  "sqlite-gen",
  "sqlite-pending",
  "sqlite-archive-check",
  "sqlite-keep",
  "sqlite-check",
  "workspace",
]);

/**
 * Restore deadline (F1): 90 % of the DO's restore budget, so ocsup ends a stalled step with its own class
 * before the DO's `budget:restore` destroys the container. Default 300 s when the plan has no value.
 */
export const restoreDeadlineMs = (plan) => Math.floor(0.9 * (plan?.timers?.restoreMs ?? 300_000));

/** Seed cap while `seeding` (amend §1.6 S4): set bytes / 10 MB/s + 30 s. */
export const seedCapMs = (setBytes) => Math.ceil(setBytes / 10_000_000) * 1000 + 30_000;

export { EXIT };
