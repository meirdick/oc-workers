// Amend §3 row 'T7e row 14' (M1 sleep-sigterm): platform SIGTERM 0.3 s into each sleep phase, two
// variants (ocsup only; every process).
import { exitInfo, gateEvents, opIdOf } from "../harness/flows.mjs";
import { localRows, probeMaxId, restoreRows, writerStart } from "../harness/sqlite.mjs";

const PHASES = [
  ["check", "sleep-check"],
  ["prepare", "sleep-prepare"],
  ["edge", "sleep-cancel"],
  ["stop-gateway", "sleep-stop-gateway"],
  ["flush", "sleep-flush"],
];

export default {
  name: "sleep-sigterm",
  source: "amend §3 row 'T7e row 14' (M1 sleep-sigterm)",
  rule: "Per phase and variant: sigterm event first; the next sleep call answers draining; exit 0; a drained event (unclean only per F1.7); no marker; restore of the gen has every row committed before the SIGTERM; variant ocsup-only: /v1/final-snapshot reaches the fake.",
  needs: ["ocsupctl"],
  timeoutMs: 5_400_000,
  async run(t) {
    let gen = 1;
    for (const variant of ["one", "all"]) {
      for (let i = 0; i < PHASES.length; i++) {
        const [phase, op] = PHASES[i];
        const label = `${variant}-${phase}`;
        const b = t.box({ name: label, gen: gen++ });
        await b.start();
        if (!t.check(`${label}: /startupz`, (await b.startupz()) !== null)) continue;
        writerStart(b, { tag: "s", everyMs: 50 });
        await t.sleep(65_000); // config-recent blocker window
        const opId = opIdOf(t, label);
        for (const [, prev] of PHASES.slice(0, i)) if (prev !== "sleep-cancel") b.ctl(prev, { opId });
        const since = (await t.gateState()).seq;
        const callP = b.ctlAsync(op, { opId });
        await t.sleep(300);
        if (variant === "one") b.sigterm();
        else b.sigtermAll();
        await callP;
        const next = b.ctl("sleep-flush", { opId });
        t.check(
          `${label}: next sleep call answers draining`,
          next.error === "draining" || next.error === "socket" || next.error === "no-answer",
          next,
        );
        await b.waitExit(600_000);
        const ex = await exitInfo(t, b);
        const evs = (await t.records({ since, plane: "control", route: "/v1/event" })).map(
          (r) => r.body?.kind,
        );
        t.check(`${label}: sigterm event first`, evs[0] === "sigterm", evs.slice(0, 4));
        t.check(`${label}: exit 0`, ex.code === 0, ex);
        const drained = (await gateEvents(t, "drained")).filter((r) => r.body?.gen === b.o.gen).at(-1);
        t.check(`${label}: drained event`, !!drained, drained?.body);
        const local = localRows(b, t.image);
        const rr = restoreRows(t.image, b.o.gen, {});
        t.check(
          `${label}: restore has every local row`,
          probeMaxId(rr) > 0 && probeMaxId(rr) === probeMaxId(local),
          { local: probeMaxId(local), restored: probeMaxId(rr) },
        );
        if (variant === "one") {
          const fs = (await t.records({ since, plane: "control", route: "/v1/final-snapshot" })).length;
          t.check(`${label}: final-snapshot reached the fake`, fs >= 1, fs);
        }
        b.rm();
      }
    }
  },
};
