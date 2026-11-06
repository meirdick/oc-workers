// Drill backup-idle: fixed cost of an asleep install over WINDOW_H hours (default 6). Real timers: the target
// runs without OC_TEST (no /ops/fault), sleep.mode auto. The driver makes no request during the window, so the
// window's DO requests, DO duration, R2 class A/B ops and cron invocations are the install's own.
// usage: node run.mjs start   wait until asleep, record the window start (state.json)
//        node run.mjs end     after the window: status, wake count; write the GraphQL query for the window
//        node run.mjs cost <graphql.json> <namespaces.json>   compute costs from the raw GraphQL answer
// env: U, T of the idle install; APP (container app id), BUCKET, SCRIPT.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { iso, loadState, now, RAWDIR, rawFile, result, saveState, sleep, status } from "../backup/lib.mjs";

const KEY = "backup-idle";
rawFile(KEY);
const WINDOW_MS = Number(process.env.WINDOW_H ?? 6) * 3_600_000;
const SCRIPT = process.env.SCRIPT ?? "oc-m4-backup-idle";
const BUCKET = process.env.BUCKET ?? "oc-m4-backup-idle";
const phase = process.argv[2];

// Workers Paid list prices (USD), 2026-11. Included monthly amounts are not subtracted (marginal cost).
const PRICE = {
  doReqPerM: 0.15,
  doGbSPerM: 12.5,
  r2APerM: 4.5,
  r2BPerM: 0.36,
  workerReqPerM: 0.3,
  workerCpuMsPerM: 0.02,
};
const CLASS_A = new Set([
  "PutObject",
  "CopyObject",
  "CreateMultipartUpload",
  "UploadPart",
  "UploadPartCopy",
  "CompleteMultipartUpload",
  "ListObjects",
  "ListMultipartUploads",
  "ListParts",
  "ListBuckets",
  "PutBucket",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
  "LifecycleStorageTierTransition",
]);
const FREE = new Set(["DeleteObject", "DeleteObjects", "AbortMultipartUpload", "DeleteBucket"]);

function query(from, to) {
  const f = `datetime_geq:"${iso(from)}", datetime_leq:"${iso(to)}"`;
  return `{viewer{accounts(filter:{accountTag:"5759bb6ef591b078e5480bfd5a767856"}){
 doReq: durableObjectsInvocationsAdaptiveGroups(limit:1000, filter:{scriptName:"${SCRIPT}", ${f}}){sum{requests errors} dimensions{namespaceId}}
 doPer: durableObjectsPeriodicGroups(limit:1000, filter:{${f}}){sum{activeTime cpuTime storageReadUnits storageWriteUnits rowsRead rowsWritten} dimensions{namespaceId}}
 r2: r2OperationsAdaptiveGroups(limit:1000, filter:{bucketName:"${BUCKET}", ${f}}){sum{requests} dimensions{actionType}}
 wk: workersInvocationsAdaptive(limit:1000, filter:{scriptName:"${SCRIPT}", ${f}}){sum{requests subrequests cpuTimeUs errors} dimensions{scriptName status}}
 cron: workersInvocationsScheduled(limit:1000, filter:{scriptName:"${SCRIPT}", ${f}}){cron status scheduledDatetime cpuTimeUs}
 ctr: containersUsageAdaptiveGroups(limit:1000, filter:{${f}}){sum{allocatedMemory cpuTimeSec} dimensions{applicationId}}
}}}`;
}

if (phase === "start") {
  const t0 = now();
  let s = await status();
  while (s.state !== "asleep" && now() - t0 < 40 * 60_000) {
    await sleep(30_000);
    s = await status();
  }
  if (s.state !== "asleep") {
    result(KEY, { phase, checks: { asleep: false }, state: s.state, blockers: s.blockers });
    process.exit(1);
  }
  const st = { asleepAt: now(), windowMs: WINDOW_MS, statusAtStart: s };
  saveState(KEY, st);
  console.log(JSON.stringify({ asleepAt: iso(st.asleepAt), waitedMs: st.asleepAt - t0, gen: s.gen?.gen }));
} else if (phase === "end") {
  const st = loadState(KEY);
  if (!st.asleepAt) throw new Error("no start");
  const end = st.asleepAt + st.windowMs;
  if (now() < end) await sleep(end - now());
  const s = await status();
  const q = query(st.asleepAt, end);
  writeFileSync(join(RAWDIR, `${KEY}.graphql`), q);
  st.end = end;
  st.statusAtEnd = s;
  saveState(KEY, st);
  console.log(JSON.stringify({ end: iso(end), state: s.state, gen: s.gen?.gen, wake: s.wake }));
} else if (phase === "cost") {
  const st = loadState(KEY);
  const g = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const ns = JSON.parse(readFileSync(process.argv[4], "utf8")); // [{id, class}] of this script
  const a = (g.data ?? g).viewer.accounts[0];
  const mine = new Set(ns.map((n) => n.id));
  const nsClass = Object.fromEntries(ns.map((n) => [n.id, n.class]));
  const hours = (st.end - st.asleepAt) / 3_600_000;
  const doReq = {};
  for (const r of a.doReq)
    doReq[nsClass[r.dimensions.namespaceId] ?? r.dimensions.namespaceId] = r.sum.requests;
  const doPer = {};
  let activeUs = 0;
  for (const r of a.doPer.filter((x) => mine.has(x.dimensions.namespaceId))) {
    doPer[nsClass[r.dimensions.namespaceId]] = r.sum;
    activeUs += r.sum.activeTime;
  }
  const r2 = Object.fromEntries(a.r2.map((r) => [r.dimensions.actionType, r.sum.requests]));
  let r2A = 0;
  let r2B = 0;
  for (const [k, v] of Object.entries(r2)) {
    if (FREE.has(k)) continue;
    if (CLASS_A.has(k)) r2A += v;
    else r2B += v;
  }
  const wkReq = a.wk.reduce((x, r) => x + r.sum.requests, 0);
  const wkCpuMs = a.wk.reduce((x, r) => x + r.sum.cpuTimeUs, 0) / 1000;
  const doReqTotal = Object.values(doReq).reduce((x, v) => x + v, 0);
  const gbS = (activeUs / 1e6) * 0.125; // DO duration billed at 128 MB per active second
  const ctrMem = a.ctr.filter((r) => r.dimensions.applicationId === process.env.APP);
  const instS = ctrMem.reduce((x, r) => x + r.sum.allocatedMemory, 0) / (6 * 1024 ** 3);
  const usd = {
    doReq: (doReqTotal / 1e6) * PRICE.doReqPerM,
    doDuration: (gbS / 1e6) * PRICE.doGbSPerM,
    r2A: (r2A / 1e6) * PRICE.r2APerM,
    r2B: (r2B / 1e6) * PRICE.r2BPerM,
    workerReq: (wkReq / 1e6) * PRICE.workerReqPerM,
    workerCpu: (wkCpuMs / 1e6) * PRICE.workerCpuMsPerM,
  };
  const total = Object.values(usd).reduce((x, v) => x + v, 0);
  const per30d = (total / hours) * 24 * 30;
  const s = st.statusAtEnd ?? {};
  result(KEY, {
    window: { from: iso(st.asleepAt), to: iso(st.end), hours: +hours.toFixed(2) },
    measured: {
      doRequests: doReq,
      doRequestsTotal: doReqTotal,
      doActiveS: +(activeUs / 1e6).toFixed(1),
      doGbS: +gbS.toFixed(2),
      doPeriodic: doPer,
      r2Ops: r2,
      r2ClassA: r2A,
      r2ClassB: r2B,
      workerInvocations: wkReq,
      workerCpuMs: +wkCpuMs.toFixed(1),
      cronRuns: a.cron.length,
      cronStatus: Object.fromEntries(
        [...new Set(a.cron.map((c) => c.status))].map((k) => [
          k,
          a.cron.filter((c) => c.status === k).length,
        ]),
      ),
      containerInstanceS: +instS.toFixed(1),
    },
    usd: Object.fromEntries(Object.entries(usd).map(([k, v]) => [k, +v.toFixed(6)])),
    usdWindow: +total.toFixed(6),
    usdPer30dAsleep: +per30d.toFixed(4),
    stateAtEnd: s.state,
    wakesInWindow: s.wake ?? null,
    checks: {
      asleepWholeWindow: s.state === "asleep" && s.gen?.gen === st.statusAtStart?.gen?.gen,
      noContainerTime: instS < 1,
      cronRan: a.cron.length > 0,
    },
  });
} else {
  console.error("usage: run.mjs start|end|cost");
  process.exit(2);
}
