import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  cgMem,
  cgroupKill,
  cpuSeconds,
  delegationFiles,
  GIB,
  limitsFor,
  MIB,
  procTreeCpuSeconds,
  setupCgroups,
  vmBytes,
} from "../lib/cgroups.mjs";
import { addProc, put, tmpdir } from "./fixtures.mjs";

describe("cgroups", () => {
  it("limitsFor 6 GiB: gw max 5 GiB, high 90%, sys 512 MiB", () => {
    const l = limitsFor(6 * GIB);
    assert.equal(l.gwMax, 5 * GIB);
    assert.equal(l.gwHigh, Math.floor(5 * GIB * 0.9));
    assert.equal(l.sysMax, 512 * MIB);
    assert.equal(limitsFor(1 * GIB).gwMax, 512 * MIB);
  });

  it("vmBytes takes the lower of MemTotal and top memory.max", () => {
    const root = tmpdir();
    put(root, "proc/meminfo", "MemTotal:       16000000 kB\n");
    put(root, "cg/memory.max", `${6 * GIB}\n`);
    assert.equal(vmBytes({ proc: `${root}/proc`, cg: `${root}/cg` }), 6 * GIB);
    put(root, "cg/memory.max", "max\n");
    assert.equal(vmBytes({ proc: `${root}/proc`, cg: `${root}/cg` }), 16000000 * 1024);
  });

  it("delegation (M0 T2): sibling leaves need the common parent too", () => {
    const f = delegationFiles("/cg/ocrt", [["gw/main", "gw/browser"]]).sort();
    assert.deepEqual(f, [
      "/cg/ocrt/gw/browser/cgroup.procs",
      "/cg/ocrt/gw/cgroup.procs",
      "/cg/ocrt/gw/main/cgroup.procs",
    ]);
    assert.deepEqual(delegationFiles("/cg/ocrt", []), []);
  });

  it("setupCgroups makes the leaf layout and writes limits", () => {
    const root = tmpdir();
    const cg = `${root}/cg`;
    put(root, "cg/cgroup.controllers", "cpuset cpu io memory pids\n");
    put(root, "cg/cgroup.procs", "1\n7\n");
    const r = setupCgroups({ cg, proc: `${root}/proc`, skipMountCheck: true, vmBytes: 6 * GIB });
    for (const l of ["sup", "gw/main", "sys", "io"])
      assert.ok(fs.statSync(path.join(cg, "ocrt", l)).isDirectory(), l);
    assert.ok(!fs.existsSync(path.join(cg, "ocrt/gw/browser")), "no browser leaf in v1");
    assert.equal(r.mode, "v2");
    assert.deepEqual(r.enabled, ["memory", "pids", "cpu"]);
    assert.equal(fs.readFileSync(`${cg}/ocrt/gw/memory.max`, "utf8"), String(5 * GIB));
    assert.equal(fs.readFileSync(`${cg}/ocrt/gw/memory.oom.group`, "utf8"), "0");
    assert.equal(fs.readFileSync(`${cg}/ocrt/sys/memory.max`, "utf8"), String(512 * MIB));
    assert.equal(fs.readFileSync(`${cg}/cgroup.subtree_control`, "utf8"), "+memory +pids +cpu");
    assert.deepEqual(r.chown, {});
    assert.equal(r.moved, 2);
  });

  it("setupCgroups without a cgroup2 mount gives mode none", () => {
    const root = tmpdir();
    put(root, "proc/self/mountinfo", "22 1 0:21 / /sys rw - sysfs sysfs rw\n");
    assert.equal(setupCgroups({ cg: `${root}/cg`, proc: `${root}/proc` }).mode, "none");
  });

  it("cgroupKill writes cgroup.kill and waits, skipping zombies", async () => {
    const root = tmpdir();
    const gw = `${root}/gw`;
    put(gw, "cgroup.procs", "11\n");
    put(gw, "main/cgroup.procs", "12\n13\n");
    setTimeout(() => {
      fs.writeFileSync(`${gw}/cgroup.procs`, "");
      fs.writeFileSync(`${gw}/main/cgroup.procs`, "13\n");
    }, 120);
    const r = await cgroupKill(gw, { capMs: 2000, isZombie: (pid) => pid === 13 });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(`${gw}/cgroup.kill`, "utf8"), "1");
    const r2 = await cgroupKill(gw, { capMs: 150 });
    assert.equal(r2.ok, false);
    assert.deepEqual(r2.left, [13]);
  });

  it("cgMem and cpuSeconds parse the files", () => {
    const root = tmpdir();
    put(root, "gw/memory.current", "1048576\n");
    put(root, "gw/memory.max", "max\n");
    put(root, "gw/memory.events", "low 0\nhigh 3\nmax 1\noom 1\noom_kill 2\n");
    assert.deepEqual(cgMem(`${root}/gw`), { current: 1048576, max: null, high: 3, oomKill: 2 });
    put(root, "ocrt/cpu.stat", "usage_usec 27400000\nuser_usec 1\nsystem_usec 2\n");
    assert.equal(cpuSeconds(`${root}/ocrt`), 27.4);
  });

  it("procTreeCpuSeconds sums utime+stime+cutime+cstime", () => {
    const root = tmpdir();
    addProc(root, 1, { utime: 10, cutime: 100 });
    addProc(root, 20, { utime: 200, stime: 50, cstime: 40 });
    assert.equal(procTreeCpuSeconds({ proc: root }), 4);
  });
});
