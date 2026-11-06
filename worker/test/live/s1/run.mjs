// M4 S1 (add §6): host kill at each sleep phase → next boot correct, SQLite loss ≤ 3 s, no marker reuse,
// ≤ 1 repeated reply per kill. Also S9 (platform SIGTERM at each phase) with ACTION=sigterm KEY=s9.
// Kill = /ops/fault sleep-at {phase, action}: hostkill = SIGKILL to the container + Runtime DO ctx.abort.
// Per phase: writer 20 rows/s; update u1 + reply; force sleep; the fault fires at the phase edge; wait for the
// next boot (L1 restart or asleep → wake by update u2); u2 reply; count replies; read the restored DB.
// usage: node run.mjs [phase ...]   env: ACTION (hostkill|sigkill|sigterm), KEY (s1|s9)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureRunning,
  exec,
  fault,
  genOf,
  note,
  now,
  ops,
  RAW,
  rawFile,
  repliesSince,
  result,
  ring,
  sleep,
  status,
  transitions,
  update,
  waitFor,
  writerQ,
  writerStart,
} from "../lib.mjs";

const ACTION = process.env.ACTION ?? "hostkill";
const KEY = process.env.KEY ?? "s1";
const ALL = ["check", "prepare", "edge", "stop-gateway", "flush", "marker", "snapshot", "destroy"];
const PHASES = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const HOT = new Set(["check", "prepare", "edge"]); // gateway still up: the writer keeps writing to the kill
rawFile(KEY);

const bootOf = (s) => ({
  gen: genOf(s),
  plan: s.gen?.planKind ?? null,
  sqliteGen: s.gen?.plan?.sqliteGen ?? null,
  snapshotId: s.gen?.plan?.snapshotId ?? null,
  rootfs: s.gen?.plan?.rootfs ?? null,
  ladder: s.ladder?.level ?? s.ladder ?? null,
});
const pkill = () => exec(["sh", "-c", "pkill -f m4s-writer; sleep 0.5; echo ok"]);

async function one(phase) {
  const t0 = now();
  const s0 = await ensureRunning();
  const g0 = genOf(s0);
  // Wait out a sleep-blocking hold from the last case (config-recent etc. are fine: force skips idle only).
  await writerStart(`${KEY}-${phase}`, 900_000);
  await sleep(6000);
  const u1 = await update(`${KEY} ${phase} u1`);
  const r1 = await waitFor(async () => ((await repliesSince(u1.t0)).length ? true : null), 150_000);
  let fin = null;
  if (!HOT.has(phase)) {
    await sleep(2000);
    await pkill();
    await sleep(3000);
    fin = await writerQ();
  }
  const armed = await fault("sleep-at", { phase, action: ACTION });
  // Force sleep until the op starts (rule 5 can hold it while the u1 row replicates).
  let opAt = null;
  for (let i = 0; i < 60 && !opAt; i++) {
    const s = await status();
    if (s.state === "quiescing") opAt = now();
    else if (s.state === "running") {
      const r = await ops("POST", "/ops/sleep?force=1");
      if (r.json?.ok) opAt = now();
      else await sleep(3000);
    } else await sleep(2000);
  }
  // The fault fires at the phase edge (ring rt/fault sleep-at).
  const fired = await waitFor(
    async () => {
      const ev = await ring(t0);
      return (
        ev.find((e) => e.src === "rt" && e.kind === "fault" && e.d?.name === "sleep-at" && e.d?.phase) ?? null
      );
    },
    240_000,
    1500,
  );
  const killAt = fired.v?.d?.at ?? fired.v?.at ?? null;
  note("fired", { phase, killAt, opAt });
  // Next boot: L1 restart to running, or asleep (kill at destroy / sigterm drain) → wake by u2.
  const settled = await waitFor(
    async () => {
      const s = await status();
      if (s.state === "running" && genOf(s) > g0) return s;
      if (s.state === "asleep") return s;
      return null;
    },
    600_000,
    3000,
  );
  const stateAfter = settled.v?.state ?? null;
  const u2 = await update(`${KEY} ${phase} u2`);
  const run2 = await waitFor(
    async () => {
      const s = await status();
      return s.state === "running" && genOf(s) > g0 ? s : null;
    },
    600_000,
    3000,
  );
  const r2 = await waitFor(async () => ((await repliesSince(u2.t0)).length ? true : null), 240_000);
  await sleep(15_000); // a late replay of u1 would land here
  const s2 = await status();
  const after = await writerQ();
  await pkill();
  const ev = await ring(t0);
  writeFileSync(join(RAW, `${KEY}-${phase}.ring.json`), JSON.stringify(ev));
  const replies = (await repliesSince(u1.t0)).length;
  const lastDurable = HOT.has(phase) ? killAt : fin?.maxTs;
  const lossMs = lastDurable && after?.maxTs ? Math.max(0, lastDurable - after.maxTs) : null;
  const lostRows = !HOT.has(phase) && fin?.maxId && after?.maxId ? fin.maxId - after.maxId : null;
  const boot = bootOf(s2);
  const r = {
    phase,
    action: ACTION,
    armed: armed.json,
    g0,
    killAt,
    opToKillMs: killAt && opAt ? killAt - opAt : null,
    stateAfterKill: stateAfter,
    killToSettledMs: killAt ? settled.ms : null,
    boot,
    transitions: transitions(ev),
    u1: { ack: u1.status, replyMs: r1.v ? r1.ms : null },
    u2: { ack: u2.status, runningMs: run2.ms, replyMs: r2.v ? r2.ms : null },
    replies,
    repeated: replies - 2,
    writer: { fin, after, hot: HOT.has(phase) },
    lossMs,
    lostRows,
    elapsedMs: now() - t0,
  };
  note("case", r);
  return r;
}

const cases = [];
for (const p of PHASES) cases.push(await one(p));
// Marker reuse: two boots that used a marker of the same gen (each sleep writes one marker for its gen).
const markerGens = cases.filter((c) => c.boot.plan === "marker").map((c) => c.boot.sqliteGen);
const reuse = markerGens.length !== new Set(markerGens).size;
const markerAfterEarlyKill = cases.filter(
  (c) => c.boot.plan === "marker" && ALL.indexOf(c.phase) < ALL.indexOf("snapshot"),
);
const checks = {
  everyFired: cases.every((c) => c.killAt),
  nextBootRunning: cases.every((c) => c.u2.replyMs !== null && c.boot.gen > c.g0),
  ladderL1: cases.every((c) => c.boot.ladder === 1 || c.boot.ladder === null),
  sqliteLossLe3s: cases.every((c) => c.lossMs !== null && c.lossMs <= 3000),
  noMarkerReuse: !reuse,
  noMarkerAfterEarlyKill: markerAfterEarlyKill.length === 0,
  noLostReply: cases.every((c) => c.replies >= 2),
  repeatedLe1: cases.every((c) => c.repeated <= 1),
};
result(KEY, { action: ACTION, phases: PHASES, checks, cases });
