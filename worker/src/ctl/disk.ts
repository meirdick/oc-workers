// Disk state in status (plan §4.12 "Disk watch"). ocsup sends alert `disk-high` at 80 % and `disk-full` at 95 %
// (or on a child's ENOSPC). Only an open `disk-full` sets status `degraded`; `disk-high` shows in the alerts.
// The heartbeat `disk` field closes them when the disk is back. The levels are those of
// image/ocrt/lib/diskwatch.mjs: ocsup leaves its own degraded state under LEVELS.clean (90 %), and raises
// disk-high again on the next crossing of LEVELS.alert (80 %).
import { resolveAlert } from "./alerts";
import { type Ctx, ring } from "./ctx";

/** diskwatch.mjs LEVELS.clean: under this use, ocsup is no longer degraded and `disk-full` closes. */
export const DISK_FULL_CLEAR_PCT = 90;
/** diskwatch.mjs LEVELS.alert: under this use, `disk-high` closes. */
export const DISK_HIGH_CLEAR_PCT = 80;

export interface DiskHb {
  usedPct?: unknown;
  inodesPct?: unknown;
}
export interface DiskSeen {
  gen: number;
  usedPct: number;
  inodesPct: number;
  at: number;
}

const isOpen = (c: Ctx, cls: string) =>
  !!c.db.one("SELECT 1 AS x FROM alerts WHERE class = ? AND open = 1", cls);

/** Heartbeat `disk` (DiskWatch.hb(): {usedPct, inodesPct}). Keeps the last value; closes disk alerts. */
export function noteDisk(c: Ctx, gen: number, d: DiskHb | null | undefined): void {
  if (!d || typeof d !== "object") return;
  const used = Number(d.usedPct);
  if (d.usedPct === null || d.usedPct === undefined || !Number.isFinite(used)) return;
  const inodes = Number.isFinite(Number(d.inodesPct)) ? Number(d.inodesPct) : 0;
  const pct = Math.max(used, inodes);
  c.db.setMeta("disk", { gen, usedPct: used, inodesPct: inodes, at: c.now() } satisfies DiskSeen);
  for (const [cls, under] of [
    ["disk-full", DISK_FULL_CLEAR_PCT],
    ["disk-high", DISK_HIGH_CLEAR_PCT],
  ] as const)
    if (pct < under && isOpen(c, cls)) {
      resolveAlert(c, cls);
      ring(c, "alert", "closed", { class: cls, usedPct: used, inodesPct: inodes });
    }
}

/** Reasons the disk gives for status `degraded`: `disk-full` while that alert is open. */
export function diskDegraded(c: Ctx): string[] {
  return isOpen(c, "disk-full") ? ["disk-full"] : [];
}

/** Last disk use a heartbeat reported, or null. */
export function lastDisk(c: Ctx): DiskSeen | null {
  return c.db.metaJson<DiskSeen | null>("disk", null);
}
