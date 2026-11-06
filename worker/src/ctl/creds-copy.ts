// CredStore second copy in R2 and its restore (plan §6.1 row 2, §6.3; spec 08 §13.3; scope [Z1.9, Z2.1]).
// `c/<inst>/<seq12>.json` = every creds row (tombstones included; blobs by their r2 key), written once, at most
// every credsCopyMs when max(seq) moved. The hwm `meta/<inst>/hwm` gets {credsSeq} with each copy, so a
// Control DO whose storage was replaced reads below the hwm (ctl-rewound). On rewound, the newest copy is loaded
// into `creds` (per path, only when newer than the row the store holds): the boot then writes those files and no
// channel relinks (drill L). The copies are not deleted here (30 d GC: guess, not built).
import { alert } from "./alerts";
import { maxCredSeq } from "./creds";
import { type Ctx, ring } from "./ctx";
import { hwmKey } from "./gens";

export const credsCopyPrefix = (inst: string) => `c/${inst}/`;
export const credsCopyKey = (inst: string, seq: number) =>
  `${credsCopyPrefix(inst)}${String(seq).padStart(12, "0")}.json`;

interface CopyRow {
  path: string;
  gen: number | null;
  seq: number;
  sha256: string | null;
  mode: number | null;
  b64: string | null;
  r2_key: string | null;
  deleted: number;
  updated_at: number;
}
export interface CredsCopy {
  v: 1;
  inst: string;
  seq: number;
  at: number;
  rows: CopyRow[];
}

/** Tick step: write the copy when the store moved and the last copy is credsCopyMs old. */
export async function copyCredsIfDue(c: Ctx): Promise<{ wrote: boolean; seq?: number; why?: string }> {
  const seq = maxCredSeq(c);
  const last = c.db.metaNum("credsCopySeq", 0);
  if (seq <= last) return { wrote: false, why: "unchanged" };
  if (c.now() - c.db.metaNum("credsCopyAt", 0) < c.timers.credsCopyMs)
    return { wrote: false, why: "not-due" };
  const rows = c.db.all<CopyRow>(
    "SELECT path, gen, seq, sha256, mode, b64, r2_key, deleted, updated_at FROM creds ORDER BY path",
  );
  const doc: CredsCopy = { v: 1, inst: c.inst, seq, at: c.now(), rows };
  const key = credsCopyKey(c.inst, seq);
  const body = JSON.stringify(doc);
  if (!(await c.bucket.head(key))) await c.bucket.put(key, body);
  // hwm: never lower the gen part (beginBoot writes it); credsSeq = this copy.
  let hwm: { gen?: number; credsSeq?: number; epoch?: number } = {};
  const o = await c.bucket.get(hwmKey(c.inst));
  if (o) hwm = JSON.parse(await o.text()) as { gen?: number; credsSeq?: number; epoch?: number };
  const gen = Math.max(hwm.gen ?? 0, c.db.metaNum("genCounter", 0));
  const epoch = hwm.epoch ?? (c.db.meta("pointer") === null ? undefined : Number(c.db.meta("pointer")));
  await c.bucket.put(
    hwmKey(c.inst),
    JSON.stringify({ gen, credsSeq: Math.max(seq, hwm.credsSeq ?? 0), epoch, at: c.now() }),
  );
  c.db.setMeta("credsCopySeq", seq);
  c.db.setMeta("credsCopyAt", c.now());
  ring(c, "creds", "copy", { key, seq, n: rows.length, bytes: body.length });
  return { wrote: true, seq };
}

/** The newest copy in R2, or null. Lists every page (keys sort by seq). */
export async function newestCredsCopy(c: Ctx): Promise<{ key: string; doc: CredsCopy } | null> {
  const prefix = credsCopyPrefix(c.inst);
  let best: string | null = null;
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const r = await c.bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of r.objects) {
      const rest = o.key.slice(prefix.length);
      if (!/^\d{12}\.json$/.test(rest)) continue; // skips blob/<sha>
      if (best === null || o.key > best) best = o.key;
    }
    if (!r.truncated) break;
    cursor = r.cursor;
  }
  if (!best) return null;
  const o = await c.bucket.get(best);
  if (!o) return null;
  return { key: best, doc: JSON.parse(await o.text()) as CredsCopy };
}

/**
 * Load the newest copy into `creds` (and one history row per applied path). A row the store holds with an equal
 * or newer seq stays. Returns what it did; ring `creds/restore-c` and alert `creds-restored-c` when it applied.
 */
export async function restoreCredsFromCopy(
  c: Ctx,
): Promise<{ key: string | null; applied: number; kept: number; rows: number }> {
  const got = await newestCredsCopy(c);
  if (!got) {
    ring(c, "creds", "restore-c-none", {});
    return { key: null, applied: 0, kept: 0, rows: 0 };
  }
  let applied = 0;
  let kept = 0;
  c.db.tx(() => {
    for (const r of got.doc.rows) {
      const cur = c.db.one<{ seq: number }>("SELECT seq FROM creds WHERE path = ?", r.path);
      if (cur && cur.seq >= r.seq) {
        kept++;
        continue;
      }
      c.db.run(
        `INSERT INTO creds (path, gen, seq, sha256, mode, b64, r2_key, deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET gen = excluded.gen, seq = excluded.seq, sha256 = excluded.sha256,
           mode = excluded.mode, b64 = excluded.b64, r2_key = excluded.r2_key, deleted = excluded.deleted,
           updated_at = excluded.updated_at`,
        r.path,
        r.gen,
        r.seq,
        r.sha256,
        r.mode,
        r.b64,
        r.r2_key,
        r.deleted,
        r.updated_at,
      );
      c.db.run(
        `INSERT OR REPLACE INTO creds_hist (path, seq, gen, sha256, mode, b64, r2_key, deleted, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.path,
        r.seq,
        r.gen,
        r.sha256,
        r.mode,
        r.b64,
        r.r2_key,
        r.deleted,
        c.now(),
      );
      applied++;
    }
    c.db.setMeta("credsCopySeq", Math.max(c.db.metaNum("credsCopySeq", 0), got.doc.seq));
    c.db.setMeta("credsRestoredFrom", got.key);
  });
  ring(c, "creds", "restore-c", { key: got.key, seq: got.doc.seq, rows: got.doc.rows.length, applied, kept });
  if (applied)
    alert(
      c,
      "creds-restored-c",
      "high",
      `${applied} creds rows restored from ${got.key} (Control DO rewound)`,
    );
  return { key: got.key, applied, kept, rows: got.doc.rows.length };
}

// ---------------------------------------------------------------- drill J: config copy

export const configCopyKey = (inst: string) => `${credsCopyPrefix(inst)}config.json`;
export interface ConfigCopy {
  v: 1;
  inst: string;
  at: number;
  rows: {
    ver: number;
    schema_sha: string | null;
    status: string;
    source: string | null;
    sha: string | null;
    dark_origin: number;
    base_ver: number | null;
    doc: string;
    good_digest: string | null;
    created_at: number;
  }[];
}

/**
 * Drill J: `c/<inst>/config.json` = the newest 20 config versions plus the newest good one, rewritten when a
 * version or a status changed (checked each tick; one small PUT per change).
 */
export async function copyConfigIfDue(c: Ctx): Promise<{ wrote: boolean }> {
  const rows = c.db.all<ConfigCopy["rows"][number]>(
    `SELECT ver, schema_sha, status, source, sha, dark_origin, base_ver, doc, good_digest, created_at FROM config
     WHERE ver IN (SELECT ver FROM config ORDER BY ver DESC LIMIT 20)
        OR ver = (SELECT MAX(ver) FROM config WHERE status = 'good') ORDER BY ver`,
  );
  if (!rows.length) return { wrote: false };
  const tag = rows.map((r) => `${r.ver}:${r.status}`).join(",");
  if (c.db.meta("configCopyTag") === tag) return { wrote: false };
  const doc: ConfigCopy = { v: 1, inst: c.inst, at: c.now(), rows };
  await c.bucket.put(configCopyKey(c.inst), JSON.stringify(doc));
  c.db.setMeta("configCopyTag", tag);
  ring(c, "config", "copy", { n: rows.length, newest: rows[rows.length - 1]?.ver });
  return { wrote: true };
}
