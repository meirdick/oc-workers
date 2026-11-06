import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canon,
  getPath,
  overlayEntries,
  proposalFrom,
  render,
  SANDBOX_PLUGIN_DIR,
  sensitiveChanges,
  setPath,
} from "../lib/config.mjs";
import { createConfigWatch } from "../lib/configwatch.mjs";
import { afterDoctor, isDoctorRequired, runDoctorStaged } from "../lib/doctor.mjs";

const V = {
  ver: 7,
  schemaSha: "s1",
  doc: {
    gateway: { bind: "loopback", auth: { mode: "token", token: "x", password: "pw" } },
    channels: { telegram: { enabled: true, botToken: { source: "env", id: "OC_TG" } } },
    plugins: { entries: { foo: { enabled: true } } },
    cron: { enabled: true },
  },
};
const PROD = { mode: "prod", channelsOff: false, overlay: [], trustedProxies: ["10.1.0.0/32"] };

describe("config render", () => {
  it("paths", () => {
    const o = {};
    setPath(o, "a.b.c", 1);
    assert.equal(getPath(o, "a.b.c"), 1);
    setPath(o, "a.b.c", undefined);
    assert.deepEqual(o, { a: { b: {} } });
    assert.equal(canon({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it("managed keys set, password and token removed, overlay empty → proposals on", () => {
    const r = render(V, PROD);
    assert.equal(r.doc.gateway.bind, "lan");
    assert.equal(r.doc.gateway.port, 18789);
    assert.equal(r.doc.gateway.auth.mode, "trusted-proxy");
    assert.equal(r.doc.gateway.auth.password, undefined);
    assert.equal(r.doc.gateway.auth.token, undefined);
    assert.ok(!r.text.includes("pw"), "auth.password is not in openclaw.json");
    assert.deepEqual(r.doc.gateway.trustedProxies, ["10.1.0.0/32"]);
    // trusted-proxy needs trustedProxy.userHeader or the gateway does not start (M3 e2e)
    assert.equal(r.doc.gateway.auth.trustedProxy.userHeader, "x-ochost-user");
    assert.deepEqual(r.doc.gateway.auth.trustedProxy.allowUsers, ["owner"]);
    const m = render(V, {
      ...PROD,
      managed: [{ path: "gateway.auth.trustedProxy.userHeader", value: "x-u" }],
    });
    assert.equal(m.doc.gateway.auth.trustedProxy.userHeader, "x-u", "plan.managed wins");
    assert.equal(r.proposals, true);
    assert.equal(V.doc.gateway.bind, "loopback", "input not changed");
  });

  it("channels off (canary, dark): every channel and cron off, proposals off", () => {
    const r = render(V, { ...PROD, mode: "canary" });
    assert.equal(r.doc.channels.telegram.enabled, false);
    assert.equal(r.doc.cron.enabled, false);
    assert.deepEqual(
      r.overlay.map((o) => o.path),
      ["channels.telegram.enabled", "cron.enabled"],
    );
    assert.equal(r.overlay[0].userValue, true);
    assert.equal(r.proposals, false);
  });

  it("plugin-missing overlay disables the entry and turns proposals off", () => {
    const r = render(V, PROD, { missingPlugins: ["foo", "bar"] });
    assert.equal(r.doc.plugins.entries.foo.enabled, false);
    assert.equal(r.doc.plugins.entries.bar.enabled, false);
    assert.equal(r.overlay[1].userValue, undefined);
    assert.equal(r.proposals, false);
    assert.deepEqual(overlayEntries(V.doc, { overlay: [{ path: "cron.skipMissedJobs", value: true }] }), [
      { path: "cron.skipMissedJobs", value: true, why: "plan" },
    ]);
  });

  it("proposal: managed keys go back to the version value; equal file → null", () => {
    const r = render(V, PROD);
    assert.equal(proposalFrom(r.doc, r, V), null);
    const changed = structuredClone(r.doc);
    changed.agents = { defaults: { model: "x" } };
    const p = proposalFrom(changed, r, V);
    assert.equal(p.doc.gateway.bind, "loopback");
    assert.equal(p.doc.gateway.auth.password, "pw");
    assert.equal(p.baseVer, 7);
    assert.deepEqual(p.sensitive, []);
    changed.channels.telegram.enabled = false;
    assert.deepEqual(proposalFrom(changed, r, V).sensitive, ["channels"]);
    assert.deepEqual(sensitiveChanges({}, { tools: { a: 1 } }), ["tools"]);
  });

  it("watcher: proposes on prod, suppresses with an overlay, tracks reload lines", async () => {
    let file = null;
    const sent = [];
    const alerts = [];
    const mk = (rendered) =>
      createConfigWatch(
        {
          readFile: async () => file,
          propose: async (b) => {
            sent.push(b);
            return { status: 200 };
          },
          alert: (c) => alerts.push(c),
          now: () => 1000,
        },
        rendered,
        V,
      );
    const r = render(V, PROD);
    const w = mk(r);
    file = { text: r.text };
    assert.equal((await w.check()).action, "none");
    const d = structuredClone(r.doc);
    d.channels.telegram.enabled = false;
    file = { text: JSON.stringify(d) };
    assert.equal((await w.check()).action, "proposed");
    assert.equal((await w.check()).why, "same-as-last");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sensitive, undefined);
    assert.deepEqual(alerts, ["config-sensitive"]);
    file = { text: "{ torn" };
    assert.equal((await w.check()).why, "torn");
    const w2 = mk(render(V, PROD, { missingPlugins: ["foo"] }));
    file = { text: JSON.stringify(d) };
    assert.equal((await w2.check()).action, "suppressed");
    assert.equal(sent.length, 1);
    w2.onGatewayLine("[gateway] config change detected; evaluating reload");
    assert.equal(w2.recentApply(), true);
  });
});

describe("doctor", () => {
  it("doctor-required on exit 78 or the marker", () => {
    assert.equal(isDoctorRequired(78), true);
    assert.equal(isDoctorRequired(1, "error gateway.maintenance_required: run doctor"), true);
    assert.equal(isDoctorRequired(1, "boom"), false);
  });

  it("no Doctor unless the plan says so", async () => {
    assert.deepEqual(await runDoctorStaged(V, { ...PROD, runDoctor: false }, {}), { ran: false });
  });

  it("staged copy without the overlay; result rendered with the overlay after", async () => {
    let staged = null;
    let env = null;
    const deps = {
      writeStaged: async (t) => {
        staged = t;
        return "/var/lib/ocrt/stage-u/doctor/openclaw.json";
      },
      readStaged: async () => {
        const d = JSON.parse(staged);
        d.agents = { migrated: true };
        return JSON.stringify(d);
      },
      runCli: async (_args, o) => {
        env = o.env;
        return { code: 0, out: "ok", ms: 5 };
      },
    };
    const plan = { ...PROD, runDoctor: true, channelsOff: true, mode: "canary" };
    const r = await runDoctorStaged(V, plan, deps);
    assert.equal(env.OPENCLAW_CONFIG_PATH, "/var/lib/ocrt/stage-u/doctor/openclaw.json");
    assert.equal(JSON.parse(staged).channels.telegram.enabled, true, "Doctor saw no overlay");
    assert.equal(r.changed, true);
    const after = render(afterDoctor(V, r), plan);
    assert.equal(after.doc.agents.migrated, true);
    assert.equal(after.doc.channels.telegram.enabled, false, "overlay applied after Doctor");
    assert.equal(after.proposals, false);
  });

  it("Doctor gets TMPDIR = deps.tmpDir (demo cutover 2026-11-05)", async () => {
    let env = null;
    await runDoctorStaged(
      V,
      { ...PROD, runDoctor: true },
      {
        writeStaged: async () => "/s/openclaw.json",
        readStaged: async () => null,
        runCli: async (_a, o) => {
          env = o.env;
          return { code: 1, out: "", ms: 1 };
        },
        tmpDir: "/var/lib/ocrt/stage-u/tmp",
      },
    );
    assert.equal(env.TMPDIR, "/var/lib/ocrt/stage-u/tmp");
    assert.equal(env.OPENCLAW_CONFIG_PATH, "/s/openclaw.json");
  });

  it("Doctor exit ≠ 0 → doctor-failed", async () => {
    const r = await runDoctorStaged(
      V,
      { ...PROD, runDoctor: true },
      {
        writeStaged: async () => "/x",
        readStaged: async () => null,
        runCli: async () => ({ code: 1, out: "x", ms: 1 }),
      },
    );
    assert.equal(r.reason, "doctor-failed");
  });
});

describe("web fetch address (docs/11 §7)", () => {
  const P = "plugins.entries.firecrawl.config.webFetch.baseUrl";
  const docWith = (u) => ({
    doc: { plugins: { entries: { firecrawl: { config: { webFetch: { baseUrl: u } } } } } },
  });

  it("a version that points firecrawl at 15.0.0.3 renders the loopback forwarder; the version stays as written", () => {
    const v = docWith("http://15.0.0.3");
    const r = render(v, { mode: "prod" });
    assert.equal(getPath(r.doc, P), "http://127.0.0.1:18791");
    assert.equal(getPath(v.doc, P), "http://15.0.0.3");
    assert.equal(getPath(render(docWith("http://15.0.0.3/"), {}).doc, P), "http://127.0.0.1:18791");
  });

  it("another baseUrl (a private firecrawl host) and a missing key stay as they are", () => {
    assert.equal(getPath(render(docWith("http://10.1.2.3:3002"), {}).doc, P), "http://10.1.2.3:3002");
    assert.equal(getPath(render({ doc: {} }, {}).doc, P), undefined);
  });

  it("a file the gateway wrote with the loopback URL gives no proposal (managed key goes back to the version)", () => {
    const v = { ...docWith("http://15.0.0.3"), ver: 1, schemaSha: "s" };
    const r = render(v, { mode: "prod" });
    assert.equal(proposalFrom(r.doc, r, v), null);
  });
});

describe("ochost.renderVersion (cli/src/render-config.ts)", () => {
  it("never reaches openclaw.json (OpenClaw rejects the root key); a file without it gives no proposal", () => {
    const v = { ver: 1, schemaSha: "s", doc: { ochost: { renderVersion: 1 }, cron: { enabled: true } } };
    const r = render(v, { mode: "prod" });
    assert.equal(getPath(r.doc, "ochost"), undefined);
    assert.equal(getPath(v.doc, "ochost.renderVersion"), 1);
    assert.equal(proposalFrom(r.doc, r, v), null);
  });
});

describe("bundled web plugins (docs/13 regression)", () => {
  const L = "plugins.load.paths";
  const withPaths = (paths) => ({ ver: 1, doc: { plugins: { load: { paths } } } });
  const OLD = ["/opt/oc-plugins/firecrawl", "/opt/oc-plugins/cf-web-search"];

  it("old load paths for firecrawl and cf-web-search are dropped; the owner's own paths stay", () => {
    const r = render(withPaths([...OLD, "/srv/mine"]), { mode: "prod" });
    assert.deepEqual(getPath(r.doc, L), ["/srv/mine"]);
  });

  it("with the sandbox plugin on, the old dirs go and both others stay", () => {
    const r = render(withPaths([...OLD, "/srv/mine"]), { mode: "prod", sandbox: true });
    assert.deepEqual(getPath(r.doc, L), ["/srv/mine", "/opt/ocrt/plugins/ochost-sandbox"]);
  });

  it("no old dir, no change", () => {
    assert.deepEqual(getPath(render(withPaths(["/srv/mine"]), { mode: "prod" }).doc, L), ["/srv/mine"]);
  });
});

describe("sandbox keys (docs/12)", () => {
  it("plan.sandbox renders backend ochost at the gate and keeps the user's plugin paths", () => {
    const v = { ver: 1, doc: { plugins: { load: { paths: ["/u/p1", SANDBOX_PLUGIN_DIR] } } } };
    const r = render(v, { mode: "prod", sandbox: true });
    assert.equal(getPath(r.doc, "agents.defaults.sandbox.mode"), "all");
    assert.equal(getPath(r.doc, "agents.defaults.sandbox.backend"), "ochost");
    assert.equal(getPath(r.doc, "agents.defaults.sandbox.workspaceAccess"), "rw");
    assert.deepEqual(getPath(r.doc, "plugins.load.paths"), ["/u/p1", SANDBOX_PLUGIN_DIR]);
    assert.deepEqual(getPath(r.doc, "plugins.entries.ochost-sandbox.config"), {
      gateUrl: "http://15.0.0.4",
      workspaceRoot: "/workspace",
    });
    // Managed keys never become a proposal: a file equal to the render proposes nothing.
    assert.equal(proposalFrom(r.doc, r, v), null);
  });

  it("sandbox off (absent or false) renders no sandbox key; a user's own sandbox block is kept", () => {
    const v = { ver: 1, doc: { agents: { defaults: { sandbox: { mode: "non-main", backend: "docker" } } } } };
    for (const plan of [{ mode: "prod" }, { mode: "prod", sandbox: false }]) {
      const r = render(v, plan);
      assert.deepEqual(getPath(r.doc, "agents.defaults.sandbox"), { mode: "non-main", backend: "docker" });
      assert.equal(getPath(r.doc, "plugins.entries.ochost-sandbox"), undefined);
    }
  });

  it("sandbox off removes the managed keys a doctor copied into the owner version", () => {
    const on = render(
      { ver: 1, doc: { plugins: { load: { paths: ["/opt/x"] } } } },
      { mode: "prod", sandbox: true },
    );
    const saved = { ver: 2, doc: on.doc };
    assert.equal(getPath(saved.doc, "agents.defaults.sandbox.backend"), "ochost");
    const r = render(saved, { mode: "prod", sandbox: false });
    assert.equal(getPath(r.doc, "agents.defaults.sandbox"), undefined);
    assert.equal(getPath(r.doc, "plugins.entries.ochost-sandbox"), undefined);
    assert.deepEqual(getPath(r.doc, "plugins.load.paths"), ["/opt/x"]);
  });
});

describe("Control UI origin (plan.publicOrigin)", () => {
  const DEV = "https://oc-demo.acct.workers.dev";
  const CUSTOM = "https://oc.example.com";
  it("writes gateway.publicOrigin and controlUi.allowedOrigins (both entries) over the owner's values", () => {
    const v = { ver: 1, doc: { gateway: { publicOrigin: DEV, controlUi: { allowedOrigins: ["*"] } } } };
    const r = render(v, { mode: "prod", publicOrigin: `${CUSTOM}/`, allowedOrigins: [CUSTOM, DEV] });
    assert.equal(getPath(r.doc, "gateway.publicOrigin"), CUSTOM);
    assert.deepEqual(getPath(r.doc, "gateway.controlUi.allowedOrigins"), [CUSTOM, DEV]);
  });
  it("publicOrigin alone → allowedOrigins holds it; bad values are dropped; no origin → no keys", () => {
    let r = render(
      { ver: 1, doc: {} },
      { mode: "prod", publicOrigin: DEV, allowedOrigins: ["javascript:x"] },
    );
    assert.deepEqual(getPath(r.doc, "gateway.controlUi.allowedOrigins"), [DEV]);
    r = render({ ver: 1, doc: {} }, { mode: "prod", publicOrigin: "not a url" });
    assert.equal(getPath(r.doc, "gateway.publicOrigin"), undefined);
    r = render({ ver: 1, doc: {} }, { mode: "prod" });
    assert.equal(getPath(r.doc, "gateway.controlUi"), undefined);
  });
  it("a UI edit does not propose the origin keys (managed)", () => {
    const v = { ver: 1, doc: { cron: { enabled: true } } };
    const r = render(v, { mode: "prod", publicOrigin: CUSTOM, allowedOrigins: [CUSTOM, DEV] });
    assert.equal(proposalFrom(r.doc, r, v), null);
  });
});
