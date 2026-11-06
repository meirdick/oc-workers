// Amend §2 row 21(a); plan §4.5 step 6: ocsup exits only after the /v1/final-snapshot answer (cap 120 s).
// Fake faults: refuseFinalSnapshot (503), hangFinalSnapshot (answer after 150 s).
export default {
  name: "final-snapshot-faults",
  source: "amend §2 row 21(a); plan §4.5 step 6; contract §2 /v1/final-snapshot",
  rule: "(a) refused (503): drain exits 0 after the answer, < 60 s after SIGTERM. (b) answer delayed 150 s: ocsup waits, exits 0 between 110 s and 135 s after the call (120 s cap).",
  needs: ["m1"],
  timeoutMs: 900_000,
  async run(t) {
    for (const [label, f] of [
      ["refused", { refuseFinalSnapshot: true }],
      ["hang", { hangFinalSnapshot: 150_000 }],
    ]) {
      await t.faults({ clear: true, ...f });
      const b = t.box({ name: label, gen: label === "refused" ? 1 : 2 });
      await b.start();
      if (!t.check(`${label}: /startupz`, (await b.startupz()) !== null)) continue;
      const since = (await t.gateState()).seq;
      const k = Date.now();
      b.sigterm();
      await b.waitExit(400_000);
      const total = Date.now() - k;
      const call = (await t.records({ since, plane: "control", route: "/v1/final-snapshot" }))[0];
      const afterCall = call ? Date.now() - call.ts : null;
      t.measure(`${label}`, {
        totalMs: total,
        callToExitMs: afterCall,
        status: call?.status,
        exit: b.state().exitCode,
      });
      t.check(`${label}: exit 0`, b.state().exitCode === 0, b.state());
      if (label === "refused") t.check("refused: exit < 60 s after SIGTERM", total < 60_000, total);
      else
        t.check(
          "hang: exit 110-135 s after the call",
          afterCall !== null && afterCall >= 110_000 && afterCall <= 135_000,
          afterCall,
        );
      b.rm();
    }
  },
};
