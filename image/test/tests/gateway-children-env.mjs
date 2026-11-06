// M4 fix M3-1 (worker/test/results/M3-security-review.md): gateway children leaked OPENCLAW_GATEWAY_PASSWORD
// and OC_ANTHROPIC_KEY to uid 1000 (children lost nodump.so, env not scrubbed). Rule: SecretRefs resolve in
// the gateway process only; each gateway child has a scrubbed env and stays non-dumpable.
import { gatewayPid } from "../harness/flows.mjs";

const KEY = "sk-ant-m4-probe-6f1d2c9e8b7a";
// In-container sampler (root): argv gw pid, ms, secrets... → JSON rows, one per descendant pid seen.
const SAMPLER = `const fs=require("fs"),cp=require("child_process");const [gw,ms,...sec]=process.argv.slice(1);const seen=new Map();
const end=Date.now()+Number(ms);const tick=()=>{const all=[];for(const d of fs.readdirSync("/proc")){if(!/^\\d+$/.test(d))continue;
try{const st=fs.readFileSync("/proc/"+d+"/stat","utf8");all.push({pid:+d,ppid:+st.slice(st.lastIndexOf(")")+2).split(" ")[1]})}catch{}}
const below=new Set([+gw]);for(let i=0;i<8;i++)for(const p of all)if(below.has(p.ppid))below.add(p.pid);below.delete(+gw);
for(const pid of below){if(seen.has(pid))continue;let env,cmd;try{env=fs.readFileSync("/proc/"+pid+"/environ","utf8");cmd=fs.readFileSync("/proc/"+pid+"/cmdline","utf8").split("\\0").join(" ").slice(0,90)}catch{continue}
let u;try{cp.execFileSync("setpriv",["--reuid=1000","--regid=1000","--clear-groups","head","-c","1","/proc/"+pid+"/environ"],{stdio:"pipe"});u="READ"}catch{u="DENIED"}
const names=env.split("\\0").map(l=>l.split("=")[0]).filter(Boolean);
seen.set(pid,{pid,cmd,uid1000Read:u,leaks:sec.filter(s=>env.includes(s)).length,badNames:names.filter(n=>/^OC_|^OPENCLAW_GATEWAY_(PASSWORD|TOKEN)$/.test(n)),preload:(/(?:^|\\0)LD_PRELOAD=([^\\0]*)/.exec(env)||[])[1]||null})}
if(Date.now()<end)setTimeout(tick,500);else console.log(JSON.stringify([...seen.values()]))};tick();`;

export default {
  name: "gateway-children-env",
  source: "M3 security review M3-1; plan §6.1 row 4; scope Z2.5",
  rule: "Gateway with trusted-proxy config: every process below the gateway (uid 1000) has /proc/<pid>/environ unreadable by uid 1000, and its environ (root read) holds no OC_* value, no OPENCLAW_GATEWAY_PASSWORD/TOKEN; the gateway itself still has the key.",
  needs: ["m1"],
  timeoutMs: 400_000,
  async run(t) {
    const b = t.box({
      name: "a",
      gen: 1,
      env: { OC_ANTHROPIC_KEY: KEY },
    });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    // Sample every process below the gateway for 90 s from /startupz (in-container loop, 500 ms), so short-lived
    // descendants count too (M4 live: the spawn broker ran `pnpm root -g` with the gateway env it got over IPC).
    const gw = gatewayPid(b);
    const gwVals = b.sh(`tr '\\0' '\\n' < /proc/${gw}/environ`).out;
    t.check("gateway env still has OC_ANTHROPIC_KEY (SecretRef source)", /^OC_ANTHROPIC_KEY=/m.test(gwVals));
    const pw = /^OPENCLAW_GATEWAY_PASSWORD=(.*)$/m.exec(gwVals)?.[1] || null;
    const tok = /^OC_GATEWAY_TOKEN=(.*)$/m.exec(gwVals)?.[1] || null;
    t.measure("gatewayHasPassword", !!pw);
    const secrets = [KEY, pw, tok].filter((s) => s && s.length >= 8);
    const r = b.sh(["node", "-e", SAMPLER, String(gw), "90000", ...secrets], { timeoutMs: 150_000 });
    let rows = [];
    try {
      rows = JSON.parse(r.out.trim().split("\n").pop());
    } catch {}
    t.measure("childRows", rows);
    t.check("gateway has ≥ 1 descendant", rows.length >= 1, rows.length);
    t.check("children read", rows.length >= 1, rows.length);
    t.check(
      "no child environ readable by uid 1000",
      rows.every((r) => r.uid1000Read === "DENIED"),
      rows.filter((r) => r.uid1000Read !== "DENIED").map((r) => r.pid),
    );
    t.check(
      "no secret value in any child env",
      rows.every((r) => r.leaks === 0),
      rows.filter((r) => r.leaks).map((r) => r.pid),
    );
    t.check(
      "no OC_*/gateway password/token name in any child env",
      rows.every((r) => r.badNames.length === 0),
      rows.flatMap((r) => r.badNames),
    );
    t.check(
      "children keep nodump.so, no jemalloc",
      rows.every((r) => /nodump\.so/.test(r.preload || "") && !/jemalloc/.test(r.preload || "")),
      rows.map((r) => r.preload),
    );
  },
};
