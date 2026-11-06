// Small fs helpers with a path root, so tests can use a temp dir as /proc and /sys/fs/cgroup.
import fs from "node:fs";

/** Read a file as text. Returns null on any error. */
export function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Write a value. Returns true, or the error code. */
export function writeText(p, s) {
  try {
    fs.writeFileSync(p, String(s));
    return true;
  } catch (e) {
    return e.code || String(e);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Paths of the host views. `proc` and `cg` can point at fixtures in tests. */
export function sysPaths(o = {}) {
  return { proc: o.proc || "/proc", cg: o.cg || "/sys/fs/cgroup" };
}
