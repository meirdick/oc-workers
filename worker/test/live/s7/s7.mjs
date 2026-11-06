// Drill S7 (add §6): host kill 0-3 s after a replay accept → the next boot replays the `accepted` row; the reply
// is sent once or twice, never zero times. Per trial: SIGKILL; while the container is down, DMs from new chats
// queue as `pending`; the boot's driver replays them (→ `accepted`); a second SIGKILL lands 0-3 s after the
// first accept (polled from /ops/inbox); after the next boot every update must have 1 or 2 replies.
// usage: node s7.mjs   env: U, T, WH, GW, RAW; TRIALS (5), PER (3 DMs per trial). Result: $RAW/s7.json
import {
  det,
  dm,
  iso,
  note,
  now,
  ops,
  raw,
  result,
  ringSince,
  rnd,
  runningNewGen,
  sends,
  sigkill,
  sleep,
  status,
  waitFor,
} from "../loss-lib.mjs";

const TRIALS = Number(process.env.TRIALS ?? 5);
const PER = Number(process.env.PER ?? 3);
const trials = [];
let chat = 75000000 + (Math.floor(now() / 1000) % 100000) * 10;
for (let t = 1; t <= TRIALS; t++) {
  let s = await status();
  if (s.state !== "running") s = (await runningNewGen(-1)).v ?? (await status());
  const g0 = s.gen?.gen;
  const k1 = await sigkill();
  await sleep(2000);
  const ups = [];
  for (let i = 0; i < PER; i++) ups.push(await dm(++chat, `drill S7 t${t} ${i}`));
  const keys = new Set(ups.map((u) => String(u.updateId)));
  // Wait for the first of my rows to be accepted by the replay driver, then kill 0-3 s after it.
  const delay = Math.round(rnd(0, 3000));
  const acc = await waitFor(
    async () => {
      const rows = (await ops("GET", "/ops/inbox")).json?.rows ?? [];
      const mine = rows.filter((r) => keys.has(String(r.platform_key)));
      const a = mine.filter((r) => r.accepted_at).sort((x, y) => x.accepted_at - y.accepted_at)[0];
      return a ? { first: a, mine } : null;
    },
    600_000,
    250,
  );
  const seenAt = now();
  const wait = Math.max(0, acc.v ? acc.v.first.accepted_at + delay - seenAt : 0);
  await sleep(wait);
  const k2 = await sigkill();
  const killAfterAcceptMs = acc.v ? k2.at - acc.v.first.accepted_at : null;
  note(`trial ${t}`, { killAfterAcceptMs, delay, accepted: acc.v?.mine.filter((r) => r.accepted_at).length });
  const s1 = (await runningNewGen(g0)).v;
  const b2 = await runningNewGen(s1?.gen?.gen ?? g0);
  // Replies settle: 90 s after running.
  await sleep(90_000);
  const ev = await ringSince(k1.at - 1000);
  const rep = [];
  for (const u of ups)
    rep.push({ chat: u.chat, update: u.updateId, ack: u.status, n: (await sends(u.chat, u.t0, ev)).length });
  const rows = ((await ops("GET", "/ops/inbox")).json?.rows ?? []).filter((r) =>
    keys.has(String(r.platform_key)),
  );
  const rec = {
    t,
    gens: [g0, s1?.gen?.gen ?? null, b2.v?.gen?.gen ?? null],
    plans: [s1?.gen?.planKind ?? null, b2.v?.gen?.planKind ?? null],
    kill1: iso(k1.at),
    firstAccept: acc.v ? iso(acc.v.first.accepted_at) : null,
    acceptedAtKill: acc.v ? acc.v.mine.filter((r) => r.accepted_at).length : 0,
    killAfterAcceptMs,
    targetDelayMs: delay,
    replays: ev.filter((e) => e.src === "driver" && e.kind === "replay-unreplicated").map((e) => det(e)),
    replies: rep,
    rowsAfter: rows.map((r) => ({ key: r.platform_key, state: r.state, acceptedGen: r.accepted_boot_gen })),
  };
  raw("s7", rec);
  trials.push(rec);
}
const all = trials.flatMap((x) => x.replies);
result("s7", {
  trials,
  summary: {
    updates: all.length,
    zero: all.filter((r) => r.n === 0).length,
    once: all.filter((r) => r.n === 1).length,
    twice: all.filter((r) => r.n === 2).length,
    more: all.filter((r) => r.n > 2).length,
    killAfterAcceptMs: trials.map((x) => x.killAfterAcceptMs),
  },
  checks: {
    trials: trials.length === TRIALS,
    killWithin0to3s: trials.every((x) => x.killAfterAcceptMs !== null && x.killAfterAcceptMs <= 3500),
    acked: all.every((r) => r.ack === 200),
    neverZero: all.every((r) => r.n >= 1),
    atMostTwice: all.every((r) => r.n <= 2),
  },
});
process.exit(0);
