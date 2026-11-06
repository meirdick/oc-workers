// Doctor policy (plan §4.9 "Doctor"; scope §1.1 rows "Config versions", "Plugins"; amend §2 rows 17, 19).
// - Runs only when the plan says runDoctor (the DO sets it on a digest change, ladder L2/L4,
//   `ochost doctor --fix`, or after one `doctor-required`). Same digest → no Doctor (D16).
// - Runs after the plugin install and before Litestream and the gateway.
// - Staged copy: Doctor edits a staged openclaw.json (OPENCLAW_CONFIG_PATH), rendered from the
//   selected version with the managed keys and WITHOUT the overlay. No overlay merge: the overlay is
//   applied on top of the Doctor result afterwards. The result goes out as a `doctor` proposal only
//   when proposals are allowed (no overlay, lit prod).
// - Exit ≠ 0 → exit 78 `doctor-failed`. An interrupted Doctor changes no source; the next boot reruns it.
import { canon, render } from "./config.mjs";

export const DOCTOR_TIMEOUT_MS = 600_000;
/** Bytes of Doctor's output kept on a failure: the gate exit event carries them (M6 polish live). */
export const DOCTOR_OUT_MAX = 2048;

/** ANSI escape sequences (ESC [ … letter). Built from a string: biome refuses a control character in a literal. */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/** The last DOCTOR_OUT_MAX bytes of Doctor's output, box-drawing frames and ANSI codes removed. */
export function doctorTail(out, max = DOCTOR_OUT_MAX) {
  const t = String(out || "")
    .replace(ANSI_RE, "")
    .replace(/[\u2500-\u257f\u25c6\u25c7]+/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n");
  const b = Buffer.from(t, "utf8");
  return b.length <= max
    ? t
    : b
        .subarray(b.length - max)
        .toString("utf8")
        .replace(/^\uFFFD+/, "");
}

/** Gateway exit 78, or the maintenance_required marker on its output → `doctor-required` (amend §2 row 19). */
export function isDoctorRequired(code, line = "") {
  return code === 78 || /gateway\.maintenance_required|maintenance_required/.test(line);
}

/**
 * deps: {writeStaged(text) -> Promise<path> (ocio), readStaged(path) -> Promise<text|null> (ocio),
 * runCli(args, {env, timeoutMs, role:"cli"}) -> Promise<{code, signal, out, ms}>, log, tmpDir?}.
 * tmpDir: Doctor's TMPDIR, a uid-1000 0700 dir (demo cutover 2026-11-05).
 * Returns {ran, code, ms, changed, doc?, reason?}. The caller maps code ≠ 0 to exit 78 doctor-failed.
 */
export async function runDoctorStaged(version, plan, deps) {
  if (!plan.runDoctor) return { ran: false };
  // No overlay, no channels-off: Doctor sees the owner's config with the managed keys only.
  const staged = render(version, { ...plan, overlay: [], channelsOff: false, mode: "prod" }, {});
  const p = await deps.writeStaged(staged.text);
  const r = await deps.runCli(["doctor", "--fix", "--non-interactive"], {
    env: { OPENCLAW_CONFIG_PATH: p, ...(deps.tmpDir ? { TMPDIR: deps.tmpDir } : {}) },
    timeoutMs: DOCTOR_TIMEOUT_MS,
    role: "cli",
  });
  const res = { ran: true, code: r.code, signal: r.signal ?? null, ms: r.ms };
  deps.log?.("doctor", { ...res, tail: String(r.out || "").slice(-800) });
  if (r.code !== 0) return { ...res, reason: "doctor-failed", out: doctorTail(r.out) };
  const text = await deps.readStaged(p);
  let doc = null;
  try {
    doc = text ? JSON.parse(text) : null;
  } catch {}
  if (!doc) return { ...res, reason: "doctor-failed", why: "staged config unreadable after Doctor" };
  res.changed = canon(doc) !== canon(staged.doc);
  if (res.changed) res.doc = doc;
  return res;
}

/**
 * The version this boot renders after Doctor: Doctor's file (managed keys still win at render) or the
 * selected version. Returns a version-shaped object {ver, schemaSha, doc}.
 */
export function afterDoctor(version, doctorRes) {
  if (!doctorRes?.changed) return version;
  return { ver: version.ver, schemaSha: version.schemaSha, doc: doctorRes.doc, source: "doctor" };
}
