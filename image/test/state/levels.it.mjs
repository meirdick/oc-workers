// Litestream level/retention presets vs per-gen storage and R2 class A ops (amend §2 rows 9, 10; §4).
// Runs INSIDE the image as root (ocrt at /opt/ocrt); SeaweedFS 3.80 anonymous at S3_ENDPOINT.
// Each preset gets its own counting proxy in front of S3 and its own gen prefix.
//   Phase W (storage): 1 DB of ~DB_MB MB + 1 row/s for W_S seconds; stored bytes at 90 s and at the end.
//   Phase I (idle): 4 small DBs, no writes, I_S seconds; class A per minute after the first minute.
// R2 classes (developers.cloudflare.com/r2/pricing): A = PUT, POST (multipart, DeleteObjects counted
// apart), LIST; B = GET, HEAD; free = DELETE.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { Litestream } from "/opt/ocrt/lib/litestream.mjs";
import { PRESETS } from "/opt/ocrt/lib/ls-config.mjs";
import { createBucket } from "/opt/ocrt/lib/s3.mjs";

const UP = new URL(process.env.S3_ENDPOINT || "http://15.8.0.10:8333");
const DB_MB = Number(process.env.DB_MB || 20);
const W_S = Number(process.env.W_S || 360);
const I_S = Number(process.env.I_S || 600);
const BUCKET = "oc-lv";
const STATE = "/home/node/.openclaw";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.log(JSON.stringify(o));
const VARIANTS = {
  default: { preset: "default" },
  check5m: { preset: "default", levelsOverride: { l0Check: "5m" } },
  lean: { preset: "lean" },
  "lean-ret30s": { preset: "lean", levelsOverride: { l0Retention: "30s", l0Check: "1m" } },
};

function proxy(port) {
  const c = { A: 0, B: 0, del: 0, delMulti: 0, putBytes: 0, byOp: {}, objects: new Map() };
  const parts = new Map();
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const q = (k) => u.searchParams.has(k);
    let op;
    if (req.method === "GET")
      op = q("list-type") || u.pathname.split("/").filter(Boolean).length <= 1 ? "List" : "Get";
    else if (req.method === "HEAD") op = "Head";
    else if (req.method === "PUT") op = q("partNumber") ? "UploadPart" : "Put";
    else if (req.method === "POST")
      op = q("uploads")
        ? "CreateMPU"
        : q("uploadId")
          ? "CompleteMPU"
          : q("delete")
            ? "DeleteObjects"
            : "Post";
    else if (req.method === "DELETE") op = q("uploadId") ? "AbortMPU" : "Delete";
    c.byOp[op] = (c.byOp[op] || 0) + 1;
    if (["List", "Put", "UploadPart", "CreateMPU", "CompleteMPU"].includes(op)) c.A++;
    else if (op === "Get" || op === "Head") c.B++;
    else if (op === "Delete") c.del++;
    else if (op === "DeleteObjects") c.delMulti++;
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const key = decodeURIComponent(u.pathname.split("/").slice(2).join("/"));
      const up = http.request(
        {
          host: UP.hostname,
          port: UP.port,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: UP.host },
        },
        (r) => {
          const out = [];
          r.on("data", (d) => out.push(d));
          r.on("end", () => {
            const rb = Buffer.concat(out);
            if (r.statusCode < 300) {
              if (op === "Put") {
                c.putBytes += body.length;
                c.objects.set(key, body.length);
              }
              if (op === "UploadPart") {
                c.putBytes += body.length;
                const id = u.searchParams.get("uploadId");
                parts.set(id, (parts.get(id) || 0) + body.length);
              }
              if (op === "CompleteMPU") c.objects.set(key, parts.get(u.searchParams.get("uploadId")) || 0);
              if (op === "Delete") c.objects.delete(key);
              if (op === "DeleteObjects")
                for (const m of body.toString().matchAll(/<Key>([^<]*)<\/Key>/g)) c.objects.delete(m[1]);
            }
            res.writeHead(r.statusCode, r.headers);
            res.end(rb);
          });
        },
      );
      up.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      up.end(body);
    });
  });
  srv.listen(port, "127.0.0.1");
  c.stored = (prefix) => {
    let n = 0;
    let b = 0;
    const lv = {};
    for (const [k, v] of c.objects) {
      if (!k.startsWith(prefix)) continue;
      n++;
      b += v;
      const l = k.split("/").at(-2);
      lv[l] = (lv[l] || 0) + v;
    }
    return { n, bytes: b, byLevel: lv };
  };
  c.snap = () => ({
    A: c.A,
    B: c.B,
    del: c.del,
    delMulti: c.delMulti,
    putBytes: c.putBytes,
    byOp: { ...c.byOp },
  });
  return c;
}

const asNode = (args) =>
  spawnSync("setpriv", ["--reuid=1000", "--regid=1000", "--init-groups", "--", ...args], {
    encoding: "utf8",
    cwd: "/home/node",
  });
function mkdb(rel, mb) {
  const f = `${STATE}/${rel}`;
  const code = `const {DatabaseSync}=require("node:sqlite");const fs=require("fs");fs.mkdirSync(require("path").dirname(process.argv[1]),{recursive:true});
const db=new DatabaseSync(process.argv[1]);db.exec("pragma journal_mode=wal; create table if not exists t(id integer primary key, b blob)");
const ins=db.prepare("insert into t(b) values (?)");const n=Math.round(+process.argv[2]*1024*1024/4096);db.exec("begin");
for(let i=0;i<n;i++)ins.run(require("crypto").randomBytes(4000));db.exec("commit");db.exec("pragma wal_checkpoint(truncate)");db.close();`;
  const r = asNode(["node", "-e", code, f, String(mb)]);
  if (r.status !== 0) throw new Error(r.stderr);
  return fs.statSync(f).size;
}
const WRITER = `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);db.exec("pragma busy_timeout=5000");
const ins=db.prepare("insert into t(b) values (?)");setInterval(()=>ins.run(require("crypto").randomBytes(200)),1000);`;

(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await createBucket({
        endpoint: UP.origin,
        bucket: BUCKET,
        region: "us-east-1",
        accessKey: "a",
        secretKey: "b",
      });
      break;
    } catch {
      await sleep(1000);
    }
  }
  spawnSync("sh", [
    "-c",
    `rm -rf ${STATE} /var/lib/ocrt; mkdir -p ${STATE} /var/lib/ocrt/ls-meta /run/ocrt; chown -R 1000:1000 /home/node /var/lib/ocrt/ls-meta; chmod 711 /var/lib/ocrt`,
  ]);
  const names = Object.keys(VARIANTS);
  const runs = [];
  let port = 19000;
  for (const [i, name] of names.entries()) {
    const v = VARIANTS[name];
    const relW = `agents/w-${name}/agent/openclaw-agent.sqlite`;
    const dbBytes = mkdb(relW, DB_MB);
    const relsI = [0, 1, 2, 3].map((k) => `agents/i${k}-${name}/agent/openclaw-agent.sqlite`);
    for (const r of relsI) mkdb(r, 0.1);
    const mk = (gen, p) =>
      new Litestream({
        state: STATE,
        inst: "lv",
        gen,
        s3: {
          endpoint: `http://127.0.0.1:${p.port}`,
          bucket: BUCKET,
          region: "us-east-1",
          accessKey: "a",
          secretKey: "b",
        },
        cfgPath: `/run/ocrt/ls-${gen}.yml`,
        metaRoot: "/var/lib/ocrt/ls-meta",
        preset: v.preset,
        levelsOverride: v.levelsOverride,
      });
    const pw = proxy(port++);
    pw.port = port - 1;
    const pi = proxy(port++);
    pi.port = port - 1;
    const lw = mk(100 + i, pw);
    const li = mk(200 + i, pi);
    runs.push({ name, v, relW, dbBytes, relsI, pw, pi, lw, li, gw: 100 + i, gi: 200 + i });
  }
  const t0 = Date.now();
  for (const r of runs) {
    await r.lw.apply([r.relW]);
    await r.li.apply(r.relsI);
    r.writer = (await import("node:child_process")).spawn(
      "setpriv",
      ["--reuid=1000", "--regid=1000", "--init-groups", "--", "node", "-e", WRITER, `${STATE}/${r.relW}`],
      { stdio: "ignore", cwd: "/home/node" },
    );
  }
  log({
    start: new Date().toISOString(),
    dbMB: DB_MB,
    wS: W_S,
    iS: I_S,
    variants: VARIANTS,
    presetsLib: PRESETS,
  });
  const marks = {};
  const at = async (s) => {
    const wait = t0 + s * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
  };
  await at(60);
  for (const r of runs) marks[`${r.name}:i60`] = r.pi.snap();
  await at(90);
  for (const r of runs)
    log({
      t: 90,
      name: r.name,
      phase: "W",
      stored: r.pw.stored(`r/lv/g${r.gw}/`),
      dbBytes: r.dbBytes,
      ops: r.pw.snap(),
    });
  await at(W_S);
  for (const r of runs) {
    r.writer.kill("SIGKILL");
    const s = r.pw.stored(`r/lv/g${r.gw}/`);
    log({
      t: W_S,
      name: r.name,
      phase: "W",
      stored: s,
      ratio: +(s.bytes / r.dbBytes).toFixed(2),
      dbBytes: r.dbBytes,
      ops: r.pw.snap(),
      aPerMin: +((r.pw.A * 60) / W_S).toFixed(1),
    });
    await r.lw.stopFinal();
  }
  await at(I_S);
  for (const r of runs) {
    const a = r.pi.snap();
    const b = marks[`${r.name}:i60`];
    const perMin = ((a.A - b.A) * 60) / (I_S - 60);
    log({
      t: I_S,
      name: r.name,
      phase: "I",
      dbs: 4,
      aPerMinAfter60s: +perMin.toFixed(2),
      aPerMinPerDb: +(perMin / 4).toFixed(2),
      ops: a,
      opsAt60: b,
    });
    await r.li.stopFinal();
  }
  log({ done: true, ms: Date.now() - t0 });
  process.exit(0);
})().catch((e) => {
  log({ error: String(e.stack || e) });
  process.exit(2);
});
