// M3 fix F1 (M2-live-A F1: gen 51 silent in phase `restore` for 310 s until the DO's budget:restore). Every
// restore step now runs under 0.9 × plan.timers.restoreMs; a stall ends the boot with exit 75
// `restore-timeout` (DO: next ladder step) instead of hanging until `litestream restore`'s own 600 s cap.
// Stall shape: ReplicaGate reads never answer (fault readDelayMs), as a hung gate request would.
import { exitInfo } from "../harness/flows.mjs";
import { writeRows } from "../harness/sqlite.mjs";

const RESTORE_MS = 40_000;
// Control run on an ocsup without the fix (OCM1_F1_CONTROL=1, --image <old build>): the plan carries no M3
// fields, the box is only watched for 150 s, and the test records whether it is still in phase restore.
const CONTROL = process.env.OCM1_F1_CONTROL === "1";

export default {
  name: "restore-stall-bounded",
  source: "M2-live-A F1; spec 08 §8.6 restore bound; M3 fix F1",
  rule: "gen restore with every replica read stalled → exit 75 restore-timeout within 0.9 × restoreMs + boot overhead (< 90 s), no lock step, no gateway start.",
  timeoutMs: 600_000,
  async run(t) {
    const a = t.box({ name: "a", gen: 1 });
    await a.start();
    if (!t.check("a: /startupz", (await a.startupz()) !== null)) return;
    writeRows(a, 20, { tag: "a" });
    await t.sleep(5000);
    a.sigkill();
    await a.waitExit(30_000);
    await t.faults({ readDelayMs: 1_000_000 });
    try {
      const b = t.box({
        name: "b",
        gen: 2,
        restoreGens: [1],
        plan: {
          rootfs: { kind: "image" },
          sqlite: { kind: "gen", gen: 1 },
          restoreGens: [1],
          dbs: [{ db: "state/openclaw.sqlite", state: "uploaded", lastTxid: 0, bytes: 0 }],
          ...(CONTROL ? {} : { workspace: { source: "none" } }),
          timers: {
            hbMs: 5_000,
            fenceMs: 150_000,
            startGateMs: 120_000,
            ...(CONTROL ? {} : { restoreMs: RESTORE_MS }),
          },
        },
      });
      const t0 = Date.now();
      await b.start();
      if (CONTROL) {
        await t.sleep(150_000);
        const phase = b
          .events()
          .filter((e) => e.ev === "phase")
          .at(-1)?.phase;
        t.measure("control.after150s", { running: b.running(), phase, lock: b.ev("lock").length });
        t.check(
          "control: still in phase restore after 150 s (no bound)",
          b.running() && phase === "restore",
          {
            phase,
          },
        );
        return;
      }
      await b.waitExit(300_000);
      const ms = Date.now() - t0;
      const x = await exitInfo(t, b);
      t.measure("b.exitMs", ms);
      t.measure("b.exit", x);
      const to = b.ev("restore-timeout").at(-1);
      t.measure("b.restoreTimeout", to);
      t.check("exit 75 restore-timeout", x.code === 75 && x.reason === "restore-timeout", x);
      t.check("ended within 90 s (deadline 36 s + boot)", ms < 90_000, { ms });
      t.check("stalled step named (sqlite-gen)", to?.step === "sqlite-gen", to);
      t.check("no lock step, no gateway start", !b.ev("lock").length && !b.ev("gateway-starting").length);
    } finally {
      await t.faults({ readDelayMs: 0 });
    }
  },
};
