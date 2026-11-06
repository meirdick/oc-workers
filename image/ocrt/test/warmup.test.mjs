import assert from "node:assert/strict";
import { test } from "node:test";
import { createWarmup, WARMUP, warmupArgs, warmupMode } from "../lib/warmup.mjs";

test("warmupMode: off by default; OCRT_WARMUP=1 is agent; an explicit mode wins; unknown is off", () => {
  assert.equal(warmupMode({}), "off");
  assert.equal(warmupMode({ OCRT_WARMUP: "1" }), "agent");
  assert.equal(warmupMode({ OCRT_WARMUP: "1", OCRT_WARMUP_MODE: "infer" }), "infer");
  assert.equal(warmupMode({ OCRT_WARMUP_MODE: "agent" }), "agent");
  assert.equal(warmupMode({ OCRT_WARMUP_MODE: "bogus" }), "off");
});

test("warmupArgs: infer goes through the gateway; agent uses its own session; agent CLI timeout < kill timeout", () => {
  const i = warmupArgs("infer");
  assert.deepEqual(i.slice(0, 5), ["/app/openclaw.mjs", "infer", "model", "run", "--gateway"]);
  const a = warmupArgs("agent");
  assert.ok(a.includes("--session-id") && a[a.indexOf("--session-id") + 1] === "ochost-warmup");
  assert.ok(!i.includes("--timeout"), "infer model run rejects --timeout");
  assert.ok(Number(a[a.indexOf("--timeout") + 1]) * 1000 < WARMUP.timeoutMs);
});

function deps(over = {}) {
  const logs = [];
  const calls = [];
  return {
    logs,
    calls,
    d: {
      mode: "infer",
      canRun: () => true,
      log: (ev, f) => logs.push([ev, f]),
      runCli: async (args, o) => {
        calls.push([args, o]);
        return { code: 0, out: "{}", ms: 1234 };
      },
      ...over,
    },
  };
}

test("run: one CLI call, logs ok and ms; concurrent run() shares it", async () => {
  const { d, logs, calls } = deps();
  const w = createWarmup(d);
  const [a, b] = await Promise.all([w.run(), w.run()]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(logs, [["warmup", { ok: true, mode: "infer", ms: 1234, code: 0 }]]);
  await w.run();
  assert.equal(calls.length, 2, "a later gateway start warms again");
});

test("run: off, blocked and failing calls never throw; failure keeps a short tail", async () => {
  const off = deps({ mode: "off" });
  assert.deepEqual(await createWarmup(off.d).run(), { ran: false, why: "off" });
  assert.equal(off.calls.length, 0);
  const blocked = deps({ canRun: () => false });
  assert.deepEqual(await createWarmup(blocked.d).run(), { ran: false, why: "blocked" });
  const bad = deps({ runCli: async () => ({ code: 1, out: `x${"e".repeat(500)}`, ms: 9 }) });
  const r = await createWarmup(bad.d).run();
  assert.equal(r.ok, false);
  assert.equal(bad.logs[0][1].tail.length, 200);
});
