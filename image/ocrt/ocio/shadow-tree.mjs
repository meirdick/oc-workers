// ocio shadow-tree (L5, M4 loss): a copy of the state tree for `openclaw backup create`, so an online archive
// never reads a live SQLite file under a write lock. uid 1000.
// argv[2] = JSON {state, out, managed:[rel]}. Copies every entry under state into out (empty) except:
// `workspace/` (the archive reads it at its live path), node_modules/.git, Litestream meta dirs, and the
// managed DBs with their -wal/-shm/-journal (ocsup restores those from the replica into out, gen restore).
// Other *.sqlite: node:sqlite backup (online, short read locks). Other files: copy. Symlinks: recreated.
// out/openclaw.json gets agents.defaults.workspace = <state>/workspace when unset.
// stdout: JSON {ok, files, dbs, bytes, why?}.
import fs from "node:fs";
import path from "node:path";
import { ignoreTerm, out } from "./_common.mjs";

ignoreTerm();
const a = JSON.parse(process.argv[2] || "{}");
const SKIP = /^(node_modules|\.git)$|-litestream$/;
const DB_SIDE = /-(wal|shm|journal)$/;
const managed = new Set(a.managed || []);
let files = 0;
let dbs = 0;
let bytes = 0;

async function walk(rel) {
  const src = path.join(a.state, rel);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (!rel && e.name === "workspace") continue;
    const s = path.join(a.state, r);
    const d = path.join(a.out, r);
    if (e.isDirectory()) {
      if (SKIP.test(e.name)) continue;
      fs.mkdirSync(d, { mode: 0o700 });
      await walk(r);
    } else if (e.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(s), d);
    } else if (e.isFile()) {
      const base = r.replace(DB_SIDE, "");
      if (managed.has(r) || (DB_SIDE.test(r) && (managed.has(base) || base.endsWith(".sqlite")))) continue;
      if (r.endsWith(".sqlite")) {
        const { DatabaseSync, backup } = process.getBuiltinModule("node:sqlite");
        const db = new DatabaseSync(s, { readOnly: true });
        try {
          await backup(db, d);
        } finally {
          db.close();
        }
        dbs++;
      } else fs.copyFileSync(s, d, fs.constants.COPYFILE_FICLONE);
      files++;
      bytes += fs.statSync(d).size;
    }
  }
}

try {
  for (const n of fs.readdirSync(a.out)) fs.rmSync(path.join(a.out, n), { recursive: true, force: true });
  await walk("");
  for (const rel of managed)
    fs.mkdirSync(path.join(a.out, path.dirname(rel)), { recursive: true, mode: 0o700 });
  const cfg = path.join(a.out, "openclaw.json");
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(cfg, "utf8"));
  } catch {} // missing or JSON5: kept as copied (OpenClaw's default workspace applies)
  if (doc && typeof doc === "object") {
    doc.agents ??= {};
    doc.agents.defaults ??= {};
    doc.agents.defaults.workspace ??= path.join(a.state, "workspace");
    fs.writeFileSync(cfg, JSON.stringify(doc, null, 2), { mode: 0o600 });
  }
  out({ ok: true, files, dbs, bytes });
} catch (e) {
  out({ ok: false, why: String(e?.message || e).slice(0, 300) });
  process.exitCode = 1;
}
