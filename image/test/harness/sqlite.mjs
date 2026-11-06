// SQLite helpers for the M1 tests: a uid-1000 probe writer inside a box, and row counts of
// (a) the local DB of a box (running or exited) and (b) a Litestream restore of one gen from SeaweedFS.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dk } from "./docker.mjs";
import { IP, NET } from "./env.mjs";

export const STATE = "/home/node/.openclaw";
export const DB_STATE = "state/openclaw.sqlite";

// Probe writer: inserts one row per `every` ms into table m1_probe(id, tag, ts), logs each committed id.
const WRITER = `
const {DatabaseSync}=require("node:sqlite");const fs=require("fs");const p=require("path");
const [db,tag,every,max]=process.argv.slice(1);fs.mkdirSync(p.dirname(db),{recursive:true});
const c=new DatabaseSync(db);c.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS m1_probe(id INTEGER PRIMARY KEY, tag TEXT, ts INTEGER)");
const ins=c.prepare("INSERT INTO m1_probe(tag,ts) VALUES(?,?)");const log="/tmp/m1-writer-"+tag+".ids";let n=0;
const t=setInterval(()=>{try{const r=ins.run(tag,Date.now());fs.appendFileSync(log,r.lastInsertRowid+"\\n");if(++n>=Number(max||1e9)){clearInterval(t);c.close();}}catch(e){fs.appendFileSync(log,"ERR "+String(e.message).slice(0,100)+"\\n")}},Number(every));
process.on("SIGTERM",()=>{});`;

/** Start the probe writer as uid 1000 (detached docker exec). */
export function writerStart(box, { db = DB_STATE, tag = "w", everyMs = 50, max = 0 } = {}) {
  return dk([
    "exec",
    "-d",
    "-u",
    "1000",
    box.name,
    "node",
    "-e",
    WRITER,
    path.join(STATE, db),
    tag,
    String(everyMs),
    String(max || 1e9),
  ]);
}
/** Write n rows now (synchronous, as uid 1000). */
export function writeRows(box, n, { db = DB_STATE, tag = "w" } = {}) {
  return box.as1000(["node", "-e", WRITER, path.join(STATE, db), tag, "1", String(n)], { timeoutMs: 60_000 });
}
/** Committed ids the writer logged (from the box rootfs). */
export function writerIds(box, tag = "w") {
  const t = box.cat(`/tmp/m1-writer-${tag}.ids`);
  if (!t) return [];
  return t
    .toString()
    .split("\n")
    .filter((l) => /^\d+$/.test(l))
    .map(Number);
}

const COUNT = `
const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync(process.argv[1],{readOnly:true});
let probe=null;try{probe=c.prepare("select tag, count(*) n, min(id) lo, max(id) hi from m1_probe group by tag").all()}catch(e){probe=String(e.message)}
const tables=c.prepare("select name from sqlite_master where type='table'").all().map(r=>r.name);
const qc=c.prepare("pragma quick_check").all().map(r=>Object.values(r)[0]).join(",");
console.log(JSON.stringify({probe,tables:tables.length,quickCheck:qc}));`;

function countIn(image, dir, file) {
  const r = dk([
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${dir}:/w`,
    "--entrypoint",
    "node",
    image,
    "-e",
    COUNT,
    `/w/${file}`,
  ]);
  try {
    return JSON.parse(r.out.split("\n").pop());
  } catch {
    return { error: (r.err || r.out).slice(-300) };
  }
}

/** Rows in the box's local DB (copies the .sqlite, -wal, -shm out; works on an exited box). */
export function localRows(box, image, db = DB_STATE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocm1-db-"));
  for (const sfx of ["", "-wal", "-shm"]) {
    const b = box.cat(path.join(STATE, `${db}${sfx}`));
    if (b) fs.writeFileSync(path.join(dir, `x.sqlite${sfx}`), b);
  }
  fs.chmodSync(dir, 0o777);
  const out = fs.existsSync(path.join(dir, "x.sqlite")) ? countIn(image, dir, "x.sqlite") : { missing: true };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

/** Litestream restore of r/<inst>/g<gen>/<db> from SeaweedFS (direct), then counts. */
export function restoreRows(image, gen, { db = DB_STATE, inst = "m1", timestamp } = {}) {
  const cfg = `dbs:
  - path: /w/x.sqlite
    replica:
      type: s3
      bucket: oc-host-${inst}
      path: r/${inst}/g${gen}/${db}
      endpoint: http://${IP.s3}:8333
      region: us-east-1
      force-path-style: true
      access-key-id: anon
      secret-access-key: anon
`;
  const t0 = Date.now();
  const r = dk([
    "run",
    "--rm",
    "--network",
    NET,
    "--entrypoint",
    "sh",
    image,
    "-c",
    `mkdir -p /w && printf '%s' "$0" > /tmp/ls.yml && litestream restore -config /tmp/ls.yml ${timestamp ? `-timestamp ${timestamp} ` : ""}-o /w/x.sqlite /w/x.sqlite >/tmp/r.log 2>&1; rc=$?; if [ $rc -ne 0 ]; then tail -c 600 /tmp/r.log; echo "{\\"restoreRc\\":$rc}"; exit 0; fi; node -e '${COUNT.replace(/'/g, "'\\''")}' /w/x.sqlite`,
    cfg,
  ]);
  const ms = Date.now() - t0;
  try {
    return {
      ms,
      ...JSON.parse(r.out.split("\n").pop()),
      log: r.out.split("\n").slice(0, -1).join("\n").slice(-600),
    };
  } catch {
    return { ms, error: (r.err || r.out).slice(-400) };
  }
}

/** Sum of probe rows for one tag (or all tags) from a count result. */
export function probeCount(res, tag) {
  if (!res || !Array.isArray(res.probe)) return 0;
  return res.probe.filter((p) => !tag || p.tag === tag).reduce((a, p) => a + p.n, 0);
}
export function probeMaxId(res, tag) {
  if (!res || !Array.isArray(res.probe)) return 0;
  return Math.max(0, ...res.probe.filter((p) => !tag || p.tag === tag).map((p) => p.hi));
}
