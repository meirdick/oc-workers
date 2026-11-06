// M1 exit test "SIGTERM to every process" (scope M1; amend §2 row 2) for the Litestream part.
// Real Litestream 0.5.17 as uid 1000 + a writer (gateway stand-in) that writes 20 more rows on SIGTERM.
// Both get SIGTERM at once (the inactivity-stop shape). ocsup's supervisor respawns Litestream (the Go
// runtime ignores an inherited SIG_IGN), the final rows replicate, stopFinal is clean, and a restore of
// the gen holds every committed row. Variant KILL4: SIGKILL everything 4 s after the SIGTERM; report loss.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { Litestream } from "/opt/ocrt/lib/litestream.mjs";
import { createBucket } from "/opt/ocrt/lib/s3.mjs";

const S3 = {
  endpoint: process.env.S3_ENDPOINT,
  bucket: "oc-st",
  region: "us-east-1",
  accessKey: "k",
  secretKey: "s0123456789012345678",
};
const STATE = "/home/node/.openclaw";
const DB = "state/openclaw.sqlite";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.log(JSON.stringify(o));
const sh = (c) => spawnSync("sh", ["-c", c], { encoding: "utf8" });
let pass = true;
const check = (n, ok, d = {}) => {
  if (!ok) pass = false;
  log({ check: n, ok, ...d });
};
const WRITER = `const {DatabaseSync}=require("node:sqlite");const fs=require("fs");const db=new DatabaseSync(process.argv[1]);
db.exec("pragma journal_mode=wal; pragma busy_timeout=5000; create table if not exists t(id integer primary key, tag text)");
const ins=db.prepare("insert into t(tag) values (?)");let n=0;const rep=()=>fs.writeFileSync("/tmp/writer.n",String(n));
const h=setInterval(()=>{ins.run("run");n++;rep()},100);
process.on("SIGTERM",()=>{clearInterval(h);let k=0;const f=setInterval(()=>{ins.run("final");n++;rep();if(++k>=20){clearInterval(f);db.close();process.exit(0)}},50)});`;

async function round(gen, kill4) {
  sh(
    `rm -rf ${STATE} /var/lib/ocrt /tmp/writer.n; mkdir -p ${STATE}/state /var/lib/ocrt/ls-meta /run/ocrt; chown -R 1000:1000 /home/node /var/lib/ocrt/ls-meta; chmod 711 /var/lib/ocrt`,
  );
  const w = spawn(
    "setpriv",
    ["--reuid=1000", "--regid=1000", "--init-groups", "--", "node", "-e", WRITER, `${STATE}/${DB}`],
    { stdio: "inherit", cwd: "/home/node" },
  );
  await sleep(500);
  const ls = new Litestream({
    state: STATE,
    inst: "sg",
    gen,
    s3: S3,
    cfgPath: `/run/ocrt/ls-${gen}.yml`,
    metaRoot: "/var/lib/ocrt/ls-meta",
  });
  const exits = [];
  ls.on("exit", (e) => exits.push(e));
  await ls.apply([DB]);
  await sleep(5000);
  const lsPid = ls.pid();
  const t0 = Date.now();
  ls.setDraining(); // ocsup's own SIGTERM handler sets this synchronously
  process.kill(lsPid, "SIGTERM");
  process.kill(w.pid, "SIGTERM");
  let wExit = null;
  w.on("exit", () => {
    wExit = Date.now() - t0;
  });
  if (kill4) {
    await sleep(4000);
    try {
      process.kill(w.pid, "SIGKILL");
    } catch {}
    const p = ls.pid();
    ls.stopped = true;
    if (p) process.kill(p, "SIGKILL");
    await sleep(500);
  } else {
    while (wExit === null) await sleep(20);
    await sleep(1500); // >= 1 sync interval after the writer's last commit (ocsup waits for lag 0 instead)
  }
  const fin = kill4 ? { clean: false, reason: "killed" } : await ls.stopFinal("drain");
  const written = Number(fs.readFileSync("/tmp/writer.n", "utf8"));
  const cfg = `/tmp/r${gen}.yml`;
  fs.writeFileSync(
    cfg,
    `dbs:\n  - path: ${STATE}/${DB}\n    replica:\n      type: s3\n      bucket: ${S3.bucket}\n      path: r/sg/g${gen}/${DB}\n      endpoint: ${S3.endpoint}\n      region: us-east-1\n      force-path-style: true\n      access-key-id: k\n      secret-access-key: ${S3.secretKey}\n`,
  );
  sh(`rm -f /tmp/r${gen}.sqlite*; litestream restore -config ${cfg} -o /tmp/r${gen}.sqlite ${STATE}/${DB}`);
  const q = sh(
    `node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/tmp/r${gen}.sqlite",{readOnly:true});console.log(JSON.stringify(d.prepare("select tag,count(*) n from t group by tag").all()))'`,
  );
  const by = JSON.parse(q.stdout.trim() || "[]");
  const restored = by.reduce((a, x) => a + x.n, 0);
  log({
    gen,
    kill4,
    lsFirstExit: exits[0],
    respawns: exits.filter((e) => e.cls === "drain-term").length,
    writerExitMs: wExit,
    written,
    restored,
    by,
    final: fin,
  });
  if (!kill4) {
    check(`gen${gen} litestream exited on SIGTERM (no SIG_IGN effect)`, exits[0]?.cls === "drain-term", {
      first: exits[0],
    });
    check(`gen${gen} every committed row in the gen`, restored === written, { written, restored });
    check(`gen${gen} final stop clean`, fin.clean, { fin });
  } else log({ kill4LossRows: written - restored, note: "rows at 10/s; final rows at 20/s" });
}

(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await createBucket(S3);
      break;
    } catch {
      await sleep(1000);
    }
  }
  await round(1, false);
  await round(2, false);
  await round(3, true);
  log({ pass });
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  log({ error: String(e.stack || e) });
  process.exit(2);
});
