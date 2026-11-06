// Amend §2 row 23: per boot, sum of usage_usec of the ocrt/* cgroups vs the process-tree sum within 10%,
// over 5 boots. Never /proc/uptime or the root cpu.stat.
const SUMS = `const fs=require("fs");const hz=100;
let cg=0;for(const d of ["sup","gw","sys","io"]){try{cg+=Number(/usage_usec (\\d+)/.exec(fs.readFileSync("/sys/fs/cgroup/ocrt/"+d+"/cpu.stat","utf8"))[1])}catch{}}
let pt=0;for(const p of fs.readdirSync("/proc")){if(!/^\\d+$/.test(p))continue;try{const s=fs.readFileSync("/proc/"+p+"/stat","utf8");const r=s.slice(s.lastIndexOf(")")+2).split(" ");
const self=Number(r[11])+Number(r[12]);const kids=Number(r[13])+Number(r[14]);pt+=self+kids}catch{}}
console.log(JSON.stringify({cgroupS:cg/1e6,treeS:pt/hz}))`;

export default {
  name: "cpu-sums",
  source: "amend §2 row 23 (M1: the two sums within 10% over 5 boots)",
  rule: "5 boots, each read 10 s after /startupz: |cgroup sum - process-tree sum| / cgroup sum <= 10%; heartbeat cpuS (if sent) within 10% of the cgroup sum.",
  timeoutMs: 1_800_000,
  async run(t) {
    const rows = [];
    for (let i = 0; i < 5; i++) {
      const b = t.box({ name: `b${i}`, gen: i + 1 });
      await b.start();
      if (!t.check(`boot ${i + 1}: /startupz`, (await b.startupz()) !== null)) continue;
      await t.sleep(10_000);
      // The probe itself is outside ocrt/* and exits before it is counted.
      let v = null;
      try {
        v = JSON.parse(b.sh(["node", "-e", SUMS]).out);
      } catch {}
      const hb = (await t.records({ plane: "control", route: "/v1/heartbeat" }))
        .filter((r) => r.body?.gen === i + 1)
        .at(-1);
      const row = { ...v, hbCpuS: hb?.body?.cpuS ?? null };
      row.diffPct = v ? (Math.abs(v.cgroupS - v.treeS) / v.cgroupS) * 100 : null;
      rows.push(row);
      t.note(`boot ${i + 1}: ${JSON.stringify(row)}`);
      b.rm();
    }
    t.measure("boots", rows);
    t.check("5 boots read", rows.filter((r) => r.cgroupS > 0).length === 5);
    t.check(
      "cgroup vs process tree within 10% each boot",
      rows.every((r) => r.diffPct !== null && r.diffPct <= 10),
      rows.map((r) => r.diffPct?.toFixed(1)),
    );
    const withHb = rows.filter((r) => r.hbCpuS !== null);
    if (withHb.length)
      t.check(
        "heartbeat cpuS within 10% of the cgroup sum",
        withHb.every((r) => Math.abs(r.hbCpuS - r.cgroupS) / r.cgroupS <= 0.1),
        withHb.map((r) => [r.hbCpuS, r.cgroupS]),
      );
  },
};
