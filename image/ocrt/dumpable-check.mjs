// T2 item 7: does a non-dumpable process hide /proc/<pid>/environ from a uid-1000 reader?
// Run as root. Starts 3 holders with a marker env var, then reads each environ as uid 1000.
//   A "node-setuid": node starts as root, then process.setuid(1000). The kernel sets dumpable from
//     fs.suid_dumpable on the uid change (0 or 2, not 1). This is the shim design.
//   B "setpriv-exec": setpriv drops to 1000, then execs node. Exec resets dumpable to 1. Control case.
//   C "prctl-0": python3 ctypes prctl(PR_SET_DUMPABLE, 0) as uid 1000. Direct check of the flag.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";

const MARK = `OCRT_PROBE_SECRET=${Math.random().toString(36).slice(2)}`;
const env = { PATH: process.env.PATH, OCRT_PROBE_SECRET: MARK.split("=")[1] };
const holders = {
  "node-setuid": spawn(
    process.execPath,
    ["-e", "process.setgid(1000);process.setuid(1000);setTimeout(()=>{},20000)"],
    { env, stdio: "ignore" },
  ),
  "setpriv-exec": spawn(
    "/usr/bin/setpriv",
    [
      "--reuid=1000",
      "--regid=1000",
      "--clear-groups",
      "--",
      process.execPath,
      "-e",
      "setTimeout(()=>{},20000)",
    ],
    { env, stdio: "ignore" },
  ),
  "prctl-0": spawn(
    "/usr/bin/setpriv",
    [
      "--reuid=1000",
      "--regid=1000",
      "--clear-groups",
      "--",
      "python3",
      "-I",
      "-c",
      "import ctypes,time;ctypes.CDLL(None).prctl(4,0,0,0,0);time.sleep(20)",
    ],
    { env, stdio: "ignore" },
  ),
};
await new Promise((r) => setTimeout(r, 1500));
const out = { suid_dumpable: fs.readFileSync("/proc/sys/fs/suid_dumpable", "utf8").trim(), holders: {} };
for (const [name, child] of Object.entries(holders)) {
  const pid = child.pid;
  let owner = null;
  try {
    const st = fs.statSync(`/proc/${pid}/environ`);
    owner = `${st.uid}:${st.gid}`;
  } catch (e) {
    owner = e.code;
  }
  let reader;
  try {
    const got = execFileSync(
      "/usr/bin/setpriv",
      ["--reuid=1000", "--regid=1000", "--clear-groups", "--", "cat", `/proc/${pid}/environ`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    reader = got.includes(MARK) ? "READABLE (secret visible)" : "readable, marker missing";
  } catch (e) {
    reader = `denied (${String(e.stderr || e.message)
      .trim()
      .split("\n")
      .pop()})`;
  }
  out.holders[name] = { pid, environOwner: owner, uid1000Read: reader };
  child.kill("SIGKILL");
}
console.log(JSON.stringify(out, null, 1));
