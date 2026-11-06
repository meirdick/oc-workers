import assert from "node:assert/strict";
import { test } from "node:test";
import { sleepOp } from "../harness/flows.mjs";

const fakeT = { name: "u", note() {} };
/** Box whose prepare answers busy `busyN` times, then ready. Records each ctl call. */
function fakeBox(busyN) {
  const calls = [];
  let busy = busyN;
  return {
    calls,
    ctl(op, { opId }) {
      calls.push([op, opId]);
      if (op === "sleep-check") return { ok: true, blockers: [] };
      if (op === "sleep-prepare")
        return busy-- > 0 ? { ok: true, status: "busy", retryAfterMs: null } : { ok: true, status: "ready" };
      return { ok: true };
    },
  };
}

test("busy prepare restarts from check with a new op id", async () => {
  const b = fakeBox(2);
  const r = await sleepOp(fakeT, b, { opId: "op-x", busyWaitMs: 1 });
  assert.equal(r.aborted, null);
  assert.equal(r.busyRetries.length, 2);
  const preps = b.calls.filter(([o]) => o === "sleep-prepare").map(([, id]) => id);
  assert.equal(preps.length, 3);
  assert.equal(new Set(preps).size, 3);
  // the later phases use the op id that got `ready`
  const stop = b.calls.find(([o]) => o === "sleep-stop-gateway");
  assert.equal(stop[1], preps[2]);
  assert.equal(r.answers.prepare.status, "ready");
});

test("busy until the deadline ends as aborted at prepare", async () => {
  const b = fakeBox(1e9);
  const r = await sleepOp(fakeT, b, { opId: "op-y", busyWaitMs: 1, checkWaitMs: 30 });
  assert.equal(r.aborted, "prepare");
  assert.equal(r.busy, true);
  assert.ok(!b.calls.some(([o]) => o === "sleep-stop-gateway"));
});

test("no busy: one check, one prepare in the loop", async () => {
  const b = fakeBox(0);
  const r = await sleepOp(fakeT, b, { opId: "op-z", abortAt: "stop-gateway" });
  assert.equal(b.calls.filter(([o]) => o === "sleep-prepare").length, 1);
  assert.equal(r.aborted, "stop-gateway");
  assert.ok(b.calls.some(([o]) => o === "resume-after-sleep"));
});
