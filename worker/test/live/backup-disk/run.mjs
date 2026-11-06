// Drill backup-disk (plan §4.12 disk watch; scope §1.1 row "Disk"; Z0.4 "a full disk is never replica-down").
// Fills the container disk as uid 1000 (fallocate under /home/node/m4b-fill/) to 82 %, 92 %, 96 % and 100 %,
// waits two disk-watch rounds (30 s) at each level, then frees it. Expected (diskwatch.mjs LEVELS 80/90/95):
// 80 % → alert disk-high; 90 % → cleanup; 95 % → reserve file deleted, degraded, alert disk-full; 100 % →
// SQLite writes fail, Litestream errors class disk-full (no replica-down alert), no container restart;
// freed → recovered. env: U, T. usage: node run.mjs
import { DB, iso, nodeAs, note, now, ops, rawFile, result, ring, sh, sleep, status } from "../backup/lib.mjs";

const KEY = "backup-disk";
rawFile(KEY);
const FILL = "/home/node/m4b-fill";
const WAIT_MS = Number(process.env.WAIT_MS ?? 75_000);

async function df() {
  const r = await sh(
    "df -B1 --output=size,used,avail,pcent / | tail -1; ls -la /var/lib/ocrt/reserve 2>&1 | head -1",
  );
  const [size, used, avail] = r.stdout.trim().split("\n")[0].trim().split(/\s+/).map(Number);
  return {
    size,
    used,
    avail,
    usedPct: +(100 * (1 - avail / size)).toFixed(2),
    reserve: !/No such file/.test(r.stdout),
  };
}
async function fillTo(pct, i) {
  const d = await df();
  // 100 %: fallocate all but 1 MiB, then random bytes until ENOSPC (zeros may be compressed by the host fs).
  const want = pct >= 100 ? d.avail - 1048576 : Math.floor(d.avail - (1 - pct / 100) * d.size);
  if (want <= 0) return { skipped: true, d };
  const top =
    pct >= 100
      ? ` ; dd if=/dev/urandom of=${FILL}/r${i} bs=1M count=64 2>&1 | tail -1; dd if=/dev/urandom of=${FILL}/s${i} bs=4k 2>&1 | tail -1`
      : "";
  const r = await sh(
    `setpriv --reuid=1000 --regid=1000 --clear-groups sh -c 'mkdir -p ${FILL} && fallocate -l ${want} ${FILL}/f${i}${top}'`,
    300_000,
  );
  return { want, r: (r.stdout + r.stderr).slice(0, 300), code: r.code };
}
const WRITE = `
import { DatabaseSync } from "node:sqlite";
let out;
try { const db = new DatabaseSync(${JSON.stringify(DB)}); db.exec("PRAGMA busy_timeout=5000");
  db.exec("CREATE TABLE IF NOT EXISTS m4b_disk(id INTEGER PRIMARY KEY, ts INTEGER, pad BLOB)");
  db.prepare("INSERT INTO m4b_disk(ts, pad) VALUES (?, randomblob(65536))").run(Date.now()); db.close(); out = { ok: true }; }
catch (e) { out = { ok: false, err: String(e.message || e).slice(0, 200), code: e.errcode ?? e.code }; }
console.log(JSON.stringify(out));
`;
async function diskLog(since) {
  const r = await sh(
    `grep -E '"ev":"(disk-[a-z-]+|replica-stage|ls-exit|litestream-exit|ls-class)"' /var/lib/ocrt/ocsup.log | tail -40`,
  );
  return r.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((x) => x && Date.parse(x.ts) >= since)
    .map((x) => ({
      ts: x.ts,
      ev: x.ev,
      ...Object.fromEntries(Object.entries(x).filter(([k]) => !["ts", "t", "ev"].includes(k))),
    }));
}

const t0 = now();
const s0 = await status();
// Alerts dedupe for 1 h (alertDedupeMs): compare counts, not send times.
const alertCount = async () =>
  Object.fromEntries(
    ((await ops("GET", "/ops/alerts")).json?.alerts ?? []).map((a) => [a.class, a.count ?? 0]),
  );
const count0 = await alertCount();
const d0 = await df();
note("start", { state: s0.state, gen: s0.gen?.gen, d0 });
const levels = [];
let i = 0;
for (const pct of [82, 92, 96, 100]) {
  const tl = now();
  const f = await fillTo(pct, i++);
  await sleep(WAIT_MS);
  const w = await nodeAs(WRITE);
  const s = await status();
  const d = await df();
  const row = {
    pct,
    fill: f,
    df: d,
    write: w,
    state: s.state,
    gen: s.gen?.gen,
    degraded: s.degraded,
    ladder: s.ladder?.level,
    log: await diskLog(tl),
  };
  levels.push(row);
  note("level", row);
}
// Free the disk.
const tf = now();
await sh(`rm -rf ${FILL}`);
await sleep(WAIT_MS);
const w2 = await nodeAs(WRITE);
const s2 = await status();
const d2 = await df();
const freed = {
  df: d2,
  write: w2,
  state: s2.state,
  gen: s2.gen?.gen,
  degraded: s2.degraded,
  log: await diskLog(tf),
};
note("freed", freed);
await sleep(45_000);
const count1 = await alertCount();
const al = ((await ops("GET", "/ops/alerts")).json?.alerts ?? []).filter(
  (a) => (count1[a.class] ?? 0) > (count0[a.class] ?? 0),
);
const ev = await ring(t0);
const s3 = await status();
const allLog = [...levels.flatMap((l) => l.log), ...freed.log];
const has = (re) => allLog.some((x) => re.test(JSON.stringify(x)));
const alertClasses = al.map((a) => a.class);
result(KEY, {
  window: { from: iso(t0), to: iso(now()) },
  start: d0,
  levels,
  freed,
  alerts: al.map((a) => ({
    class: a.class,
    severity: a.severity,
    detail: a.last_detail ?? a.detail,
    count: a.count,
  })),
  rtRing: ev
    .filter((e) => e.src === "rt" && /row|stop|class|restart/.test(e.kind))
    .map((e) => ({ at: iso(e.at), kind: e.kind, d: e.d }))
    .slice(0, 30),
  stateAtEnd: s3.state,
  checks: {
    reserveAtStart: d0.reserve,
    diskHighAlert: alertClasses.includes("disk-high"),
    diskFullAlert: alertClasses.includes("disk-full"),
    reserveFreedAt95: levels.find((l) => l.pct === 96)?.df.reserve === false,
    degradedLogged: has(/disk-degraded.*"on":true|"disk-full"/),
    writeFailsWhenFull: levels.find((l) => l.pct === 100)?.write.ok === false,
    noReplicaDownAlert: !alertClasses.some((c) => /^replica-down/.test(c)),
    noRestart: levels.every((l) => l.gen === s0.gen?.gen) && s3.gen?.gen === s0.gen?.gen,
    writeOkAfterFree: w2.ok === true,
    recovered: has(/recovered|disk-degraded.*"on":false/),
    runningAtEnd: s3.state === "running",
  },
});
