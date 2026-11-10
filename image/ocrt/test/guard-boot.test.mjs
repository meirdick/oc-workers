import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configStep, doctorStep, netfilterStep, startConfigWatch } from "../lib/guard-boot.mjs";
import { tmpdir } from "./fixtures.mjs";

const V = {
  ver: 3,
  schemaSha: "s",
  doc: { gateway: { auth: { password: "pw" } }, channels: { telegram: { enabled: true } } },
};

function ctx(o = {}) {
  const files = new Map();
  const calls = [];
  const c = {
    plan: {
      mode: "prod",
      configVer: 3,
      pluginsVer: o.pluginsVer ?? null,
      runDoctor: !!o.runDoctor,
      overlay: [],
      ...o.plan,
    },
    state: "/home/node/.openclaw",
    stageDir: tmpdir("stage"),
    freshStage: (d) => d,
    log: () => {},
    alert: (cls) => calls.push(["alert", cls]),
    cliEnv: () => ({ HOME: "/home/node" }),
    gate: {
      call: async (m, route, body) => {
        calls.push([m, route]);
        if (route.startsWith("/v1/config/3")) return V;
        if (route === "/v1/plugins/manifest") return { ver: 1, plugins: [{ id: "foo", spec: "foo@1" }] };
        if (route === "/v1/config/proposal") return { ok: true, body };
        throw new Error("404");
      },
    },
    runOcio: async (_name, args, opt) => {
      if (args[0] === "write") files.set(args[1], opt.stdin);
      if (args[0] === "read")
        return { json: files.has(args[1]) ? { ok: true, text: files.get(args[1]) } : { ok: false } };
      return { json: { ok: true } };
    },
    runCli: async (args, opt) => {
      calls.push(["cli", args.join(" "), opt?.env?.OPENCLAW_CONFIG_PATH || null]);
      if (args[1] === "plugins" && args[2] === "list")
        return { code: 0, out: JSON.stringify({ plugins: [] }) };
      if (args[1] === "plugins") return { code: 1, out: "" };
      if (args[1] === "doctor") {
        const p = opt.env.OPENCLAW_CONFIG_PATH;
        const d = JSON.parse(files.get(p));
        d.agents = { fixed: true };
        files.set(p, JSON.stringify(d));
        return { code: 0, out: "", ms: 1 };
      }
      return { code: 0, out: "" };
    },
  };
  return { c, files, calls };
}

describe("guard boot steps", () => {
  it("netfilterStep reports failure to the caller (fail closed, F-SEC-2) and passes the nets", () => {
    let got = null;
    const r = netfilterStep({
      nets: ["15.0.0.0/30", "15.7.0.1"],
      apply: (o) => {
        got = o;
        return { ok: false, code: 1, err: "x" };
      },
    });
    assert.equal(r.ok, false);
    assert.deepEqual(got, { net: ["15.0.0.0/30", "15.7.0.1"] });
  });

  it("configStep: plugin missing → overlay, file written without auth.password", async () => {
    const { c, files, calls } = ctx({ pluginsVer: 1 });
    const r = await configStep(c);
    assert.deepEqual(r.rec.missingPlugins, ["foo"]);
    const doc = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
    assert.equal(doc.plugins.entries.foo.enabled, false);
    assert.equal(doc.gateway.auth.password, undefined);
    assert.ok(calls.some((x) => x[1] === "/app/openclaw.mjs plugins install foo@1 --pin"));
    assert.ok(calls.some((x) => x[1] === "plugin-missing"));
  });

  it("doctorStep: staged path, overlay kept, no proposal with an overlay", async () => {
    const { c, files, calls } = ctx({ runDoctor: true, plan: { channelsOff: true } });
    await configStep(c);
    const r = await doctorStep(c);
    assert.equal(r.rec.changed, true);
    const doc = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
    assert.equal(doc.agents.fixed, true);
    assert.equal(doc.channels.telegram.enabled, false);
    assert.ok(calls.some((x) => x[0] === "cli" && x[2]?.endsWith("/openclaw.json")));
    assert.ok(!calls.some((x) => x[1] === "/v1/config/proposal"));
  });

  it("doctorStep on a lit prod boot sends a doctor proposal; watcher sees no change after", async () => {
    const { c, calls } = ctx({ runDoctor: true });
    await configStep(c);
    await doctorStep(c);
    assert.ok(calls.some((x) => x[1] === "/v1/config/proposal"));
    const w = startConfigWatch(c, { everyMs: 1e9 });
    const r = await w.check();
    w.stop();
    assert.equal(r.action, "none", "Doctor's doc is the watcher baseline: no second proposal");
  });
});

describe("Doctor failure output (M6 polish live)", () => {
  it("doctorStep on exit 1 returns the last 2 KB of Doctor output, frames removed", async () => {
    const { c } = ctx({ runDoctor: true });
    await configStep(c);
    const run = c.runCli;
    c.runCli = async (args, opt) => {
      if (args[1] !== "doctor") return run(args, opt);
      const pad = "│  - Disabled skill  │\n".repeat(400);
      return {
        code: 1,
        out: `${pad}│  Error: config invalid: channels.telegram.webhookUrl  │\n└  Doctor failed.\n`,
        ms: 1,
      };
    };
    const r = await doctorStep(c);
    assert.equal(r.exit, "doctor-failed");
    assert.equal(r.detail, "doctor exit 1");
    assert.ok(Buffer.byteLength(r.out) <= 2048, `out ${Buffer.byteLength(r.out)} bytes`);
    assert.match(r.out, /Error: config invalid: channels\.telegram\.webhookUrl/);
    assert.match(r.out, /Doctor failed\.$/m);
    assert.doesNotMatch(r.out, /[│└]/);
  });

  it("doctorTail keeps short output whole and cuts long output to the tail", async () => {
    const { doctorTail } = await import("../lib/doctor.mjs");
    assert.equal(doctorTail("a\nb"), "a\nb");
    const t = doctorTail(`${"x".repeat(5000)}END`);
    assert.equal(t.length, 2048);
    assert.ok(t.endsWith("END"));
    assert.equal(doctorTail(""), "");
  });
});
