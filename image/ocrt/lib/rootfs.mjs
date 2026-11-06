// Root-owned system dirs (demo cutover 2026-11-05, M6 polish live: Doctor exit 78).
// On Cloudflare the container's "/" was owned by uid 2346 (not set by the image: every layer is 0:0).
// OpenClaw 2026.10.9 walks every ancestor up to "/" of its temp root (@openclaw/fs-safe: owner must be the
// euid, root, or the overflow uid) and of its SQLite staging root (owner euid or root, no foreign
// group/world write). One foreign ancestor fails Doctor and the gateway's temp workspaces.
// ocsup is root at start: it gives these dirs back to root and drops group/world write (sticky dirs keep
// theirs) before any uid-1000 child runs. Leaf module: node:fs only.
import fs from "node:fs";

/** Ancestors of the OpenClaw state, temp and stage paths. /home/node stays uid 1000. */
export const ROOT_DIRS = ["/", "/home", "/tmp", "/var", "/var/lib", "/run"];

/**
 * Returns {fixed:[{path, uid, gid, mode, chown?, chmod?, err?}]}: one row per dir that was not root-owned
 * or was group/world writable without the sticky bit. Missing dirs are skipped.
 */
export function fixRootOwners({ dirs = ROOT_DIRS, fsx = fs } = {}) {
  const fixed = [];
  for (const p of dirs) {
    let st;
    try {
      st = fsx.lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const perm = st.mode & 0o7777;
    const badOwner = st.uid !== 0;
    const badMode = (perm & 0o022) !== 0 && (perm & 0o1000) === 0;
    if (!badOwner && !badMode) continue;
    const row = { path: p, uid: st.uid, gid: st.gid, mode: perm.toString(8) };
    try {
      if (badOwner) {
        fsx.chownSync(p, 0, 0);
        row.chown = "0:0";
      }
      if (badMode) {
        fsx.chmodSync(p, perm & ~0o022);
        row.chmod = (perm & ~0o022).toString(8);
      }
    } catch (e) {
      row.err = e.code || e.message;
    }
    fixed.push(row);
  }
  return { fixed };
}
