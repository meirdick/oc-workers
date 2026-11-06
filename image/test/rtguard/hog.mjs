// In-image hog runs (root, privileged, cgroupns private). Part A: memwatch vs a growing gw hog, N runs:
// pass = memwatch acts (tier 2/3) and ocrt/gw memory.events oom_kill stays 0. Part B: a CLI-role
// balloon (+300) against the container memory limit dies, ocsup-role (-900) survives.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { cgMem, cgroupKill, setupCgroups } from "/opt/ocrt/lib/cgroups.mjs";
import { decide } from "/opt/ocrt/lib/memwatch.mjs";
import { applySupervisorOom, spawnPrelude } from "/opt/ocrt/lib/oom.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const part = process.argv[2] || "A";
const runs = Number(process.argv[3] || 10);
const cg = setupCgroups();
applySupervisorOom();
const drop = "setpriv --reuid=1000 --regid=1000 --init-groups --";
const HOG = "/tmp/hog.js";
// 32 MiB every 100 ms, up to 3 GiB: without memwatch it hits memory.max and the kernel OOM-kills it.
fs.writeFileSync(
  HOG,
  "const a=[];const t=setInterval(()=>{if(a.length>=96)return;a.push(Buffer.alloc(32<<20,1))},100);",
  { mode: 0o644 },
);
const meminfo = () => {
  const mi = fs.readFileSync("/proc/meminfo", "utf8");
  const kb = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(mi)[1]) * 1024;
  return { total: kb("MemTotal"), avail: kb("MemAvailable") };
};

if (part === "A") {
  // gw limit 1 GiB, high 90%: a small VM share so the test is fast.
  fs.writeFileSync(`${cg.dirs.gw}/memory.max`, String(1024 ** 3));
  fs.writeFileSync(`${cg.dirs.gw}/memory.high`, String(Math.floor(0.9 * 1024 ** 3)));
  let pass = 0;
  for (let i = 1; i <= runs; i++) {
    const oom0 = cgMem(cg.dirs.gw).oomKill;
    const pre = spawnPrelude({ cg: cg.dirs.gwMain, role: "gateway" }).join("; ");
    spawn("sh", ["-c", `${pre}; exec ${drop} node ${HOG}`], { stdio: "ignore" });
    const st = {};
    let d = { tier: 0 };
    const t0 = Date.now();
    let acted = null;
    while (Date.now() - t0 < 30_000) {
      await sleep(1000); // memwatch period (plan §4.6: every 1 s)
      const m = cgMem(cg.dirs.gw);
      const vm = meminfo();
      d = decide(
        { now: Date.now(), vmTotal: vm.total, vmAvail: vm.avail, gwCurrent: m.current, gwMax: m.max },
        st,
      );
      if (d.tier >= 2) {
        // tier 2 is a graceful restart; the hog has no drain, so both tiers end in cgroup.kill here.
        const k = await cgroupKill(cg.dirs.gw, {});
        acted = {
          tier: d.tier,
          reasons: d.reasons,
          ms: Date.now() - t0,
          gwFrac: +d.gwFrac.toFixed(3),
          killOk: k.ok,
        };
        break;
      }
    }
    if (!acted) await cgroupKill(cg.dirs.gw, {});
    const oom = cgMem(cg.dirs.gw).oomKill - oom0;
    const ok = !!acted && oom === 0;
    if (ok) pass++;
    console.log(`run ${i}: ${ok ? "PASS" : "FAIL"} acted=${JSON.stringify(acted)} oom_kill+${oom}`);
    await sleep(300);
  }
  console.log(`SUMMARY A pass=${pass}/${runs}`);
} else {
  // B: container --memory limit; a CLI child (+300) balloons in ocrt/io (no own limit).
  const sup = spawn(
    "sh",
    ["-c", `${spawnPrelude({ cg: cg.dirs.sup, role: "ocsup" }).join("; ")}; exec sleep 600`],
    { stdio: "ignore" },
  );
  const pre = spawnPrelude({ cg: cg.dirs.io, role: "cli" }).join("; ");
  const cli = spawn("sh", ["-c", `${pre}; exec ${drop} node ${HOG}`], { stdio: "ignore" });
  const res = await new Promise((r) => {
    cli.on("exit", (code, signal) => r({ code, signal }));
    setTimeout(() => r({ timeout: true }), 60_000);
  });
  await sleep(500);
  const supAlive = sup.exitCode === null && sup.signalCode === null;
  const ev = fs.readFileSync("/sys/fs/cgroup/memory.events", "utf8").replace(/\n/g, " ");
  console.log(
    `cli exit ${JSON.stringify(res)}; ocsup-role (-900) alive=${supAlive}; self alive; top memory.events: ${ev}`,
  );
  console.log(`SUMMARY B ${res.signal === "SIGKILL" && supAlive ? "PASS" : "FAIL"}`);
  sup.kill("SIGKILL");
}
process.exit(0);
