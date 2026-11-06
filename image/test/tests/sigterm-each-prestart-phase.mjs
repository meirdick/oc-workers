// Scope §4 M1 row 2: SIGTERM in each pre-start phase exits 0 and starts no gateway (plan §4.5 step 2).
import { exitInfo, gateEvents, statusFile } from "../harness/flows.mjs";
import { writeRows } from "../harness/sqlite.mjs";

const PHASES = ["boot", "restore", "doctor", "lock", "replica", "litestream"];

async function waitPhase(b, phase, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && b.running()) {
    if (
      b
        .events()
        .some(
          (e) =>
            (e.ev === "phase" && e.phase === phase) ||
            (phase === "boot" && (e.ev === "boot" || e.ev === "start")),
        )
    )
      return true;
    if (statusFile(b)?.phase === phase) return true;
    if (b.events().some((e) => e.ev === "gateway-start" || e.ev === "startupz")) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

export default {
  name: "sigterm-each-prestart-phase",
  source: "scope §4 M1 'SIGTERM in each pre-start phase'; plan §4.5 step 2, §6.2",
  rule: "For each pre-start phase that is caught: exit 0 (reason sigterm or sigterm:<phase>), no gateway-start, no /startupz. At least 3 phases caught.",
  timeoutMs: 1_500_000,
  async run(t) {
    // Seed gen 1 so a gen restore has data.
    const s = t.box({ name: "seed", gen: 1 });
    await s.start();
    if (!t.check("seed /startupz", (await s.startupz()) !== null)) return;
    writeRows(s, 50, { tag: "seed" });
    await t.sleep(12_000);
    s.sigterm();
    await s.waitExit(300_000);
    s.rm();
    await t.faults({ readDelayMs: 1500 }); // a slower restore phase to catch
    let gen = 2;
    const caught = [];
    for (const phase of PHASES) {
      const b = t.box({
        name: `p-${phase}`,
        gen,
        restoreGens: [1],
        env: { OCRT_DOCTOR: "1", OCRT_RESTORE_GEN: "1" },
        plan: { sqlite: { kind: "gen", gen: 1 }, runDoctor: true, restoreGens: [1] },
      });
      gen++;
      await b.start();
      const hit = await waitPhase(b, phase, 60_000);
      if (!hit) {
        t.note(`phase ${phase}: not caught (passed too fast or not in this ocsup)`);
        b.rm();
        continue;
      }
      b.sigterm();
      await b.waitExit(120_000);
      const ex = await exitInfo(t, b);
      const started = b.events().some((e) => e.ev === "gateway-start" || e.ev === "startupz");
      const gs = (await gateEvents(t, "gateway-starting")).filter((r) => r.body?.gen === b.o.gen);
      // The phase counts as caught only if the SIGTERM landed in pre-start (ocsup signal event or exit reason).
      const sig = b.events().find((e) => e.ev === "signal" || e.ev === "sigterm");
      const at = sig?.phase || String(ex.reason || "").split(":")[1] || null;
      if (!at || ["running", "gateway-start", "gateway-restart", "draining"].includes(at)) {
        t.note(`phase ${phase}: SIGTERM landed in ${at || "?"} (after pre-start); not counted`);
        b.rm();
        continue;
      }
      caught.push(`${phase}->${at}`);
      t.check(
        `${phase}: exit 0, sigterm reason`,
        ex.code === 0 && /^sigterm/.test(ex.reason || "sigterm"),
        ex,
      );
      t.check(`${phase}: no gateway started`, !started && gs.length === 0, {
        started,
        gatewayStarting: gs.length,
      });
      b.rm();
    }
    t.measure("caught", caught);
    t.check(">= 3 pre-start phases caught", caught.length >= 3, caught);
  },
};
