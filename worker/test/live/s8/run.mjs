// M4 S8 (add §6): the requestWake after an ack is dropped (drop-wake fault) → the Control DO inbox retry wakes
// the install within 60 s; the update is replied once.
import {
  fault,
  now,
  rawFile,
  repliesSince,
  result,
  ring,
  sleep,
  toAsleep,
  update,
  waitFor,
  waitState,
} from "../lib.mjs";

rawFile("s8");
const N = Number(process.env.N ?? 3);
const runs = [];
for (let i = 0; i < N; i++) {
  await toAsleep();
  const t0 = now();
  const drop = await fault("drop-wake", { count: 1 });
  const u = await update(`s8 u${i}`);
  const run = await waitState("running", 600_000, 2000);
  await waitFor(async () => ((await repliesSince(u.t0)).length ? true : null), 240_000);
  await sleep(8000);
  const ev = await ring(t0);
  const dropped = ev.find(
    (e) => e.src === "rt" && e.kind === "fault" && e.d?.name === "drop-wake" && e.d?.reason,
  );
  const wake = ev.find(
    (e) => e.src === "rt" && e.kind === "row" && e.d?.from === "asleep" && e.d?.to === "starting",
  );
  const replies = (await repliesSince(u.t0)).length;
  runs.push({
    i,
    armed: drop.json?.ok,
    ack: u.status,
    droppedAt: dropped?.at ?? null,
    wakeAt: wake?.at ?? null,
    ackToWakeMs: wake ? wake.at - (u.t0 + u.ackMs) : null,
    wakeReason: ev.find((e) => e.src === "driver" && e.kind === "resume")?.d ?? null,
    runningMs: run.ms,
    replies,
  });
}
result("s8", {
  runs,
  checks: {
    dropped: runs.every((r) => r.droppedAt),
    wokeLe60s: runs.every((r) => r.ackToWakeMs !== null && r.ackToWakeMs <= 60_000),
    oneReply: runs.every((r) => r.replies === 1),
  },
});
