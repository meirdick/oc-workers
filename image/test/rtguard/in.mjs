// Runs INSIDE the runtime image as root (privileged, cgroupns private). Real-kernel checks of the
// runtime guard modules: cgroup layout + limits, reap() of a setsid daemon with a zombie and a
// tracked helper, memwatch tier on a gw balloon + cgroup.kill, oom_score_adj, CPU sums, nft rule.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { cgMem, cgroupKill, cpuSeconds, procTreeCpuSeconds, setupCgroups } from "/opt/ocrt/lib/cgroups.mjs";
import { decide } from "/opt/ocrt/lib/memwatch.mjs";
import { applySupervisorOom, spawnPrelude } from "/opt/ocrt/lib/oom.mjs";
import { identity } from "/opt/ocrt/lib/procs.mjs";
import { reap, termGatewayTree } from "/opt/ocrt/lib/reaper.mjs";

const out = [];
const ok = (name, pass, detail) => {
  out.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (script, o = {}) =>
  spawn("sh", ["-c", script], { stdio: "ignore", detached: !!o.detached, env: { PATH: process.env.PATH } });

// 1. cgroups
const cg = setupCgroups();
ok("cgroups v2 layout", cg.mode === "v2", {
  mode: cg.mode,
  enabled: cg.enabled,
  gwMax: cg.gwMax,
  gwHigh: cg.gwHigh,
  moved: cg.moved,
});
const self = fs.readFileSync("/proc/self/cgroup", "utf8").trim();
ok("ocsup in ocrt/sup", self.endsWith("/ocrt/sup"), self);
const rb = (f) => fs.readFileSync(`${cg.dirs.root}/${f}`, "utf8").trim();
ok(
  "gw memory.max/high read back",
  rb("gw/memory.max") === String(cg.gwMax) && rb("gw/memory.high") === String(cg.gwHigh),
  {
    max: rb("gw/memory.max"),
    high: rb("gw/memory.high"),
    sys: rb("sys/memory.max"),
  },
);
ok("no browser leaf", !fs.existsSync(`${cg.dirs.root}/gw/browser`), null);

// 2. oom_score_adj
const oo = applySupervisorOom();
ok(
  "oom tini -1000 ocsup -900",
  fs.readFileSync("/proc/1/oom_score_adj", "utf8").trim() === "-1000" &&
    fs.readFileSync("/proc/self/oom_score_adj", "utf8").trim() === "-900",
  oo,
);

// 3. reap. In gw/main (uid 1000): a gateway node that starts a setsid daemon ignoring SIGTERM, and a
// LISTEN on 18789. Outside the tree (ocrt/sup, uid 1000, ignores SIGTERM): an "escaped" process.
// A uid-1000 zombie whose root parent never waits. A tracked helper (uid 1000, ocrt/io) must survive.
const pre = (role) =>
  spawnPrelude({
    cg: role === "io" ? cg.dirs.io : cg.dirs.gwMain,
    role: role === "io" ? "ocio" : "gateway",
  }).join("; ");
const drop = "setpriv --reuid=1000 --regid=1000 --init-groups --";
fs.writeFileSync(
  "/tmp/gw.js",
  `const {spawn}=require("child_process");
spawn("setsid",["sh","-c","trap '' TERM; exec sleep 600"],{detached:true,stdio:"ignore"}).unref();
require("net").createServer().listen(18789,"0.0.0.0");
setInterval(()=>{},1e9);`,
  { mode: 0o644 },
);
sh(`${pre("gw")}; exec ${drop} node /tmp/gw.js`);
sh(`${drop} sh -c "trap '' TERM; exec sleep 601"`); // escaped: stays in ocrt/sup
sh(`${drop} sleep 0.1 & exec sleep 602`); // root sleep 602 never waits → uid-1000 zombie
const helper = sh(`${pre("io")}; exec ${drop} sleep 600`);
await sleep(1500);
const helperPid = Number(fs.readFileSync(`${cg.dirs.io}/cgroup.procs`, "utf8").trim().split("\n")[0]);
const ps = () =>
  spawnSync("ps", ["-eo", "pid,uid,stat,comm,args"], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((l) => /^\s*\d+\s+1000\s/.test(l));
const before = ps();
const t1 = await termGatewayTree(cg.dirs.gw, {});
const r = await reap("test", { gwDir: cg.dirs.gw, tracked: () => new Set([identity(helperPid)]) });
const left = ps();
ok(
  "reap: daemon and escaped pid killed, zombie skipped, helper alive, no LISTEN",
  r.ok &&
    r.zombies >= 1 &&
    r.killed >= 1 &&
    left.every((l) => / Z/.test(l) || l.trim().startsWith(String(helperPid))) &&
    fs.existsSync(`/proc/${helperPid}`),
  {
    reap: r,
    termTree: t1,
    before,
    left,
  },
);
ok(
  "helper oom_score_adj 0, cgroup io",
  fs.readFileSync(`/proc/${helperPid}/oom_score_adj`, "utf8").trim() === "0",
  fs.readFileSync(`/proc/${helperPid}/cgroup`, "utf8").trim(),
);
try {
  process.kill(helperPid, "SIGKILL");
} catch {}
void helper;

// 4. memwatch on a real balloon in gw/main: shrink gw memory.max to 600 MiB, balloon 560 MiB.
fs.writeFileSync(`${cg.dirs.gw}/memory.high`, "max");
fs.writeFileSync(`${cg.dirs.gw}/memory.max`, String(600 * 1024 ** 2));
sh(
  `${pre("gw")}; exec ${drop} node -e 'const a=[];for(let i=0;i<560;i++)a.push(Buffer.alloc(1<<20,1));setInterval(()=>a.length,1e9)'`,
);
let tier = 0;
let d;
const t0 = Date.now();
for (let i = 0; i < 100 && tier < 3; i++) {
  await sleep(100);
  const m = cgMem(cg.dirs.gw);
  const mi = fs.readFileSync("/proc/meminfo", "utf8");
  const kb = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(mi)[1]) * 1024;
  d = decide(
    {
      now: Date.now(),
      vmTotal: kb("MemTotal"),
      vmAvail: kb("MemAvailable"),
      gwCurrent: m.current,
      gwMax: m.max,
    },
    {},
  );
  tier = d.tier;
}
const ck = await cgroupKill(cg.dirs.gw, {});
ok("memwatch tier 3 on gw balloon, cgroup.kill clears it", tier === 3 && ck.ok, {
  decision: d,
  msToTier3: Date.now() - t0,
  kill: ck,
  oomKill: cgMem(cg.dirs.gw).oomKill,
});

// 5. CPU: cgroup sum vs process tree
const burn = sh(`${pre("gw")}; exec ${drop} node -e 'const e=Date.now()+1500;while(Date.now()<e){}'`);
await new Promise((res) => burn.on("exit", res));
await sleep(200);
const cgS = cpuSeconds(cg.dirs.root);
const treeS = procTreeCpuSeconds();
ok("cpu sums present", cgS > 1 && treeS > 1, {
  cgroupS: cgS,
  procTreeS: treeS,
  ratio: +(cgS / treeS).toFixed(3),
});

const fail = out.filter((x) => !x.pass).length;
console.log(`SUMMARY pass=${out.length - fail} fail=${fail}`);
process.exit(fail ? 1 : 0);
