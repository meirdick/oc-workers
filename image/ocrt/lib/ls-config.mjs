// Litestream 0.5.17 config for the managed DB set (plan §4.8; amend §1.5 F1.1, F1.3; §2 rows 9, 10).
// Pure: no I/O. ocsup writes the result to /run/ocrt/litestream.yml (0600, owner uid 1000: Litestream
// runs as uid 1000, scope §1.1 row "Litestream").
import { createHash } from "node:crypto";
import path from "node:path";

export const META_ROOT = "/var/lib/ocrt/ls-meta";
export const MAX_DBS = 32;

/** Explicit managed set (scope §1.1): state DB + one agent DB per agent dir. */
export const MANAGED_RE = /^(state\/openclaw\.sqlite|agents\/[^/\0]{1,128}\/agent\/openclaw-agent\.sqlite)$/;
export const isManagedRel = (rel) => MANAGED_RE.test(rel);

/** Stable, path-safe id of a DB relpath: readable stem + 8 hex of sha256 (no collisions between agents). */
export function dbId(rel) {
  const stem = rel
    .replace(/\.sqlite$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, 48);
  return `${stem}-${createHash("sha256").update(rel).digest("hex").slice(0, 8)}`;
}

/** F1.1: per-gen, per-DB meta dir. A new gen gets a new, empty dir by construction. */
export const metaPathFor = (gen, rel, root = META_ROOT) => path.join(root, `g${gen}`, dbId(rel));
/** M0 layout (Litestream default): `.<file>-litestream` beside the DB. */
export const legacyMetaPath = (state, rel) =>
  path.join(state, path.dirname(rel), `.${path.basename(rel)}-litestream`);

/**
 * Level presets. `default` = Litestream defaults (L1 30 s, L2 5 m, L3 1 h, l0-retention 5 m, check 15 s).
 * `lean` = the M1/M2 pick: L1 only at 5 min, short L0 retention, slow retention scan. Each L1
 * compaction with new L0 costs about 3 List + 1 Put; at 30 s the state DB of 2026.10.9 (it writes
 * every 8.6 s idle) made idle class A 16.1/min for 4 DBs (limit 15). Record: docs/06-m0-amendments.md §4.
 * Values are Go durations.
 */
export const PRESETS = Object.freeze({
  default: {
    levels: null,
    l0Retention: null,
    l0Check: null,
    snapshotInterval: null,
    snapshotRetention: null,
  },
  lean: {
    levels: ["5m"],
    l0Retention: "1m",
    l0Check: "5m",
    snapshotInterval: "24h",
    snapshotRetention: "24h",
  },
});

/**
 * M4b N3: free space under the reserve. guess: Litestream 0.5 has no switch to turn compaction off, so the
 * L1 level and the snapshot move out to 24 h / 720 h; WAL sync to L0 goes on (managed SQLite RPO kept).
 */
export const LOW_DISK = Object.freeze({
  levels: ["24h"],
  snapshotInterval: "720h",
  snapshotRetention: "720h",
});

const q = (s) => JSON.stringify(String(s));

/**
 * Render litestream.yml.
 * o: {state, gen, inst, dbs: [rel], s3: {endpoint, bucket, region, accessKey, secretKey},
 *     syncInterval='1s', preset='lean', metaRoot, shutdownSyncTimeout='20s', prefix?, levelsOverride?,
 *     legacyMeta?}
 */
export function renderConfig(o) {
  const p = { ...PRESETS[o.preset || "lean"], ...(o.levelsOverride || {}), ...(o.lowDisk ? LOW_DISK : {}) };
  const dbs = [...o.dbs].sort();
  if (dbs.length > MAX_DBS) throw new Error(`db set over cap ${MAX_DBS}`);
  for (const rel of dbs) if (!isManagedRel(rel)) throw new Error(`not a managed relpath: ${rel}`);
  const prefix = o.prefix ?? `r/${o.inst}/g${o.gen}/`;
  const L = ["# written by ocsup; do not edit"];
  L.push(`shutdown-sync-timeout: ${o.shutdownSyncTimeout || "20s"}`);
  if (p.l0Retention) L.push(`l0-retention: ${p.l0Retention}`);
  if (p.l0Check) L.push(`l0-retention-check-interval: ${p.l0Check}`);
  if (p.levels) {
    L.push("levels:");
    for (const iv of p.levels) L.push(`  - interval: ${iv}`);
  }
  if (p.snapshotInterval || p.snapshotRetention) {
    L.push("snapshot:");
    if (p.snapshotInterval) L.push(`  interval: ${p.snapshotInterval}`);
    if (p.snapshotRetention) L.push(`  retention: ${p.snapshotRetention}`);
  }
  L.push("dbs:");
  for (const rel of dbs) {
    L.push(`  - path: ${q(path.join(o.state, rel))}`);
    // legacyMeta (test only, F1-wake-legacy): M0 layout, meta dir beside the DB.
    if (!o.legacyMeta) L.push(`    meta-path: ${q(metaPathFor(o.gen, rel, o.metaRoot))}`);
    L.push("    replica:");
    L.push("      type: s3");
    L.push(`      bucket: ${q(o.s3.bucket)}`);
    L.push(`      path: ${q(`${prefix}${rel}`)}`);
    L.push(`      endpoint: ${q(o.s3.endpoint)}`);
    L.push(`      region: ${q(o.s3.region || "auto")}`);
    L.push("      force-path-style: true");
    L.push(`      access-key-id: ${q(o.s3.accessKey)}`);
    L.push(`      secret-access-key: ${q(o.s3.secretKey)}`);
    L.push(`      sync-interval: ${o.syncInterval || "1s"}`);
    L.push("      auto-recover: false");
  }
  return `${L.join("\n")}\n`;
}
