// Boot identity (plan §4.3, §4.12 boot.json, §5.2 step 7; scope §1.1 rows "Hostname and lock",
// "In-container restarts"). All file paths come from opts so tests run on a temp dir.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BIN } from "./bins.mjs";

const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
};

/** Random 32-hex iid, made once per ocsup process (contract RE.iid). */
export const newIid = () => randomBytes(16).toString("hex");
export const secretHash = (secret) => createHash("sha256").update(String(secret)).digest("hex");

/**
 * Read boot_id and compare with the value stored by the last ocsup in this rootfs.
 * opts: {bootIdFile, varDir}. Returns {bootId, prev, newBoot, bootCount}.
 * newBoot=true: new VM or snapshot restore (CF gives a new boot_id per instance, T2 item 2).
 */
export function readBootIdentity(o) {
  const bootId = read(o.bootIdFile || "/proc/sys/kernel/random/boot_id");
  const f = path.join(o.varDir, "boot_id");
  const prev = read(f) || null;
  const nf = path.join(o.varDir, "boot_count");
  const bootCount = (Number(read(nf)) || 0) + 1;
  try {
    fs.mkdirSync(o.varDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, `${bootId}\n`, { mode: 0o600 });
    fs.writeFileSync(nf, String(bootCount), { mode: 0o600 });
  } catch {}
  return { bootId, prev, newBoot: prev !== bootId, bootCount };
}

/**
 * Hostname pin (plan §4.3). deps: {get(), set(name) -> {ok, err}}. Never throws; a failure is
 * reported as pinned:false and the lock step uses its fallback.
 */
export function pinHostname(target = "localhost", deps = {}) {
  const get = deps.get || (() => os.hostname());
  const set =
    deps.set ||
    ((n) => {
      const r = spawnSync(BIN.hostname, [n], { encoding: "utf8" });
      return {
        ok: r.status === 0,
        err: r.status === 0 ? null : (r.stderr || "").trim() || `exit ${r.status}`,
      };
    });
  const before = get();
  let err = null;
  if (before !== target) {
    const r = set(target);
    if (!r.ok) err = r.err;
  }
  const after = get();
  return { before, after, target, pinned: after === target, err };
}

/**
 * Move the pid counter by a random step at a new boot_id (scope §1.1 "In-container restarts":
 * a restored lock file then never names a live pid by chance). Writes ns_last_pid; best effort.
 */
export function stepPidCounter(o = {}) {
  const f = o.file || "/proc/sys/kernel/ns_last_pid";
  const step = o.step ?? 1000 + (randomBytes(2).readUInt16BE(0) % 20000);
  const cur = Number(read(f));
  if (!Number.isFinite(cur) || cur <= 0) return { ok: false, why: "unreadable" };
  const max = Number(read(o.maxFile || "/proc/sys/kernel/pid_max")) || 4194304;
  const next = cur + step < max - 1000 ? cur + step : 300;
  try {
    fs.writeFileSync(f, String(next));
    return { ok: true, from: cur, to: next };
  } catch (e) {
    return { ok: false, why: e.code || String(e) };
  }
}

/** /run/ocrt/boot.json for the DO identity check (plan §5.4 step 3; contract BootJson). */
export function writeBootJson(file, { gen, epoch, iid, secret }) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = { gen, epoch, iid, secretHash: secretHash(secret || "") };
  fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
  return body;
}
