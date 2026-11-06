// /proc readers shared by the reaper and memwatch.
import fs from "node:fs";
import { readText, sysPaths } from "./sysfs.mjs";

/** Parse /proc/<pid>/stat. Returns {pid, comm, state, ppid, pgid, sid, starttime} or null. */
export function parseStat(text) {
  if (!text) return null;
  const a = text.indexOf("(");
  const b = text.lastIndexOf(")");
  if (a < 0 || b < 0) return null;
  const f = text
    .slice(b + 2)
    .trim()
    .split(/\s+/);
  return {
    pid: Number(text.slice(0, a).trim()),
    comm: text.slice(a + 1, b),
    state: f[0],
    ppid: Number(f[1]),
    pgid: Number(f[2]),
    sid: Number(f[3]),
    starttime: Number(f[19]),
  };
}

/** Real uid from /proc/<pid>/status. */
export function parseUid(statusText) {
  const m = /^Uid:\s+(\d+)/m.exec(statusText || "");
  return m ? Number(m[1]) : null;
}

/** One process, or null if gone. */
export function proc(pid, p = sysPaths()) {
  const st = parseStat(readText(`${p.proc}/${pid}/stat`));
  if (!st) return null;
  st.uid = parseUid(readText(`${p.proc}/${pid}/status`));
  return st;
}

/** Every process. */
export function listProcs(p = sysPaths()) {
  let ents = [];
  try {
    ents = fs.readdirSync(p.proc);
  } catch {}
  const out = [];
  for (const d of ents) {
    if (!/^\d+$/.test(d)) continue;
    const r = proc(d, p);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Identity of a tracked helper: pid + starttime. Node has no pidfd API, so ocsup keys tracked
 * helpers (Litestream, ocio) by this pair; a reused pid gets a new starttime.
 */
export function identity(pid, p = sysPaths()) {
  const r = proc(pid, p);
  return r ? `${r.pid}:${r.starttime}` : null;
}

/** Is a LISTEN (0A) socket on this port in /proc/net/tcp or tcp6? Other states are ignored. */
export function listening(port, p = sysPaths()) {
  const hex = `:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  for (const f of ["tcp", "tcp6"]) {
    for (const l of (readText(`${p.proc}/net/${f}`) || "").split("\n").slice(1)) {
      const c = l.trim().split(/\s+/);
      if (c[1]?.endsWith(hex) && c[3] === "0A") return true;
    }
  }
  return false;
}

/** Anonymous memory of a pid in bytes, from smaps_rollup (memwatch slope fallback). */
export function anonBytes(pid, p = sysPaths()) {
  const m = /^Anonymous:\s+(\d+) kB/m.exec(readText(`${p.proc}/${pid}/smaps_rollup`) || "");
  return m ? Number(m[1]) * 1024 : null;
}
