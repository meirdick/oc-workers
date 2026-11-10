// The Setup tab's controls (ingress/panel-actions.ts: sandbox, alerts, model) run against the real Control DO ops:
// the settings value, the restart, the config version and the alert sink the Worker sends to.
import { describe, expect, it } from "vitest";
import { alert, flushAlerts } from "../../src/ctl/alerts";
import { configPropose } from "../../src/ctl/config";
import { DEFAULT_SETTINGS, mergeSettings } from "../../src/ctl/ctx";
import type { PanelDeps } from "../../src/ctl/panel";
import { withSandboxChoice } from "../../src/ctl/settings";
import { type PanelOps, panelAct } from "../../src/ingress/panel-actions";
import { type World, world } from "./world";

/** ownerPanel() over the world with fake probes (as in panel.test.ts). */
async function ownerPanelFor(w: World) {
  const deps: Omit<PanelDeps, "status" | "view" | "caps" | "sink"> = {
    hop: async () => ({ status: 200, ms: 1 }),
    sandbox: async () => ({ state: "asleep" }),
    env: { access: null, gateway: "default" },
  };
  w.core.panelProbes = deps;
  return w.core.ownerPanel({ origin: "https://oc.example" });
}

const MODELS = ["@cf/a/one", "@cf/b/two"].map((id) => ({ id }));
const DOC = {
  agents: { defaults: { model: { primary: "cfgw/@cf/a/one", fallbacks: ["cfgw/@cf/b/two"] }, x: 1 } },
  models: { providers: { cfgw: { baseUrl: "http://15.0.0.3/ai/v1", models: MODELS } } },
};

async function setup(state: "running" | "asleep" = "running") {
  const w = world({
    settings: { publicOrigin: "https://oc.example" },
    alertUrl: "https://ntfy.example/secret-topic",
  });
  w.install();
  w.rt(1).state = state as never;
  w.ctx.settings = () =>
    withSandboxChoice(
      mergeSettings(DEFAULT_SETTINGS, { publicOrigin: "https://oc.example" }),
      w.db.meta("sandboxChoice"),
    );
  await configPropose(w.ctx, { source: "owner", doc: DOC });
  const calls: string[] = [];
  const ops: PanelOps = (r) => {
    calls.push(`${r.method} ${r.action}${r.sub?.length ? `/${r.sub.join("/")}` : ""}`);
    return w.api.ops({ ...r, sub: r.sub ?? [], query: {}, body: r.body ?? {}, role: "owner" });
  };
  const act = (a: Parameters<typeof panelAct>[0], f: Record<string, string>) =>
    panelAct(a, new URLSearchParams(f), ops);
  return { w, calls, act };
}

describe("Sandbox control", () => {
  it("saves the choice, restarts a running install, and the next boot plan carries it", async () => {
    const { w, calls, act } = await setup();
    expect(w.ctx.settings().sandbox).toBeUndefined();
    expect(await act("sandbox", { value: "all" })).toEqual({ code: "saved-restart" });
    expect(calls).toEqual(["POST sandbox-set", "GET status", "POST restart"]);
    expect(w.ctx.settings().sandbox).toBe("all");
    const p = await ownerPanelFor(w);
    expect(p.toggles?.sandbox).toEqual({ value: "all", pending: true });
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    expect(r.plan).toMatchObject({ sandbox: true, sandboxMode: "all" });
    expect((await ownerPanelFor(w)).toggles?.sandbox.pending).toBe(false);
    // Back to off: the plan drops the flag.
    await act("sandbox", { value: "off" });
    const r2 = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s2", reason: "user" });
    expect(r2.plan.sandbox).toBe(false);
  });

  it("an asleep install is not woken: the change applies at the next start", async () => {
    const { calls, act } = await setup("asleep");
    expect(await act("sandbox", { value: "on" })).toEqual({ code: "saved-next" });
    expect(calls).not.toContain("POST restart");
  });

  it("a bad value is refused before any op", async () => {
    const { calls, act } = await setup();
    expect((await act("sandbox", { value: "yes" })).code).toBe("panel-failed");
    expect(calls).toEqual([]);
  });
});

describe("Alerts control", () => {
  const sendOne = async (w: Awaited<ReturnType<typeof setup>>["w"], cls: string) => {
    w.sent.length = 0;
    alert(w.ctx, cls, "high", "x");
    await flushAlerts(w.ctx);
    return w.sent.map((s) => s.url);
  };

  it("Save stores the URL in the Control DO and the sender uses it before the Worker secret", async () => {
    const { w, act } = await setup();
    expect(await sendOne(w, "c1")).toEqual(["https://ntfy.example/secret-topic"]);
    expect(await act("alerts", { do: "save", url: "https://hooks.example/new" })).toEqual({
      code: "alerts-saved",
    });
    expect(w.db.meta("alertSinkUrl")).toBe("https://hooks.example/new");
    expect(await sendOne(w, "c2")).toEqual(["https://hooks.example/new"]);
    // The secret's token does not travel to a saved URL.
    expect(w.sent[0]?.headers.authorization).toBeUndefined();
    expect((await ownerPanelFor(w)).toggles?.alerts.source).toBe("console");
  });

  it("Off silences alerts even with the secret set; clearing the row brings the secret back", async () => {
    const { w, act } = await setup();
    expect(await act("alerts", { do: "off" })).toEqual({ code: "alerts-off" });
    expect(await sendOne(w, "c1")).toEqual([]);
    expect((await ownerPanelFor(w)).toggles?.alerts.source).toBe("off");
    w.db.delMeta("alertSinkUrl");
    expect(await sendOne(w, "c2")).toEqual(["https://ntfy.example/secret-topic"]);
  });

  it("Test sends the same test alert as ochost alerts test, with a code, to the saved URL", async () => {
    const { w, calls, act } = await setup();
    await act("alerts", { do: "save", url: "https://hooks.example/new" });
    w.sent.length = 0;
    const r = await act("alerts", { do: "test" });
    expect(r.code).toBe("alerts-test");
    expect(r.why).toMatch(/^[a-z0-9]{6}$/);
    expect(calls.at(-1)).toBe("POST alerts/test");
    expect(w.sent.map((s) => s.url)).toEqual(["https://hooks.example/new"]);
    expect(w.sent[0]?.body).toContain(`ochost alerts ack ${r.why}`);
  });

  it("Test with no channel and a refusing sink report a problem", async () => {
    const a = await setup();
    await a.act("alerts", { do: "off" });
    expect((await a.act("alerts", { do: "test" })).code).toBe("panel-failed");
    const b = await setup();
    b.w.setSink(500);
    expect((await b.act("alerts", { do: "test" })).code).toBe("panel-failed");
  });

  it("refuses a URL that is not https, before any op", async () => {
    const { calls, act } = await setup();
    for (const url of ["http://x.example/t", "ntfy.sh/topic", "", "javascript:alert(1)"])
      expect((await act("alerts", { do: "save", url })).code).toBe("panel-failed");
    expect(calls).toEqual([]);
  });
});

describe("Model control", () => {
  it("posts a config version with the main model changed (source owner) and restarts", async () => {
    const { w, calls, act } = await setup();
    expect(await act("model", { id: "@cf/b/two" })).toEqual({ code: "saved-restart" });
    const rows = w.db.all<{ ver: number; source: string; doc: string }>(
      "SELECT ver, source, doc FROM config ORDER BY ver",
    );
    expect(rows.map((r) => [r.ver, r.source])).toEqual([
      [1, "owner"],
      [2, "owner"],
    ]);
    const next = JSON.parse(rows[1]?.doc as string);
    expect(next.agents.defaults.model).toEqual({ primary: "cfgw/@cf/b/two", fallbacks: ["cfgw/@cf/b/two"] });
    expect(next.agents.defaults.x).toBe(1);
    expect(next.models).toEqual(DOC.models);
    expect(calls.at(-1)).toBe("POST restart");
    expect((await ownerPanelFor(w)).toggles?.model).toEqual({
      primary: "@cf/b/two",
      choices: ["@cf/a/one", "@cf/b/two"],
    });
  });

  it("the main model again: no new version, no restart; an id outside the list is refused", async () => {
    const { w, calls, act } = await setup();
    expect(await act("model", { id: "@cf/a/one" })).toEqual({ code: "model-same" });
    expect(calls).not.toContain("POST restart");
    expect((await act("model", { id: "@cf/evil/zzz" })).code).toBe("panel-failed");
    expect(w.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM config")?.n).toBe(1);
  });
});
