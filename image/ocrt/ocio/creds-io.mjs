// ocio creds-io: boot-time credential restore from the CredStore (plan §6.2 step 8, §6.1 row 2). Runs as
// uid 1000. Usage: node creds-io.mjs <op> <json-args> [stdin JSON]. Prints one JSON line.
//   shas   {state, rels:[rel]}                     -> {sha:{rel: hex|null}}  (null = missing or unsafe)
//   apply  {state} + stdin {put:[{rel, b64, sha256, mode}], del:[rel]}
//                                                  -> {written:[rel], deleted:[rel], bad:[{rel, why}]}
// Only rels below credentials/ or codex-home/ are touched. Writes are atomic (0600 files, 0700 dirs);
// a put whose bytes do not hash to sha256 is refused. A del removes a regular file with nlink 1 only.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ignoreTerm, mkdirSafe, openSafe, out, readSafe, unsafeDirs, writeAtomic } from "./_common.mjs";

ignoreTerm();
const [op, argJson] = process.argv.slice(2);
const a = argJson ? JSON.parse(argJson) : {};
const sha = (b) => createHash("sha256").update(b).digest("hex");
const TREES = ["credentials/", "codex-home/"];
const inScope = (rel) =>
  typeof rel === "string" && TREES.some((t) => rel.startsWith(t)) && !rel.split("/").includes("..");

function shaOf(state, rel) {
  if (!inScope(rel) || unsafeDirs(state, rel)) return null;
  const r = readSafe(path.join(state, rel), 4 * 1024 * 1024);
  return r.err ? null : sha(r.buf);
}

try {
  switch (op) {
    case "shas":
      out({ sha: Object.fromEntries((a.rels || []).map((rel) => [rel, shaOf(a.state, rel)])) });
      break;
    case "apply": {
      const job = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
      const written = [];
      const deleted = [];
      const bad = [];
      for (const p of job.put || []) {
        if (!inScope(p.rel)) {
          bad.push({ rel: p.rel, why: "scope" });
          continue;
        }
        const buf = Buffer.from(p.b64 || "", "base64");
        if (sha(buf) !== p.sha256) {
          bad.push({ rel: p.rel, why: "sha256" });
          continue;
        }
        try {
          mkdirSafe(a.state, path.dirname(p.rel));
          const why = unsafeDirs(a.state, p.rel);
          if (why) {
            bad.push({ rel: p.rel, why });
            continue;
          }
          const dest = path.join(a.state, p.rel);
          try {
            const st = fs.lstatSync(dest);
            if (!st.isFile() || st.nlink !== 1) {
              bad.push({ rel: p.rel, why: st.isSymbolicLink() ? "symlink" : "not-file" });
              continue;
            }
          } catch {}
          writeAtomic(dest, buf, (Number(p.mode) || 0o600) & 0o600 || 0o600);
          written.push(p.rel);
        } catch (e) {
          bad.push({ rel: p.rel, why: String(e.code || e.message).slice(0, 60) });
        }
      }
      for (const rel of job.del || []) {
        if (!inScope(rel) || unsafeDirs(a.state, rel)) continue;
        const o = openSafe(path.join(a.state, rel));
        if (o.err) continue; // absent (or not a plain file: left for the ownership scan)
        fs.closeSync(o.fd);
        fs.rmSync(path.join(a.state, rel), { force: true });
        deleted.push(rel);
      }
      out({ written, deleted, bad });
      break;
    }
    default:
      out({ error: `unknown op ${op}` });
      process.exitCode = 2;
  }
} catch (e) {
  out({ error: String(e.message || e).slice(0, 500) });
  process.exitCode = 1;
}
