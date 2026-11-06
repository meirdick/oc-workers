import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SleepFlushRes, validate } from "../lib/contract.mjs";
import { DiskWatch, faultClass, isDiskFull } from "../lib/diskwatch.mjs";
import { MarkerGuard } from "../lib/marker.mjs";

const good = {
  opId: "op1",
  lag: [
    { db: "state/openclaw.sqlite", lag: 0, localTxid: 40 },
    { db: "agents/main/agent/openclaw-agent.sqlite", lag: 0, localTxid: 7 },
  ],
  ls: { clean: true },
  creds: { ok: true },
  shadows: [{ ok: true, rel: "x.sqlite" }],
  nextWakeAtMs: 123,
};

describe("marker guard", () => {
  it("confirmed flush gives a contract-valid reply with TXIDs", () => {
    const m = new MarkerGuard();
    const r = m.flush(good);
    assert.equal(r.ok, true);
    assert.deepEqual(validate(SleepFlushRes, r), []);
    assert.equal(r.txidPerDb["state/openclaw.sqlite"], 40);
    assert.ok(m.confirmed("op1"));
  });
  it("lag > 0, a log fault, unclean Litestream, cred or shadow failure → sleep-flush-failed", () => {
    const cases = [
      { lag: [{ db: "s", lag: 3, localTxid: 9 }] },
      { lag: [{ db: "s", lag: null, localTxid: 9, fault: "ltx-missing" }] },
      { ls: { clean: false, reason: "shutdown-sync-failed" } },
      { ls: { clean: false, reason: "timeout" } },
      { creds: { ok: false, why: "cap" } },
      { shadows: [{ ok: false, rel: "q.sqlite", why: "upload" }] },
    ];
    for (const [i, c] of cases.entries()) {
      const m = new MarkerGuard();
      const r = m.flush({ ...good, ...c, opId: `o${i}` });
      assert.equal(r.ok, false, JSON.stringify(c));
      assert.equal(r.error, "sleep-flush-failed");
      assert.equal(m.confirmed(`o${i}`), false);
    }
  });
  it("single use: same op returns the stored reply; a later write voids it", () => {
    const m = new MarkerGuard();
    assert.equal(m.flush(good).ok, true);
    assert.equal(m.flush({ ...good, ls: { clean: false } }).ok, true); // idempotent per op id, not recomputed
    assert.equal(m.void("resume-after-sleep"), "op1");
    assert.equal(m.confirmed("op1"), false);
    assert.equal(m.flush(good).ok, false); // a void op never turns ok again
    assert.equal(m.void("x"), null);
  });
  it("drain unclean list (F1.7)", () => {
    assert.deepEqual(
      MarkerGuard.drainUnclean({ ls: { clean: true }, gatewayClean: true, creds: { ok: true } }),
      [],
    );
    assert.deepEqual(
      MarkerGuard.drainUnclean({ ls: { clean: false }, gatewayClean: false, creds: { ok: false } }),
      ["litestream", "gateway", "creds"],
    );
  });
});

describe("disk watch", () => {
  it("ENOSPC is disk-full, never replica-*", () => {
    assert.ok(isDiskFull({ code: "ENOSPC" }));
    assert.ok(isDiskFull("SQLITE_FULL: database or disk is full"));
    assert.ok(!isDiskFull({ code: "ECONNREFUSED" }));
    assert.equal(faultClass(["replica-crash", "disk-full"]), "disk-full");
    assert.equal(faultClass(["replica-down:local"], ["write x: no space left on device"]), "disk-full");
    assert.equal(faultClass(["replica-oom"]), "replica-oom");
  });
  it("80 alert, 90 cleanup, 95 reserve freed + disk-full + degraded, recover below 90", async () => {
    const varDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-"));
    let used = 50;
    const alerts = [];
    const deg = [];
    let cleaned = 0;
    const dw = new DiskWatch({
      varDir,
      statfs: () => ({ usedPct: used, inodesPct: 1, freeBytes: (100 - used) * 1e9, totalBytes: 100e9 }),
      alert: (c, s) => alerts.push(`${c}:${s}`),
      onDegraded: (d) => deg.push(d),
      cleanup: async () => {
        cleaned++;
        return { freed: 1 };
      },
      fallocate: (f, n) => {
        fs.writeFileSync(f, Buffer.alloc(16));
        return n > 0;
      },
    });
    assert.equal(dw.makeReserve().made, true);
    assert.equal((await dw.check()).level, "ok");
    used = 82;
    assert.deepEqual((await dw.check()).actions, ["alert"]);
    used = 91;
    assert.deepEqual((await dw.check()).actions, ["cleanup:1"]);
    used = 96;
    const r = await dw.check();
    assert.deepEqual(r.actions, ["cleanup:1", "reserve-freed", "disk-full"]);
    assert.equal(fs.existsSync(path.join(varDir, "reserve")), false);
    used = 85;
    assert.ok((await dw.check()).actions.includes("recovered"));
    assert.deepEqual(alerts, ["disk-high:warn", "disk-full:high"]);
    assert.deepEqual(deg, [true, false]);
    assert.equal(cleaned, 2);
  });
  it("reserve only when free > 2x reserve; child ENOSPC goes the disk-full path", async () => {
    const varDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-"));
    const alerts = [];
    const dw = new DiskWatch({
      varDir,
      statfs: () => ({ usedPct: 99, inodesPct: 1, freeBytes: 600e6, totalBytes: 16e9 }),
      alert: (c) => alerts.push(c),
      fallocate: () => true,
    });
    assert.equal(dw.makeReserve().why, "low-free");
    assert.equal(await dw.onChildError({ code: "EPIPE" }), false);
    assert.equal(await dw.onChildError(new Error("write: no space left on device")), true);
    assert.deepEqual(alerts, ["disk-full"]);
  });
  it("real statfs of / works", async () => {
    const dw = new DiskWatch({ varDir: os.tmpdir() });
    const r = await dw.check();
    assert.ok(r.usedPct >= 0 && r.usedPct <= 100);
    assert.ok(dw.hb().inodesPct >= 0);
  });
});
