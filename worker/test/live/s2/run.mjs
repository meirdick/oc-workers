// M4 S2 (add §6): wake with the newest snapshot not found → previous snapshot + gen; bulk loss ≤ the gap
// between the two snapshots. Wake A writes ws file f1 + DB rows, sleeps (snapshot Sa); wake B writes f2 + DB
// rows, sleeps (snapshot Sb, newest). Fault snapshot-not-found ×1, wake by update: expect rootfs Sa, SQLite
// from the newest gen (marker is bound to Sb), f1 present, f2 gone (bulk gap), every DB row kept, 1 reply.
import {
  exec,
  fault,
  now,
  rawFile,
  repliesSince,
  result,
  ring,
  rows,
  sleep,
  status,
  toAsleep,
  update,
  waitFor,
  waitState,
  writerQ,
  writerStart,
  wsHas,
  wsWrite,
} from "../lib.mjs";

rawFile("s2");
const t0 = now();
const tag = `s2-${t0}`;
const pkill = () => exec(["sh", "-c", "pkill -f m4s-writer; sleep 0.5; echo ok"]);
async function awakeWrite(file) {
  await waitState("running", 600_000);
  await wsWrite(file, tag);
  await writerStart(file, 600_000);
  await sleep(8000);
  await pkill();
  await sleep(3000);
  const q = await writerQ();
  const slept = await toAsleep();
  const s = await status();
  return { q, slept, snapshotId: s.rt?.sleep?.snapshotId ?? null, gen: s.gen?.gen };
}
await toAsleep();
await update(`${tag} wakeA`);
const A = await awakeWrite(`${tag}-f1`);
await update(`${tag} wakeB`);
const B = await awakeWrite(`${tag}-f2`);
const armed = await fault("snapshot-not-found", { count: 1 });
const tw = now();
const u = await update(`${tag} wakeC`);
const run = await waitState("running", 600_000);
const s = await status();
const _rep = await waitFor(async () => ((await repliesSince(u.t0)).length ? true : null), 240_000);
await sleep(10_000);
const f1 = await wsHas(`${tag}-f1`);
const f2 = await wsHas(`${tag}-f2`);
const q = await writerQ();
const ev = await ring(tw);
const r = await rows(10);
const miss = ev.filter(
  (e) => /snapshot/.test(`${e.kind}`) && /miss|lost|not found/i.test(JSON.stringify(e.d ?? e.detail)),
);
const replies = (await repliesSince(u.t0)).length;
result("s2", {
  A,
  B,
  armed: armed.json,
  wake: { gen: s.gen?.gen, plan: s.gen?.plan, runningMs: run.ms },
  missEvents: miss.map((e) => ({ src: e.src, kind: e.kind, d: e.d })),
  snapshots: (r.snapshots ?? [])
    .slice(0, 4)
    .map((x) => ({ id: x.id, kind: x.kind, misses: x.misses, state: x.state, size: x.size })),
  f1,
  f2,
  db: { afterB: B.q, now: q, lostRows: (B.q?.maxId ?? 0) - (q?.maxId ?? 0) },
  replies,
  elapsedMs: now() - t0,
  checks: {
    twoSnapshots: !!A.snapshotId && !!B.snapshotId && A.snapshotId !== B.snapshotId,
    previousSnapshot: s.gen?.plan?.snapshotId === A.snapshotId,
    sqliteFromGen: s.gen?.plan?.sqlite === "gen",
    bulkGapOnly: f1 && !f2,
    noDbLoss: q?.maxId === B.q?.maxId,
    oneReply: replies === 1,
  },
});
