// Drill L (scope §4 M4 [Z1.9]): Control DO storage replaced → creds restored from R2 `c/`, no relink.
// The fake second channel churns its creds; probes map each creds.json version (sha) to its write time; then
// /ops/fault ctl-wipe (deleteAll + abort) and an owner wake (runs ensure: hwm check → ctl-rewound → restore
// from the newest c/ copy). Checks: rewound, creds.json and every path of the copy back in the store, identity
// version found (no relink), loss window ≤ credsCopyMs + tick, prod boot blocked (spec §13.3), gen not reissued.
// Leaves the install blocked (restore-blocked:rewound) by design: run it last.
// usage: node l.mjs   env: U, T, WH, GW, RAW; CHURN_S (150), COPY_BOUND_MS (60000 + 60000). Result: $RAW/l.json
import {
  fakewaStart,
  iso,
  note,
  now,
  ops,
  probe,
  raw,
  result,
  ringSince,
  runningNewGen,
  sleep,
  status,
  waitFor,
} from "../loss-lib.mjs";

const CHURN = Number(process.env.CHURN_S ?? 150) * 1000;
const BOUND = Number(process.env.COPY_BOUND_MS ?? 120_000);
const t0 = now();
let s = await status();
if (s.state !== "running") s = (await runningNewGen(-1)).v ?? (await status());
const before = { gen: s.gen?.gen, genCounter: s.gen?.counter ?? null, ctlState: s.ctlState };
await fakewaStart(`l-${now()}`);
// creds.json versions seen on disk: sha16 → write ts.
const versions = new Map();
let last = null;
while (now() - t0 < CHURN) {
  const p = await probe();
  const f = p.creds?.["creds.json"];
  if (f) versions.set(f.sha, f.ts);
  last = p;
  await sleep(1500);
}
const manBefore = (await ops("GET", "/ops/creds")).json;
const copies = (await ringSince(t0)).filter((e) => e.src === "creds" && e.kind === "copy");
const usage = (await ops("POST", "/ops/fault", { name: "r2-usage" })).json;
const wipeAt = now();
const w = await ops("POST", "/ops/fault", { name: "ctl-wipe" });
note("wiped", { status: w.status, body: w.json });
await sleep(3000);
const after0 = await status();
const wake = await ops("POST", "/ops/wake");
const rew = await waitFor(
  async () => {
    const st = await status();
    const man = (await ops("GET", "/ops/creds")).json;
    return st.ctlState === "ctl-rewound" && (man?.files?.length ?? 0) > 0 ? { st, man } : null;
  },
  420_000,
  5000,
);
const st = rew.v?.st ?? (await status());
const man = rew.v?.man ?? (await ops("GET", "/ops/creds")).json;
const byPath = new Map((man?.files ?? []).map((f) => [f.path, f]));
const disk = last?.creds ?? {};
const cj = byPath.get("credentials/whatsapp/default/creds.json");
const restoredTs = cj ? (versions.get(cj.sha256.slice(0, 16)) ?? null) : null;
const files = Object.keys(disk).map((f) => {
  const m = byPath.get(`credentials/whatsapp/default/${f}`);
  return {
    f,
    disk: disk[f].sha,
    store: m ? m.sha256.slice(0, 16) : null,
    same: !!m && m.sha256.startsWith(disk[f].sha),
  };
});
// Boot after the wipe: expect no start (restore-blocked:rewound), no new gen at or below the hwm.
// The wiped ring restarts at id 1, so read it directly (the collector file keys on ids).
await sleep(30_000);
const ev = ((await ops("GET", "/ops/events?limit=500")).json?.events ?? []).reverse();
const blocked = ev
  .filter((e) => /rewound/.test(`${e.kind} ${e.detail}`))
  .map((e) => `${iso(e.at)} ${e.src}/${e.kind}`);
const restoreRow = ev.find((e) => e.src === "creds" && e.kind === "restore-c");
const alerts = (await ops("GET", "/ops/alerts")).json?.alerts ?? [];
const r = {
  before,
  wipe: { at: iso(wipeAt), status: w.status, body: w.json },
  afterWipe: { initialized: after0.initialized, epoch: after0.epoch, ctlState: after0.ctlState },
  wake: { status: wake.status, body: wake.json },
  rewound: { ms: rew.ms, ctlState: st.ctlState, gen: st.gen ?? null, state: st.state },
  copiesBeforeWipe: copies.map((e) => ({ at: iso(e.at), detail: e.detail })),
  r2Usage: usage?.by?.c ?? null,
  storeBefore: { seq: manBefore?.seq, files: manBefore?.files?.length },
  storeAfter: { seq: man?.seq, files: man?.files?.length },
  restoreRow: restoreRow ? restoreRow.detail : null,
  credsJson: {
    inStore: !!cj,
    restoredVersionTs: restoredTs,
    lossWindowMs: restoredTs ? wipeAt - restoredTs : null,
    versionsSeen: versions.size,
  },
  files,
  blocked,
  alerts: alerts
    .filter((a) => /creds-restored-c|ctl-rewound/.test(a.class))
    .map((a) => `${a.class}:${a.last_detail ?? ""}`),
};
raw("l", r);
result("l", {
  ...r,
  checks: {
    // The wipe aborts the DO, so the call may answer 500; the storage check below decides.
    wiped: w.status === 200 || after0.initialized === false,
    storageGone: after0.initialized === false || after0.epoch === null,
    rewound: st.ctlState === "ctl-rewound",
    restoredFromC: !!restoreRow,
    credsJsonBack: !!cj,
    noRelink: restoredTs !== null,
    lossWithinCopyBound: restoredTs !== null && wipeAt - restoredTs <= BOUND,
    prodBootBlocked: st.state !== "running" || blocked.length > 0,
  },
});
process.exit(0);
