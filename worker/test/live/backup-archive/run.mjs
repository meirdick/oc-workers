// Drill backup-archive (plan §6.1 row 7: archive every 6 h and before an upgrade; gates/archive-policy.ts).
// Test install values (OC_SETTINGS archive): everyMs (6 h → TEST everyMs), minGapMs. Steps:
//   cadence   watch the archive index OBS_MIN minutes while the install runs (other drills write): every
//             cadence archive starts only when due (none / dirty after minGapMs / age after everyMs); no
//             complete archive gets older than everyMs + slack while awake.
//   upgrade   POST /ops/archive {reason:"pre-upgrade"} while awake: an archive with that reason completes
//             even inside the cadence gap; a second request while pending returns the same request.
//   asleep    force sleep, then POST pre-upgrade: the request wakes the install and the archive completes.
// env: U, T; EVERY_MS, GAP_MS (must match the install). usage: node run.mjs cadence|upgrade|asleep
import {
  archives,
  forceSleep,
  iso,
  loadState,
  note,
  now,
  ops,
  rawFile,
  result,
  saveState,
  sleep,
  status,
  waitFor,
} from "../backup/lib.mjs";

const KEY = "backup-archive";
rawFile(KEY);
const step = process.argv[2];
const OBS_MIN = Number(process.env.OBS_MIN ?? 75);
const st = loadState(KEY);

if (step === "cadence") {
  const t0 = now();
  const first = await archives();
  const EVERY = Number(process.env.EVERY_MS ?? first.cfg?.everyMs);
  const GAP = Number(process.env.GAP_MS ?? first.cfg?.minGapMs);
  const seen = new Map();
  const dueLog = [];
  let maxAgeAwake = 0;
  while (now() - t0 < OBS_MIN * 60_000) {
    const a = await archives();
    const s = await status();
    dueLog.push({ t: now(), due: a.due, newestAgeMs: a.newestAgeMs, state: s.state });
    if (s.state === "running" && a.newestAgeMs != null) maxAgeAwake = Math.max(maxAgeAwake, a.newestAgeMs);
    for (const x of a.archives ?? [])
      if (!seen.has(x.id)) {
        // The due answer at the poll before this archive appeared.
        const prev = dueLog.at(-2)?.due ?? null;
        seen.set(x.id, { ...x, dueBefore: prev });
        note("archive", { id: x.id, state: x.state, reason: x.reason, size: x.size, due: prev });
      } else seen.set(x.id, { ...seen.get(x.id), ...x });
    await sleep(30_000);
  }
  const list = [...seen.values()]
    .filter((x) => x.created_at >= t0 - EVERY)
    .sort((a, b) => a.created_at - b.created_at);
  const cadence = list.filter((x) => ["6h", "due", "maint"].includes(x.reason));
  const gaps = cadence.slice(1).map((x, i) => x.created_at - cadence[i].created_at);
  const whys = cadence.map((x) => x.dueBefore?.why ?? null);
  st.cadence = {
    t0,
    list: list.map((x) => ({ id: x.id, reason: x.reason, created: iso(x.created_at), state: x.state })),
  };
  saveState(KEY, st);
  result(`${KEY}`, {
    step,
    cfg: { everyMs: EVERY, minGapMs: GAP },
    window: { from: iso(t0), to: iso(now()) },
    archives: list.map((x) => ({
      id: x.id,
      reason: x.reason,
      state: x.state,
      size: x.size,
      created: iso(x.created_at),
      completeS: x.completed_at ? (x.completed_at - x.created_at) / 1000 : null,
      dueBefore: x.dueBefore?.why ?? null,
      digest: x.digest,
      key: x.key,
    })),
    gapsMin: gaps.map((g) => +(g / 60_000).toFixed(1)),
    whys,
    maxAgeAwakeMin: +(maxAgeAwake / 60_000).toFixed(1),
    dueSamples: dueLog.length,
    checks: {
      atLeastTwoCadenceArchives: cadence.length >= 2,
      allComplete: list.every((x) => x.state === "complete"),
      gapAtLeastMinGap: gaps.every((g) => g >= GAP - 60_000),
      newestNeverOlderThanEvery: maxAgeAwake <= EVERY + 3 * 60_000,
      keyHasDigest: list.every((x) => !/unknown-0{12}/.test(x.key)),
    },
  });
} else if (step === "upgrade" || step === "asleep") {
  const t0 = now();
  let sleptMs = null;
  if (step === "asleep") {
    sleptMs = await forceSleep(8 * 60_000);
    note("asleep", { sleptMs });
  }
  const s0 = await status();
  const due0 = (await archives()).due;
  const r1 = await ops("POST", "/ops/archive", { reason: "pre-upgrade" });
  const r2 = await ops("POST", "/ops/archive", { reason: "pre-upgrade" });
  note("request", { r1: r1.json, r2: r2.json?.request });
  const w = await waitFor(
    async () => {
      const a = await archives();
      const x = (a.archives ?? []).find((y) => y.reason === "pre-upgrade" && y.created_at >= t0);
      return x && x.state === "complete" ? { x, req: a.request } : null;
    },
    15 * 60_000,
    5000,
  );
  const s1 = await status();
  result(`${KEY}-${step}`, {
    step,
    stateBefore: s0.state,
    sleptMs,
    dueBefore: due0,
    request: r1.json?.request,
    woke: r1.json?.woke ?? null,
    sameRequestOnRepeat: r2.json?.request?.id === r1.json?.request?.id,
    archive: w.v
      ? {
          id: w.v.x.id,
          size: w.v.x.size,
          created: iso(w.v.x.created_at),
          completeS: (w.v.x.completed_at - w.v.x.created_at) / 1000,
          key: w.v.x.key,
        }
      : null,
    requestAfter: w.v?.req ?? null,
    requestToCompleteS: w.v ? (w.v.x.completed_at - t0) / 1000 : null,
    stateAfter: s1.state,
    checks: {
      accepted: r1.status === 202,
      deduped: r2.json?.request?.id === r1.json?.request?.id,
      completed: !!w.v,
      requestDone: w.v?.req?.state === "done",
      ...(step === "asleep"
        ? { wasAsleep: s0.state === "asleep" }
        : { insideGap: due0?.why === "gap" || due0?.why === "fresh" }),
    },
  });
} else {
  console.error("usage: run.mjs cadence|upgrade|asleep");
  process.exit(2);
}
