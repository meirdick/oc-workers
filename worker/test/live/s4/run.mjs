// M4 S4 (add §6, task: 200 cycles): sleep/wake cycles with one fake Telegram update per cycle → 0 lost replies,
// 0 repeated replies on clean cycles, gen GC keeps R2 bytes flat (guess bound 3x state), the rebase runs and the
// snapshot sizes drop after it. Each cycle: asleep → update → wake → reply → force sleep. Every GC_EVERY cycles:
// POST /ops/gc (the daily job's GC, run more often) and an R2 usage read. Resumable: cycles append to
// RAW/s4.cycles.jsonl and a rerun continues from the last index. env: N (200), GC_EVERY (10).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fault,
  forceSleep,
  now,
  ops,
  RAW,
  rawFile,
  repliesSince,
  result,
  ring,
  rows,
  sleep,
  status,
  update,
  waitFor,
  waitState,
} from "../lib.mjs";

rawFile("s4");
const N = Number(process.env.N ?? 200);
const GC_EVERY = Number(process.env.GC_EVERY ?? 10);
const CY = join(RAW, "s4.cycles.jsonl");
const US = join(RAW, "s4.usage.jsonl");
const load = (f) =>
  existsSync(f)
    ? readFileSync(f, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
let cycles = load(CY);
const t0 = now();

async function usage(i) {
  const gc = await ops("POST", "/ops/gc");
  const u = (await fault("r2-usage")).json ?? {};
  const r = await rows(5);
  const row = {
    i,
    at: now(),
    gc: {
      status: gc.status,
      deleted: gc.json?.deleted?.length ?? gc.json?.deleted ?? null,
      more: gc.json?.more,
    },
    total: u.total ?? null,
    by: u.by ?? null,
    archive: r.archives?.[0] ? { id: r.archives[0].id, size: r.archives[0].size } : null,
    marker: r.markers?.[0] ? { gen: r.markers[0].gen, bytes: r.markers[0].bytes } : null,
  };
  appendFileSync(US, `${JSON.stringify(row)}\n`);
  return row;
}

if (!cycles.length) await usage(0);
for (let i = cycles.length; i < N; i++) {
  const s0 = await status();
  if (s0.state !== "asleep") await forceSleep(10 * 60_000);
  const tc = now();
  const u = await update(`s4 cycle ${i}`);
  const run = await waitState("running", 10 * 60_000, 1500);
  const rep = await waitFor(async () => ((await repliesSince(u.t0)).length ? true : null), 5 * 60_000, 1500);
  const s = await status();
  await sleep(2000);
  const slept = await forceSleep(10 * 60_000);
  const ev = await ring(u.t0);
  const replies = ev.filter(
    (e) => e.src === "telegram" && e.kind === "sendMessage" && /mock reply/.test(String(e.d?.text ?? "")),
  ).length;
  const r = await rows(2);
  const snap = r.snapshots?.[0] ?? null;
  const c = {
    i,
    at: tc,
    ack: u.status,
    ackMs: u.ackMs,
    runningMs: run.v ? run.ms : null,
    replyMs: rep.v ? rep.ms : null,
    replies,
    gen: s.gen?.gen ?? null,
    plan: s.gen?.planKind ?? null,
    rootfs: s.gen?.plan?.rootfs ?? null,
    archiveId: s.gen?.plan?.archiveId ?? null,
    rebase: ev.some((e) => e.src === "gen" && e.kind === "rebase"),
    sleepMs: slept,
    snapshot: snap ? { id: snap.id, size: snap.size, parent: snap.parent_id, base: snap.chain_base } : null,
    chainLength: (await status()).chainLength ?? null,
    alerts: ev.filter((e) => e.src === "alert").map((e) => e.kind),
  };
  appendFileSync(CY, `${JSON.stringify(c)}\n`);
  cycles.push(c);
  console.error(
    `${new Date().toISOString()} cycle ${i} ${c.plan} run ${c.runningMs} reply ${c.replyMs} n=${replies} snap ${snap?.size} sleep ${slept}`,
  );
  if ((i + 1) % GC_EVERY === 0) await usage(i + 1);
}
const use = load(US);
cycles = load(CY);
const lost = cycles.filter((c) => c.replies < 1).map((c) => c.i);
const dup = cycles.filter((c) => c.replies > 1).map((c) => c.i);
const rebases = cycles.filter((c) => c.rebase || (c.rootfs === "image" && c.archiveId)).map((c) => c.i);
// Snapshot size: the sleep right after a rebase vs the sleep right before it.
const drops = rebases
  .filter((i) => i > 0)
  .map((i) => ({
    i,
    before: cycles[i - 1]?.snapshot?.size ?? null,
    after: cycles[i]?.snapshot?.size ?? null,
  }));
// Chain bytes: a snapshot plus every parent up to its chain base (what a restore depends on).
const snaps = new Map(((await rows(500)).snapshots ?? []).map((x) => [x.id, x]));
const chainBytes = (id) => {
  let n = 0;
  let k = 0;
  for (let x = snaps.get(id); x && k < 1000; x = x.parent_id ? snaps.get(x.parent_id) : null, k++)
    n += x.size ?? 0;
  return id && snaps.has(id) ? n : null;
};
const chainDrops = rebases
  .filter((i) => i > 0)
  .map((i) => ({
    i,
    before: chainBytes(cycles[i - 1]?.snapshot?.id),
    after: chainBytes(cycles[i]?.snapshot?.id),
  }));
// State = the managed DBs (marker bytes per DB at the last sleep) + the newest archive. The state grows with the
// session history, so the R2 bound is a ratio per sample.
const dbBytes = (u) => {
  try {
    return Object.values(JSON.parse(u?.marker?.bytes ?? "{}")).reduce((x, y) => x + y, 0);
  } catch {
    return 0;
  }
};
const samples = use
  .filter((x) => x.total !== null)
  .map((x) => {
    const st = dbBytes(x) + (x.archive?.size ?? 0);
    return { i: x.i, total: x.total, state: st, ratio: st ? x.total / st : null };
  });
const late = samples.filter((x) => x.i >= N / 4 && x.ratio !== null);
const maxRatio = late.length ? Math.max(...late.map((x) => x.ratio)) : null;
const ratioGrowth = late.length > 1 ? late.at(-1).ratio / late[0].ratio : null;
const stateBytes = samples.at(-1)?.state ?? null;
const maxTotal = late.length ? Math.max(...late.map((x) => x.total)) : null;
const totalGrowth = late.length > 1 ? late.at(-1).total / late[0].total : null;
result("s4", {
  n: cycles.length,
  elapsedMs: now() - t0,
  lost,
  duplicated: dup,
  plans: Object.fromEntries(
    [...new Set(cycles.map((c) => c.plan))].map((k) => [k, cycles.filter((c) => c.plan === k).length]),
  ),
  runningMs: pct(cycles.map((c) => c.runningMs)),
  replyMs: pct(cycles.map((c) => c.replyMs)),
  sleepMs: pct(cycles.map((c) => c.sleepMs)),
  rebases,
  snapshotDrops: drops,
  chainDrops,
  snapshotSizes: pct(cycles.map((c) => c.snapshot?.size)),
  r2: {
    stateBytes,
    maxTotal,
    maxRatio,
    ratioGrowth,
    totalGrowth,
    samples: samples.map((x) => [x.i, x.total, x.state, x.ratio && Math.round(x.ratio * 100) / 100]),
  },
  checks: {
    allCycles: cycles.length >= N,
    noLost: lost.length === 0,
    noDuplicate: dup.length === 0,
    r2Within3xState: maxRatio !== null && maxRatio <= 3,
    r2FlatVsState: ratioGrowth !== null && ratioGrowth <= 1.5,
    rebaseRan: rebases.length > 0,
    chainBytesDropAfterRebase:
      chainDrops.length > 0 && chainDrops.every((d) => d.before && d.after && d.after < d.before),
    snapshotDropsAfterRebase:
      drops.length > 0 && drops.every((d) => d.before && d.after && d.after < d.before),
  },
});
function pct(a) {
  const v = a.filter((x) => typeof x === "number").sort((x, y) => x - y);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, p50: q(0.5), p95: q(0.95), max: v.at(-1) };
}
