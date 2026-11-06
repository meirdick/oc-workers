import assert from "node:assert/strict";
import { test } from "node:test";
import { drain, drainPlan } from "../lib/drain.mjs";
import { channelBlockers, createSleepOps, rowBlockers } from "../lib/sleep.mjs";

function world(o = {}) {
  const calls = [];
  const w = {
    calls,
    draining: false,
    gwRunning: true,
    lsRunning: true,
    lag: o.lag ?? true,
    lsClean: o.lsClean ?? true,
    gwClean: o.gwClean ?? true,
    stopGate: null,
  };
  const rec =
    (n, r) =>
    async (...a) => {
      calls.push(n);
      return typeof r === "function" ? r(...a) : r;
    };
  w.deps = {
    draining: () => w.draining,
    now: Date.now,
    queryRows: rec("rows", () => o.rows || { nextWakeAtMs: 123 }),
    channelsStatus: rec(
      "channels",
      () =>
        o.channels ?? [
          { channel: "telegram", lifecycle: "ready", restartPending: false, transport: "webhook" },
        ],
    ),
    seeding: () => !!o.seeding,
    replicaFault: () => null,
    lastConfigChangeAt: () => o.configAt ?? null,
    suspendPrepare: rec("prepare", () => o.prepare || { status: "ready" }),
    suspendResume: rec("resume", { ok: true }),
    gateway: {
      running: () => w.gwRunning,
      stop: async () => {
        calls.push("gw-stop");
        if (w.stopGate) await w.stopGate;
        w.gwRunning = false;
        return { clean: w.gwClean, code: w.gwClean ? 0 : 1, signal: null, ms: 5 };
      },
      start: rec("gw-start", () => {
        w.gwRunning = true;
        return { started: true };
      }),
      waitStartupz: rec("startupz", 1000),
    },
    postExitRead: rec("post-exit", () => o.post || { openRows: 0, eventJobs: [], nextWakeAtMs: 456 }),
    replica: {
      running: () => w.lsRunning,
      waitLagZero: rec("ls-lag", () => ({ ok: w.lag, lag: w.lag ? 0 : 3 })),
      stopFinal: rec("ls-final", () => {
        w.lsRunning = false;
        return { clean: w.lsClean, detail: w.lsClean ? null : "shutdown sync failed" };
      }),
      start: rec("ls-start", () => {
        w.lsRunning = true;
      }),
      waitLagUnder: rec("ls-lag-under", { ok: true }),
      perDb: () => ({
        txid: { "state/openclaw.sqlite": 9 },
        bytes: { "state/openclaw.sqlite": 100 },
        lastWriteAt: { "state/openclaw.sqlite": 1 },
      }),
    },
    creds: { flush: rec("creds", { ok: true }), restart: () => calls.push("creds-restart") },
    sync: rec("sync", undefined),
    alert: (c) => calls.push(`alert:${c}`),
    log: () => {},
    setPhase: (p) => calls.push(`phase:${p}`),
  };
  return w;
}

const flow = ["sleep-check", "sleep-prepare", "sleep-stop-gateway", "sleep-flush"];

test("sleep phases in order, idempotent per opId, busy for another op", async () => {
  const w = world();
  const S = createSleepOps(w.deps);
  const c = await S.handle("sleep-check", "op1");
  assert.deepEqual([c.ok, c.blockers, c.nextWakeAtMs], [true, [], 123]);
  assert.equal((await S.handle("sleep-flush", "op1")).error, "wrong-phase");
  // op1 only checked (holds nothing): a new op id replaces it; op1 is then gone.
  assert.equal((await S.handle("sleep-check", "op2")).ok, true);
  assert.equal((await S.handle("sleep-prepare", "op2")).ok, true);
  assert.equal((await S.handle("sleep-check", "op1")).error, "busy"); // op2 holds the lease now
  assert.equal((await S.handle("sleep-cancel", "op2")).ok, true);
  for (const op of flow) assert.equal((await S.handle(op, "op1")).ok, true, op);
  const n = w.calls.length;
  const again = await S.handle("sleep-flush", "op1");
  assert.equal(w.calls.length, n);
  assert.deepEqual(again.txidPerDb, { "state/openclaw.sqlite": 9 });
  assert.equal(again.nextWakeAtMs, 456);
  assert.deepEqual(S.state().state, "done");
  assert.ok(w.calls.includes("phase:asleep-ready"));
  // a flushed op holds: a new op id is busy until resume-after-sleep of op1
  assert.equal((await S.handle("sleep-check", "op2")).error, "busy");
  assert.equal((await S.handle("resume-after-sleep", "op1")).ok, true);
  assert.equal((await S.handle("sleep-check", "op2")).ok, true);
});

test("check blockers: channels, rows, seeding, config hot reload", async () => {
  assert.deepEqual(
    channelBlockers([
      { channel: "telegram", lifecycle: "recovering", restartPending: false, transport: "webhook" },
      { channel: "discord", lifecycle: "ready", restartPending: false, transport: "socket" },
      { channel: "x", transport: "webhook" },
      { channel: "y", running: false },
    ]).map((b) => b.kind),
    ["channel-unsettled", "channel-socket", "channel-unknown"],
  );
  assert.equal(channelBlockers(null)[0].kind, "channels-unknown");
  assert.deepEqual(
    rowBlockers({ cronRunning: 1, eventJobs: [{ id: "j" }] }).map((b) => b.kind),
    ["cron-running", "event-job"],
  );
  const w = world({ seeding: true, configAt: Date.now() - 3000 });
  const S = createSleepOps(w.deps);
  const c = await S.handle("sleep-check", "op1");
  assert.deepEqual(
    c.blockers.map((b) => b.kind),
    ["seeding", "config-recent"],
  );
  assert.equal((await S.handle("sleep-prepare", "op1")).error, "wrong-phase");
  assert.equal(S.state().state, "aborted");
});

test("prepare busy aborts; cancel resumes the lease", async () => {
  const w = world({ prepare: { status: "busy", retryAfterMs: 5000 } });
  const S = createSleepOps(w.deps);
  await S.handle("sleep-check", "a");
  assert.deepEqual(await S.handle("sleep-prepare", "a"), { ok: true, status: "busy", retryAfterMs: 5000 });
  const w2 = world();
  const S2 = createSleepOps(w2.deps);
  await S2.handle("sleep-check", "b");
  await S2.handle("sleep-prepare", "b");
  assert.equal((await S2.handle("sleep-cancel", "b")).ok, true);
  assert.ok(w2.calls.includes("resume"));
  assert.equal((await S2.handle("sleep-stop-gateway", "b")).error, "wrong-phase");
});

test("unclean gateway exit -> sleep-unclean-exit; resume-after-sleep restarts on the same gen", async () => {
  const w = world({ gwClean: false });
  const S = createSleepOps(w.deps);
  await S.handle("sleep-check", "a");
  await S.handle("sleep-prepare", "a");
  const r = await S.handle("sleep-stop-gateway", "a");
  assert.deepEqual([r.ok, r.error], [false, "sleep-unclean-exit"]);
  assert.ok(w.calls.includes("alert:sleep-unclean-exit"));
  const z = await S.handle("resume-after-sleep", "a");
  assert.equal(z.ok, true);
  assert.ok(w.calls.includes("gw-start"));
  assert.ok(!w.calls.includes("ls-start"), "litestream was never stopped");
});

test("flush fails on lag or unclean Litestream exit (F1.6): no marker data, resume restarts Litestream", async () => {
  for (const o of [{ lag: false }, { lsClean: false }]) {
    const w = world(o);
    const S = createSleepOps(w.deps);
    for (const op of flow.slice(0, 3)) await S.handle(op, "a");
    const f = await S.handle("sleep-flush", "a");
    assert.deepEqual([f.ok, f.error], [false, "sleep-flush-failed"]);
    assert.equal(f.txidPerDb, undefined);
    assert.ok(w.calls.includes("alert:sleep-flush-failed"));
    const z = await S.handle("resume-after-sleep", "a");
    assert.equal(z.ok, true, JSON.stringify(z));
    assert.equal(w.calls.includes("ls-start"), o.lsClean === false);
  }
});

test("draining refuses every sleep op", async () => {
  const w = world();
  const S = createSleepOps(w.deps);
  w.draining = true;
  for (const op of [...flow, "resume-after-sleep"]) assert.equal((await S.handle(op, "a")).error, "draining");
});

test("drainPlan by phase", () => {
  assert.deepEqual(drainPlan("restore", {}, { gatewayRunning: false }), { prestart: true });
  assert.equal(drainPlan("running", {}).skipGateway, false);
  assert.equal(drainPlan("running", {}, { fenced: true, gatewayRunning: false }).skipGateway, true);
  assert.equal(drainPlan("quiescing", { open: true, phase: "prepare" }).skipGateway, false);
  assert.equal(drainPlan("quiescing", { open: true, phase: "flush", gwStopped: true }).awaitInflight, true);
  assert.deepEqual(drainPlan("asleep-ready", { flushed: true }), {
    prestart: false,
    skipGateway: true,
    awaitInflight: false,
    skipLitestream: true,
    skipCreds: true,
  });
});

function drainDeps(w, extra = {}) {
  const events = [];
  return {
    events,
    deps: {
      phase: () => extra.phase || "running",
      event: async (k, x) => events.push([k, x]),
      setPhase: () => {},
      reap: async () => ({ ok: true }),
      gateway: w.deps.gateway,
      fenced: () => false,
      sleepInterrupt: extra.si ? () => extra.si : undefined,
      replica: w.deps.replica,
      creds: w.deps.creds,
      sync: async () => {},
      finalSnapshot: async (u) => {
        events.push(["final", u]);
        return { ok: true, snapshotId: "s" };
      },
      abortPrestart: () => events.push(["abort"]),
      log: () => {},
    },
  };
}

test("drain running: sigterm first, gateway, Litestream final, creds, drained, final snapshot", async () => {
  const w = world();
  const { deps, events } = drainDeps(w);
  const r = await drain(deps);
  assert.deepEqual([r.code, r.reason, r.unclean], [0, "sigterm", []]);
  assert.equal(events[0][0], "sigterm");
  assert.deepEqual(
    events.slice(1).map((e) => e[0]),
    ["drained", "final"],
  );
  assert.deepEqual(
    w.calls.filter((c) => !c.startsWith("phase")),
    ["gw-stop", "ls-lag", "ls-final", "creds"],
  );
  assert.ok(!w.calls.includes("prepare"), "no suspend.prepare on SIGTERM (amend §2 row 2)");
});

test("drain unclean: gateway exit != 0 and Litestream lag -> drained {unclean} (F1.7, T7e row 8)", async () => {
  const w = world({ gwClean: false, lag: false });
  const { deps, events } = drainDeps(w);
  const r = await drain(deps);
  assert.deepEqual(r.unclean, ["gateway", "litestream"]);
  assert.deepEqual(events.find((e) => e[0] === "drained")[1], { unclean: ["gateway", "litestream"] });
  assert.deepEqual(events.find((e) => e[0] === "final")[1], ["gateway", "litestream"]);
});

test("drain prestart: abort, reap, exit 0 sigterm:<phase>, no final snapshot", async () => {
  const w = world();
  w.gwRunning = false;
  w.lsRunning = false;
  const { deps, events } = drainDeps(w, { phase: "restore" });
  const r = await drain(deps);
  assert.deepEqual([r.code, r.reason], [0, "sigterm:restore"]);
  assert.ok(!events.some((e) => e[0] === "final"));
});

test("SIGTERM mid stop-gateway: the sleep call answers draining, drain finishes the stop and flushes", async () => {
  const w = world();
  let release;
  w.stopGate = new Promise((r) => {
    release = r;
  });
  const S = createSleepOps(w.deps);
  await S.handle("sleep-check", "a");
  await S.handle("sleep-prepare", "a");
  const p = S.handle("sleep-stop-gateway", "a");
  await new Promise((r) => setImmediate(r));
  w.draining = true;
  const si = S.interruptBySigterm();
  assert.deepEqual([si.open, si.phase], [true, "stop-gateway"]);
  const { deps, events } = drainDeps(w, { phase: "quiescing", si });
  const dp = drain(deps);
  release();
  assert.equal((await p).error, "draining");
  const r = await dp;
  assert.deepEqual(r.unclean, []);
  assert.equal(w.calls.filter((c) => c === "gw-stop").length, 1);
  assert.ok(w.calls.includes("ls-final"));
  assert.equal(S.state().state, "interrupted:sigterm");
  assert.ok(events.some((e) => e[0] === "final"));
});

test("SIGTERM after flush: drain does the final snapshot only", async () => {
  const w = world();
  const S = createSleepOps(w.deps);
  for (const op of flow) await S.handle(op, "a");
  const si = S.interruptBySigterm();
  const { deps, events } = drainDeps(w, { phase: "asleep-ready", si });
  const before = w.calls.length;
  const r = await drain(deps);
  assert.deepEqual(
    w.calls.slice(before).filter((c) => !c.startsWith("phase")),
    [],
  );
  assert.deepEqual(r.unclean, []);
  assert.ok(events.some((e) => e[0] === "final"));
});

test("H25a: SIGTERM after flush + resume-after-sleep stops the gateway and Litestream again", async () => {
  const w = world();
  const S = createSleepOps(w.deps);
  for (const op of flow) assert.equal((await S.handle(op, "r1")).ok, true, op);
  assert.equal((await S.handle("resume-after-sleep", "r1")).ok, true);
  assert.ok(w.calls.includes("ls-start"));
  const si = S.interruptBySigterm();
  assert.deepEqual([si.flushed, si.gwStopped, si.lsStopped], [false, false, false]);
  const p = drainPlan("running", si, { gatewayRunning: true });
  assert.deepEqual([p.skipGateway, p.skipLitestream, p.skipCreds], [false, false, false]);
});

test("marker guard: flush ok only through MarkerGuard, resume voids it", async () => {
  const { MarkerGuard } = await import("../lib/marker.mjs");
  const w = world();
  const m = new MarkerGuard();
  w.deps.marker = m;
  w.deps.replica.waitLagZero = async () => ({
    ok: true,
    lag: [{ db: "state/openclaw.sqlite", lag: 0, localTxid: 9, fault: null }],
  });
  const S = createSleepOps(w.deps);
  for (const op of flow.slice(0, 3)) await S.handle(op, "m1");
  const f = await S.handle("sleep-flush", "m1");
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.ok(m.confirmed("m1"));
  await S.handle("resume-after-sleep", "m1");
  assert.equal(m.confirmed("m1"), false);
});
