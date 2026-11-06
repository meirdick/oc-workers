// Amend §1.5 F1.1/F1.2 proof: F1-wake and F1-wake-legacy (F1 regression). Wake from a snapshot on the
// same rootfs with gen k+1 (marker plan, no restore): every DB gets a level-0 upload within 10 s of the
// first write; drain litestream-final clean in <= 5 s; a restore of gen k+1 has every row.
import { dk } from "../harness/docker.mjs";
import { localRows, probeMaxId, restoreRows, writeRows, writerStart } from "../harness/sqlite.mjs";

// Shortened L0 retention so step 2 of amend §1.2 happens in 30 s (as image/test/f1-meta.sh).
const ENV = { OCRT_LS_L0_RETENTION: "10s", OCRT_LS_L0_RETENTION_CHECK: "2s", OCRT_LS_LEVELS: "5s" };

async function variant(t, label, legacy) {
  const gk = legacy ? 20 : 10;
  const a = t.box({
    name: `${label}-k`,
    gen: gk,
    env: { ...ENV, ...(legacy ? { OCRT_LS_LEGACY_META: "1" } : {}) },
  });
  await a.start();
  if (!t.check(`${label}: gen k /startupz`, (await a.startupz()) !== null)) return;
  writerStart(a, { tag: "k", everyMs: 100, max: 600 }); // 600 rows over 60 s
  await t.sleep(65_000);
  // Litestream starts when the DB set has a DB (after the first write), so read the config now.
  const yml = a.sh("cat /run/ocrt/litestream.yml 2>/dev/null").out;
  if (!legacy) {
    t.check(
      `${label}: meta-path per DB under /var/lib/ocrt/ls-meta/g${gk}/`,
      new RegExp(`meta-path:.*?/var/lib/ocrt/ls-meta/g${gk}/`).test(yml),
      yml.slice(0, 300),
    );
    t.check(`${label}: auto-recover false`, /auto-recover:\s*false/.test(yml));
  }
  const beside = a.sh("ls -a /home/node/.openclaw/state | grep -- '-litestream' || true").out;
  if (!legacy) t.check(`${label}: no .<file>-litestream dir beside the DB`, beside === "", beside);
  else t.note(`legacy meta beside DB: ${beside}`);
  a.sigterm();
  await a.waitExit(300_000);
  const snap = a.snapshot();
  const b = t.box({
    name: `${label}-k1`,
    image: snap,
    gen: gk + 1,
    env: { ...ENV, OCRT_SNAPSHOT_ID: snap },
    plan: {
      rootfs: { kind: "snapshot", snapshotId: snap },
      sqlite: { kind: "marker", markerId: `mk-${label}`, snapshotId: snap, gen: gk, txid: {} },
    },
  });
  await b.start();
  if (!t.check(`${label}: gen k+1 /startupz`, (await b.startupz()) !== null)) return;
  if (legacy)
    t.check(
      `${label}: pre-start removed .<file>-litestream`,
      // Read the wipe step: in legacy mode gen k+1 runs Litestream with the M0 layout again, so a new
      // meta dir appears beside the DB right after the wipe; a dir listing cannot tell them apart.
      (b.events().find((e) => e.ev === "step" && e.step === "wipe")?.legacy || []).some((p) =>
        /\.openclaw\.sqlite-litestream$/.test(p),
      ),
      b.events().find((e) => e.ev === "step" && e.step === "wipe")?.legacy,
    );
  const w = Date.now();
  writeRows(b, 50, { tag: "k1" });
  let l0 = null;
  while (Date.now() - w < 30_000 && l0 === null) {
    const st = await t.gateState();
    const u = st.uploads?.[gk + 1] || {};
    const dbs = Object.keys(u);
    if (dbs.length && dbs.every((d) => u[d].l0MaxTxid > 0)) l0 = { ms: Date.now() - w, dbs };
    else await t.sleep(250);
  }
  t.measure(`${label}.firstL0`, l0);
  t.check(`${label}: level-0 upload for each DB within 10 s`, l0 !== null && l0.ms <= 10_000, l0);
  b.sigterm();
  await b.waitExit(300_000);
  const fin = b
    .events()
    .find(
      (e) =>
        (e.ev === "drain-step" && e.step === "litestream-final") ||
        e.ev === "litestream-final" ||
        (e.ev === "litestream-stop" && /drain|final/.test(e.why || "")),
    );
  t.measure(`${label}.litestreamFinal`, fin);
  t.check(
    `${label}: litestream-final clean <= 5 s`,
    !!fin && fin.clean !== false && (fin.ms ?? 0) <= 5000,
    fin,
  );
  const local = localRows(b, t.image);
  const rr = restoreRows(t.image, gk + 1, {});
  t.measure(`${label}.rows`, { localMax: probeMaxId(local), restoredMax: probeMaxId(rr), restoreMs: rr.ms });
  t.check(
    `${label}: restore of gen k+1 has every row`,
    probeMaxId(rr) > 0 && probeMaxId(rr) === probeMaxId(local),
    { local: probeMaxId(local), restored: probeMaxId(rr) },
  );
  dk(["rmi", "-f", snap]);
}

export default {
  name: "litestream-after-snapshot-restore",
  source: "amend §1.5 F1.1-F1.2 (M1 F1-wake, F1-wake-legacy); M0-STATUS §3 row 1",
  rule: "F1-wake: rendered litestream.yml has meta-path /var/lib/ocrt/ls-meta/g<gen>/<db-id> and auto-recover false; no .<file>-litestream beside a DB; after a wake on the same rootfs as gen k+1, every DB has a level-0 upload <= 10 s after the first write; drain litestream-final clean <= 5 s; restore of g<k+1> = local rows. F1-wake-legacy: gen k with the M0 meta layout; pre-start of k+1 removes .<file>-litestream; same pass rule.",
  needs: ["m1"],
  timeoutMs: 1_800_000,
  async run(t) {
    await variant(t, "wake", false);
    await variant(t, "legacy", true);
  },
};
