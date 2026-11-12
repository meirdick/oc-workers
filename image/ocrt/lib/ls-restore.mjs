// Managed SQLite at boot: pre-start wipe, DB discovery, gen restore, marker check
// (plan §6.2 steps 3, 6; §6.1 rows 1, 5; amend §1.5 F1.2, §2 row 21b; scope §1.1 rows
// "Litestream", "Other SQLite"). All work in uid-1000 trees goes through ocio (fsops.mjs).
// Restore never passes -if-replica-exists: an empty gen is an error, never "fresh" (plan §6.2).
import fs from "node:fs";
import path from "node:path";
import { BIN } from "./bins.mjs";
import { dbId, isManagedRel, MAX_DBS, META_ROOT, renderConfig } from "./ls-config.mjs";
import { runOcio, spawnTracked } from "./ocio-run.mjs";

export const FORBIDDEN_RESTORE_FLAGS = ["-if-replica-exists"];

/**
 * SQLite files OpenClaw makes that are neither replicated nor a shadow worth an alert: the quarantine DB (an
 * OpenClaw scratch store) and anything under tmp/ (plugin captures). M8 live: db-unclassified 473 times.
 */
export const IGNORED_RE = /^(state\/openclaw-quarantine\.sqlite|tmp\/)/;

const ocioJson = async (ocio, op, args, o = {}) => {
  const r = await ocio("fsops", [op, JSON.stringify(args)], o);
  if (r.code !== 0 || !r.json || r.json.error)
    throw new Error(`ocio ${op}: ${r.json?.error || r.err || `exit ${r.code}`}`);
  return r.json;
};

/**
 * Pre-start wipe (plan §6.2 step 3; F1.2). Root dirs are removed by root; the uid-1000 Litestream
 * meta root and any legacy `.<file>-litestream` beside a managed DB go through ocio.
 * o: {state, varDir, metaRoot?, rels, ocio?}
 */
export async function prestartWipe(o) {
  const ocio = o.ocio || runOcio;
  const rootDirs = ["creds-pending", "stage", "probe"].map((d) => path.join(o.varDir, d));
  for (const d of rootDirs) fs.rmSync(d, { recursive: true, force: true });
  // These dirs sit in root's /var/lib/ocrt but hold uid-1000 files: ocio empties them, the dirs stay.
  const meta = await ocioJson(ocio, "empty", {
    dirs: [
      o.metaRoot || META_ROOT,
      path.join(o.varDir, "rs"),
      path.join(o.varDir, "rv"),
      path.join(o.varDir, "bk-u"),
      path.join(o.varDir, "bk-s"),
    ],
  });
  const legacy = await ocioJson(ocio, "wipe-legacy", { state: o.state, rels: o.rels });
  ensureMetaRoot(o.metaRoot || META_ROOT, o);
  return { root: rootDirs, ocio: meta.removed, legacy: legacy.removed };
}

/** Root makes the (new, empty) meta root and hands it to uid 1000; Litestream makes g<gen>/<id> in it. */
export function ensureMetaRoot(metaRoot = META_ROOT, o = {}) {
  fs.mkdirSync(path.dirname(metaRoot), { recursive: true, mode: 0o711 });
  try {
    fs.mkdirSync(metaRoot, { mode: 0o700 });
  } catch (e) {
    if (e.code !== "EEXIST" || !fs.lstatSync(metaRoot).isDirectory()) throw e;
  }
  if (!o.asRoot) fs.chownSync(metaRoot, 1000, 1000);
}

/**
 * Split a discovery scan (fsops scan) into classes (scope §1.1 "Other SQLite").
 * Returns {managed, shadow, refused:[{rel,why}], alerts:[{class, detail}]}.
 */
export function classifyDbs(scan, { cap = MAX_DBS } = {}) {
  const managed = [];
  const shadow = [];
  const refused = [];
  const ignored = [];
  for (const f of scan.sqlite) {
    if (f.symlink || f.nlink !== 1) {
      refused.push({ rel: f.rel, why: f.symlink ? "symlink" : "hardlink" });
      continue;
    }
    if (isManagedRel(f.rel)) managed.push(f.rel);
    else if (IGNORED_RE.test(f.rel)) ignored.push(f.rel);
    else shadow.push(f.rel);
  }
  managed.sort((a, b) =>
    a === "state/openclaw.sqlite" ? -1 : b === "state/openclaw.sqlite" ? 1 : a < b ? -1 : 1,
  );
  const over = managed.splice(cap);
  const alerts = [];
  if (shadow.length)
    alerts.push({ class: "db-unclassified", severity: "warn", detail: shadow.join(", ").slice(0, 1900) });
  if (over.length)
    alerts.push({ class: "db-set-cap", severity: "warn", detail: over.join(", ").slice(0, 1900) });
  if (refused.length)
    alerts.push({ class: "db-unsafe", severity: "high", detail: JSON.stringify(refused).slice(0, 1900) });
  if (scan.truncated)
    alerts.push({ class: "db-scan-truncated", severity: "warn", detail: "scan cap reached" });
  return { managed, shadow: [...shadow, ...over], refused, ignored, alerts };
}

/** Run `litestream restore` as uid 1000. Returns {code, out, ms, json}. */
export function lsRestoreRun(bin, args, o = {}) {
  for (const f of FORBIDDEN_RESTORE_FLAGS)
    if (args.includes(f)) throw new Error(`forbidden restore flag ${f}`);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = (o.spawn || spawnTracked)(bin, args, { cg: o.cg, asRoot: o.asRoot, oom: 0 });
    let out = "";
    child.stdout?.on("data", (d) => {
      if (out.length < 200_000) out += d;
    });
    child.stderr?.on("data", (d) => {
      if (out.length < 200_000) out += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs || 600_000);
    o.onChild?.(child);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let json = null;
      const a = out.indexOf("\n{");
      const start = out.startsWith("{") ? 0 : a >= 0 ? a + 1 : -1;
      const end = out.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          json = JSON.parse(out.slice(start, end + 1));
        } catch {}
      }
      resolve({ code, signal, out, ms: Date.now() - t0, json });
    });
  });
}

/** TXID of a restore: from the -json summary if present, else null. */
export function restoredTxid(json) {
  if (!json) return null;
  for (const k of ["txid", "TXID", "maxTXID", "max_txid", "maxTxid"]) {
    const v = json[k];
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^[0-9a-f]{1,16}$/i.test(v)) return Number.parseInt(v, 16);
  }
  return null;
}

/**
 * Restore the plan set from g<gen> (plan §6.2 step 6 `gen`).
 * o: {state, varDir, inst, gen, dbs:[rel], lastTxid:{rel:n}, ts?, s3, bin?, ocio?, spawn?, asRoot?,
 *     cg?, writeConfig?, stop?: () => bool}
 * Returns {ok, reason?, dbs:[{rel, ms, txid, bytes}]}. reason: restore-blocked:mismatch|infra.
 */
export async function restoreGen(o) {
  const ocio = o.ocio || runOcio;
  const rs = path.join(o.varDir, "rs");
  fs.mkdirSync(rs, { recursive: true, mode: 0o700 });
  if (!o.asRoot) fs.chownSync(rs, 1000, 1000);
  const cfgPath = path.join(o.runDir || "/run/ocrt", "litestream-restore.yml");
  const text = renderConfig({
    state: o.state,
    gen: o.gen,
    inst: o.inst,
    dbs: o.dbs,
    s3: o.s3,
    metaRoot: path.join(rs, "meta"),
    prefix: o.prefix,
  });
  (
    o.writeConfig ||
    ((p, t) => {
      fs.rmSync(p, { force: true }); // 0400 from the last run: replace, do not open for write
      fs.writeFileSync(p, t, { mode: 0o400 });
      if (!o.asRoot) fs.chownSync(p, 1000, 1000);
    })
  )(cfgPath, text);
  const res = [];
  // Local files stay until each restore passed; `place` then replaces the DB and drops its -wal/-shm.
  for (const rel of o.dbs) {
    if (o.stop?.()) return { ok: false, reason: "sigterm", dbs: res };
    const outFile = path.join(rs, `${dbId(rel)}.sqlite`);
    const args = ["restore", "-config", cfgPath, "-o", outFile, "-json", "-integrity-check", "quick"];
    if (o.ts) args.push("-timestamp", o.ts);
    args.push(path.join(o.state, rel));
    const r = await lsRestoreRun(o.bin || BIN.litestream, args, o);
    if (r.code !== 0) {
      const infra = /StatusCode: 5\d\d|connection refused|timeout|no such host|EOF/i.test(r.out);
      return {
        ok: false,
        reason: infra ? "restore-blocked:infra" : "restore-blocked:mismatch",
        rel,
        out: r.out.slice(-800),
        dbs: res,
      };
    }
    const txid = restoredTxid(r.json);
    const want = o.lastTxid?.[rel] ?? 0;
    if (txid !== null && txid < want)
      return {
        ok: false,
        reason: "restore-blocked:mismatch",
        rel,
        why: `txid ${txid} < plan ${want}`,
        dbs: res,
      };
    const qc = await ocioJson(ocio, "quickcheck", { file: outFile });
    if (!qc.ok)
      return {
        ok: false,
        reason: "restore-blocked:mismatch",
        rel,
        why: `quick_check ${qc.result}`,
        dbs: res,
      };
    const placed = await ocioJson(ocio, "place", { src: outFile, state: o.state, rel });
    res.push({ rel, ms: r.ms, txid, bytes: placed.bytes });
  }
  await ocioJson(ocio, "empty", { dirs: [rs] }); // rs sits in root-owned varDir (0711): uid 1000 can empty it, not unlink it
  return { ok: true, dbs: res };
}

/**
 * N7 (plan §6.1 row 1): restore probe of g<gen>. Each DB of the set is restored from its newest LTX set into the
 * scratch dir `<varDir>/rv` (never the live state), `quick_check`ed, then removed. The live DBs are not opened.
 * L5: with `into` (a shadow state tree) each DB is restored to <into>/<rel> and kept there for the archive.
 * o: {varDir, inst, gen, dbs:[rel], s3, state, into?, bin?, ocio?, spawn?, asRoot?, cg?, writeConfig?, timeoutMs?}
 * Returns {ok:true, dbs:[{rel, ms, txid}]} | {ok:false, reason: "bad"|"infra", rel, why}.
 */
export function verifyGen(o) {
  // The N7 probe and the L5 shadow share `rv` and the config file: one run at a time.
  const run = verifyChain.then(() => verifyGenOnce(o));
  verifyChain = run.catch(() => undefined);
  return run;
}
let verifyChain = Promise.resolve();

/** Restore output that proves the gen's replica set is missing or damaged. Anything else is infra (no verdict). */
const RESTORE_BAD =
  /no matching backups|checksum|corrupt|malformed|invalid ltx|decode|bad magic|not a database/i;
/**
 * A restore of the live gen lists the replica, then reads each LTX file. Litestream's L0 retention deletes an L0
 * file after it is compacted into L1, so a file from the list can be gone at the read ("reopen ltx file at
 * offset 0: file does not exist"; live on oc-waketest 2026-11-12, the next archive passed). The gen is not
 * damaged: list again. Still gone after LTX_GONE_RETRIES: the normal verdict applies.
 */
const LTX_GONE = /ltx file[^\n]*(does not exist|no such file)/i;
export const LTX_GONE_RETRIES = 2;
export const LTX_GONE_WAIT_MS = 1500;
/** quick_check answers that say nothing about the restored DB (open or IO trouble on the probe). */
const QC_INFRA = /locked|busy|ENOENT|no such file|unable to open|ENOSPC|disk is full|out of memory|EACCES/i;

async function verifyGenOnce(o) {
  const ocio = o.ocio || runOcio;
  const rv = path.join(o.varDir, "rv");
  fs.mkdirSync(rv, { recursive: true, mode: 0o700 });
  if (!o.asRoot) fs.chownSync(rv, 1000, 1000);
  const cfgPath = path.join(o.runDir || "/run/ocrt", "litestream-verify.yml");
  const text = renderConfig({
    state: o.state,
    gen: o.gen,
    inst: o.inst,
    dbs: o.dbs,
    s3: o.s3,
    metaRoot: path.join(rv, "meta"),
    prefix: o.prefix,
  });
  (
    o.writeConfig ||
    ((p, t) => {
      fs.rmSync(p, { force: true }); // 0400 from the last run: replace, do not open for write
      fs.writeFileSync(p, t, { mode: 0o400 });
      if (!o.asRoot) fs.chownSync(p, 1000, 1000);
    })
  )(cfgPath, text);
  const res = [];
  try {
    for (const rel of o.dbs) {
      const outFile = o.into ? path.join(o.into, rel) : path.join(rv, `${dbId(rel)}.sqlite`);
      const args = ["restore", "-config", cfgPath, "-o", outFile, "-json", path.join(o.state, rel)];
      let r = await lsRestoreRun(o.bin || BIN.litestream, args, o);
      for (let i = 0; i < LTX_GONE_RETRIES && r.code !== 0 && !r.signal && LTX_GONE.test(r.out); i++) {
        o.log?.("verify-ltx-gone-retry", { rel, attempt: i + 1 });
        await new Promise((ok) => setTimeout(ok, o.ltxGoneWaitMs ?? LTX_GONE_WAIT_MS));
        r = await lsRestoreRun(o.bin || BIN.litestream, args, o);
      }
      if (r.code !== 0) {
        // A 403, a deadline or a full disk on the probe must not mark a good gen bad (the boot would skip it).
        const infra = !!r.signal || !RESTORE_BAD.test(r.out);
        return {
          ok: false,
          reason: infra ? "infra" : "bad",
          rel,
          why: r.out.slice(-300) || `exit ${r.code}`,
        };
      }
      const qc = await ocioJson(ocio, "quickcheck", { file: outFile });
      if (!qc.ok)
        return {
          ok: false,
          reason: QC_INFRA.test(String(qc.result ?? "")) ? "infra" : "bad",
          rel,
          why: `quick_check ${qc.result}`,
        };
      res.push({ rel, ms: r.ms, txid: restoredTxid(r.json) });
    }
    return { ok: true, dbs: res };
  } catch (e) {
    return { ok: false, reason: "infra", why: String(e?.message || e).slice(0, 300) };
  } finally {
    await ocioJson(ocio, "empty", { dirs: [rv] }).catch(() => undefined);
  }
}

/**
 * Marker boot (plan §6.2 step 6 `marker`; add §2.8): quick_check on each .sqlite + -wal unit, keep files.
 * Returns {ok, bad:[{rel, result}]}. Any failure → caller exits 75 restore-blocked:mismatch.
 */
export async function markerCheck({ state, dbs, ocio = runOcio }) {
  const bad = [];
  for (const rel of dbs) {
    const r = await ocioJson(ocio, "quickcheck", { file: path.join(state, rel) });
    if (!r.ok) bad.push({ rel, result: r.result });
  }
  return { ok: bad.length === 0, bad };
}

/** Pending DBs (plan §6.1 row 1): keep the snapshot copy if quick_check passes, else omit + `db-lost`. */
export async function pendingCheck({ state, dbs, ocio = runOcio }) {
  const keep = [];
  const lost = [];
  for (const rel of dbs) {
    let r;
    try {
      r = await ocioJson(ocio, "quickcheck", { file: path.join(state, rel) });
    } catch (e) {
      r = { ok: false, result: e.message };
    }
    (r.ok ? keep : lost).push(rel);
  }
  if (lost.length) await ocioJson(ocio, "unlink-db", { state, rels: lost });
  return { keep, lost, alerts: lost.map((rel) => ({ class: "db-lost", severity: "high", detail: rel })) };
}
