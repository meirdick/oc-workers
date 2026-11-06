// Drill backup-pitr: plan §12 M3 drill D as changed by scope §4 M4: poisoned SQLite → L4 + l5-pending, then a
// manual `pitr:` restore loses ≤ the chosen window. Poison: `PRAGMA user_version = 999999` on the state DB
// (OpenClaw refuses to start on a schema newer than the build). Litestream replicates it into the gen, so L1-L4
// all boot the poison. Steps:
//   1. writer 20 rows/s into m4s_w for WRITE_S; at CHOOSE_S the driver notes the PITR point; at POISON_S it
//      poisons the DB; writer ends; 20 s later SIGKILL.
//   2. watch the ladder (status.ladder, alerts ladder-*, l5-pending) up to WATCH_MIN.
//   3. POST /ops/restore {sqlite:"pitr:<choose>", acceptLoss:true}; watch REST_MIN for a boot that runs the
//      l5 op, then read the DB: newest row ≤ choose point, rows lost after choose, user_version back to normal.
// env: U, T. usage: node run.mjs
import {
  DB,
  fault,
  iso,
  nodeAs,
  note,
  now,
  ops,
  rawFile,
  result,
  ring,
  sleep,
  status,
  waitFor,
  writerQ,
  writerStart,
} from "../backup/lib.mjs";

const KEY = "backup-pitr";
rawFile(KEY);
const WRITE_S = Number(process.env.WRITE_S ?? 70);
const CHOOSE_S = Number(process.env.CHOOSE_S ?? 30);
const POISON_S = Number(process.env.POISON_S ?? 50);
const WATCH_MIN = Number(process.env.WATCH_MIN ?? 45);
const REST_MIN = Number(process.env.REST_MIN ?? 15);

const POISON = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(DB)});
db.exec("PRAGMA busy_timeout=5000");
const before = db.prepare("PRAGMA user_version").get().user_version;
db.exec("PRAGMA user_version = 999999");
const after = db.prepare("PRAGMA user_version").get().user_version;
db.close();
console.log(JSON.stringify({ at: Date.now(), before, after }));
`;
const UV = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(DB)}, { readOnly: true });
console.log(JSON.stringify({ uv: db.prepare("PRAGMA user_version").get().user_version }));
`;

const t0 = now();
const s0 = await status();
note("start", { state: s0.state, gen: s0.gen?.gen, ladder: s0.ladder });
const uv0 = await nodeAs(UV);
await writerStart(`pitr${t0}`, WRITE_S * 1000);
const tw = now();
await sleep(CHOOSE_S * 1000);
const choose = now();
await sleep(Math.max(0, tw + POISON_S * 1000 - now()));
const poison = await nodeAs(POISON);
note("poison", poison);
await sleep(Math.max(0, tw + WRITE_S * 1000 - now()) + 3000);
const q0 = await writerQ();
note("writer", q0);
await sleep(20_000);
const tk = now();
const k = await fault("sigkill");
note("sigkill", k.json);

// 2. ladder walk.
const ladderSeen = [];
let l5At = null;
const tw0 = now();
while (now() - tw0 < WATCH_MIN * 60_000) {
  const s = await status();
  const lv = s.ladder?.level ?? null;
  if (ladderSeen.at(-1)?.level !== lv || ladderSeen.at(-1)?.state !== s.state)
    ladderSeen.push({
      at: iso(now()),
      level: lv,
      state: s.state,
      gen: s.gen?.gen,
      plan: s.gen?.plan,
      lastClass: s.ladder?.lastClass,
    });
  const al = (await ops("GET", "/ops/alerts")).json?.alerts ?? [];
  const l5 = al.find((a) => a.class === "l5-pending" && (a.last_sent_at ?? 0) >= tk);
  if (l5) {
    l5At = l5.last_sent_at;
    break;
  }
  await sleep(15_000);
}
note("ladder", { ladderSeen, l5At: iso(l5At) });
const alertsAfterWalk = ((await ops("GET", "/ops/alerts")).json?.alerts ?? [])
  .filter((a) => (a.last_sent_at ?? 0) >= tk)
  .map((a) => ({ class: a.class, at: iso(a.last_sent_at), detail: a.last_detail }));

// 3. owner PITR restore.
const pitr = `pitr:${new Date(choose).toISOString()}`;
const tr = now();
const r = await ops("POST", "/ops/restore", { sqlite: pitr, acceptLoss: true });
note("restore", { status: r.status, body: r.json });
const st = await ops("POST", "/ops/start");
note("start-after-restore", { status: st.status, body: st.json });
const w = await waitFor(
  async () => {
    const s = await status();
    return s.state === "running" && s.gen?.gen !== ladderSeen.at(-1)?.gen ? s : null;
  },
  REST_MIN * 60_000,
  10_000,
);
const sEnd = w.v ?? (await status());
const q1 = sEnd.state === "running" ? await writerQ() : null;
const uv1 = sEnd.state === "running" ? await nodeAs(UV) : null;
const ev = await ring(tr);
const l5ops = ev.filter((e) => /l5/.test(`${e.src}${e.kind}`) || e.d?.reason === "l5");
const lossS = q1?.maxTs ? (choose - q1.maxTs) / 1000 : null;
result(KEY, {
  window: { from: iso(t0), to: iso(now()) },
  userVersionBefore: uv0,
  writer: { start: iso(tw), choose: iso(choose), poison: poison, last: q0 },
  sigkillAt: iso(tk),
  ladder: ladderSeen,
  l5PendingAt: iso(l5At),
  l5PendingAfterKillMin: l5At ? +((l5At - tk) / 60_000).toFixed(1) : null,
  alerts: alertsAfterWalk,
  restore: { source: pitr, status: r.status, body: r.json, start: st.json },
  afterRestore: {
    state: sEnd.state,
    gen: sEnd.gen?.gen,
    plan: sEnd.gen?.plan,
    reason: sEnd.gen?.reason,
    ladder: sEnd.ladder,
    writer: q1,
    userVersion: uv1,
    timeout: !!w.timeout,
  },
  l5Ring: l5ops.map((e) => ({ at: iso(e.at), src: e.src, kind: e.kind, d: e.d })),
  lossAfterChooseS: lossS,
  checks: {
    poisoned: poison.after === 999999,
    reachedL4: ladderSeen.some((x) => x.level === 4),
    reachedSlow: ladderSeen.some((x) => x.level === "slow"),
    l5Pending: !!l5At,
    restoreAccepted: r.status === 202,
    bootedFromPitr:
      sEnd.state === "running" && (sEnd.gen?.reason === "l5" || sEnd.gen?.plan?.sqlite === "pitr"),
    userVersionRestored: uv1?.uv === uv0?.uv,
    lossWithinWindow: lossS !== null && lossS >= 0 && lossS <= 5,
  },
});
