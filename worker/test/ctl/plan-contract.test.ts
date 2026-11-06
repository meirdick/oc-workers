// M3 e2e: every boot plan the Control DO makes must pass ocsup's BootPlan contract (image/ocrt/lib/contract.mjs),
// else ocsup exits restore-blocked:infra ("bad plan") at once.
import { describe, expect, it } from "vitest";
import { BootPlan, validate } from "../../../image/ocrt/lib/contract.mjs";
import { bootComplete, world } from "./world";

const check = (plan: unknown) => validate(BootPlan, plan) as string[];

describe("boot plan vs ocsup contract", () => {
  it("fresh plan with publicOrigin passes", async () => {
    const w = world({ settings: { publicOrigin: "https://x.example.dev" } });
    w.install();
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    expect(check({ ...r.plan, gen: r.gen })).toEqual([]);
  });
  it("gen plan after a completed boot passes", async () => {
    const w = world({ settings: { publicOrigin: "https://x.example.dev" } });
    w.install();
    await bootComplete(w);
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s2", reason: "wake:inbox" });
    expect(check({ ...r.plan, gen: r.gen })).toEqual([]);
  });
});

describe("sandbox flag (docs/12)", () => {
  it("settings sandbox on → plan.sandbox true, ocsup renders backend ochost; default off renders none", async () => {
    const { render } = await import("../../../image/ocrt/lib/config.mjs");
    for (const [settings, want] of [
      [{ sandbox: "on" }, true],
      [{ sandbox: "all" }, true],
      [{}, false],
      [{ sandbox: "off" }, false],
    ] as const) {
      const w = world({ settings: { publicOrigin: "https://x.example.dev", ...settings } });
      w.install();
      const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
      expect(check({ ...r.plan, gen: r.gen })).toEqual([]);
      expect(r.plan.sandbox).toBe(want);
      const doc = render({ ver: 1, doc: {} }, r.plan).doc as {
        agents?: { defaults?: { sandbox?: unknown } };
      };
      expect(doc.agents?.defaults?.sandbox !== undefined).toBe(want);
      if (want)
        expect((doc.agents?.defaults?.sandbox as { mode?: string }).mode).toBe(
          (settings as { sandbox?: string }).sandbox === "all" ? "all" : "non-main",
        );
      // The gate reads the same setting through the ledger.
      expect(w.api.ledger.sbxAdmit(1, r.gen).on).toBe(want);
    }
  });
});

describe("Control UI origin (Access custom domain)", () => {
  const DEV = "https://oc-demo.acct.workers.dev";
  const CUSTOM = "https://oc.example.com";
  const boot = async (settings: Record<string, unknown>) => {
    const w = world({ settings });
    w.install();
    const r = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    expect(check({ ...r.plan, gen: r.gen })).toEqual([]);
    return r.plan;
  };
  const managed = (plan: { managed: { path: string; value?: unknown }[] }, path: string) =>
    plan.managed.find((m) => m.path === path)?.value;

  it("Access off: publicOrigin = workers.dev, allowedOrigins = [workers.dev]", async () => {
    const plan = await boot({ publicOrigin: `${DEV}/` });
    expect(plan.publicOrigin).toBe(DEV);
    expect(plan.allowedOrigins).toEqual([DEV]);
    expect(managed(plan, "gateway.publicOrigin")).toBe(DEV);
    expect(managed(plan, "gateway.controlUi.allowedOrigins")).toEqual([DEV]);
  });
  it("Access on: publicOrigin = the custom domain, allowedOrigins = both; ocsup renders them", async () => {
    const plan = await boot({ publicOrigin: DEV, uiOrigin: CUSTOM });
    expect(plan.publicOrigin).toBe(CUSTOM);
    expect(plan.allowedOrigins).toEqual([CUSTOM, DEV]);
    const { render } = await import("../../../image/ocrt/lib/config.mjs");
    // An owner doc with the old workers.dev origin: the managed keys win.
    const doc = render({ ver: 1, doc: { gateway: { publicOrigin: DEV } } }, plan).doc as {
      gateway: { publicOrigin: string; controlUi: { allowedOrigins: string[] } };
    };
    expect(doc.gateway.publicOrigin).toBe(CUSTOM);
    expect(doc.gateway.controlUi.allowedOrigins).toEqual([CUSTOM, DEV]);
  });
  it("no origin known: no origin keys", async () => {
    const plan = await boot({});
    expect(plan.publicOrigin).toBeUndefined();
    expect(managed(plan, "gateway.publicOrigin")).toBeUndefined();
  });
});

describe("ownerView (status page at /)", () => {
  it("state and since, last activity, next wake, snapshot count, the two newest alerts; no detail text", async () => {
    const { alert } = await import("../../src/ctl/alerts");
    const w = world({ settings: { publicOrigin: "https://x.example.dev" } });
    w.install();
    const t = w.clock.t;
    const rt = w.rt(1) as unknown as { status: () => Promise<unknown> };
    rt.status = async () => ({
      state: "asleep",
      stateAt: t - 3_600_000,
      lastActivityAt: t - 4_000_000,
      hb: { lastActivityAt: t - 3_700_000 },
      sleep: { wakeAt: t + 7_200_000 },
    });
    alert(w.ctx, "a-old", "info", "old detail");
    w.advance(1000);
    alert(w.ctx, "b-mid", "warn", "secret-ish detail");
    w.advance(1000);
    alert(w.ctx, "c-new", "high", "detail");
    const v = await w.core.ownerView();
    expect(v).toMatchObject({
      inst: "t1",
      state: "asleep",
      stateAt: t - 3_600_000,
      lastActivityAt: t - 3_700_000,
      nextWakeAt: t + 7_200_000,
      snapshots: 0,
    });
    expect(v.alerts.map((a) => a.class)).toEqual(["c-new", "b-mid"]);
    expect(JSON.stringify(v)).not.toContain("detail");
  });
});
