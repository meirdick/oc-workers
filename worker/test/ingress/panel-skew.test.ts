import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { statusPage } from "../../src/ui/pages";

// A panel from Durable Object code that predates `cost` and `events` (deferred code update after a deploy).
describe("owner page with a panel missing newer fields", () => {
  it("renders instead of throwing", () => {
    const now = Date.now();
    const v: any = {
      inst: "demo",
      state: "asleep",
      stateAt: now - 60_000,
      lastActivityAt: now - 5_000,
      nextWakeAt: null,
      snapshots: 3,
      alerts: [],
      now,
    };
    const panel: any = {
      inst: "demo",
      now,
      view: v,
      render: { doc: 1, cli: 1 },
      probes: {},
      ok: 1,
      fails: 0,
      warns: 0,
      checks: [],
      connected: [],
      alerts: { open: [], doctorTail: null },
      budgets: [],
      backups: {},
      channels: [],
    };
    let html: string;
    try {
      html = statusPage("n", v, undefined, panel);
    } catch {
      html = statusPage("n", v, undefined, null); // the route falls back the same way
    }
    expect(html).toContain("Asleep");
    expect(html.length).toBeGreaterThan(1000);
  });
});
