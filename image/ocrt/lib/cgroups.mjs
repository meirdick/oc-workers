// cgroup v2 setup for ocsup (plan §4.2, scope §1.1 row "PID 1 and cgroups", M0 T2 item 4).
// Leaf layout: ocrt/sup (tini, ocsup), ocrt/gw/main (gateway tree), ocrt/sys (Litestream), ocrt/io (ocio).
// The shared gateway limit sits on ocrt/gw. cgroup v2 forbids processes in a cgroup that enables
// controllers for its children, so every process lives in a leaf.
import fs from "node:fs";
import path from "node:path";
import { readText, sleep, sysPaths, writeText } from "./sysfs.mjs";

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;

export const LEAVES = ["sup", "gw/main", "sys", "io"];

/**
 * Memory limits for a VM size. guess: gw max = VM - 1 GiB (plan §4.2), floor 512 MiB.
 * sys (Litestream) 512 MiB: M0 T4 peak 222 MB replicate, 128 MB restore at 1 GB.
 */
export function limitsFor(vmBytes, o = {}) {
  const reserve = o.reserveBytes ?? GIB;
  const gwMax = Math.max(vmBytes - reserve, 512 * MIB);
  return {
    gwMax,
    gwHigh: Math.floor(gwMax * (o.highFraction ?? 0.9)),
    sysMax: o.sysMax ?? 512 * MIB,
  };
}

/** VM memory: MemTotal, capped by the top cgroup memory.max. */
export function vmBytes(p = sysPaths()) {
  const m = /MemTotal:\s+(\d+) kB/.exec(readText(`${p.proc}/meminfo`) || "");
  const total = m ? Number(m[1]) * 1024 : 0;
  const lim = (readText(`${p.cg}/memory.max`) || "").trim();
  return lim && lim !== "max" && Number(lim) > 0 ? Math.min(total, Number(lim)) : total;
}

/** Is cgroup2 mounted at p.cg? Reads /proc/self/mountinfo. */
export function cgroup2Mounted(p = sysPaths()) {
  const mi = readText(`${p.proc}/self/mountinfo`) || "";
  return mi.split("\n").some((l) => / - cgroup2 /.test(l) && l.split(" ")[4] === p.cg);
}

/**
 * Delegation set (M0 T2 item 4): a uid-1000 move between two leaves needs write access on both
 * leaf cgroup.procs AND the common parent's cgroup.procs. Returns the cgroup.procs paths to chown.
 * v1 has no browser leaf, so ocsup passes no pairs and chowns nothing.
 */
export function delegationFiles(root, pairs) {
  const out = new Set();
  for (const [a, b] of pairs) {
    const pa = a.split("/");
    const pb = b.split("/");
    let i = 0;
    while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
    const common = pa.slice(0, i).join("/");
    out.add(path.join(root, a, "cgroup.procs"));
    out.add(path.join(root, b, "cgroup.procs"));
    out.add(path.join(root, common, "cgroup.procs"));
  }
  return [...out];
}

/**
 * Create the tree and set limits. Returns {mode, dirs, writes, ...}. Never throws.
 * mode "v2" = tree made and gw memory.max written; "v2-nolimit" = tree made, limits refused; "none".
 */
export function setupCgroups(o = {}) {
  const p = sysPaths(o);
  const res = { mode: "none" };
  if (!(o.skipMountCheck || cgroup2Mounted(p))) return { ...res, why: "no cgroup2 mount" };
  const root = path.join(p.cg, "ocrt");
  try {
    for (const l of LEAVES) fs.mkdirSync(path.join(root, l), { recursive: true });
  } catch (e) {
    return { ...res, why: `mkdir: ${e.code}` };
  }
  // Move every process of the top cgroup into ocrt/sup. Kernel threads in a real root fail; ignore.
  let moved = 0;
  for (const pid of (readText(`${p.cg}/cgroup.procs`) || "").split("\n").filter(Boolean))
    if (writeText(`${root}/sup/cgroup.procs`, pid) === true) moved++;
  const ctrl = (readText(`${p.cg}/cgroup.controllers`) || "").trim().split(/\s+/);
  const want = ["memory", "pids", "cpu"].filter((c) => ctrl.includes(c));
  const line = want.map((c) => `+${c}`).join(" ");
  const subtree = {
    top: writeText(`${p.cg}/cgroup.subtree_control`, line),
    ocrt: writeText(`${root}/cgroup.subtree_control`, line),
    gw: writeText(`${root}/gw/cgroup.subtree_control`, line),
  };
  const vm = o.vmBytes ?? vmBytes(p);
  const lim = limitsFor(vm, o);
  const writes = {
    "gw/memory.max": writeText(`${root}/gw/memory.max`, lim.gwMax),
    "gw/memory.high": writeText(`${root}/gw/memory.high`, lim.gwHigh),
    // 0: an OOM in the gateway tree kills one process, never the whole tree (plan §4.2).
    "gw/memory.oom.group": writeText(`${root}/gw/memory.oom.group`, 0),
    "sys/memory.max": writeText(`${root}/sys/memory.max`, lim.sysMax),
  };
  const chown = {};
  for (const f of delegationFiles(root, o.delegate || [])) {
    try {
      fs.chownSync(f, 1000, 1000);
      chown[path.relative(root, f)] = true;
    } catch (e) {
      chown[path.relative(root, f)] = e.code;
    }
  }
  const dirs = {
    root,
    gw: `${root}/gw`,
    gwMain: `${root}/gw/main`,
    sup: `${root}/sup`,
    sys: `${root}/sys`,
    io: `${root}/io`,
  };
  return {
    mode: writes["gw/memory.max"] === true ? "v2" : "v2-nolimit",
    dirs,
    controllers: ctrl,
    enabled: want,
    subtree,
    writes,
    chown,
    moved,
    killFile: fs.existsSync(`${root}/gw/cgroup.kill`),
    vmBytes: vm,
    ...lim,
  };
}

/** pids in a cgroup (its own cgroup.procs only). */
export function procsOf(dir) {
  return (readText(`${dir}/cgroup.procs`) || "").split("\n").filter(Boolean).map(Number);
}

/** pids in a cgroup and every child cgroup. */
export function procsDeep(dir) {
  const out = procsOf(dir);
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {}
  for (const e of ents) if (e.isDirectory()) out.push(...procsDeep(path.join(dir, e.name)));
  return out;
}

/**
 * Kill a cgroup subtree with cgroup.kill and wait until no live pid is left (cap ms).
 * isZombie(pid) lets the caller skip zombie entries. Returns {ok, left, ms, written}.
 */
export async function cgroupKill(dir, o = {}) {
  const t = Date.now();
  const cap = o.capMs ?? 10_000;
  const isZombie = o.isZombie || (() => false);
  const written = writeText(`${dir}/cgroup.kill`, 1);
  const live = () => procsDeep(dir).filter((pid) => !isZombie(pid));
  let left = live();
  while (left.length && Date.now() - t < cap) {
    await sleep(o.pollMs ?? 50);
    left = live();
  }
  return { ok: left.length === 0, left, ms: Date.now() - t, written };
}

/** Parse a flat keyed file (memory.events, cpu.stat). */
export function keyed(text) {
  const out = {};
  for (const l of (text || "").split("\n")) {
    const [k, v] = l.trim().split(/\s+/);
    if (k) out[k] = Number(v);
  }
  return out;
}

/** Memory facts of one cgroup. */
export function cgMem(dir) {
  if (!dir) return null;
  const v = (f) => (readText(`${dir}/${f}`) || "").trim();
  const ev = keyed(v("memory.events"));
  const max = v("memory.max");
  return {
    current: Number(v("memory.current")) || 0,
    max: max === "max" || !max ? null : Number(max),
    high: ev.high ?? 0,
    oomKill: ev.oom_kill ?? 0,
  };
}

/**
 * CPU seconds of this boot (amendment row 23): usage_usec of ocrt/cpu.stat, which counts every
 * descendant since creation. Never /proc/uptime or the root cpu.stat (per VM).
 */
export function cpuSeconds(root) {
  const u = keyed(readText(`${root}/cpu.stat`)).usage_usec;
  return Number.isFinite(u) ? u / 1e6 : null;
}

/**
 * Process-tree CPU seconds (cross-check for cpuSeconds): utime+stime+cutime+cstime of every live
 * /proc/<pid>/stat. A dead process is counted once, in the cutime of the process that reaped it.
 * Clock ticks = 100 (Linux x86_64 USER_HZ).
 */
export function procTreeCpuSeconds(p = sysPaths(), hz = 100) {
  let ticks = 0;
  let ents = [];
  try {
    ents = fs.readdirSync(p.proc);
  } catch {}
  for (const d of ents) {
    if (!/^\d+$/.test(d)) continue;
    const st = readText(`${p.proc}/${d}/stat`);
    if (!st) continue;
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    // fields after comm: 0 state … 11 utime 12 stime 13 cutime 14 cstime
    ticks += Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]);
  }
  return ticks / hz;
}
