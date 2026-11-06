// ocio sqlite-backup: online copy of one non-managed SQLite file (plan §4.11 "Shadow", §6.1 row 5).
// uid 1000. argv[2] = JSON {src, tmpDir}. node:sqlite backup() into a uid-1000 temp file, then the bytes
// go to stdout and the temp file is removed. stderr last line: JSON {ok, bytes, ms, why?}.
import fs from "node:fs";
import path from "node:path";
import { ignoreTerm, openSafe } from "./_common.mjs";

ignoreTerm();
const a = JSON.parse(process.argv[2] || "{}");
const done = (o, code = 0) => {
  process.stderr.write(`${JSON.stringify(o)}\n`);
  process.exitCode = code;
};
const t0 = Date.now();
const chk = openSafe(a.src); // refuse symlink / hard link (plan §4.13)
if (chk.err) done({ ok: false, why: chk.err }, 3);
else {
  fs.closeSync(chk.fd);
  const tmp = path.join(a.tmpDir || "/tmp", `ocio-shadow-${process.pid}-${Date.now()}.sqlite`);
  try {
    const { DatabaseSync, backup } = process.getBuiltinModule("node:sqlite");
    const db = new DatabaseSync(a.src, { readOnly: true });
    await backup(db, tmp);
    db.close();
    const rs = fs.createReadStream(tmp);
    let bytes = 0;
    rs.on("data", (d) => {
      bytes += d.length;
    });
    rs.pipe(process.stdout);
    await new Promise((r, j) => {
      rs.on("end", r);
      rs.on("error", j);
    });
    fs.rmSync(tmp, { force: true });
    done({ ok: true, bytes, ms: Date.now() - t0 });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    done({ ok: false, why: String(e.message || e).slice(0, 300) }, 1);
  }
}
