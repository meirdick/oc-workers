import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { faultStage, LagTracker, maxTxidOfNames } from "../lib/ls-lag.mjs";

const clock = () => {
  let t = 1_000_000;
  const now = () => t;
  now.add = (ms) => {
    t += ms;
  };
  return now;
};
const DB = "state/openclaw.sqlite";

describe("ls-lag", () => {
  it("max TXID from L0 names", () => {
    assert.equal(
      maxTxidOfNames(["0000000000000001-0000000000000001.ltx", "000000000000001f-0000000000000021.ltx", "x"]),
      0x21,
    );
    assert.equal(maxTxidOfNames([]), 0);
  });
  it("lag counts level-0000 only: L9 at start does not hide a stuck L0 (F1.5 lag-level)", () => {
    const now = clock();
    const t = new LagTracker({ dbs: [DB], now });
    t.setLocal(DB, 40); // local L0 up to 40; gate recorded only an L9 key (not passed to setRemote)
    assert.equal(t.report()[0].lag, 40);
    now.add(11_500);
    assert.ok(t.overdueMs() > 0);
  });
  it("busy DB that keeps up is healthy although lag is never 0 at a sample", () => {
    const now = clock();
    const t = new LagTracker({ dbs: [DB], now });
    for (let i = 1; i <= 60; i++) {
      t.setLocal(DB, i * 2);
      t.setRemote(DB, i * 2 - 1); // always one behind, but each local TXID is remote within 1 s
      now.add(1000);
      assert.equal(t.overdueMs(), 0);
    }
    assert.equal(t.report()[0].lag, 1);
  });
  it("fault from the log makes lag infinite, restart clears it (F1.4)", () => {
    const now = clock();
    const t = new LagTracker({ dbs: [DB], now });
    t.setFault(DB, "ltx-missing");
    assert.equal(t.report()[0].lag, null);
    assert.equal(t.worstMs(), Number.POSITIVE_INFINITY);
    assert.equal(t.caughtUp(), false);
    t.clearFaults();
    assert.equal(t.caughtUp(), true);
  });
  it("log fault: fault clock from the fault line, no I + 10 s allowance, not Infinity (F1.4)", () => {
    const now = clock();
    const t = new LagTracker({ dbs: [DB], now });
    t.setFault(DB, "ltx-missing");
    now.add(6000);
    assert.equal(t.overdueMs(), 6000);
    assert.equal(faultStage(t.overdueMs()), "admission-close");
    now.add(10_000);
    assert.equal(faultStage(t.overdueMs()), "gateway-stop");
  });
  it("planned restart holds the fault rule 30 s", () => {
    const now = clock();
    const t = new LagTracker({ dbs: [DB], now });
    t.hold(30_000, "planned-restart");
    t.setLocal(DB, 5);
    now.add(20_000);
    assert.equal(t.overdueMs(), 0);
    now.add(11_000);
    assert.ok(t.overdueMs() > 0);
  });
  it("fault stages +5 s, +15 s, 10 min", () => {
    assert.equal(faultStage(0), "ok");
    assert.equal(faultStage(1000), "late");
    assert.equal(faultStage(5000), "admission-close");
    assert.equal(faultStage(15_000), "gateway-stop");
    assert.equal(faultStage(600_000), "replica-down");
    assert.equal(faultStage(0, { lsDown: true, downForMs: 6000 }), "admission-close");
    // test mode (plan timers.replicaFault)
    const at = { closeMs: 1000, stopMs: 2000, downMs: 3000 };
    assert.equal(faultStage(1500, { at }), "admission-close");
    assert.equal(faultStage(3000, { at }), "replica-down");
    assert.equal(faultStage(1500, { at: { stopMs: 1200 } }), "gateway-stop");
  });
});
