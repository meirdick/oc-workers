// M4 S10 (add §6): destroy() timeout injected → asleep-unconfirmed, reconcile until gone, next wake within the
// bound (last heartbeat + unconfirmedWaitMs; 60 s test value, 200 s real); no second gateway.
import {
  bootSpans,
  ensureRunning,
  fault,
  now,
  ops,
  overlaps,
  rawFile,
  repliesSince,
  result,
  ring,
  sleep,
  update,
  waitFor,
  waitState,
} from "../lib.mjs";

rawFile("s10");
const BOUND_MS = Number(process.env.BOUND_MS ?? 60_000);
const s0 = await ensureRunning();
const t0 = now();
const armed = await fault("destroy-timeout", { count: 1 });
await ops("POST", "/ops/sleep?force=1");
const unc = await waitState("asleep-unconfirmed", 300_000, 1000);
const _tU = now();
// A wake request while unconfirmed: must wait for settle, then start.
const u = await update("s10 u1 while asleep-unconfirmed");
const _run = await waitState("running", 900_000, 2000);
await waitFor(async () => ((await repliesSince(u.t0)).length ? true : null), 240_000);
await sleep(8000);
const ev = await ring(t0);
const rowsT = ev.filter((e) => e.src === "rt" && e.kind === "row" && e.d?.to && e.d.to !== e.d.from);
const at = (to) => rowsT.find((e) => e.d.to === to)?.at ?? null;
const tUnc = at("asleep-unconfirmed");
const tStart = rowsT.find((e) => e.d.to === "starting" && e.at >= (tUnc ?? 0))?.at ?? null;
const _lastHb = s0.rt?.hb?.at ?? null;
const spans = bootSpans(ev);
const replies = (await repliesSince(u.t0)).length;
result("s10", {
  armed: armed.json,
  gen0: s0.gen?.gen,
  transitions: rowsT.map((e) => `${e.d.from}>${e.d.to}@${e.at - t0}`),
  unconfirmedToStartMs: tUnc && tStart ? tStart - tUnc : null,
  boundMs: BOUND_MS,
  zombieAlert: ev.some((e) => e.src === "alert" && e.kind === "zombie"),
  spans,
  overlaps: overlaps(spans),
  replies,
  checks: {
    unconfirmed: !!unc.v,
    wakeWithinBound: tUnc !== null && tStart !== null && tStart - tUnc <= BOUND_MS + 30_000,
    noSecondGateway: overlaps(spans).length === 0,
    oneReply: replies === 1,
  },
});
