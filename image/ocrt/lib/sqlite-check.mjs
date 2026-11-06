// M4b N1+N2 (M4-STATUS §7): SQLite corruption evidence. quick_check on each managed DB at boot (every plan
// kind but fresh) and after a gateway exit whose log tail names a SQLite corruption or schema error. A failed
// check ends the boot with the named exit `sqlite-corrupt` (75); the Runtime DO counts it as SQLite evidence
// and raises `l5-pending` with the evidence text (plan §9.3).
import path from "node:path";
import { runOcio } from "./ocio-run.mjs";

/** Gateway log text that makes ocsup check the managed DBs before the restart. */
export const SQLITE_SUSPECT_RE =
  /SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database|malformed database schema|database schema (?:is )?(?:newer|has changed)|schema version|no such (?:table|column)/i;

/**
 * quick_check each rel under state (ocio fsops quickcheck, uid 1000). Returns {ok, bad:[{rel, result}],
 * evidence} where evidence is the text the exit carries ("quick_check <rel>: <result>; ...", ≤ 300 chars).
 */
export async function sqliteCheck({ state, rels, ocio = runOcio, timeoutMs = 60_000, cg }) {
  const bad = [];
  for (const rel of rels) {
    let r;
    try {
      const x = await ocio("fsops", ["quickcheck", JSON.stringify({ file: path.join(state, rel) })], {
        timeoutMs,
        cg,
      });
      r = x.json ?? { ok: false, result: `ocio: ${String(x.err || x.code).slice(0, 120)}` };
    } catch (e) {
      r = { ok: false, result: `ocio: ${String(e.message || e).slice(0, 120)}` };
    }
    // An ocio failure (timeout, spawn) is not evidence of corruption: only a quick_check answer counts.
    if (!r.ok && !String(r.result).startsWith("ocio:")) bad.push({ rel, result: String(r.result) });
  }
  const evidence = bad
    .map((b) => `quick_check ${b.rel}: ${b.result}`)
    .join("; ")
    .slice(0, 300);
  return { ok: bad.length === 0, bad, evidence: evidence || null };
}
