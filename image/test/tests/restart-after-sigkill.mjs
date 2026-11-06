// Scope §4 M1 row 3 (first two cases): restart after SIGKILL reaches /startupz with no lock "wait" line,
// (a) for a new boot_id (snapshot of the killed box, new container) and (b) for an in-container restart.
import { exitInfo, gatewayPid } from "../harness/flows.mjs";
import { writeRows } from "../harness/sqlite.mjs";

const waitLine = (b) =>
  b.events().filter((e) => e.ev === "lock-wait" || (e.ev === "lock" && /wait/.test(String(e.action || ""))));

export default {
  name: "restart-after-sigkill",
  source: "scope §4 M1 'Restart after SIGKILL'; plan §4.3, §4.4",
  rule: "(a) new boot_id after SIGKILL: /startupz, no lock wait line, lock class dead:samehost-newboot or none. (b) gateway SIGKILL in the container: ocsup restarts it, /startupz again, no wait line.",
  timeoutMs: 900_000,
  async run(t) {
    const a = t.box({ name: "a", gen: 1 });
    await a.start();
    if (!t.check("a: /startupz", (await a.startupz()) !== null)) return;
    writeRows(a, 10, { tag: "a" });
    await t.sleep(3000);
    a.sigkill();
    await a.waitExit(30_000);
    const snap = a.snapshot(); // rootfs with the dead gateway's lock files and lease row
    // (a) new boot_id
    const b = t.box({
      name: "b",
      image: snap,
      gen: 2,
      restoreGens: [1],
      env: { OCRT_SNAPSHOT_ID: snap },
      plan: {
        rootfs: { kind: "snapshot", snapshotId: snap },
        sqlite: { kind: "gen", gen: 1 },
        restoreGens: [1],
      },
    });
    await b.start();
    const msB = await b.startupz(240_000);
    const lockB = b.ev("lock").at(-1);
    t.measure("a.startupzMs", msB);
    t.measure("a.lock", lockB && { cls: lockB.cls, action: lockB.action, ms: lockB.ms });
    t.check("(a) new boot_id: /startupz", msB !== null, {
      msB,
      exit: msB === null ? await exitInfo(t, b) : undefined,
    });
    t.check("(a) new boot_id: no lock wait line", waitLine(b).length === 0, waitLine(b).slice(0, 2));
    t.check(
      "(a) boot_id differs from the killed boot",
      a.o.bootId !== b.o.bootId && (b.ev("boot")[0]?.newBoot ?? true) !== false,
      { newBoot: b.ev("boot")[0]?.newBoot },
    );
    // (b) in-container: SIGKILL the gateway tree.
    const pid = gatewayPid(b);
    const n0 = b.ev("startupz").length;
    const t0 = Date.now();
    b.sh(`kill -KILL -${pid} 2>/dev/null || kill -KILL ${pid}`);
    const again = await b.waitEv((e) => e.ev === "startupz" && b.ev("startupz").length > n0, 240_000);
    const restartMs = again ? Date.now() - t0 : null;
    t.measure("b.restartMs", restartMs);
    t.check("(b) in-container restart: /startupz again", !!again, { pid, restartMs });
    t.check("(b) in-container restart: no lock wait line", waitLine(b).length === 0, waitLine(b).slice(0, 2));
    t.check("(b) ocsup still running", b.running());
  },
};
