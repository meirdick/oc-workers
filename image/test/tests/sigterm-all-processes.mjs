// Scope §4 M1 row 1 + amend §2 row 2: SIGTERM to every process (inactivity-stop shape).
import { exitInfo, gateEvents, ps } from "../harness/flows.mjs";
import {
  localRows,
  probeCount,
  probeMaxId,
  restoreRows,
  writerIds,
  writerStart,
} from "../harness/sqlite.mjs";

// guess: 2 s covers ocsup's exit handler + respawn (sample period 200 ms).
const LS_GAP_MS = 2000;

export default {
  name: "sigterm-all-processes",
  source: "scope §4 M1 'SIGTERM to every process'; amend §2 row 2 (SIGKILL all at +4 s)",
  rule: "Variant A (no kill): a Litestream process runs from the SIGTERM until after the gateway exit (one respawn gap <= 2 s allowed: Go resets SIG_IGN) and credsync (ocio credwatch) lives until after the gateway exit and the drain creds-flush is ok; every probe row committed before the drain end is in the gen; exit 0. Variant B (SIGKILL all at +4 s): SQLite loss <= sync interval + 4 s; `sigterm` event first.",
  timeoutMs: 900_000,
  async run(t) {
    for (const variant of ["A", "B"]) {
      const b = t.box({ name: `v${variant}`, gen: variant === "A" ? 1 : 2 });
      await b.start();
      const ms = await b.startupz(180_000);
      if (!t.check(`${variant}: /startupz`, ms !== null, { ms })) continue;
      writerStart(b, { tag: variant, everyMs: 20 });
      await t.sleep(15_000); // DB-set scan + steady replication
      const before = ps(b);
      const lsPid = before.find((p) => /litestream replicate/.test(p.cmd))?.pid;
      // credsync = the ocio watcher `node /opt/ocrt/ocio/credwatch.mjs` (uid 1000). The old regex
      // (credsync|ocio/creds) never matched it: measured.A.pids.credsync was null in M1.
      const isCred = (p) => /ocio\/credwatch\.mjs/.test(p.cmd);
      const credPid = before.find(isCred)?.pid;
      t.measure(`${variant}.pids`, { litestream: lsPid, credsync: credPid ?? null });
      const tTerm = Date.now();
      b.sigtermAll();
      if (variant === "B") {
        await t.sleep(4000);
        b.sigkill();
      }
      // Watch Litestream. Go resets an inherited SIG_IGN, so the first pid exits on the SIGTERM after its
      // own sync; ocsup respawns it in drain mode (lib/litestream.mjs header). Rule: no Litestream gap
      // longer than LS_GAP_MS before the gateway is gone, and one runs after the gateway exit.
      let lsGoneAt = null;
      let gwGoneAt = null;
      let gapStart = null;
      let credGoneAt = null;
      let credAtGwGone = null;
      let maxGapMs = 0;
      const lsPids = new Set();
      while (b.running() && Date.now() - tTerm < 400_000) {
        const p = ps(b);
        const now = Date.now() - tTerm;
        const lsNow = p.filter((x) => /litestream replicate/.test(x.cmd));
        for (const x of lsNow) lsPids.add(x.pid);
        if (lsGoneAt === null && lsPid && !p.some((x) => x.pid === lsPid)) lsGoneAt = now;
        if (credGoneAt === null && !p.some(isCred)) credGoneAt = now;
        if (gwGoneAt === null) {
          if (!lsNow.length && gapStart === null) gapStart = now;
          if (lsNow.length && gapStart !== null) {
            maxGapMs = Math.max(maxGapMs, now - gapStart);
            gapStart = null;
          }
        }
        if (gwGoneAt === null && !p.some((x) => x.uid === 1000 && /openclaw/.test(x.cmd))) {
          gwGoneAt = now;
          credAtGwGone = p.some(isCred);
          if (gapStart !== null) maxGapMs = Math.max(maxGapMs, now - gapStart);
        }
        await t.sleep(200);
      }
      const ex = await exitInfo(t, b);
      t.measure(`${variant}.exit`, ex);
      t.measure(`${variant}.lsGoneMs`, lsGoneAt);
      t.measure(`${variant}.gwGoneMs`, gwGoneAt);
      t.measure(`${variant}.lsMaxGapMs`, maxGapMs);
      t.measure(`${variant}.lsPids`, [...lsPids]);
      t.measure(`${variant}.credGoneMs`, credGoneAt);
      const evs = await gateEvents(t);
      const first = evs.find((e) => ["sigterm", "drained", "exit"].includes(e.body?.kind));
      t.check(
        `${variant}: sigterm event is the first drain event`,
        first?.body?.kind === "sigterm",
        first?.body?.kind,
      );
      const ids = writerIds(b, variant);
      const local = localRows(b, t.image);
      const rest = restoreRows(t.image, b.o.gen, {});
      const lastLocal = probeMaxId(local, variant);
      const lastRest = probeMaxId(rest, variant);
      t.measure(`${variant}.rows`, {
        writerCommitted: ids.length,
        local: probeCount(local, variant),
        restored: probeCount(rest, variant),
        lastLocal,
        lastRest,
      });
      if (variant === "A") {
        t.check("A: exit 0", ex.code === 0, ex);
        // ocsup's log decides the order: the box may exit < 200 ms after the gateway (no ps sample).
        const evA = b.events().filter((e) => Date.parse(e.ts) >= tTerm - 1000);
        const gwExitTs = evA.find((e) => e.ev === "gateway-exit")?.ts;
        const lsExits = evA.filter((e) => e.ev === "litestream-exit");
        const lastLs = lsExits.at(-1);
        t.measure(
          "A.lsExits",
          lsExits.map((e) => ({ ts: e.ts, pid: e.pid, cls: e.cls })),
        );
        t.measure("A.gwExitTs", gwExitTs ?? null);
        t.check(
          `A: Litestream runs until after the gateway exit (respawn gap <= ${LS_GAP_MS} ms)`,
          !!gwExitTs &&
            !!lastLs &&
            Date.parse(lastLs.ts) >= Date.parse(gwExitTs) &&
            lastLs.cls === "planned" &&
            maxGapMs <= LS_GAP_MS,
          { lsGoneAt, gwGoneAt, gwExitTs, lastLs, maxGapMs, pids: [...lsPids] },
        );
        t.check(
          "A: every local row is in the gen (no drain write lost)",
          lastLocal > 0 && lastRest === lastLocal,
          { lastLocal, lastRest },
        );
        // credsync lives to the final sync: watcher found, never gone in a ps sample before the gateway
        // exit (ocsup log time; the box may exit < 200 ms after the gateway, so no ps sample shows
        // "gateway gone"), and the drain creds-flush step is ok (scope §4 M1 row 1).
        const cf = b.events().find((e) => e.ev === "drain-step" && e.step === "creds-flush");
        const gwExitMs = gwExitTs ? Date.parse(gwExitTs) - tTerm : null;
        t.measure("A.credsFlush", cf ?? null);
        t.check(
          "A: credsync watcher found and alive until after the gateway exit; creds-flush ok",
          !!credPid &&
            gwExitMs !== null &&
            (credGoneAt === null || credGoneAt > gwExitMs) &&
            !!cf &&
            cf.ok !== false,
          { credPid, credGoneAt, gwExitMs, credAtGwGone, credsFlush: cf ?? null },
        );
        const fs = await t.records({ plane: "control", route: "/v1/final-snapshot" });
        t.check("A: final-snapshot reached the fake DO", fs.length === 1, fs.length);
      } else {
        // Rows are 20 ms apart: loss in ms = (lastLocal - lastRest) * 20. Bound: 1 s sync + 4 s.
        const lossMs = (lastLocal - lastRest) * 20;
        t.check("B: SQLite loss <= sync interval + 4 s", lastRest > 0 && lossMs <= 5000, {
          lossMs,
          lastLocal,
          lastRest,
        });
      }
    }
  },
};
