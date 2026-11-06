// Fake /proc and /sys/fs/cgroup trees for unit tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tmpdir(tag = "ocrt") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
}

export function put(root, rel, text) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}

/** Add a fake process. o = {comm, state, ppid, pgid, sid, starttime, uid, utime, stime, cutime, cstime}. */
export function addProc(proc, pid, o = {}) {
  const f = [
    o.state || "S",
    o.ppid ?? 1,
    o.pgid ?? pid,
    o.sid ?? pid,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    o.utime ?? 0,
    o.stime ?? 0,
    o.cutime ?? 0,
    o.cstime ?? 0,
    20,
    0,
    1,
    0,
    o.starttime ?? 1000 + pid,
  ];
  put(proc, `${pid}/stat`, `${pid} (${o.comm || "node"}) ${f.join(" ")} 0 0\n`);
  put(
    proc,
    `${pid}/status`,
    `Name:\t${o.comm || "node"}\nUid:\t${o.uid ?? 0}\t${o.uid ?? 0}\t${o.uid ?? 0}\t${o.uid ?? 0}\n`,
  );
}

export function rmProc(proc, pid) {
  fs.rmSync(path.join(proc, String(pid)), { recursive: true, force: true });
}

export function tcpLine(port, state) {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  return `   0: 00000000:${hex} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 1\n`;
}
