// M4 fix A1 (worker/test/results/M3-live-A.md §5.1): a Doctor staged copy left a cron_jobs row with
// store_key /var/lib/ocrt/stage-u/cron/jobs.json and a past nextRunAtMs; nextWakeAtMs went past and no job
// pre-woke the install. Rule: ocsup reconciles cron rows against the gateway's cron.list at each gateway
// start; an orphan is deleted and logged (event + gate alert); sleep-read ignores it in the meantime.
import { gateAlerts } from "../harness/flows.mjs";

const DB = "/home/node/.openclaw/state/openclaw.sqlite";
const ORPHAN_KEY = "/var/lib/ocrt/stage-u/cron/jobs.json";

// Insert a row with every NOT NULL column filled (schema read at run time; OpenClaw owns it).
const INSERT = `const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync(process.argv[1]);c.exec("PRAGMA busy_timeout=5000");
const cols=c.prepare("PRAGMA table_info(cron_jobs)").all();const now=Date.now();const v={};
for(const k of cols){if(k.notnull&&k.dflt_value===null)v[k.name]=k.type.toUpperCase().includes("INT")?0:"m4";}
Object.assign(v,{store_key:process.argv[2],job_id:"m4-orphan-0001",enabled:1,
job_json:JSON.stringify({id:"m4-orphan-0001",name:"heartbeat-main",schedule:{kind:"every",everyMs:1800000}}),
state_json:JSON.stringify({nextRunAtMs:now-4.5*3600000})});
for(const k of Object.keys(v))if(!cols.some(x=>x.name===k))delete v[k];
const ks=Object.keys(v);c.prepare("INSERT INTO cron_jobs ("+ks.join(",")+") VALUES ("+ks.map(()=>"?").join(",")+")").run(...ks.map(k=>v[k]));
console.log(JSON.stringify({ok:true,cols:cols.map(x=>x.name)}))`;
const COUNT = `const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync(process.argv[1],{readOnly:true});
console.log(JSON.stringify(c.prepare("SELECT store_key, job_id FROM cron_jobs").all()))`;

export default {
  name: "cron-orphan-reconcile",
  source: "M3 live A A1; spec 08 §10.1 rule 7, §11.2",
  rule: "Orphan cron_jobs row (staging store_key, past nextRunAtMs) inserted while running: sleep-read nextWakeAtMs is not that past time; after a gateway restart ocsup logs cron-orphan-deleted, the row is gone, the gate gets alert cron-orphan; live rows stay.",
  needs: ["m1", "ocsupctl"],
  timeoutMs: 500_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1, env: { OC_ANTHROPIC_KEY: "sk-ant-m4-cron-probe-0000" } });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    const first = await b.waitEv((e) => e.ev === "cron-reconcile" || e.ev === "cron-orphan-deleted", 60_000);
    t.measure("bootReconcile", first);
    t.check("reconcile ran at the first gateway start", !!first);
    t.check(
      "cron.list answer understood (live count known)",
      first && first.live !== null && first.live !== undefined,
      first?.live,
    );
    const ins = b.as1000(["node", "-e", INSERT, DB, ORPHAN_KEY]);
    t.measure("insert", ins.out.trim() || ins.err.slice(-300));
    if (!t.check("orphan row inserted", /"ok":true/.test(ins.out), ins.err.slice(-200))) return;
    const rowsBefore = JSON.parse(b.as1000(["node", "-e", COUNT, DB]).out || "[]");
    t.measure("rowsBefore", rowsBefore);
    const sr = JSON.parse(
      b.as1000(["node", "/opt/ocrt/ocio/sleep-read.mjs", DB, String(Date.now())]).out.trim() || "{}",
    );
    t.measure("sleepRead", { nextWakeAtMs: sr.nextWakeAtMs, missing: sr.missing });
    t.check(
      "sleep-read nextWakeAtMs is not the orphan's past time",
      sr.ok && (sr.nextWakeAtMs === null || sr.nextWakeAtMs > Date.now() - 60_000),
      sr.nextWakeAtMs,
    );
    const n0 = b.ev("startupz").length;
    const r = b.ctl("restart-gateway");
    t.check("restart-gateway ok", r.ok, JSON.stringify(r).slice(0, 200));
    await b.waitEv(() => b.ev("startupz").length > n0, 180_000);
    const del = await b.waitEv("cron-orphan-deleted", 60_000);
    t.measure("deletedEvent", del);
    t.check(
      "cron-orphan-deleted logged with the orphan",
      !!del && (del.orphans || []).some((o) => o.startsWith("m4-orphan-0001@")),
      del?.orphans,
    );
    const rowsAfter = JSON.parse(b.as1000(["node", "-e", COUNT, DB]).out || "[]");
    t.measure("rowsAfter", rowsAfter);
    t.check("orphan row gone", !rowsAfter.some((x) => x.job_id === "m4-orphan-0001"));
    t.check(
      "other rows kept",
      rowsAfter.length === rowsBefore.length - 1,
      `${rowsBefore.length} → ${rowsAfter.length}`,
    );
    const al = await gateAlerts(t, "cron-orphan");
    t.check("gate alert cron-orphan", al.length >= 1, al.length);
  },
};
