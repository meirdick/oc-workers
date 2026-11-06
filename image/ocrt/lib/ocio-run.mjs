// Spawn ocio helpers and Litestream as uid 1000 in a leaf cgroup (plan §4.2; scope §1.1 rows
// "PID 1 and cgroups", "Signals", "Litestream").
//
// Signals (measured in M1, see report): a shell `trap '' TERM` before exec does NOT hold for these
// children. The Go runtime (Litestream) installs its own SIGTERM handler, and Node resets every signal
// to SIG_DFL at start (SigIgn has only PIPE and XFSZ). So:
//   - ocio helpers ignore SIGTERM in-process (ocio/_common.mjs ignoreTerm()).
//   - Litestream is respawned at once when a SIGTERM ends it during a drain (lib/litestream.mjs).
// The wrapper still sets SIG_IGN (harmless; keeps non-Node, non-Go children safe).
//
// Tracking: each child is our own child, so its pid cannot be reused until Node reaps it on `exit`.
// That gives the pidfd guarantee for reap() exclusion without a pidfd syscall (Node has none).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BIN } from "./bins.mjs";

/** OOM_ADJ.ocio in lib/oom.mjs (not imported: oom.mjs imports sysfs, keep this module leaf-only). */
export const OCIO_OOM = 0;
export const OCIO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ocio");
export const USER_ENV = Object.freeze({
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/home/node",
  USER: "node",
  LANG: "C.UTF-8",
  TZ: "UTC",
  NODE_ENV: "production",
  OPENCLAW_NO_AUTO_UPDATE: "1",
});

/** Live tracked pids (helpers + Litestream). reap() must skip these. */
export const tracked = new Set();

/**
 * Build the argv (absolute /bin/sh and setpriv: root never resolves a name, F-SEC-1): sh wrapper (cgroup move, oom_score_adj, SIG_IGN TERM, umask 022) → setpriv → cmd.
 * o: {cg?: leaf dir, oom?: int, asRoot?: bool (tests), uid?: 1000}
 */
export function wrapArgv(cmd, args, o = {}) {
  const pre = [];
  if (o.cg) pre.push(`echo $$ > '${o.cg}/cgroup.procs' 2>/dev/null || true`);
  if (o.oom !== undefined) pre.push(`echo ${Number(o.oom)} > /proc/self/oom_score_adj 2>/dev/null || true`);
  pre.push("trap '' TERM");
  pre.push("umask 022");
  const drop = o.asRoot
    ? []
    : [BIN.setpriv, `--reuid=${o.uid ?? 1000}`, `--regid=${o.uid ?? 1000}`, "--init-groups", "--"];
  return [BIN.sh, ["-c", `${pre.join("; ")}; exec "$@"`, "sh", ...drop, cmd, ...args]];
}

export const NODUMP_SO = "/opt/ocrt/nodump.so";
let nodumpOk = null;
const hasNodump = () => {
  if (nodumpOk === null) nodumpOk = fs.existsSync(NODUMP_SO);
  return nodumpOk;
};

/** Spawn and track. Returns the ChildProcess. */
export function spawnTracked(cmd, args, o = {}) {
  const [c, a] = wrapArgv(cmd, args, o);
  let env = o.env || USER_ENV;
  // uid-1000 children are non-dumpable like the gateway (scope §1.1 "Image", Z2.5): another uid-1000
  // process cannot read their /proc/<pid>/environ or mem. Go (Litestream) ignores the preload.
  if (!o.asRoot && o.nodump !== false && hasNodump()) env = { ...env, LD_PRELOAD: NODUMP_SO };
  const child = spawn(c, a, {
    env,
    stdio: o.stdio || ["pipe", "pipe", "pipe"],
    cwd: o.cwd || (o.asRoot ? "/" : "/home/node"),
  });
  if (child.pid) tracked.add(child.pid);
  child.on("exit", () => tracked.delete(child.pid));
  child.on("error", () => tracked.delete(child.pid));
  return child;
}

/** Spawn an ocio helper script (ocio/<name>.mjs). */
export function spawnOcio(name, args, o = {}) {
  const node = o.node || process.execPath;
  // oom_score_adj 0 (scope §1.1): without it a helper inherits ocsup's -900 and would outlive the gateway.
  return spawnTracked(node, [path.join(o.ocioDir || OCIO_DIR, `${name}.mjs`), ...args], {
    oom: OCIO_OOM,
    ...o,
  });
}

/**
 * Run an ocio helper to completion. Returns {code, signal, out: Buffer, err: string, ms, json}.
 * stdin: optional Buffer/string. timeoutMs: SIGKILL after.
 */
export function runOcio(name, args, o = {}) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnOcio(name, args, o);
    } catch (e) {
      resolve({ code: -1, signal: null, out: Buffer.alloc(0), err: String(e), ms: 0, json: null });
      return;
    }
    const out = [];
    let outLen = 0;
    let err = "";
    child.stdout.on("data", (d) => {
      if (o.onData) return o.onData(d);
      if (outLen < (o.maxOut ?? 16 * 1024 * 1024)) {
        out.push(d);
        outLen += d.length;
      }
    });
    child.stderr.on("data", (d) => {
      if (err.length < 65536) err += d;
    });
    if (o.stdin !== undefined) child.stdin.end(o.stdin);
    else child.stdin.end();
    const timer = o.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, o.timeoutMs)
      : null;
    if (o.onChild) o.onChild(child);
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const buf = Buffer.concat(out);
      let json = null;
      try {
        const last = buf.toString("utf8").trim().split("\n").pop();
        json = last ? JSON.parse(last) : null;
      } catch {}
      resolve({ code, signal, out: buf, err, ms: Date.now() - t0, json });
    });
  });
}
