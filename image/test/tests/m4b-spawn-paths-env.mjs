// M4b S1 + S2 (worker/test/results/M4-security-review.md §2): spawn paths the unpreload.mjs child_process hook
// does not see. A uid-1000 node process started exactly like the gateway (the gateway's own start env from
// /proc/<gw>/environ, LD_PRELOAD, --import unpreload.mjs) spawns `sleep` children by: (main) child_process in
// the main thread (control), (worker) child_process in a worker_threads Worker (S2 class: guess for the
// post-wake sqlite worker), (pty) @lydell/node-pty spawn with env = process.env (S1: exec {pty:true}).
// Each child: environ must hold no secret value and must not be readable by another uid-1000 process.
import { gatewayPid } from "../harness/flows.mjs";

const KEY = "sk-ant-m4b-probe-7c1e9a2b4d6f";
// Run as uid 1000 with the gateway env. Prints one JSON row per path.
const PROBE = `const cp=require("child_process"),fs=require("fs"),{Worker}=require("worker_threads");
const sec=JSON.parse(process.argv[2]);const rows=[];
const look=(path,pid)=>{let env="",read="DENIED";try{env=cp.execFileSync("cat",["/proc/"+pid+"/environ"],{encoding:"utf8"});read="READ"}catch{}
const names=env.split("\\0").filter(l=>/^(OC_|OPENCLAW_GATEWAY_)/.test(l)).map(l=>l.split("=")[0]+(l.endsWith("=ochost-scrubbed")?"=placeholder":"=value"));
rows.push({path,pid,uid1000Read:read,leaks:sec.filter(s=>env.includes(s)).length,names})};
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
const a=cp.spawn("sleep",["8"],{stdio:"ignore"});await wait(800);look("main",a.pid);
const w=new Worker('const cp=require("child_process");const c=cp.spawn("sleep",["8"],{stdio:"ignore",env:process.env});require("worker_threads").parentPort.postMessage(c.pid);',{eval:true});
const wp=await new Promise(r=>w.once("message",r));await wait(800);look("worker",wp);
try{const pty=require("/app/node_modules/@lydell/node-pty");const p=pty.spawn("sleep",["8"],{env:process.env,cwd:"/tmp"});await wait(800);look("pty",p.pid)}catch(e){rows.push({path:"pty",error:String(e).slice(0,200)})}
console.log(JSON.stringify(rows));setTimeout(()=>process.exit(0),3000)})();`;

export default {
  name: "m4b-spawn-paths-env",
  source: "M4 security review S1 (node-pty exec), S2 (post-wake sqlite worker); scope Z2.5",
  rule: "Children made by child_process in the main thread, child_process in a worker thread and node-pty, from a process with the gateway's start env and preloads: 0 secret values, environ DENIED to uid 1000.",
  needs: ["m1"],
  timeoutMs: 400_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1, env: { OC_ANTHROPIC_KEY: KEY } });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    const gw = gatewayPid(b);
    const env = b.sh(`tr '\\0' '\\n' < /proc/${gw}/environ`).out.split("\n").filter(Boolean);
    const val = (k) => env.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1) || null;
    const secrets = [KEY, val("OPENCLAW_GATEWAY_PASSWORD"), val("OC_GATEWAY_TOKEN")].filter(
      (s) => s && s.length >= 8,
    );
    t.measure("gatewayStartEnvNames", env.map((l) => l.split("=")[0]).sort());
    t.measure("secretCount", secrets.length);
    // Probe script readable by uid 1000; the launcher (root) takes env -i + the gateway's start env (with its
    // LD_PRELOAD) and runs node --import unpreload.mjs as uid 1000, like ocsup starts the gateway.
    b.sh([
      "node",
      "-e",
      'require("fs").writeFileSync("/tmp/m4b-probe.js", process.argv[1], {mode: 0o644})',
      PROBE,
    ]);
    // MALLOC_CONF dropped: a uid-1000 node with jemalloc background_thread aborts in this replay (harness only,
    // also on the HEAD image; the gateway itself runs with it). Root reads each child's environ for the leak
    // count while the children still sleep.
    const LAUNCH = `const e=JSON.parse(process.argv[1]).filter(l=>!l.startsWith("MALLOC_CONF="));const sec=JSON.parse(process.argv[2]);const o={};for(const l of e){const i=l.indexOf("=");o[l.slice(0,i)]=l.slice(i+1)}
const cp=require("child_process"),fs=require("fs");const c=cp.spawn("/usr/bin/setpriv",["--reuid=1000","--regid=1000","--init-groups","--","/usr/local/bin/node","--import","/opt/ocrt/unpreload.mjs","/tmp/m4b-probe.js",process.argv[2]],{env:o,cwd:"/app"});
let out="",err="";c.stderr.on("data",d=>err+=d);c.stdout.on("data",d=>{out+=d;const l=out.split("\\n").find(x=>x.startsWith("["));if(!l)return;c.stdout.removeAllListeners("data");
const rows=JSON.parse(l);for(const r of rows){if(!r.pid)continue;let env="";try{env=fs.readFileSync("/proc/"+r.pid+"/environ","utf8")}catch(x){r.rootErr=String(x.code)}
r.leaks=sec.filter(s=>env.includes(s)).length;r.names=env.split("\\0").filter(x=>/^(OC_|OPENCLAW_GATEWAY_)/.test(x)).map(x=>x.split("=")[0]+(x.endsWith("=ochost-scrubbed")?"=placeholder":"=value"));
r.preload=(/(?:^|\\0)LD_PRELOAD=([^\\0]*)/.exec(env)||[])[1]||null}console.log(JSON.stringify(rows))});
c.on("exit",(code)=>{if(!out.includes("["))console.error("probe exit "+code+" "+err.slice(-500))});setTimeout(()=>process.exit(0),20000).unref()`;
    const run = b.sh(["node", "-e", LAUNCH, JSON.stringify(env), JSON.stringify(secrets)], {
      timeoutMs: 120_000,
    });
    let rows = [];
    try {
      rows = JSON.parse(
        run.out
          .trim()
          .split("\n")
          .filter((l) => l.startsWith("["))
          .pop(),
      );
    } catch {}
    t.measure("rows", rows.length ? rows : { out: run.out.slice(-500), err: run.err.slice(-800) });
    for (const p of ["main", "worker", "pty"]) {
      const r = rows.find((x) => x.path === p);
      t.check(`${p}: child sampled`, !!r && !r.error, r);
      t.check(`${p}: no secret value in the child env`, r?.leaks === 0, r);
      t.check(`${p}: child environ DENIED to uid 1000`, r?.uid1000Read === "DENIED", r);
    }
  },
};
