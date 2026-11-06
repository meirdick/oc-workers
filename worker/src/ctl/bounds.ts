// Control DO storage bounds (sec F2, spec §3.2 "tables stay bounded"). SQLite-backed DO storage stops every
// write at its 10 GB cap; then beginBoot, inboxPut, heartbeats and ensure() all fail. Two layers:
// - per-write caps in the gates' ledger (creds_hist, creds paths, config, plugins, shadows, alerts) and here
//   (creds_hist from owner restores, config from owner edits);
// - `boundsTick` (daily and from ensure()/tick): row caps that keep the newest N, and a storage guard that
//   prunes hard above STORAGE.soft. Pruning past a cap alerts `ctl-prune` (1/h); the guard alerts
//   `ctl-storage-high`. Growth writes above STORAGE.hard get 507 `ctl-full` in the gates, so ensure() and the
//   small rows of a boot keep fitting.
import { CAPS, pruneAlertRows, pruneConfigRows, pruneRowsByVer, type StorageLimits } from "../gates/ledger";
import { alert } from "./alerts";
import { type Ctx, ring } from "./ctx";

/** Newest dead inbox rows kept (bodies ≤ 1 MiB each); older dead rows go before their 24 h keep time. */
export const DEAD_KEEP = 500;
/** Per-gen gate rows (hello, badsig, log seq, boot budget, hb seq, per-level stats) of the newest N gens. */
export const GEN_ROWS_KEEP = 50;
/** Emergency caps above STORAGE.soft. */
export const HARD = Object.freeze({ credsHistPerPath: 3, configRows: 10, pluginRows: 5, ring: 100 });

function del(c: Ctx, where: string, ...b: (string | number)[]): number {
  const n = c.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${where}`, ...b)?.n ?? 0;
  if (n) c.db.run(`DELETE FROM ${where}`, ...b);
  return n;
}

const GEN_TABLES = ["gate_hello", "gate_badsig", "log_seq", "gate_boot", "gate_hbseq", "gendb_level"];

export interface BoundsResult {
  size: number | null;
  pruned: Record<string, number>;
  hard: boolean;
}

/** Settings storage.pruneAtMb and refuseAtMb in bytes. */
export function storageLimits(c: Ctx): StorageLimits {
  const s = c.settings().storage;
  return { soft: s.pruneAtMb * 1_000_000, hard: s.refuseAtMb * 1_000_000 };
}

/** Row caps (always) and the storage guard (above the prune limit). Sync; never throws on a missing table. */
export function boundsTick(c: Ctx, o: { size?: number | null } = {}): BoundsResult {
  const size = o.size !== undefined ? o.size : c.db.size();
  const soft = storageLimits(c).soft;
  const hard = size !== null && size >= soft;
  const pruned: Record<string, number> = {};
  const add = (k: string, n: number) => {
    if (n) pruned[k] = (pruned[k] ?? 0) + n;
  };
  const histKeep = hard ? HARD.credsHistPerPath : CAPS.credsHistPerPath;
  c.db.tx(() => {
    add(
      "creds_hist",
      del(
        c,
        `creds_hist WHERE (path, seq) NOT IN (SELECT path, seq FROM (SELECT path, seq, ROW_NUMBER() OVER
         (PARTITION BY path ORDER BY seq DESC) AS rn FROM creds_hist) WHERE rn <= ${histKeep})`,
      ),
    );
    add("config", pruneConfigRows(c.db.store, hard ? HARD.configRows : CAPS.configRows));
    add("plugins", pruneRowsByVer(c.db.store, "plugins", hard ? HARD.pluginRows : CAPS.pluginRows));
    add("alerts", pruneAlertRows(c.db.store));
    add(
      "inbox-dead",
      del(
        c,
        `inbox WHERE state = 'dead' AND id NOT IN (SELECT id FROM inbox WHERE state = 'dead'
         ORDER BY received_at DESC LIMIT ${hard ? 0 : DEAD_KEEP})`,
      ),
    );
    const top = c.db.one<{ m: number | null }>("SELECT MAX(gen) AS m FROM gens")?.m ?? 0;
    for (const t of GEN_TABLES)
      try {
        add(t, del(c, `${t} WHERE gen <= ?`, top - GEN_ROWS_KEEP));
      } catch {
        // gate table not created yet (ledger.migrate runs after ctl migrate in ControlApi)
      }
    if (hard) {
      add("ring", del(c, `ring WHERE id <= (SELECT MAX(id) FROM ring) - ${HARD.ring}`));
      add("ltx", del(c, "ltx WHERE gen IN (SELECT gen FROM gens WHERE state IN ('deleted', 'abandoned'))"));
      add("shadow_rate", del(c, "shadow_rate WHERE at < ?", c.now() - 3_600_000));
    }
  });
  const total = Object.values(pruned).reduce((a, b) => a + b, 0);
  if (total) {
    const what = Object.entries(pruned)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    ring(c, "bounds", "pruned", { ...pruned, size, what });
  }
  if (hard) alert(c, "ctl-storage-high", "high", `Control DO storage ${size} bytes ≥ ${soft}`);
  return { size, pruned, hard };
}

/** Guard for ensure(): run the caps when storage is high, or once per hour. Never throws. */
export function boundsGuard(c: Ctx): BoundsResult | null {
  try {
    const size = c.db.size();
    const last = c.db.metaNum("boundsAt", 0);
    if ((size === null || size < storageLimits(c).soft) && c.now() - last < 3_600_000) return null;
    c.db.setMeta("boundsAt", c.now());
    return boundsTick(c, { size });
  } catch (e) {
    try {
      ring(c, "bounds", "error", String(e).slice(0, 300));
    } catch {
      // storage refuses writes: the caller goes on (ensure must still try to start a boot)
    }
    return null;
  }
}
