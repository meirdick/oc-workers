// Amend §1.6 S3, S4 (M1 wake-1g): 1 GB set marker wake starts the gateway before the seed L0 is recorded
// (state seeding); SIGKILL at +20 s -> next boot restores the marker gen with every row up to the marker
// TXID. 100 MB marker wake: the gateway waits for the seed, seed <= 10 s. Also amend §2 row 10: bytes and
// time per new gen at 100 MB and 1 GB.
import { sleepOp, sleepSnapshot, waitL0 } from "../harness/flows.mjs";
import { probeMaxId, restoreRows, writeRows } from "../harness/sqlite.mjs";

// busy_timeout: the gateway writes the state DB right after /startupz; without it the fill can fail at
// once with SQLITE_BUSY (M1 run 3: 1000 MB fill ended 1 s after /startupz at 160 MB).
const fill = (mb) =>
  `node -e 'const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync("/home/node/.openclaw/state/openclaw.sqlite");c.exec("PRAGMA busy_timeout=30000;PRAGMA journal_mode=WAL;create table if not exists m1_big(b blob)");const s=c.prepare("insert into m1_big values(randomblob(1048576))");for(let k=0;k<${mb};k+=50){c.exec("begin immediate");for(let i=0;i<50;i++)s.run();c.exec("commit")}c.close();console.log("filled")'`;

async function oneSize(t, mb, gen0) {
  const a = t.box({ name: `s${mb}`, gen: gen0 });
  await a.start();
  if (!t.check(`${mb} MB: /startupz`, (await a.startupz()) !== null)) return null;
  t.check(`${mb} MB: filled`, /filled/.test(a.as1000(fill(mb), { timeoutMs: 600_000 }).out));
  writeRows(a, 20, { tag: "pre" });
  await waitL0(t, gen0, { timeoutMs: 600_000 });
  const r = await sleepOp(t, a, { checkWaitMs: 900_000 });
  if (!t.check(`${mb} MB: flush ok`, r.answers.flush?.ok, r.answers.flush)) return null;
  const { snap, marker, dbs } = sleepSnapshot(t, a, r.answers.flush);
  const k = Date.now();
  const w = t.box({
    name: `s${mb}w`,
    image: snap,
    gen: gen0 + 1,
    restoreGens: [gen0],
    env: { OCRT_SNAPSHOT_ID: snap },
    plan: { rootfs: { kind: "snapshot", snapshotId: snap }, sqlite: marker, dbs, restoreGens: [gen0] },
  });
  await w.start();
  let spawnMs = null;
  let seedMs = null;
  while (Date.now() - k < 600_000 && (spawnMs === null || seedMs === null)) {
    if (spawnMs === null && w.ev("gateway-start").length) spawnMs = Date.now() - k;
    const u = (await t.gateState()).uploads?.[gen0 + 1]?.["state/openclaw.sqlite"];
    if (seedMs === null && u?.l0Seen) seedMs = Date.now() - k;
    if (!w.running()) break;
    await t.sleep(200);
  }
  return { a, w, snap, marker, spawnMs, seedMs, gen: gen0 + 1 };
}

export default {
  name: "wake-1g",
  source: "amend §1.6 S3, S4 (M1 wake-1g); amend §2 row 10 (bytes and time per new gen)",
  rule: "1 GB: gateway spawn before the seed L0 is recorded; phase seeding reported; SIGKILL at +20 s; a gen restore of the marker gen has every pre-sleep row. 100 MB: gateway spawn after the seed L0; seed <= 10 s from wake start.",
  needs: ["ocsupctl"],
  timeoutMs: 5_400_000,
  async run(t) {
    const s100 = await oneSize(t, 100, 1);
    if (s100) {
      t.measure("100MB", { spawnMs: s100.spawnMs, seedMs: s100.seedMs });
      t.check(
        "100 MB: gateway waits for the seed",
        s100.spawnMs !== null && s100.seedMs !== null && s100.spawnMs >= s100.seedMs,
        { spawnMs: s100.spawnMs, seedMs: s100.seedMs }, // not s100: it holds Box objects (circular)
      );
      t.check("100 MB: seed <= 10 s", s100.seedMs !== null && s100.seedMs <= 10_000, s100.seedMs);
      const st = await t.gateState();
      t.measure("100MB.genBytes", st.uploads?.[2]?.["state/openclaw.sqlite"]?.bytes);
      s100.w.rm();
    }
    const s1g = await oneSize(t, 1000, 10);
    if (!s1g) return;
    t.measure("1GB", { spawnMs: s1g.spawnMs, seedMs: s1g.seedMs });
    t.check(
      "1 GB: gateway spawn before the seed L0",
      s1g.spawnMs !== null && (s1g.seedMs === null || s1g.spawnMs < s1g.seedMs),
      { spawnMs: s1g.spawnMs, seedMs: s1g.seedMs },
    );
    const hb = (await t.records({ plane: "control", route: "/v1/heartbeat" })).filter(
      (r) => r.body?.gen === 11,
    );
    t.check(
      "1 GB: phase or rpo seeding reported",
      hb.some((r) => r.body?.phase === "seeding" || r.body?.rpo === "seeding") ||
        s1g.w.events().some((e) => /seeding/.test(JSON.stringify(e))),
    );
    // SIGKILL at +20 s of the wake, then a gen restore of the marker gen (10).
    await t.sleep(Math.max(0, 20_000 - (s1g.spawnMs || 0)));
    s1g.w.sigkill();
    const rr = restoreRows(t.image, 10, {});
    t.measure("1GB.restoreMarkerGen", { ms: rr.ms, probe: rr.probe });
    t.check("1 GB: marker gen restore has every pre-sleep row", probeMaxId(rr, "pre") === 20, rr.probe);
    const st = await t.gateState();
    t.measure("1GB.genBytes", {
      g10: st.uploads?.[10]?.["state/openclaw.sqlite"]?.bytes,
      g11: st.uploads?.[11]?.["state/openclaw.sqlite"]?.bytes,
    });
  },
};
