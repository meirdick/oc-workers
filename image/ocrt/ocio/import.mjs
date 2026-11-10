// ocio import (uid 1000): apply an `ochost import` workspace bundle (docs/10-cli-spec.md §1.2).
// Usage: node import.mjs apply <json-args>. One JSON line out.
//   apply {archive, workspace, stage, id, overwrite:[rel], remove:[rel]}
//     -> {ok, added, same, replaced, kept, removed, skipped, bytes, lists:{replaced, kept, removed, skipped}}
// The bundle is a tar.gz of paths relative to the workspace. It is extracted into `stage` first (a fresh dir
// in the uid-1000 state tree), then each regular file is merged into `workspace`:
//   missing                 -> added
//   same bytes              -> same      (so a second run changes nothing: the import is idempotent)
//   other bytes, in overwrite -> replaced (the old file goes to <workspace>/.ochost-import/<id>/backup/<rel>),
//                              once: a file an earlier import replaced is kept (a rerun keeps later edits)
//   other bytes, otherwise  -> kept      (the install's file wins; the import never clobbers new work)
// `remove` paths that exist as regular files move to the same backup (BOOTSTRAP.md: the old install already ran
// its first-run ritual). Symlinks, devices and paths through a symlinked dir are skipped. The stage is removed
// at the end.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ignoreTerm, mkdirSafe, out, readSafe, unsafeDirs, writeAtomic } from "./_common.mjs";

ignoreTerm();
const [op, argJson] = process.argv.slice(2);
const a = argJson ? JSON.parse(argJson) : {};
const LIST_MAX = 50;
const FILE_MAX = 512 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const sha = (b) => createHash("sha256").update(b).digest("hex");

/** Regular files under root as relative paths; symlinks and other kinds are reported, never followed. */
function walk(root) {
  const files = [];
  const skipped = [];
  const rec = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(dir, e.name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) rec(p, r);
      else if (st.isFile()) files.push(r);
      else skipped.push({ rel: r, why: st.isSymbolicLink() ? "symlink" : "not-file" });
    }
  };
  rec(root, "");
  return { files: files.sort(), skipped };
}

/** True when an earlier import id holds a backup of rel (that import replaced it). */
function replacedBefore(ws, rel) {
  let ids = [];
  try {
    ids = fs.readdirSync(path.join(ws, ".ochost-import"));
  } catch {
    return false;
  }
  return ids.some((id) => fs.existsSync(path.join(ws, ".ochost-import", id, "backup", rel)));
}

function apply() {
  if (!ID_RE.test(String(a.id))) throw new Error("bad id");
  const ws = path.resolve(a.workspace);
  const stage = path.resolve(a.stage);
  const overwrite = new Set(Array.isArray(a.overwrite) ? a.overwrite.map(String) : []);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  fs.mkdirSync(ws, { recursive: true, mode: 0o700 });
  try {
    // Absolute tar (F-SEC-1). GNU tar drops leading '/' and refuses members with '..'; links are dropped by the
    // walk below. --no-same-owner/permissions: files land as uid 1000 under umask 022.
    const r = spawnSync(
      "/usr/bin/tar",
      ["-xzf", a.archive, "--no-same-owner", "--no-same-permissions", "-C", stage],
      { encoding: "utf8", timeout: a.timeoutMs || 300_000, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" } },
    );
    if (r.status !== 0) return { ok: false, error: `tar ${r.status ?? r.signal}: ${String(r.stderr).slice(-300)}` };
    const { files, skipped } = walk(stage);
    const res = { ok: true, added: 0, same: 0, replaced: 0, kept: 0, skipped: skipped.length, bytes: 0 };
    const lists = { replaced: [], kept: [], skipped: skipped.slice(0, LIST_MAX) };
    const backupRoot = `.ochost-import/${a.id}/backup`;
    // `openclaw backup create --verify` refuses two paths that differ only in case; never add one.
    const lower = new Map();
    for (const rel of walk(ws).files) lower.set(rel.toLowerCase(), rel);
    for (const rel of files) {
      if (rel.startsWith(".ochost-import/")) {
        res.skipped++;
        if (lists.skipped.length < LIST_MAX) lists.skipped.push({ rel, why: "reserved" });
        continue;
      }
      const src = readSafe(path.join(stage, rel), FILE_MAX);
      if (src.err) {
        res.skipped++;
        if (lists.skipped.length < LIST_MAX) lists.skipped.push({ rel, why: src.err });
        continue;
      }
      const bad = unsafeDirs(ws, rel);
      if (bad && bad !== "ENOENT") {
        res.skipped++;
        if (lists.skipped.length < LIST_MAX) lists.skipped.push({ rel, why: bad });
        continue;
      }
      const dest = path.join(ws, rel);
      let st = null;
      try {
        st = fs.lstatSync(dest);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (st && !st.isFile()) {
        res.skipped++;
        if (lists.skipped.length < LIST_MAX) lists.skipped.push({ rel, why: st.isSymbolicLink() ? "dest-symlink" : "dest-not-file" });
        continue;
      }
      if (st) {
        const cur = readSafe(dest, FILE_MAX);
        if (!cur.err && sha(cur.buf) === sha(src.buf)) {
          res.same++;
          continue;
        }
        // Replace a bootstrap file once: when an earlier import already did (its backup exists), the file there is
        // the old install's or a later edit, and a rerun keeps it.
        if (!overwrite.has(rel) || replacedBefore(ws, rel)) {
          res.kept++;
          if (lists.kept.length < LIST_MAX) lists.kept.push(rel);
          continue;
        }
        if (!cur.err) {
          const b = `${backupRoot}/${rel}`;
          mkdirSafe(ws, path.dirname(b));
          writeAtomic(path.join(ws, b), cur.buf, 0o600);
        }
        writeAtomic(dest, src.buf, 0o644);
        res.replaced++;
        res.bytes += src.buf.length;
        if (lists.replaced.length < LIST_MAX) lists.replaced.push(rel);
        continue;
      }
      const twin = lower.get(rel.toLowerCase());
      if (twin && twin !== rel) {
        res.skipped++;
        if (lists.skipped.length < LIST_MAX) lists.skipped.push({ rel, why: `case-collision with ${twin}` });
        continue;
      }
      mkdirSafe(ws, path.dirname(rel));
      writeAtomic(dest, src.buf, 0o644);
      lower.set(rel.toLowerCase(), rel);
      res.added++;
      res.bytes += src.buf.length;
    }
    res.removed = 0;
    lists.removed = [];
    for (const rel of Array.isArray(a.remove) ? a.remove.map(String) : []) {
      if (unsafeDirs(ws, rel)) continue;
      const p = path.join(ws, rel);
      const cur = readSafe(p, FILE_MAX);
      if (cur.err) continue;
      const b = `${backupRoot}/${rel}`;
      mkdirSafe(ws, path.dirname(b));
      writeAtomic(path.join(ws, b), cur.buf, 0o600);
      fs.unlinkSync(p);
      res.removed++;
      lists.removed.push(rel);
    }
    const summary = { ...res, lists, at: Date.now() };
    mkdirSafe(ws, `.ochost-import/${a.id}`);
    writeAtomic(path.join(ws, `.ochost-import/${a.id}/result.json`), JSON.stringify(summary, null, 2), 0o644);
    return summary;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

try {
  if (op !== "apply") {
    out({ ok: false, error: `unknown op ${op}` });
    process.exitCode = 2;
  } else {
    const r = apply();
    out(r);
    if (!r.ok) process.exitCode = 1;
  }
} catch (e) {
  out({ ok: false, error: String(e?.message || e).slice(0, 300) });
  process.exitCode = 1;
}
