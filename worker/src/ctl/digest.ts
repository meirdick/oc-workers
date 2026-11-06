// F1 digest guard (M4b): the deploy skew gate and beginBoot refuse or defer an image digest change that would
// lose the workspace.

import { alert } from "./alerts";
import { requestArchive } from "./archives";
import { type Ctx, ring } from "./ctx";

/** guess: the archive age bound of plan §6.1 row 7 (6 h) as the slack a boot-time digest change allows. */
export const DIGEST_ARCHIVE_SLACK_MS = 6 * 3_600_000;

export interface DigestGuard {
  ok: boolean;
  why?: string;
  snapshotAt: number | null;
  archiveAt: number | null;
  archiveId: string | null;
}

/**
 * F1 (M4 sleep): a new image digest forces the image path (image + newest archive + gen); an archive without
 * the workspace, or one much older than the newest snapshot, loses the workspace. ok when there is no usable
 * snapshot to lose, or the newest complete archive with the workspace is newer than the newest snapshot minus
 * `slackMs` (0 at the deploy skew gate; DIGEST_ARCHIVE_SLACK_MS at a boot).
 */
export function digestGuard(c: Ctx, digest: string | null, slackMs = 0): DigestGuard {
  const snap = c.db.one<{ created_at: number }>(
    `SELECT created_at FROM snapshots WHERE state IN ('ok', 'suspect')${digest ? " AND digest = ?" : ""}
     ORDER BY created_at DESC LIMIT 1`,
    ...(digest ? [digest] : []),
  );
  const arch = c.db.one<{ id: string; created_at: number }>(
    `SELECT id, created_at FROM archives WHERE state = 'complete' AND COALESCE(ws_missing, 0) = 0
       AND (ws_entries IS NULL OR ws_entries > 0) ORDER BY created_at DESC LIMIT 1`,
  );
  const out = {
    snapshotAt: snap?.created_at ?? null,
    archiveAt: arch?.created_at ?? null,
    archiveId: arch?.id ?? null,
  };
  if (!snap) return { ok: true, ...out };
  if (!arch) return { ok: false, why: "no archive with the workspace", ...out };
  if (arch.created_at <= snap.created_at - slackMs)
    return { ok: false, why: "newest archive is older than the newest snapshot", ...out };
  return { ok: true, ...out };
}

/**
 * beginBoot side of F1 (a raw `wrangler deploy` skips the skew gate): when the deployed digest differs from the
 * epoch digest and the guard fails with DIGEST_ARCHIVE_SLACK_MS, the boot keeps the old digest (snapshot path),
 * asks for a pre-upgrade archive, and alerts once. The next boot after that archive takes the new digest.
 */
export function deferDigest(c: Ctx, from: string, to: string): boolean {
  const g = digestGuard(c, from, DIGEST_ARCHIVE_SLACK_MS);
  if (g.ok) return false;
  const req = c.db.metaJson<{ state?: string; reason?: string } | null>("archiveRequest", null);
  if (!req || !["pending", "running"].includes(req.state ?? "")) requestArchive(c, "pre-upgrade");
  ring(c, "epoch", "digest-deferred", {
    from,
    to,
    why: g.why,
    snapshotAt: g.snapshotAt,
    archiveAt: g.archiveAt,
  });
  alert(c, "digest-deferred", "warn", `image ${to.slice(0, 19)} waits for a pre-upgrade archive (${g.why})`);
  return true;
}
