// M4 exit drill: N random SIGKILLs during fake Telegram traffic and a fake second channel (fakewa, lib.mjs)
// with a writer. Per kill: managed SQLite rows lost and window, non-managed SQLite window, creds window, creds
// dir diff (missing / changed files, identity = relink), workspace window, restart timing, plan, replays.
// After the last kill: replies per Telegram update (0 = lost, 2+ = repeated).
// usage: node loss50.mjs   env: U, T, WH, GW; N (50), UP_MIN_S (20), UP_MAX_S (200), DM_EVERY_S (10), START (1)
// Bounds (scope §4 M4): SQLite ≤ 3 s, non-managed SQLite ≤ 15 min, creds ≤ 30 s, bulk ≤ 60 min always-on
// (BULK_BOUND_MS, default 60 min; the test timers scale checkpointMs), relinks 0.

import {
  credsDiff,
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
  ringSince,
  rnd,
  rtRows,
  runningNewGen,
  sigkill,
  sleep,
  status,
  waitFor,
} from "../loss-lib.mjs";
import { analyze } from "./analyze.mjs";

const N = Number(process.env.N ?? 50);
const UP_MIN = Number(process.env.UP_MIN_S ?? 20) * 1000;
const UP_MAX = Number(process.env.UP_MAX_S ?? 200) * 1000;
const DM_EVERY = Number(process.env.DM_EVERY_S ?? 10) * 1000;
const START = Number(process.env.START ?? 1);
// ARCH_AT (M4b): kill numbers that are taken while an owner archive is running (pending → running seen first).
const ARCH_AT = new Set((process.env.ARCH_AT ?? "").split(",").filter(Boolean).map(Number));
let chatSeq = Number(process.env.CHAT0 ?? 73000000 + (Math.floor(now() / 1000) % 100000) * 10);

const t00 = now();
let s = await status();
if (s.state !== "running") {
  const w = await runningNewGen(-1, 900_000);
  s = w.v ?? (await status());
}
for (let i = START; i <= N; i++) {
  const s0 = await status();
  if (s0.state !== "running") {
    note("not running before kill", { i, state: s0.state });
    await runningNewGen(-1, 900_000);
  }
  const g0 = (await status()).gen?.gen;
  let st = await fakewaStart(`k${i}-${now()}`);
  for (let r = 0; r < 3 && !/started/.test(st.stdout ?? ""); r++) {
    await sleep(3000);
    st = await fakewaStart(`k${i}-${now()}`);
  }
  const upMs = Math.round(rnd(UP_MIN, UP_MAX));
  note(`kill ${i}/${N}`, { gen: g0, upMs, fakewa: (st.stdout ?? st.error ?? "").trim() });
  // Telegram traffic during the awake period: one DM per DM_EVERY from a new chat (1 update ↔ 1 chat).
  const tUp = now();
  const sent = [];
  while (now() - tUp < upMs) {
    const chat = ++chatSeq;
    dm(chat, `m4 loss${process.env.SLOW ? " m4b-slow" : ""} k${i} ${chat}`).then((u) => {
      sent.push(u);
      raw("loss50-updates", { kill: i, ...u });
    });
    await sleep(Math.min(DM_EVERY, Math.max(0, upMs - (now() - tUp))));
  }
  let arch = null;
  if (ARCH_AT.has(i)) {
    const rq = await ops("POST", "/ops/archive", { reason: "owner" });
    const seen = await waitFor(
      async () => {
        const a = (await ops("GET", "/ops/archive")).json;
        return a?.request?.id === rq.json?.request?.id && a?.request?.state === "running"
          ? a.request.state
          : null;
      },
      120_000,
      2000,
    );
    await sleep(8000); // let the archive get past the sqlite backups
    arch = { id: rq.json?.request?.id ?? null, running: !!seen.v, waitMs: seen.ms };
    raw("loss50-arch", { kill: i, ...arch });
  }
  const before = await probe();
  const k = await sigkill();
  note("killed", { i, ok: k.ok, err: k.err });
  const w = await runningNewGen(g0, 900_000);
  const tRun = now();
  const after = await probe();
  const ev = await ringSince(k.at - 1000);
  const rows = rtRows(ev);
  const restart = rows.find((x) => x.to === "starting");
  const run = rows.find((x) => x.to === "running");
  const skew = before.now && before.laptopMid ? before.now - before.laptopMid : 0;
  const killC = k.at + skew; // kill time on the container clock
  const sa = w.v ?? (await status());
  const replay = ev.find((e) => e.src === "driver" && e.kind === "replay-unreplicated");
  const ckpts = (await ringSince(tUp)).filter(
    (e) => e.src === "rt" && e.kind === "checkpoint" && e.at < k.at,
  );
  const cd = credsDiff(before, after);
  const rec = {
    i,
    gen: [g0, sa.gen?.gen ?? null],
    plan: sa.gen?.planKind ?? null,
    upMs,
    kill: { at: iso(k.at), ok: k.ok, err: k.err },
    killToRestartMs: restart ? restart.at - k.at : null,
    killToRunningMs: w.v ? (run?.at ?? tRun) - k.at : null,
    probeToKillMs: k.at - before.sentAt,
    probeNow: before.now ?? null,
    writerActive: !!(before.sql?.maxTs && before.now && before.now - before.sql.maxTs <= 5000),
    fakewa: (st.stdout ?? st.error ?? "").trim().slice(0, 80),
    sql: {
      before: before.sql,
      after: after.sql,
      rowsLostMin:
        before.sql?.maxId != null && after.sql?.maxId != null ? before.sql.maxId - after.sql.maxId : null,
      windowMs: after.sql?.maxTs ? killC - after.sql.maxTs : null,
    },
    nm: { before: before.nm, after: after.nm, windowMs: after.nm?.maxTs ? killC - after.nm.maxTs : null },
    creds: {
      windowMs: after.credsTs ? killC - after.credsTs : null,
      identity: [before.identity, after.identity],
      relink: !after.identity || after.identity !== before.identity,
      preKey: [before.preKey, after.preKey],
      diff: { ...cd, missing: cd.missing.length, extra: cd.extra.length, changed: cd.changed.length },
      lostFiles: cd.missing.slice(0, 20),
    },
    ws: {
      before: before.ws,
      after: after.ws,
      notes: [before.wsNotes, after.wsNotes],
      windowMs: after.ws?.ts ? killC - after.ws.ts : null,
    },
    checkpointsInPeriod: ckpts.map((e) => ({ at: iso(e.at), size: det(e)?.size, ms: det(e)?.ms })),
    replayed: replay ? det(replay)?.n : 0,
    archInFlight: arch,
    dmsSent: sent.length,
    timeout: !!w.timeout,
  };
  raw("loss50-kills", rec);
  note(`kill ${i} done`, {
    plan: rec.plan,
    run: rec.killToRunningMs,
    sqlMs: rec.sql.windowMs,
    rows: rec.sql.rowsLostMin,
    nmMs: rec.nm.windowMs,
    credsMs: rec.creds.windowMs,
    relink: rec.creds.relink,
    wsMs: rec.ws.windowMs,
  });
  if (w.timeout) {
    note("no running after kill; owner restart", { i });
    await ops("POST", "/ops/restart");
    await runningNewGen(sa.gen?.gen, 900_000);
  }
}
await fakewaStop();
// SETTLE_MIN (M4b L3): an accepted row with no reply is replayed after 10 min, so wait past that before counting.
if (process.env.SETTLE_MIN) await sleep(Number(process.env.SETTLE_MIN) * 60_000);
// Replies per update: wait until the replay settles (no new sendMessage for 60 s, cap 10 min).
let lastN = -1;
await waitFor(
  async () => {
    const n = (await ringSince(t00)).filter((e) => e.src === "telegram" && e.kind === "sendMessage").length;
    const same = n === lastN;
    lastN = n;
    return same ? true : null;
  },
  600_000,
  60_000,
);
await analyze(N - START + 1);
process.exit(0);
