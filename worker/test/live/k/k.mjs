// Drill K (scope §4 M4 [Z0.1]; add §2.8 K'): planned stop → boot (clean marker) → writes → host kill →
// next boot restores from the gen: SQLite loss ≤ 3 s, the marker is not used again, bulk loss 0 after the
// planned stop, Telegram updates accepted before the kill are replied ≥ 1 time.
// usage: node k.mjs   env: U, T, WH, GW, RAW. Result: $RAW/k.json
import {
  det,
  dm,
  fakewaStart,
  fakewaStop,
  iso,
  note,
  now,
  ops,
  probe,
  raw,
  result,
  ringSince,
  runningNewGen,
  sends,
  sigkill,
  sleep,
  status,
  waitFor,
} from "../loss-lib.mjs";

const t0 = now();
let s = await status();
if (s.state !== "running") s = (await runningNewGen(-1)).v ?? (await status());
const g0 = s.gen?.gen;
// 1. writes, then a planned stop.
await fakewaStart(`k-a-${now()}`);
await sleep(30_000);
const preStop = await probe();
const stopAt = now();
const st = await ops("POST", "/ops/stop");
const stopped = await waitFor(
  async () => ((await status()).state === "stopped" ? true : null),
  900_000,
  3000,
);
note("stopped", { status: st.status, ms: stopped.ms });
// 2. boot: expect plan marker.
const sa = await ops("POST", "/ops/start");
const b1 = await runningNewGen(g0);
const s1 = b1.v ?? (await status());
const afterStart = await probe();
note("boot 1", { gen: s1.gen?.gen, plan: s1.gen?.planKind });
// 3. writes + Telegram on the marker boot, then a host kill.
await fakewaStart(`k-b-${now()}`);
const chat0 = 74000000 + (Math.floor(now() / 1000) % 100000) * 10;
const ups = [];
for (let i = 0; i < 3; i++) {
  ups.push(await dm(chat0 + i, `drill K ${i}`));
  await sleep(6000);
}
await sleep(10_000);
const preKill = await probe();
const k = await sigkill();
const b2 = await runningNewGen(s1.gen?.gen);
const s2 = b2.v ?? (await status());
const afterKill = await probe();
await fakewaStop();
await sleep(60_000);
const ev = await ringSince(t0);
const replies = [];
for (const u of ups) replies.push({ chat: u.chat, ack: u.status, n: (await sends(u.chat, u.t0, ev)).length });
const skew = preKill.now - preKill.laptopMid;
const killC = k.at + skew;
const markerRows = ev
  .filter((e) => /marker/.test(e.kind) || /marker/.test(String(e.detail)))
  .map((e) => `${iso(e.at)} ${e.src}/${e.kind} ${String(e.detail).slice(0, 160)}`);
const replay = ev.filter((e) => e.src === "driver" && e.kind === "replay-unreplicated").map((e) => det(e));
const r = {
  gens: [g0, s1.gen?.gen ?? null, s2.gen?.gen ?? null],
  plans: [s1.gen?.planKind ?? null, s2.gen?.planKind ?? null],
  stop: { status: st.status, ms: stopped.ms, at: iso(stopAt) },
  start: { status: sa.status, ms: b1.ms },
  plannedStop: {
    preStop: { sql: preStop.sql, nm: preStop.nm, ws: preStop.ws, credsTs: preStop.credsTs },
    afterStart: { sql: afterStart.sql, nm: afterStart.nm, ws: afterStart.ws, credsTs: afterStart.credsTs },
    sqlRowsLost: (preStop.sql?.maxId ?? 0) - (afterStart.sql?.maxId ?? 0),
    wsKept: (afterStart.ws?.k ?? -1) >= (preStop.ws?.k ?? 0),
    nmKept: (afterStart.nm?.maxId ?? -1) >= (preStop.nm?.maxId ?? 0),
  },
  kill: { at: iso(k.at), ok: k.ok, toRunningMs: b2.ms },
  hostKill: {
    preKill: { sql: preKill.sql, ws: preKill.ws, credsTs: preKill.credsTs },
    afterKill: { sql: afterKill.sql, ws: afterKill.ws, credsTs: afterKill.credsTs },
    sqlRowsLostMin: (preKill.sql?.maxId ?? 0) - (afterKill.sql?.maxId ?? 0),
    sqlWindowMs: afterKill.sql?.maxTs ? killC - afterKill.sql.maxTs : null,
    credsWindowMs: afterKill.credsTs ? killC - afterKill.credsTs : null,
    identity: [preKill.identity, afterKill.identity],
  },
  replay,
  replies,
  markerRows,
};
raw("k", r);
result("k", {
  ...r,
  checks: {
    stopped: !!stopped.v,
    boot1Marker: s1.gen?.planKind === "marker",
    plannedStopSqlLoss0: r.plannedStop.sqlRowsLost <= 0,
    plannedStopBulkLoss0: r.plannedStop.wsKept && r.plannedStop.nmKept,
    killRestarted: !!b2.v,
    noMarkerReuse: s2.gen?.planKind === "gen",
    sqlLe3s: r.hostKill.sqlWindowMs !== null && r.hostKill.sqlWindowMs <= 3000,
    noRelink: !!afterKill.identity && afterKill.identity === preKill.identity,
    repliedOnceOrTwice: replies.every((x) => x.ack !== 200 || (x.n >= 1 && x.n <= 2)),
  },
});
process.exit(0);
