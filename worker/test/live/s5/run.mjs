// M4 S5 (add §6): Control DO reset while asleep → the alarm and the inbox survive (DO storage); wake works.
// Asleep; drop-wake ×1 so the update stays a pending inbox row with the Control DO retry alarm armed; read
// the alarm; ctl-reset (ctx.abort); read the alarm and the inbox again; the retry alarm wakes the install.
import {
  fault,
  now,
  ops,
  rawFile,
  repliesSince,
  result,
  ring,
  sleep,
  status,
  toAsleep,
  update,
  waitFor,
  waitState,
} from "../lib.mjs";

rawFile("s5");
await toAsleep();
const s0 = await status();
const t0 = now();
const drop = await fault("drop-wake", { count: 1 });
const u = await update("s5 u1 asleep, wake dropped");
await sleep(1500);
const a0 = (await fault("ctl-alarm")).json;
const inbox0 = (await ops("GET", "/ops/inbox")).json?.counts;
const reset = await fault("ctl-reset");
await sleep(3000);
const a1 = (await fault("ctl-alarm")).json;
const inbox1 = (await ops("GET", "/ops/inbox")).json?.counts;
const s1 = await status();
const run = await waitState("running", 600_000, 2000);
const _rep = await waitFor(async () => ((await repliesSince(u.t0)).length ? true : null), 240_000);
await sleep(10_000);
const ev = await ring(t0);
const _inits = ev.filter((e) => e.src === "rt" && e.kind === "init").length;
const wakeAt =
  ev.find((e) => e.src === "rt" && e.kind === "row" && e.d?.from === "asleep" && e.d?.to === "starting")
    ?.at ?? null;
const replies = (await repliesSince(u.t0)).length;
result("s5", {
  stateBefore: s0.state,
  rtWakeAtBefore: s0.rt?.sleep?.wakeAt ?? null,
  rtWakeAtAfterReset: s1.rt?.sleep?.wakeAt ?? null,
  drop: drop.json,
  ack: u.status,
  alarmBefore: a0,
  reset: reset.json,
  alarmAfter: a1,
  inboxBefore: inbox0,
  inboxAfter: inbox1,
  ackToWakeMs: wakeAt ? wakeAt - u.t0 : null,
  runningMs: run.ms,
  replies,
  ctlResetSeen: ev.some((e) => e.src === "fault" && e.kind === "ctl-reset"),
  checks: {
    asleepBefore: s0.state === "asleep",
    dropped: ev.some((e) => e.src === "rt" && e.kind === "fault" && e.d?.name === "drop-wake" && e.d?.reason),
    alarmSurvives: typeof a1?.alarm === "number" && a1.alarm > 0,
    inboxSurvives:
      (inbox1?.pending ?? 0) + (inbox1?.accepted ?? 0) + (inbox1?.replicated ?? 0) >= 1 &&
      (inbox0?.pending ?? 0) >= 1,
    rtAlarmKept:
      s1.state === "asleep" ? (s1.rt?.sleep?.wakeAt ?? null) === (s0.rt?.sleep?.wakeAt ?? null) : true,
    wakes: !!run.v,
    oneReply: replies === 1,
  },
});
