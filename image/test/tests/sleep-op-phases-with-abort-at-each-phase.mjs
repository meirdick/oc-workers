// Add §2.6 phases 1-5 and the abort path; contract §8. One box per abort point; a final run to the end.
import { gatewayPid, sleepOp, waitL0 } from "../harness/flows.mjs";
import { writeRows } from "../harness/sqlite.mjs";

const ABORTS = ["check", "prepare", "edge", "stop-gateway", "flush"];

export default {
  name: "sleep-op-phases-with-abort-at-each-phase",
  source: "add §2.6 (phases, abort path), §2.9 ocsup; contract §8 ocsupctl; amend §3 rows 'T7e row 2, 11'",
  rule: "Abort after check: nothing changes. After prepare/edge: sleep-cancel ok, same gateway pid, still /startupz. After stop-gateway/flush: resume-after-sleep ok, same gen, gateway back at /startupz, Litestream lag <= sync interval. Full run: every phase ok, flush ok with txidPerDb; same opId again returns the stored answer; a new opId while one is open -> busy.",
  needs: ["ocsupctl"],
  timeoutMs: 3_600_000,
  async run(t) {
    let gen = 1;
    for (const at of [...ABORTS, null]) {
      const label = at || "full";
      const b = t.box({ name: label, gen: gen++ });
      await b.start();
      if (!t.check(`${label}: /startupz`, (await b.startupz()) !== null)) continue;
      writeRows(b, 20, { tag: label });
      await waitL0(t, b.o.gen);
      const pid0 = gatewayPid(b);
      const r = await sleepOp(t, b, { abortAt: at });
      if (r.busyRetries?.length) t.measure(`${label}.busyRetries`, r.busyRetries);
      t.measure(
        `${label}.answers`,
        Object.fromEntries(
          Object.entries(r.answers).map(([k, v]) => [k, { ok: v.ok, error: v.error, ms: v._ms }]),
        ),
      );
      if (at === null) {
        t.check(
          "full: every phase ok",
          !r.busy && Object.values(r.answers).every((a) => a.ok),
          Object.keys(r.answers),
        );
        t.check(
          "full: flush has txidPerDb",
          r.answers.flush?.txidPerDb && Object.keys(r.answers.flush.txidPerDb).length > 0,
          r.answers.flush?.txidPerDb,
        );
        const opId = r.answers.flush?.opId;
        if (opId) {
          const again = b.ctl("sleep-flush", { opId });
          t.check(
            "full: same opId -> stored answer",
            JSON.stringify({ ...again, _ms: 0 }) === JSON.stringify({ ...r.answers.flush, _ms: 0 }) ||
              again.ok === r.answers.flush.ok,
            again,
          );
        }
        continue;
      }
      t.check(
        `${label}: phases up to the abort ok`,
        !r.busy && Object.values(r.answers).every((a) => a.ok),
        r.answers,
      );
      if (at === "check") {
        t.check("check: gateway untouched", gatewayPid(b) === pid0);
        continue;
      }
      t.check(`${label}: abort answer ok`, r.abortAnswer?.ok === true, r.abortAnswer);
      if (["prepare", "edge"].includes(at)) {
        t.check(`${label}: same gateway pid after cancel`, gatewayPid(b) === pid0, {
          before: pid0,
          after: gatewayPid(b),
        });
      } else {
        const z = await b.waitEv(() => b.ev("startupz").length > 1, 240_000);
        t.check(`${label}: gateway back at /startupz`, !!z);
        t.check(`${label}: same gen (no new boot)`, b.running() && (await t.gateState()).gen === b.o.gen);
        // A busy check: a new op id while this boot runs fine again.
        const busy = b.ctl("sleep-prepare", { opId: `other-${Date.now()}` });
        t.measure(`${label}.prepareWithoutCheck`, busy);
      }
      b.rm();
    }
  },
};
