// CredStore owner side (plan §4.10, §6.1 row 2). The write-through wire (PUT/DELETE/GET /v1/creds/*) is the
// gates' ledger (src/gates/ledger.ts) on the same tables. Here: manifest for status, history and the manual
// restore from history (`/ops/creds/restore`), and the hwm credsSeq.
import { CAPS } from "../gates/ledger";
import { alert } from "./alerts";
import type { Ctx } from "./ctx";

const HIST_KEEP = CAPS.credsHistPerPath;
const HIST_DAYS = 30;
const DAY = 86_400_000;

export interface CredRow {
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

type Res = { status: number; body: Record<string, unknown> };

function b64Size(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

export function getCred(c: Ctx, path: string): CredRow | null {
  return c.db.one<CredRow>("SELECT * FROM creds WHERE path = ?", path);
}

function hist(
  c: Ctx,
  path: string,
  gen: number,
  seq: number,
  sha: string | null,
  mode: number | null,
  b64: string | null,
  r2: string | null,
  deleted: number,
  at: number,
): void {
  c.db.run(
    `INSERT INTO creds_hist (path, seq, gen, sha256, mode, b64, r2_key, deleted, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path, seq) DO UPDATE SET gen = excluded.gen, sha256 = excluded.sha256, mode = excluded.mode,
       b64 = excluded.b64, r2_key = excluded.r2_key, deleted = excluded.deleted, at = excluded.at`,
    path,
    seq,
    gen,
    sha,
    mode,
    b64,
    r2,
    deleted,
    at,
  );
  // sec F2: newest HIST_KEEP versions per path; versions older than HIST_DAYS go except the newest one.
  // (The old `at < 30 d AND seq NOT IN newest 50` kept every version younger than 30 d.)
  c.db.run(
    `DELETE FROM creds_hist WHERE path = ? AND seq NOT IN
       (SELECT seq FROM creds_hist WHERE path = ? ORDER BY seq DESC LIMIT ?)`,
    path,
    path,
    HIST_KEEP,
  );
  c.db.run(
    "DELETE FROM creds_hist WHERE path = ? AND at < ? AND seq <> (SELECT MAX(seq) FROM creds_hist WHERE path = ?)",
    path,
    at - HIST_DAYS * DAY,
    path,
  );
}

/** GET /v1/creds/manifest. */
export function credManifest(c: Ctx): {
  seq: number;
  files: { path: string; seq: number; sha256: string; mode: number; deleted: boolean; size: number }[];
} {
  const rows = c.db.all<CredRow>("SELECT * FROM creds ORDER BY path");
  const seq = rows.reduce((m, r) => Math.max(m, r.seq), 0);
  return {
    seq,
    files: rows
      .filter((r) => !r.deleted)
      .map((r) => ({
        path: r.path,
        seq: r.seq,
        sha256: r.sha256 ?? "",
        mode: r.mode ?? 0o600,
        deleted: false,
        size: r.b64 ? b64Size(r.b64) : 0,
      })),
  };
}

export function credHistory(c: Ctx, path: string): Omit<CredRow, "b64" | "updated_at">[] {
  return c.db.all(
    "SELECT path, seq, gen, sha256, mode, r2_key, deleted, at FROM creds_hist WHERE path = ? ORDER BY gen DESC, seq DESC",
    path,
  );
}

export function maxCredSeq(c: Ctx): number {
  return c.db.one<{ m: number | null }>("SELECT MAX(seq) AS m FROM creds")?.m ?? 0;
}

/**
 * Owner restore from history (`/ops/creds/restore`, plan §4.10 manual restore). Writes the old bytes as a new
 * version: same gen as the current row, seq + 1, so the next boot's credsync sees it as newest.
 */
export function credRestore(c: Ctx, path: string, seq: number): Res {
  return c.db.tx(() => {
    const h = c.db.one<CredRow & { at: number }>(
      "SELECT * FROM creds_hist WHERE path = ? AND seq = ?",
      path,
      seq,
    );
    if (!h || h.deleted) return { status: 404, body: { error: "no-version" } };
    const cur = getCred(c, path);
    const gen = cur?.gen ?? h.gen ?? 0;
    const next = (cur?.seq ?? h.seq) + 1;
    const now = c.now();
    c.db.run(
      `INSERT INTO creds (path, gen, seq, sha256, mode, b64, r2_key, deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(path) DO UPDATE SET gen = excluded.gen, seq = excluded.seq, sha256 = excluded.sha256,
         mode = excluded.mode, b64 = excluded.b64, r2_key = excluded.r2_key, deleted = 0, updated_at = excluded.updated_at`,
      path,
      gen,
      next,
      h.sha256,
      h.mode,
      h.b64,
      h.r2_key,
      now,
    );
    hist(c, path, gen, next, h.sha256, h.mode, h.b64, h.r2_key, 0, now);
    alert(c, "creds-restored", "warn", `${path} restored from seq ${seq} as seq ${next}`);
    return { status: 200, body: { ok: true, seq: next } };
  });
}
