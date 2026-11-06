// ocio helper (uid 1000): workspace facts and repair at boot (spec 08 §8.3 B1). The workspace files live
// only on the rootfs; their identity lives in the state DB (workspace_setup_state). A boot that pairs an
// older rootfs with a newer gen can leave an attested workspace empty; OpenClaw then answers every message
// with a "workspace is missing" notice (WorkspaceVanishedError). ocsup checks before the gateway starts.
// Usage: node workspace.mjs <op> <json-args>. One JSON line out.
//   check   {db, state}                 -> {ok, attested:[{path, entries}], missing:[path], noTable?}
//   reset   {db, paths:[abs]}           -> {ok, deleted}  (owner accepted loss: OpenClaw seeds a new workspace)
//   extract {archive, state}            -> {ok, files, dirs}  (workspace/ and workspace-*/ files of an `openclaw backup` archive)
// Table shape from OpenClaw 2026.9.x (OPENCLAW_STATE_SCHEMA_SQL): workspace_setup_state(workspace_key,
// workspace_path, version, bootstrap_seeded_at, setup_completed_at, updated_at, attested_at_ms, ...).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ignoreTerm, out } from "./_common.mjs";

ignoreTerm();
const [op, argJson] = process.argv.slice(2);
const a = argJson ? JSON.parse(argJson) : {};

/** Entries in a dir (any kind); -1 when it is missing, not a dir, or a symlink. */
function entries(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return -1;
  }
  if (!st.isDirectory()) return -1;
  try {
    return fs.readdirSync(p).length;
  } catch {
    return -1;
  }
}

function attestedPaths(db) {
  if (!fs.existsSync(db)) return { rows: [], noDb: true };
  const c = new DatabaseSync(db, { readOnly: true });
  try {
    const rows = c
      .prepare(
        `SELECT DISTINCT workspace_path AS p FROM workspace_setup_state
         WHERE workspace_path IS NOT NULL
           AND (bootstrap_seeded_at IS NOT NULL OR setup_completed_at IS NOT NULL OR attested_at_ms IS NOT NULL)`,
      )
      .all();
    return { rows: rows.map((r) => String(r.p)) };
  } catch (e) {
    if (/no such table|no such column/.test(String(e.message))) return { rows: [], noTable: true };
    throw e;
  } finally {
    c.close();
  }
}

try {
  switch (op) {
    case "check": {
      const { rows, noTable, noDb } = attestedPaths(a.db);
      const attested = [];
      const missing = [];
      for (const p of rows) {
        // Only paths under the state root or the home dir are ours to judge; others are listed, not judged.
        const r = path.resolve(p);
        const n = entries(r);
        attested.push({ path: r, entries: n });
        if (n <= 0) missing.push(r);
      }
      out({
        ok: true,
        attested,
        missing,
        ...(noTable ? { noTable: true } : {}),
        ...(noDb ? { noDb: true } : {}),
      });
      break;
    }
    case "reset": {
      const c = new DatabaseSync(a.db);
      let deleted = 0;
      try {
        c.exec("PRAGMA busy_timeout = 5000");
        const st = c.prepare("DELETE FROM workspace_setup_state WHERE workspace_path = ?");
        for (const p of a.paths || []) deleted += Number(st.run(p).changes || 0);
      } finally {
        c.close();
      }
      out({ ok: true, deleted });
      break;
    }
    case "extract": {
      // Archive layout (`openclaw backup create`): <stamp>-openclaw-backup/payload/posix<abs path>/...
      // Take every workspace dir directly under <state>: workspace/ and any workspace-<name>/ a second agent
      // uses (M8 live: agent `dev` at workspace-dev was attested but not restored, every boot blocked).
      // --no-same-owner/permissions: files land as uid 1000, umask applies.
      const state = path.resolve(a.state);
      const rel = `payload/posix${state}`;
      const strip = 1 + rel.split("/").length; // stamp dir + path up to and including <state>
      fs.mkdirSync(path.join(state, "workspace"), { recursive: true, mode: 0o700 });
      // Absolute path (F-SEC-1); `tar` resolves gzip by name, so the child PATH is root's fixed one.
      const r = spawnSync(
        "/usr/bin/tar",
        [
          "-xzf",
          a.archive,
          "--wildcards",
          "--no-same-owner",
          "--no-same-permissions",
          "--no-overwrite-dir",
          `--strip-components=${strip}`,
          "-C",
          state,
          `*/${rel}/workspace/*`,
          `*/${rel}/workspace-*/*`,
        ],
        {
          encoding: "utf8",
          timeout: a.timeoutMs || 300_000,
          env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
        },
      );
      // An archive made while workspace/ was empty has only the dir entry: the member pattern matches nothing
      // and tar exits 2 "Not found in archive" (M3 e2e live). That is an empty workspace, not a bad archive;
      // the workspace step then decides (attested + empty → blocked, else OpenClaw seeds it). With two patterns
      // tar says so once per unmatched pattern; any other error is a bad archive.
      const err = String(r.stderr || "");
      const notFound =
        r.status === 2 &&
        err
          .split("\n")
          .filter((l) => l.trim())
          .every((l) => /Not found in archive|Exiting with failure status/.test(l));
      if (r.status !== 0 && !notFound) {
        out({ ok: false, error: `tar ${r.status ?? r.signal}: ${err.slice(-300)}` });
        process.exitCode = 1;
        break;
      }
      const dirs = fs
        .readdirSync(state, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^workspace(-[A-Za-z0-9_.-]+)?$/.test(e.name))
        .map((e) => e.name)
        .sort();
      const perDir = Object.fromEntries(dirs.map((n) => [n, entries(path.join(state, n))]));
      out({ ok: true, files: perDir.workspace ?? 0, dirs: perDir });
      break;
    }
    default:
      out({ ok: false, error: `unknown op ${op}` });
      process.exitCode = 2;
  }
} catch (e) {
  out({ ok: false, error: String(e?.message || e).slice(0, 300) });
  process.exitCode = 1;
}
