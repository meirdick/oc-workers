import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCronCheck, judge, parseStatus } from "../lib/cronstall.mjs";
import { applyRules, gateNets, ruleset } from "../lib/netfilter.mjs";
import { checkAtBoot, createPluginRetry, diff, parseList } from "../lib/plugins.mjs";
import { applyProactive, cronFor, DEFAULT_PROACTIVE_PROMPT, editArgs, pickJobs } from "../lib/proactive.mjs";

describe("plugins", () => {
  const out = `banner\n${JSON.stringify({
    plugins: [
      { id: "a2a", origin: "bundled" },
      { id: "x", origin: "global" },
      { id: "foo", origin: "global" },
    ],
  })}`;
  it("parseList and diff", () => {
    const l = parseList(out);
    assert.equal(l.length, 3);
    const d = diff(
      {
        plugins: [
          { id: "foo", spec: "foo@1" },
          { id: "bar", spec: "bar@2" },
        ],
      },
      l,
    );
    assert.deepEqual(
      d.missing.map((m) => m.id),
      ["bar"],
    );
    assert.deepEqual(d.extra, ["x"]);
    assert.equal(parseList("garbage"), null);
  });
  it("checkAtBoot: failed install → missing + alert; retry installs later", async () => {
    const alerts = [];
    let installOk = false;
    const runCli = async (a) => (a[1] === "list" ? { code: 0, out } : { code: installOk ? 0 : 1, out: "" });
    const m = { plugins: [{ id: "bar", spec: "bar@2" }] };
    const r = await checkAtBoot(m, { runCli, alert: (c) => alerts.push(c) });
    assert.deepEqual(r.missing, ["bar"]);
    assert.deepEqual(alerts, ["plugins-changed", "plugin-missing"]);
    let t = 0;
    const done = [];
    const rt = createPluginRetry(m, r.missing, { runCli, now: () => t, onInstalled: (id) => done.push(id) });
    t = 15 * 60_000;
    assert.deepEqual(await rt.tick(), ["bar"]);
    installOk = true;
    t += 60_000;
    assert.deepEqual(await rt.tick(), ["bar"], "not before 15 min");
    t += 15 * 60_000;
    assert.deepEqual(await rt.tick(), []);
    assert.deepEqual(done, ["bar"]);
  });
  it("list failure gives no overlay", async () => {
    const r = await checkAtBoot({ plugins: [{ id: "a" }] }, { runCli: async () => ({ code: 1, out: "" }) });
    assert.equal(r.listFailed, true);
    assert.deepEqual(r.missing, []);
  });
});

describe("cron-stalled", () => {
  const now = 10_000_000;
  it("judge", () => {
    assert.equal(judge({ enabled: true, nextWakeAtMs: now - 11 * 60_000 }, now).stalled, true);
    assert.equal(judge({ enabled: true, nextWakeAtMs: now - 9 * 60_000 }, now).stalled, false);
    assert.equal(judge({ enabled: false, nextWakeAtMs: 0 }, now).stalled, false);
    assert.equal(judge(null, now).why, "unknown");
    assert.deepEqual(parseStatus('x\n{"enabled":true}'), { enabled: true });
  });
  it("one restart per boot, alert each time", async () => {
    const ev = [];
    const c = createCronCheck({
      runCli: async () => ({ code: 0, out: JSON.stringify({ enabled: true, nextWakeAtMs: now - 3600_000 }) }),
      alert: (x) => ev.push(x),
      requestRestart: (x) => ev.push(`restart:${x}`),
      now: () => now,
    });
    await c.check();
    await c.check();
    assert.deepEqual(ev, ["cron-stalled", "restart:cron-stalled", "cron-stalled"]);
  });
});

describe("proactive", () => {
  it("cronFor", () => {
    assert.equal(cronFor("2h@08-22"), "0 8-22/2 * * *");
    assert.equal(cronFor(), "0 8-22/2 * * *");
    assert.equal(cronFor("off"), "off");
    assert.throws(() => cronFor("30m"));
    assert.throws(() => cronFor("2h@22-08"));
  });
  const job = (
    id,
    agent,
    message,
    name = `Proactive check (${agent})`,
    schedule = { kind: "every", everyMs: 1800000 },
  ) => ({
    job_id: id,
    name,
    agent_id: agent,
    enabled: 1,
    job_json: JSON.stringify({ id, agentId: agent, schedule, payload: { kind: "agentTurn", message } }),
  });
  it("pickJobs: receipt first, prompt fallback, ambiguity unmatched", () => {
    const jobs = [
      job("j1", "main", "custom"),
      job("j2", "ops", DEFAULT_PROACTIVE_PROMPT),
      job("j3", "x", DEFAULT_PROACTIVE_PROMPT),
      job("j4", "x", DEFAULT_PROACTIVE_PROMPT),
    ];
    const receipts = [
      {
        state_key: "automation-default:/s/cron:main",
        value_json: JSON.stringify({ jobId: "j1", phase: "complete" }),
      },
    ];
    const p = pickJobs(receipts, jobs);
    assert.equal(p.agents.main.by, "receipt");
    assert.equal(p.agents.ops.jobId, "j2");
    assert.deepEqual(p.unmatched, [{ agent: "x", why: "2 prompt matches" }]);
    assert.deepEqual(pickJobs([], []), { agents: {}, unmatched: [], named: false });
  });
  it("editArgs: only when different", () => {
    assert.deepEqual(editArgs("j", { schedule: { kind: "every" } }, "2h@08-22", "Asia/Jerusalem"), [
      "cron",
      "edit",
      "j",
      "--cron",
      "0 8-22/2 * * *",
      "--tz",
      "Asia/Jerusalem",
    ]);
    assert.equal(
      editArgs("j", { schedule: { kind: "cron", expr: "0 8-22/2 * * *", tz: "UTC" } }, "2h@08-22", "UTC"),
      null,
    );
    assert.deepEqual(editArgs("j", { enabled: true }, "off"), ["cron", "edit", "j", "--disable"]);
    assert.equal(editArgs("j", {}, "openclaw"), null);
  });
  it("applyProactive edits the matched job", async () => {
    const calls = [];
    const r = await applyProactive("2h@08-22", "UTC", {
      read: async () => ({ receipts: [], jobs: [job("j2", "main", DEFAULT_PROACTIVE_PROMPT)] }),
      runCli: async (a) => {
        calls.push(a);
        return { code: 0 };
      },
    });
    assert.deepEqual(r.edited, ["j2"]);
    assert.equal(calls[0][2], "j2");
  });
});

describe("netfilter", () => {
  it("ruleset lets any uid reach CapGate 15.0.0.3 and SandboxGate 15.0.0.4 only, before the drop", () => {
    const s = ruleset();
    const drop = s.indexOf("skuid != 0 counter drop");
    for (const ip of ["15.0.0.3", "15.0.0.4"]) {
      const acc = s.indexOf(`ip daddr ${ip} tcp dport 80 counter accept`);
      assert.ok(acc > 0 && acc < drop, ip);
    }
    assert.equal(s.match(/accept/g).length - 1, 2); // the policy word and these two rules
    assert.doesNotMatch(s, /15\.0\.0\.[012] .*accept/);
  });

  it("ruleset drops uid != 0 to 15.0.0.0/30 (no reject: CF microvm kernel has none)", () => {
    const s = ruleset();
    assert.match(s, /ip daddr 15\.0\.0\.0\/30 meta skuid != 0 counter drop/);
    assert.doesNotMatch(s, /reject/);
    assert.match(s, /flush table inet ocrt/);
  });
  it("gateNets adds gate hosts outside 15.0.0.0/30 (harness per-network runs)", () => {
    assert.deepEqual(gateNets(["http://15.0.0.1", "http://15.0.0.2"]), ["15.0.0.0/30"]);
    assert.deepEqual(gateNets(["http://15.7.0.1", "http://15.7.0.2:80", "http://gate.local"]), [
      "15.0.0.0/30",
      "15.7.0.1",
      "15.7.0.2",
    ]);
    assert.match(
      ruleset(gateNets(["http://15.7.0.1"])),
      /ip daddr \{ 15\.0\.0\.0\/30, 15\.7\.0\.1 \} meta skuid != 0 counter drop/,
    );
  });
  it("applyRules runs nft by absolute path (F-SEC-1)", () => {
    let bin = null;
    applyRules({
      spawnSync: (b) => {
        bin = b;
        return { status: 0 };
      },
    });
    assert.equal(bin, "/usr/sbin/nft");
  });
  it("applyRules reports a missing binary", () => {
    const r = applyRules({ spawnSync: () => ({ status: null, error: { code: "ENOENT" } }) });
    assert.equal(r.ok, false);
    assert.equal(r.err, "ENOENT");
  });
});
