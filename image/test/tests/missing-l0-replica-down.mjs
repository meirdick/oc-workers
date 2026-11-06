// Amend §1.5 F1.4: inject a missing L0 file during an awake period -> lag infinite -> replica-down path,
// no clean sleep.
import { sleepOp, waitL0 } from "../harness/flows.mjs";
import { writeRows } from "../harness/sqlite.mjs";

export default {
  name: "missing-l0-replica-down",
  source: "amend §1.5 F1.4 ('inject a missing L0 file ... replica-down path, no clean sleep')",
  rule: "Throttle level-0 PUTs so local L0 files pile up, delete the second-oldest local L0 file not yet uploaded (min TXID > gate L0 max; the oldest is open in the upload retry; H23), lift the throttle: ocsup logs the Litestream 'open ltx file' fault, heartbeat lag null, admission close / replica-down starts; a sleep op does not complete a clean flush.",
  needs: ["ocsupctl"],
  timeoutMs: 900_000,
  async run(t) {
    // hbMs 5 s (test mode): the heartbeat after the fault must come inside the 25 s wait.
    const b = t.box({
      name: "a",
      gen: 1,
      plan: { timers: { hbMs: 5000, fenceMs: 150_000, startGateMs: 120_000 } },
    });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    writeRows(b, 5, { tag: "w" });
    await waitL0(t, 1);
    await t.sleep(3000); // let Litestream upload the first rows before the throttle
    await t.faults({ throttle: { refuseLevel: 0, status: 503 } });
    // H23: several commits, one per Litestream sync (1 s), so each lands in its own L0 file.
    for (let i = 0; i < 6; i++) {
      writeRows(b, 5, { tag: `m${i}` });
      await t.sleep(1500);
    }
    const remote = (await t.gateState()).uploads?.[1]?.["state/openclaw.sqlite"]?.l0MaxTxid ?? 0;
    const files = b
      .sh("find /var/lib/ocrt/ls-meta -path '*state*' -path '*ltx/0/*.ltx' | sort")
      .out.split("\n")
      .filter(Boolean);
    // H23 cause: the old test deleted files[0], an L0 file already uploaded, so no upload needed it.
    // Run 1 of the fix deleted the first pending file: Litestream was inside its upload (SDK retries on
    // the 503 with the file open), so the open fd still read it. Delete the SECOND pending file: the
    // upload loop opens it by path after the first one lands (amend §1.2 step 5) and finds it gone.
    const minOf = (f) => Number.parseInt(/([0-9a-f]{16})-[0-9a-f]{16}\.ltx$/.exec(f)?.[1] || "0", 16);
    const pending = files.filter((f) => minOf(f) > remote);
    t.measure("localL0", files.length);
    t.measure("remoteL0MaxTxid", remote);
    t.measure(
      "pendingL0",
      pending.map((f) => f.split("/").pop()),
    );
    if (!t.check("local L0 files not yet uploaded (>= 3)", pending.length >= 3, pending.length)) return;
    const victim = pending[1];
    t.measure("deleted", victim.split("/").pop());
    b.sh(`rm -f '${victim}'`);
    await t.faults({ clear: true });
    const k = Date.now();
    let seen = null;
    while (Date.now() - k < 60_000 && seen === null) {
      if (b.events().some((e) => /open ltx file|shutdown sync failed/.test(JSON.stringify(e))))
        seen = Date.now() - k;
      else await t.sleep(500);
    }
    t.check("Litestream fault line seen by ocsup", seen !== null, seen);
    await t.sleep(25_000);
    const hb = (await t.records({ plane: "control", route: "/v1/heartbeat" })).at(-1);
    const d = (hb?.body?.litestream?.dbs || []).find((x) => x.db === "state/openclaw.sqlite");
    t.check("heartbeat lag null (infinite)", d && d.lag === null, d);
    t.check(
      "fault path started",
      b
        .events()
        .some(
          (e) => (e.ev === "replica-stage" && e.to !== "ok") || /admission|replica-down|suspend/.test(e.ev),
        ),
    );
    const r = await sleepOp(t, b, { checkWaitMs: 10_000 });
    const clean = r.answers.flush?.ok === true;
    t.check(
      "no clean sleep",
      !clean,
      Object.fromEntries(Object.entries(r.answers).map(([k2, v]) => [k2, v.ok ? "ok" : v.error])),
    );
  },
};
