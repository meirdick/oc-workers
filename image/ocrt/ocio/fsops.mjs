// ocio fsops: one-shot file jobs in uid-1000 trees (plan §4.13, §6.2 steps 3, 6; amend §1.5 F1.2;
// scope §1.1 row "Other SQLite"). Usage: node fsops.mjs <op> <json-args>. Prints one JSON line.
//   scan        {state, maxEntries?}          -> {sqlite:[{rel,size,mtimeMs,walSize,walMtimeMs,nlink,symlink}], truncated}
//   wipe        {dirs:[abs]}                  -> {removed:[...]}
//   empty       {dirs:[abs]}                  -> {removed:[...]}  (children only; the dir's parent is root's)
//   wipe-legacy {state, rels:[rel]}           -> {removed:[...]}  (.<file>-litestream beside a DB, F1.2)
//   unlink-db   {state, rels:[rel]}           -> {removed:[...]}  (DB + -wal + -shm, plan §6.2 step 6)
//   place       {src, state, rel}             -> {ok, bytes}       (copy, fsync, rename; removes -wal/-shm)
//   quickcheck  {file}                        -> {ok, result}
//   safe        {state, rels:[rel]}           -> {bad:[{rel, why}]}
//   max-txid    {dirs:{id: abs}}              -> {txid:{id: n}}    (local level-0 max TXID per DB)
//   dirty       {state, sinceMs, maxEntries?} -> {count, bytes, newestMs, sample:[rel], truncated}
//               files changed after sinceMs (M4 A4 checkpoint; plan §4.12 "Dirty source"). Skips SQLite
//               and its -wal/-shm/-journal (Litestream and shadows own them), Litestream meta dirs,
//               node_modules (plugin installs are recorded in the manifest).
import fs from "node:fs";
import path from "node:path";
import { ignoreTerm, mkdirSafe, openSafe, out, unsafeDirs } from "./_common.mjs";

ignoreTerm();
const [op, argJson] = process.argv.slice(2);
const a = argJson ? JSON.parse(argJson) : {};

const SKIP_DIRS = new Set(["node_modules", ".git"]);

function scan(state, maxEntries = 200_000) {
  const sqlite = [];
  let n = 0;
  let truncated = false;
  const walk = (dir, rel, depth) => {
    if (depth > 16 || truncated) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (++n > maxEntries) {
        truncated = true;
        return;
      }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r, depth + 1);
      } else if (/\.sqlite$/.test(e.name) && (e.isFile() || e.isSymbolicLink())) {
        const st = fs.lstatSync(path.join(dir, e.name));
        // N5: a WAL DB with an open writer changes only its -wal file; the shadow change test needs both.
        let wal = null;
        try {
          wal = fs.lstatSync(path.join(dir, `${e.name}-wal`));
        } catch {}
        sqlite.push({
          rel: r,
          size: st.size,
          mtimeMs: Math.round(st.mtimeMs),
          walSize: wal?.isFile() ? wal.size : 0,
          walMtimeMs: wal?.isFile() ? Math.round(wal.mtimeMs) : 0,
          nlink: st.nlink,
          symlink: st.isSymbolicLink(),
        });
      }
    }
  };
  walk(state, "", 0);
  return { sqlite: sqlite.sort((x, y) => (x.rel < y.rel ? -1 : 1)), truncated };
}

const DB_FILE = /\.sqlite(-wal|-shm|-journal)?$|\.db(-wal|-shm|-journal)?$/;
const NOISE_DIR = /^(node_modules|\.cache|cache|caches|\.npm|\.pnpm-store)$|-litestream$/;
const TOP_NOISE_DIR = /^(tmp|logs?)$/;
const NOISE_FILE = /\.(lock|log|pid)$|\.log\.\d+$/;

function dirty(state, sinceMs, maxEntries = 200_000) {
  let count = 0;
  let bytes = 0;
  let newestMs = 0;
  let n = 0;
  let truncated = false;
  const sample = [];
  const walk = (dir, rel, depth) => {
    if (depth > 24 || truncated) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (++n > maxEntries) {
        truncated = true;
        return;
      }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // M4b N2: lock files under tmp/ (rewritten every few s by the gateway), logs and caches made an idle
        // install always dirty; they are not state a crash restart needs.
        if (!NOISE_DIR.test(e.name) && !(depth === 0 && TOP_NOISE_DIR.test(e.name)))
          walk(path.join(dir, e.name), r, depth + 1);
        continue;
      }
      if (DB_FILE.test(e.name) || NOISE_FILE.test(e.name)) continue;
      let st;
      try {
        st = fs.lstatSync(path.join(dir, e.name));
      } catch {
        continue;
      }
      const m = Math.max(st.mtimeMs, st.ctimeMs);
      if (m > sinceMs) {
        count++;
        bytes += st.size;
        newestMs = Math.max(newestMs, Math.round(m));
        if (sample.length < 5) sample.push(r);
      }
    }
  };
  walk(state, "", 0);
  return { count, bytes, newestMs: newestMs || null, sample, truncated };
}

function rmTree(p) {
  try {
    fs.lstatSync(p);
  } catch {
    return false;
  }
  fs.rmSync(p, { recursive: true, force: true }); // never follows symlinks inside
  return true;
}

function quickcheck(file) {
  const o = openSafe(file);
  if (o.err) return { ok: false, result: o.err };
  fs.closeSync(o.fd);
  try {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    const r = db.prepare("PRAGMA quick_check").all();
    db.close();
    const result = r.map((x) => Object.values(x)[0]).join("; ");
    return { ok: result === "ok", result };
  } catch (e) {
    return { ok: false, result: String(e.message || e).slice(0, 300) };
  }
}

function maxTxid(dir) {
  try {
    let max = 0;
    for (const n of fs.readdirSync(path.join(dir, "ltx", "0"))) {
      const m = /^[0-9a-f]{16}-([0-9a-f]{16})\.ltx$/.exec(n);
      if (m) max = Math.max(max, Number.parseInt(m[1], 16));
    }
    return max;
  } catch {
    return 0;
  }
}

try {
  switch (op) {
    case "scan":
      out(scan(a.state, a.maxEntries));
      break;
    case "dirty":
      out(dirty(a.state, Number(a.sinceMs) || 0, a.maxEntries));
      break;
    case "wipe":
      out({ removed: a.dirs.filter((d) => rmTree(d)) });
      break;
    case "empty": {
      const removed = [];
      for (const d of a.dirs) {
        let st;
        try {
          st = fs.lstatSync(d);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        for (const n of fs.readdirSync(d)) if (rmTree(path.join(d, n))) removed.push(path.join(d, n));
      }
      out({ removed });
      break;
    }
    case "wipe-legacy": {
      const removed = [];
      for (const rel of a.rels) {
        if (unsafeDirs(a.state, rel)) continue;
        const p = path.join(a.state, path.dirname(rel), `.${path.basename(rel)}-litestream`);
        if (rmTree(p)) removed.push(p);
      }
      out({ removed });
      break;
    }
    case "unlink-db": {
      const removed = [];
      for (const rel of a.rels) {
        if (unsafeDirs(a.state, rel)) continue;
        for (const s of ["", "-wal", "-shm"]) {
          const p = path.join(a.state, `${rel}${s}`);
          try {
            fs.unlinkSync(p);
            removed.push(p);
          } catch {}
        }
      }
      out({ removed });
      break;
    }
    case "place": {
      const bad = unsafeDirs(a.state, a.rel);
      if (bad && bad !== "ENOENT") throw new Error(`unsafe dest: ${bad}`);
      mkdirSafe(a.state, path.dirname(a.rel));
      const src = openSafe(a.src);
      if (src.err) throw new Error(`src: ${src.err}`);
      const dest = path.join(a.state, a.rel);
      const tmp = `${dest}.ocio-tmp`;
      fs.rmSync(tmp, { force: true });
      const fd = fs.openSync(
        tmp,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      const buf = Buffer.alloc(1 << 20);
      let bytes = 0;
      for (;;) {
        const n = fs.readSync(src.fd, buf, 0, buf.length, bytes);
        if (!n) break;
        fs.writeSync(fd, buf, 0, n);
        bytes += n;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.closeSync(src.fd);
      for (const s of ["-wal", "-shm"]) fs.rmSync(`${dest}${s}`, { force: true });
      fs.renameSync(tmp, dest);
      out({ ok: true, bytes });
      break;
    }
    case "quickcheck":
      out(quickcheck(a.file));
      break;
    case "safe": {
      const bad = [];
      for (const rel of a.rels) {
        const why = unsafeDirs(a.state, rel);
        if (why) {
          bad.push({ rel, why });
          continue;
        }
        const o = openSafe(path.join(a.state, rel));
        if (o.err) bad.push({ rel, why: o.err });
        else {
          if (o.st.uid !== process.getuid()) bad.push({ rel, why: "owner" });
          fs.closeSync(o.fd);
        }
      }
      out({ bad });
      break;
    }
    case "max-txid":
      out({ txid: Object.fromEntries(Object.entries(a.dirs).map(([id, d]) => [id, maxTxid(d)])) });
      break;
    default:
      out({ error: `unknown op ${op}` });
      process.exitCode = 2;
  }
} catch (e) {
  out({ error: String(e.message || e).slice(0, 500) });
  process.exitCode = 1;
}
