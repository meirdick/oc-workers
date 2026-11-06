// Scope §4 M1 row 11 [Z0.4]: ENOSPC during an archive or in Litestream -> disk-full, never replica-down.
import { gateAlerts, gateEvents } from "../harness/flows.mjs";
import { writerStart } from "../harness/sqlite.mjs";

export default {
  name: "enospc-classification",
  source:
    "scope §4 M1 'ENOSPC during an archive or in Litestream -> disk-full, never replica-down' [Z0.4]; plan §4.12",
  rule: "(a) Litestream meta dir on a 4 MiB tmpfs, steady writes: disk-full alert or event; no replica-down alert/event; no exit 75 replica-down. (b) archive into a full /var/lib/ocrt/bk-u (128 KiB tmpfs; a fresh-state archive is about 270 KB, measured in M1) via ocsupctl archive: disk-full; no replica-down.",
  needs: ["m1", "diskwatch"],
  timeoutMs: 900_000,
  async run(t) {
    const a = t.box({ name: "ls", gen: 1, args: ["--tmpfs", "/var/lib/ocrt/ls-meta:size=4m"] });
    await a.start();
    if (!t.check("(a) /startupz", (await a.startupz()) !== null)) return;
    writerStart(a, { tag: "e", everyMs: 5 });
    // Harness fix: the insert used to run once, unchecked. The writer holds the DB every 5 ms, so a
    // bare insert could fail SQLITE_BUSY and add no blob (no ENOSPC in 180 s, M1 verify runs).
    // Now: busy_timeout, retry each row on SQLITE_BUSY, and the test checks the count.
    const ins = a.as1000(
      [
        "node",
        "-e",
        `const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync("/home/node/.openclaw/state/openclaw.sqlite");c.exec("pragma busy_timeout=5000");const busy=(e)=>/SQLITE_BUSY|database is locked/i.test(String(e&&(e.errstr||e.message)));const retry=(f)=>{for(let i=0;;i++){try{return f()}catch(e){if(!busy(e)||i>=50)throw e;const t=Date.now()+100;while(Date.now()<t){}}}};retry(()=>c.exec("create table if not exists m1_blob(b blob)"));const s=c.prepare("insert into m1_blob values(randomblob(65536))");let ok=0;for(let i=0;i<200;i++){retry(()=>{s.run();ok++});}const n=c.prepare("select count(*) n from m1_blob").get().n;console.log(JSON.stringify({ok,n}));c.close()`,
      ],
      { timeoutMs: 120_000 },
    );
    let insRes = null;
    try {
      insRes = JSON.parse(ins.out.trim().split("\n").pop());
    } catch {}
    t.measure("a.insert", insRes ?? { code: ins.code, err: ins.err.slice(-300) });
    t.check(
      "(a) 200 blob rows inserted (12.5 MiB > 4 MiB meta tmpfs)",
      insRes?.ok === 200,
      insRes ?? ins.err.slice(-300),
    );
    let full = null;
    const k = Date.now();
    while (Date.now() - k < 180_000 && full === null) {
      const al = await gateAlerts(t, "disk-full");
      if (al.length || a.events().some((e) => /disk-full/.test(JSON.stringify(e)))) full = Date.now() - k;
      else await t.sleep(1000);
    }
    t.measure("a.diskFullMs", full);
    t.check("(a) disk-full reported", full !== null, full);
    const rd = [...(await gateEvents(t, "replica-down")), ...(await gateAlerts(t, "replica-down"))];
    t.check("(a) no replica-down", rd.length === 0, rd.length);
    t.check(
      "(a) no replica-down exit",
      !(a.ev("exit").at(-1)?.reason || "").startsWith("replica-down"),
      a.ev("exit").at(-1),
    );
    a.rm();
    if (!t.features.ocsupctl) return t.note("(b) skipped: no ocsupctl");
    const since = (await t.gateState()).seq;
    const b = t.box({ name: "ar", gen: 2, args: ["--tmpfs", "/var/lib/ocrt/bk-u:size=128k,uid=1000"] });
    await b.start();
    if (!t.check("(b) /startupz", (await b.startupz()) !== null)) return;
    const r = b.ctl("archive", { args: { kind: "online" } });
    t.measure("b.archive", r);
    await t.sleep(5000);
    const recs = await t.records({ since });
    const df =
      recs.filter((x) => /disk-full/.test(JSON.stringify(x.body || {}))).length +
      (/disk-full/.test(JSON.stringify(r)) ? 1 : 0);
    const rdb = recs.filter((x) => /replica-down/.test(JSON.stringify(x.body || {}))).length;
    t.check("(b) disk-full reported", df > 0, df);
    t.check("(b) no replica-down", rdb === 0, rdb);
  },
};
