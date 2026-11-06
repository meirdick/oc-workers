// M4b N2 (M4 fix report N2): an idle always-on install was never clean, and each checkpoint was ~55 MB for a
// ~1.3 KB $STATE change. Measures the rootfs delta a checkpoint snapshot would carry (sum of sizes of regular
// files on the container rootfs changed in the window: overlay copy-up keeps whole files) for a 1 KB workspace
// write, before and after ocsupctl `checkpoint-prep`, and the `dirty` answer for an idle window.
const WALK = `const fs=require("fs"),p=require("path");const since=Number(process.argv[1]);const skip=new Set(["/proc","/sys","/dev","/run/secrets"]);
const by={};let total=0,n=0;const top=[];const walk=(d,depth)=>{if(skip.has(d)||depth>30)return;let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return}
for(const e of es){const f=p.join(d,e.name);let st;try{st=fs.lstatSync(f)}catch{continue}if(st.dev!==root)continue;if(e.isDirectory()){walk(f,depth+1);continue}
if(!e.isFile())continue;if(Math.max(st.mtimeMs,st.ctimeMs)<=since)continue;n++;total+=st.size;const k=f.split("/").slice(0,4).join("/");by[k]=(by[k]||0)+st.size;top.push([st.size,f])}};
const root=fs.statSync("/").dev;walk("/",0);top.sort((a,b)=>b[0]-a[0]);console.log(JSON.stringify({n,total,by:Object.entries(by).sort((a,b)=>b[1]-a[1]).slice(0,12),top:top.slice(0,12)}))`;

// Non-managed (shadow-class) SQLite of ~8 MB, made by uid 1000 in the window (an agent memory DB shape).
const SHADOW_DB = `const {DatabaseSync}=require("node:sqlite");require("fs").mkdirSync("/home/node/.openclaw/memory",{recursive:true});
const c=new DatabaseSync("/home/node/.openclaw/memory/m4b-mem.sqlite");c.exec("create table if not exists t(b blob)");
const s=c.prepare("insert into t values(randomblob(8192))");for(let i=0;i<1000;i++)s.run();c.close()`;

export default {
  name: "m4b-checkpoint-delta",
  source: "M4 fix report N2; M4-STATUS §7 fix N2; plan §6.1 row 6",
  rule: "Idle 60 s: `dirty` false (no tmp locks, logs, caches). Window with a 1 KB workspace write and a new 8 MB shadow-class DB, then the checkpoint's shadow round: `dirty` lists the workspace file; the rootfs delta holds no local shadow copy under /var/lib/ocrt/shadow.",
  needs: ["m1", "ocsupctl"],
  timeoutMs: 900_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1 });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    await t.sleep(60_000); // settle after start
    const now = () => Number(b.sh(["node", "-e", "console.log(Date.now())"]).out.trim());
    const t0 = now();
    await t.sleep(60_000);
    const idle = b.ctl("dirty", { args: { sinceMs: t0 } });
    t.measure("dirtyIdle", idle);
    const t1 = now();
    b.as1000([
      "sh",
      "-c",
      "mkdir -p /home/node/.openclaw/workspace && head -c 1024 /dev/urandom | base64 | head -c 1024 > /home/node/.openclaw/workspace/m4b-1k.md",
    ]);
    b.as1000(["node", "-e", SHADOW_DB], { timeoutMs: 60_000 });
    await t.sleep(5000);
    const d1 = b.ctl("dirty", { args: { sinceMs: t1 } });
    t.measure("dirty1k", d1);
    const sh = b.ctl("shadow-backup"); // the checkpoint's shadow phase
    t.measure("shadowBackup", sh);
    const walk = (since) => {
      const r = b.sh(["node", "-e", WALK, String(since)], { timeoutMs: 120_000 });
      try {
        return JSON.parse(r.out.trim().split("\n").pop());
      } catch {
        return { error: r.err.slice(-300) };
      }
    };
    const delta = walk(t1);
    t.measure("delta", delta);
    const shadowBytes = (delta.top || [])
      .filter(([, f]) => f.startsWith("/var/lib/ocrt/shadow/"))
      .reduce((a, [n]) => a + n, 0);
    t.measure("deltaShadowCopyBytes", shadowBytes);
    t.measure("deltaTotalBytes", delta.total ?? null);
    t.check("idle window: dirty false (no tmp locks, logs, caches)", idle?.dirty === false, idle);
    t.check(
      "1 KB write: dirty sample has the workspace file",
      d1?.dirty === true && (d1?.sample || []).some((r) => /m4b-1k\.md$/.test(r)),
      d1,
    );
    t.check("shadow round uploaded the new DB", JSON.stringify(sh).includes("m4b-mem.sqlite"), sh);
    t.check("no local shadow copy in the rootfs delta", shadowBytes === 0, shadowBytes);
  },
};
