// M4 S6 (add §6): deploy of identical code while asleep and while quiescing → no lost update, one gateway at a
// time, same epoch and digest. DEPLOY = command that redeploys the same code (e.g. the group deploy.sh).
// Part A: asleep → deploy → update wakes it. Part B: hold the sleep op at `flush` (sleep-at hold), send an
// update and deploy during the hold; the op resumes or aborts after the DO restart; every update replied.
import { execSync } from "node:child_process";
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
  status,
  toAsleep,
  update,
  waitFor,
  waitState,
} from "../lib.mjs";

rawFile("s6");
const DEPLOY = process.env.DEPLOY;
if (!DEPLOY) throw new Error("set DEPLOY");
const deploy = () => {
  const t = now();
  const out = execSync(DEPLOY, { encoding: "utf8", maxBuffer: 1 << 26 });
  return {
    ms: now() - t,
    version: /Current Version ID: (\S+)/.exec(out)?.[1] ?? null,
    pushed: /pushing:/.test(out),
    skipped: /already exists remotely/.test(out),
  };
};
// ---- A: deploy while asleep
await toAsleep();
const sA = await status();
const tA = now();
const dA = deploy();
const uA = await update("s6 A after deploy while asleep");
const runA = await waitState("running", 600_000, 2000);
await waitFor(async () => ((await repliesSince(uA.t0)).length ? true : null), 240_000);
await sleep(8000);
const sA2 = await status();
const repA = (await repliesSince(uA.t0)).length;
// ---- B: deploy while quiescing (op held at flush)
await ensureRunning();
const tB = now();
await fault("sleep-at", { phase: "flush", action: "hold", ms: 300_000 });
await ops("POST", "/ops/sleep?force=1");
const held = await waitFor(
  async () => {
    const ev = await ring(tB);
    return (
      ev.find((e) => e.src === "rt" && e.kind === "fault" && e.d?.name === "sleep-at" && e.d?.phase) ?? null
    );
  },
  240_000,
  1500,
);
const uB = await update("s6 B during quiescing + deploy");
const dB = deploy();
const settled = await waitState(["running", "asleep"], 600_000, 2000);
// If it went to sleep, the update wakes it (or already woke it).
const _runB = await waitState("running", 600_000, 2000);
await waitFor(async () => ((await repliesSince(uB.t0)).length ? true : null), 300_000);
await sleep(10_000);
const sB2 = await status();
const repB = (await repliesSince(uB.t0)).length;
const ev = await ring(tA);
const spans = bootSpans(ev);
const digestChanges = ev.filter((e) => e.src === "epoch" && e.kind === "digest-change").length;
result("s6", {
  A: {
    deploy: dA,
    epochBefore: sA.epoch,
    epochAfter: sA2.epoch,
    plan: sA2.gen?.planKind,
    runningMs: runA.ms,
    replies: repA,
  },
  B: {
    deploy: dB,
    heldAt: held.v?.at ?? null,
    stateAfterDeploy: settled.v?.state ?? null,
    ops: ev
      .filter((e) => e.at >= tB && e.src === "rt" && ["init", "sleep-abort", "sleep-error"].includes(e.kind))
      .map((e) => ({ kind: e.kind, d: e.d })),
    plan: sB2.gen?.planKind,
    replies: repB,
  },
  transitions: ev
    .filter((e) => e.src === "rt" && e.kind === "row" && e.d?.to && e.d.to !== e.d.from)
    .map((e) => `${e.d.from}>${e.d.to}`),
  digestChanges,
  spans,
  overlaps: overlaps(spans),
  checks: {
    identicalImage: !dA.pushed && !dB.pushed,
    sameDigest: digestChanges === 0,
    sameEpoch: (sA.epoch?.n ?? sA.epoch) === (sB2.epoch?.n ?? sB2.epoch),
    noLostUpdate: repA >= 1 && repB >= 1,
    noDuplicate: repA === 1 && repB === 1,
    oneGatewayAtATime: overlaps(spans).length === 0,
    heldDuringDeploy: !!held.v,
  },
});
