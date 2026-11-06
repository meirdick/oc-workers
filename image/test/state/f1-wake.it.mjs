// M1 F1-wake, F1-wake-legacy and a negative control (amend §1.5 proof). Runs INSIDE the image as root,
// with the repo's ocrt mounted at /opt/ocrt. Real Litestream 0.5.17 as uid 1000, SeaweedFS 3.80.
// Prints one JSON line per phase and a final {"pass":bool}. Env: S3_ENDPOINT, KEEP_TIMES=1.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseLtxKey } from "/opt/ocrt/lib/contract.mjs";
import { Litestream } from "/opt/ocrt/lib/litestream.mjs";
import { metaPathFor } from "/opt/ocrt/lib/ls-config.mjs";
import { prestartWipe } from "/opt/ocrt/lib/ls-restore.mjs";
import { createBucket, listKeys } from "/opt/ocrt/lib/s3.mjs";

const S3 = {
  endpoint: process.env.S3_ENDPOINT || "http://15.8.0.10:8333",
  bucket: "oc-st",
  region: "us-east-1",
  accessKey: "k",
  secretKey: "s0123456789012345678",
};
const INST = "st";
const STATE = "/home/node/.openclaw";
const VAR = "/var/lib/ocrt";
const META = `${VAR}/ls-meta`;
const DB = "state/openclaw.sqlite";
const FAST = { levels: ["5s"], l0Retention: "10s", l0Check: "2s" }; // F1 shape in 30 s, not 5.5 min
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.log(JSON.stringify(o));
const sh = (c) => spawnSync("sh", ["-c", c], { encoding: "utf8" });
let pass = true;
const check = (name, ok, detail) => {
  if (!ok) pass = false;
  log({ check: name, ok, ...detail });
};

const WRITER = `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);
db.exec("pragma journal_mode=wal; pragma busy_timeout=5000; create table if not exists t(id integer primary key, tag text, at integer)");
const ins=db.prepare("insert into t(tag,at) values (?,?)");const n=+process.argv[2],gap=+process.argv[3];let i=0;
const h=setInterval(()=>{ins.run(process.argv[4],Date.now());if(++i>=n){clearInterval(h);db.close()}},gap);`;
const write = (n, gapMs, tag) => {
  const r = spawnSync(
    "setpriv",
    [
      "--reuid=1000",
      "--regid=1000",
      "--init-groups",
      "--",
      "node",
      "-e",
      WRITER,
      `${STATE}/${DB}`,
      String(n),
      String(gapMs),
      tag,
    ],
    { cwd: "/home/node", encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`writer: ${r.stderr}`);
};
const writeAsync = (n, gapMs, tag) =>
  new Promise((res, rej) => {
    const c = spawn(
      "setpriv",
      [
        "--reuid=1000",
        "--regid=1000",
        "--init-groups",
        "--",
        "node",
        "-e",
        WRITER,
        `${STATE}/${DB}`,
        String(n),
        String(gapMs),
        tag,
      ],
      { cwd: "/home/node", stdio: "inherit" },
    );
    c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`writer exit ${code}`))));
  });

function freshState() {
  sh(
    `rm -rf ${STATE} ${VAR}; mkdir -p ${STATE}/state ${VAR} && chown -R 1000:1000 /home/node && chmod 0711 ${VAR}`,
  );
  fs.mkdirSync(META, { mode: 0o700 });
  fs.chownSync(META, 1000, 1000);
}
const l0Keys = async (gen) =>
  (await listKeys(S3, `r/${INST}/g${gen}/${DB}/0000/`)).map(parseLtxKey).filter(Boolean);
const keysByLevel = async (gen) => {
  const by = {};
  for (const k of await listKeys(S3, `r/${INST}/g${gen}/`)) {
    const p = parseLtxKey(k);
    if (p) by[p.level] = (by[p.level] || 0) + 1;
  }
  return by;
};
function localL0(dir) {
  try {
    return fs.readdirSync(path.join(dir, "ltx", "0")).sort();
  } catch {
    return [];
  }
}
function restoreCount(gen) {
  const cfg = `/tmp/r${gen}.yml`;
  fs.writeFileSync(
    cfg,
    `dbs:\n  - path: ${STATE}/${DB}\n    replica:\n      type: s3\n      bucket: ${S3.bucket}\n      path: r/${INST}/g${gen}/${DB}\n      endpoint: ${S3.endpoint}\n      region: ${S3.region}\n      force-path-style: true\n      access-key-id: ${S3.accessKey}\n      secret-access-key: ${S3.secretKey}\n`,
  );
  const out = `/tmp/r${gen}.sqlite`;
  sh(`rm -f ${out}*`);
  const r = sh(`litestream restore -config ${cfg} -o ${out} -json -integrity-check quick ${STATE}/${DB}`);
  if (r.status !== 0) return { rc: r.status, err: r.stderr.slice(-300) };
  const q = sh(
    `node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("${out}",{readOnly:true});console.log(JSON.stringify(d.prepare("select tag,count(*) n from t group by tag").all()))'`,
  );
  const by = JSON.parse(q.stdout.trim());
  return {
    rc: 0,
    json: JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))),
    total: by.reduce((a, x) => a + x.n, 0),
    by,
  };
}
function mkLs(gen, { legacy = false } = {}) {
  const ls = new Litestream({
    state: STATE,
    inst: INST,
    gen,
    s3: S3,
    cfgPath: `/run/ocrt/litestream-g${gen}.yml`,
    metaRoot: META,
    levelsOverride: FAST,
    writeConfig: (p, text) => {
      const t = legacy ? text.replace(/^\s+meta-path:.*\n/gm, "") : text; // M0 config: meta dir beside the DB
      fs.writeFileSync(p, t, { mode: 0o400 });
      fs.chownSync(p, 1000, 1000);
    },
  });
  const lines = [];
  ls.on("line", (l) => lines.push(l));
  ls.lines = lines;
  return ls;
}
const snapshot = (name) =>
  sh(
    `rm -rf /snap-${name} && mkdir -p /snap-${name} && cp -a ${STATE} /snap-${name}/state && cp -a ${VAR} /snap-${name}/var`,
  );
const fromSnapshot = (name) =>
  sh(`rm -rf ${STATE} ${VAR} && cp -a /snap-${name}/state ${STATE} && cp -a /snap-${name}/var ${VAR}`);

/** Gen k: write 60 rows over 30 s, idle 20 s so L0 retention deletes local L0 1-1 (F1 step 2), clean stop. */
async function genK(gen, legacy) {
  freshState();
  write(1, 1, "init");
  const ls = mkLs(gen, { legacy });
  await ls.apply([DB]);
  write(60, 500, "A");
  await sleep(20_000);
  const metaDir = legacy ? `${STATE}/state/.openclaw.sqlite-litestream` : metaPathFor(gen, DB, META);
  const l0 = localL0(metaDir);
  const fin = await ls.stopFinal("flush");
  log({
    phase: `gen${gen}${legacy ? "-legacy" : ""}`,
    localL0First: l0[0],
    localL0Count: l0.length,
    final: fin,
    keys: await keysByLevel(gen),
  });
  check(`gen${gen} retention removed local L0 1-1`, l0.length > 0 && !l0[0].startsWith("0000000000000001-"), {
    first: l0[0],
  });
  return fin;
}

/** Gen k+1 on the snapshot copy (wake, no gen restore): L0 seed must upload, final clean, restore has all rows. */
async function genWake(gen, { legacy = false, wipe = false, expectF1 = false } = {}) {
  if (wipe) {
    const w = await prestartWipe({ state: STATE, varDir: VAR, metaRoot: META, rels: [DB] });
    log({ phase: `gen${gen} wipe`, legacy: w.legacy, ocio: w.ocio });
    check(
      `gen${gen} legacy meta dir removed`,
      !fs.existsSync(`${STATE}/state/.openclaw.sqlite-litestream`),
      {},
    );
  }
  const ls = mkLs(gen, { legacy });
  await ls.apply([DB]);
  await sleep(1500);
  const t0 = Date.now();
  const wr = writeAsync(40, 250, "B");
  let seedAt = null;
  let firstL0At = null;
  while (Date.now() - t0 < (expectF1 ? 12_000 : 15_000)) {
    const l0 = await l0Keys(gen);
    if (!firstL0At && l0.length) firstL0At = Date.now() - t0;
    if (!seedAt && l0.some((k) => k.minTxid === 1)) seedAt = Date.now() - t0;
    if (seedAt && l0.some((k) => k.minTxid > 1)) break;
    await sleep(250);
  }
  await wr;
  // lag 0: local L0 max == remote L0 max (F1.5), cap 30 s
  const metaDir = legacy ? `${STATE}/state/.openclaw.sqlite-litestream` : metaPathFor(gen, DB, META);
  let lag = null;
  const lagT0 = Date.now();
  while (Date.now() - lagT0 < (expectF1 ? 3000 : 30_000)) {
    const local = localL0(metaDir).map((n) => Number.parseInt(n.slice(17, 33), 16));
    const remote = (await l0Keys(gen)).map((k) => k.maxTxid);
    lag = Math.max(0, ...local) - Math.max(0, ...remote);
    ls.lag.setLocal(DB, Math.max(0, ...local));
    ls.lag.setRemote(DB, Math.max(0, ...remote));
    if (lag === 0) break;
    await sleep(250);
  }
  const lagReport = ls.lag.report()[0];
  const fin = await ls.stopFinal("flush");
  const rc = restoreCount(gen);
  const besideDb = fs.existsSync(`${STATE}/state/.openclaw.sqlite-litestream`);
  const errs = ls.lines.filter((l) => /open ltx file|shutdown sync failed/.test(l)).length;
  log({
    phase: `gen${gen}`,
    legacy,
    wipe,
    seedL0Ms: seedAt,
    firstL0Ms: firstL0At,
    lag,
    lagReport,
    final: fin,
    restore: rc,
    keys: await keysByLevel(gen),
    metaBesideDb: besideDb,
    errLines: errs,
  });
  if (expectF1) {
    check(
      `control gen${gen}: F1 reproduces (no L0 seed, fault seen)`,
      seedAt === null && (lagReport.lag === null || errs > 0),
      { seedAt, lagReport, errs },
    );
    return;
  }
  check(`gen${gen} seed L0 (minTxid 1) within 10 s of first write`, seedAt !== null && seedAt <= 10_000, {
    seedAt,
  });
  check(`gen${gen} lag 0 before stop`, lag === 0, { lag });
  check(`gen${gen} final clean in <= 5 s`, fin.clean && fin.ms <= 5000, { fin });
  check(`gen${gen} restore has every row`, rc.total === 101, { total: rc.total, by: rc.by });
  if (!legacy) check(`gen${gen} no meta dir beside the DB`, !besideDb, {});
}

(async () => {
  log({ litestream: sh("litestream version").stdout.trim(), node: process.version });
  for (let i = 0; i < 60; i++) {
    try {
      await createBucket(S3);
      break;
    } catch {
      await sleep(1000);
    }
  }
  fs.mkdirSync("/run/ocrt", { recursive: true });
  // F1-wake (F1.1): gen 1 → snapshot → gen 2 on the copy, g1 meta still on disk, no wipe.
  await genK(1, false);
  snapshot("a");
  fromSnapshot("a");
  check("snapshot copy holds g1 meta", fs.existsSync(metaPathFor(1, DB, META)), {});
  await genWake(2, {});
  // Control: M0 config (meta beside the DB), no wipe → F1 must show (proves the test can fail).
  await genK(3, true);
  snapshot("b");
  fromSnapshot("b");
  await genWake(4, { legacy: true, expectF1: true });
  // F1-wake-legacy (F1.2): same legacy snapshot, pre-start wipe, then the M1 config.
  fromSnapshot("b");
  await genWake(5, { wipe: true });
  log({ pass });
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  log({ error: String(e.stack || e) });
  process.exit(2);
});
