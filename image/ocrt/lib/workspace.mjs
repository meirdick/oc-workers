// Workspace at boot (spec 08 §8.3 B1). The agent workspace (/home/node/.openclaw/workspace) lives only on the
// rootfs; its identity (workspace_setup_state) lives in the state DB, which comes from the gen. A boot that
// pairs an image or older rootfs with a newer gen leaves an attested workspace empty, and OpenClaw answers
// every message with a repair notice. Rules here:
//   - plan workspace.source "archive": take workspace/ from the plan's archive (step workspace-restore).
//   - step workspace: an attested workspace that is missing or empty → exit 75 restore-blocked:mismatch and a
//     high alert `workspace-missing` (DO: ladder; L3 tries an older snapshot, L4 image + archive), unless the
//     owner accepted the loss (`acceptLoss`): then the attestation rows go, OpenClaw seeds a new workspace,
//     alert `workspace-reset`.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runOcio } from "./ocio-run.mjs";

const ocioJson = async (ocio, args, o) => {
  const r = await ocio("workspace", args, o);
  if (!r.json?.ok)
    throw new Error(`ocio workspace ${args[0]}: ${r.json?.error || r.err || `exit ${r.code}`}`);
  return r.json;
};

/**
 * Step `workspace`. o: {state, db, source, acceptLoss, ocio?}. Returns {rec, alerts} or {exit, detail, alerts}.
 */
export async function workspaceStep(o) {
  const ocio = o.ocio || runOcio;
  const chk = await ocioJson(ocio, ["check", JSON.stringify({ db: o.db, state: o.state })]);
  const rec = { source: o.source, attested: chk.attested?.length ?? 0, missing: chk.missing ?? [] };
  if (!chk.missing?.length) return { rec };
  const detail = `workspace-missing ${chk.missing.join(", ").slice(0, 200)} (source ${o.source})`;
  if (o.acceptLoss) {
    const r = await ocioJson(ocio, ["reset", JSON.stringify({ db: o.db, paths: chk.missing })]);
    return {
      rec: { ...rec, reset: r.deleted },
      alerts: [{ class: "workspace-reset", severity: "high", detail }],
    };
  }
  return {
    exit: "restore-blocked:mismatch",
    detail,
    alerts: [{ class: "workspace-missing", severity: "high", detail }],
  };
}

/**
 * Step `workspace-restore`: download the plan archive through ControlGate (`GET /v1/archive/get`), check its
 * sha256 in the same pass, then ocio extracts workspace/ only. o: {gate, archive:{archiveId, sha256}, state,
 * varDir, ocio?, timeoutMs, log?}. Returns {rec} or {exit, detail}.
 */
export async function workspaceRestore(o) {
  const ocio = o.ocio || runOcio;
  const file = path.join(o.varDir, "ws-archive.tgz");
  fs.rmSync(file, { force: true });
  let res;
  try {
    res = await o.gate.fetchRaw(`/v1/archive/get?archiveId=${encodeURIComponent(o.archive.archiveId)}`, {
      timeoutMs: o.timeoutMs,
    });
  } catch (e) {
    return { exit: "restore-blocked:infra", detail: `archive get: ${String(e?.message || e).slice(0, 200)}` };
  }
  if (res.status !== 200 || !res.body)
    return { exit: "restore-blocked:infra", detail: `archive get: HTTP ${res.status}` };
  const h = createHash("sha256");
  let size = 0;
  const fd = fs.openSync(file, "w", 0o640);
  // ocsup runs with umask 077, so the open mode gives 0600 and ocio (uid 1000) cannot read it (M3 e2e live:
  // "tar: ws-archive.tgz: Cannot open: Permission denied", every image-path boot blocked).
  fs.fchmodSync(fd, 0o640);
  try {
    for await (const chunk of res.body) {
      const b = Buffer.from(chunk);
      h.update(b);
      size += b.length;
      fs.writeSync(fd, b);
    }
  } finally {
    fs.closeSync(fd);
  }
  const sha = h.digest("hex");
  if (o.archive.sha256 && sha !== o.archive.sha256) {
    fs.rmSync(file, { force: true });
    return { exit: "restore-blocked:mismatch", detail: `archive sha256 ${sha} != plan ${o.archive.sha256}` };
  }
  // Root wrote it in root's varDir (0711); group 1000 reads it by path. ocio never opens a root tree.
  if (!o.asRoot) fs.chownSync(file, 0, 1000);
  try {
    const r = await ocioJson(ocio, ["extract", JSON.stringify({ archive: file, state: o.state })], {
      timeoutMs: o.timeoutMs,
    });
    o.log?.("workspace-restore", { archiveId: o.archive.archiveId, size, files: r.files, dirs: r.dirs });
    return { rec: { archiveId: o.archive.archiveId, size, files: r.files, dirs: r.dirs } };
  } finally {
    fs.rmSync(file, { force: true });
  }
}
