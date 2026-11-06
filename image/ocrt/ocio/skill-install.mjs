// ocio helper (uid 1000): install the oc-workers-cloudflare skill into the agent workspace (docs/11 §4).
// Usage: node skill-install.mjs <json-args>   {src, workspace, name, remove?: [oldName]}  -> {ok, changed}
// Writes <workspace>/skills/<name>/SKILL.md from the image copy. Overwritten each boot (image-owned file).
// Refuses symlinked or non-directory path parts (plan §4.13).
import fs from "node:fs";
import path from "node:path";
import { ignoreTerm, out } from "./_common.mjs";

ignoreTerm();
const a = JSON.parse(process.argv[2] || "{}");

function realDir(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    fs.mkdirSync(p, { mode: 0o755 });
    return;
  }
  if (!st.isDirectory()) throw new Error(`not a real directory: ${p}`);
}

try {
  if (!/^[a-z0-9-]+$/.test(a.name || "")) throw new Error("bad name");
  const body = fs.readFileSync(a.src);
  realDir(a.workspace);
  const dirs = [path.join(a.workspace, "skills"), path.join(a.workspace, "skills", a.name)];
  for (const d of dirs) realDir(d);
  const dest = path.join(dirs[1], "SKILL.md");
  let same = false;
  try {
    const st = fs.lstatSync(dest);
    if (!st.isFile()) throw new Error(`not a regular file: ${dest}`);
    same = fs.readFileSync(dest).equals(body);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (!same) {
    const tmp = `${dest}.tmp${process.pid}`;
    fs.writeFileSync(tmp, body, { mode: 0o644, flag: "wx" });
    fs.renameSync(tmp, dest);
  }
  // An older name of this skill (the product was renamed): its dir goes, so the agent sees one skill.
  for (const old of Array.isArray(a.remove) ? a.remove : []) {
    if (!/^[a-z0-9-]+$/.test(old) || old === a.name) continue;
    const d = path.join(a.workspace, "skills", old);
    try {
      if (fs.lstatSync(d).isDirectory()) fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  out({ ok: true, changed: !same });
} catch (e) {
  out({ ok: false, error: String(e?.message || e).slice(0, 300) });
  process.exitCode = 1;
}
