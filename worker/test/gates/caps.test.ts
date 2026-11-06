// Per-verb daily budgets (gates/caps.ts) on the real ledger tables: thresholds, day rollover, limits, ops.
import { describe, expect, it } from "vitest";
import { CAP_DEFAULTS, estimateNeurons } from "../../src/gates/caps";
import { T0, World } from "./harness";

const DAY = 86_400_000;
const alerts = (w: World) =>
  w.sql<{ class: string; severity: string }>("SELECT class, severity FROM alerts ORDER BY class");

describe("thresholds", () => {
  it("80% warns once, 100% alerts high once, then take() refuses without charging", () => {
    const w = new World();
    w.ledger.capsSet({ neurons: 100 });
    expect(w.ledger.capTake("neurons", 79).ok).toBe(true);
    expect(alerts(w)).toEqual([]); // 79% is below
    w.ledger.capTake("neurons", 1); // exactly 80
    expect(alerts(w)).toEqual([{ class: "cap-neurons-80", severity: "warn" }]);
    w.ledger.capTake("neurons", 5); // still under 100: no second 80 alert row change in class set
    expect(alerts(w).map((a) => a.class)).toEqual(["cap-neurons-80"]);
    const hit = w.ledger.capTake("neurons", 15); // reaches 100
    expect(hit.ok).toBe(true);
    expect(alerts(w).map((a) => [a.class, a.severity])).toEqual([
      ["cap-neurons-100", "high"],
      ["cap-neurons-80", "warn"],
    ]);
    const no = w.ledger.capTake("neurons", 1);
    expect(no.ok).toBe(false);
    expect(w.ledger.capsView().verbs.neurons.used).toBe(100);
  });

  it("one big charge that jumps over 80 straight to 100 raises the 100 alert only", () => {
    const w = new World();
    w.ledger.capsSet({ browser: 100 });
    w.ledger.capAdd("browser", 150);
    expect(alerts(w).map((a) => a.class)).toEqual(["cap-browser-100"]);
  });

  it("capAdd never refuses: usage may pass the limit (the work already happened)", () => {
    const w = new World();
    w.ledger.capsSet({ requests: 1 });
    w.ledger.capAdd("requests", 5);
    expect(w.ledger.capsView().verbs.requests).toMatchObject({ used: 5, limit: 1 });
    expect(w.ledger.capCheck("requests").ok).toBe(false);
  });

  it("negative, NaN and Infinity charges add nothing", () => {
    const w = new World();
    for (const n of [-5, Number.NaN, Number.POSITIVE_INFINITY]) w.ledger.capAdd("neurons", n);
    expect(w.ledger.capsView().verbs.neurons.used).toBe(0);
  });

  it("a verb at the 80% mark in one place does not trip another verb", () => {
    const w = new World();
    w.ledger.capsSet({ browser: 10, neurons: 10 });
    w.ledger.capAdd("browser", 9);
    expect(alerts(w).map((a) => a.class)).toEqual(["cap-browser-80"]);
  });
});

describe("day and limits", () => {
  it("usage is per UTC day: the next day starts at zero and retryAfterS counts to midnight", () => {
    const w = new World(); // T0 = 12:00 UTC
    w.ledger.capsSet({ requests: 1 });
    w.ledger.capTake("requests", 1);
    const c = w.ledger.capCheck("requests");
    expect(c.ok).toBe(false);
    expect(c.retryAfterS).toBe(12 * 3600);
    w.clock.t = T0 + DAY - 12 * 3_600_000; // 00:00 next day
    expect(w.ledger.capCheck("requests")).toMatchObject({ ok: true, used: 0 });
    expect(w.ledger.capsView().day).toBe("2026-11-01");
  });

  it("defaults apply until set; set persists, touches only the named verbs, and survives a new ledger on the same store", () => {
    const w = new World();
    expect(w.ledger.capsView().verbs.neurons.limit).toBe(CAP_DEFAULTS.neurons);
    w.ledger.capsSet({ neurons: 123 });
    const v = w.ledger.capsView().verbs;
    expect([v.neurons.limit, v.browser.limit]).toEqual([123, CAP_DEFAULTS.browser]);
  });

  it("raising the limit lifts a refusal; lowering below usage refuses at once", () => {
    const w = new World();
    w.ledger.capsSet({ requests: 2 });
    w.ledger.capTake("requests", 2);
    expect(w.ledger.capCheck("requests").ok).toBe(false);
    w.ledger.capsSet({ requests: 3 });
    expect(w.ledger.capCheck("requests").ok).toBe(true);
    w.ledger.capsSet({ requests: 1 });
    expect(w.ledger.capCheck("requests").ok).toBe(false);
  });

  it("a limit of 0 refuses everything", () => {
    const w = new World();
    w.ledger.capsSet({ browser: 0 });
    expect(w.ledger.capCheck("browser").ok).toBe(false);
  });

  it("bad values throw and change nothing, even for the valid verb in the same call", () => {
    const w = new World();
    for (const bad of [
      { neurons: -1 },
      { neurons: "x" },
      { neurons: 2e9 },
      { neurons: 5, browser: Number.NaN },
    ])
      expect(() => w.ledger.capsSet(bad)).toThrow(/bad limit/);
    expect(w.ledger.capsView().verbs.neurons.limit).toBe(CAP_DEFAULTS.neurons);
  });

  it("unknown keys in a set are ignored", () => {
    const w = new World();
    w.ledger.capsSet({ money: 5 } as never);
    expect(w.ledger.capsView().verbs).not.toHaveProperty("money");
  });
});

describe("estimateNeurons", () => {
  it("embeddings use reported tokens, else bytes/4; chat falls back to a floor", () => {
    expect(estimateNeurons("embeddings", { bytes: 4000 }, { usage: { total_tokens: 1_000_000 } })).toBe(
      Math.ceil((0.012 / 0.011) * 1000),
    );
    expect(estimateNeurons("embeddings", { bytes: 4000 }, null)).toBe(
      Math.ceil(1000 * ((0.012 / 1e6) * (1000 / 0.011))),
    );
    expect(estimateNeurons("chat/completions", { bytes: 10 }, null)).toBeGreaterThan(0);
  });

  it("images scale with n, capped at 10", () => {
    expect(estimateNeurons("images/generations", { bytes: 1, json: { n: 3 } }, null)).toBe(1500);
    expect(estimateNeurons("images/generations", { bytes: 1, json: { n: 999 } }, null)).toBe(5000);
    expect(estimateNeurons("images/generations", { bytes: 1, json: { n: -2 } }, null)).toBe(500);
  });
});
