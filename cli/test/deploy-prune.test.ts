// ochost deploy, prune step: registry tags of old snapshot chains go when the Control DO has a plan (M8 live fix 5).
import { describe, expect, it } from "vitest";
import { pruneStep } from "../src/deploy.ts";
import type { Ctx } from "../src/ui.ts";
import { makeUi } from "../src/ui.ts";

function ctxOf(plan: unknown, status = 200) {
  let err = "";
  const calls: string[] = [];
  const ctx = {
    ui: makeUi(
      { json: false, nonInteractive: true },
      { err: { write: (s: string) => (err += s) }, out: { write: () => 0 } },
    ),
    args: { positionals: [], flags: {} },
    dir: "/nonexistent",
    fetch: async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(plan), { status });
    },
    env: {},
    now: () => 0,
    sleep: async () => {},
    interactive: false,
  } as unknown as Ctx;
  return { ctx, err: () => err, calls };
}

describe("deploy prune step", () => {
  it("no plan, or not ready: one GET, nothing else", async () => {
    for (const plan of [{ ready: false, why: "waiting", ids: [] }, { ready: true, ids: [] }, {}]) {
      const { ctx, err, calls } = await ctxOf(plan);
      await pruneStep(ctx, "https://x.example", "tok");
      expect(calls).toEqual(["https://x.example/ops/snapshots/prune"]);
      expect(err()).toBe("");
    }
  });

  it("a plan with ids runs ochost snapshot prune --yes; a failure there warns and never throws", async () => {
    const { ctx, err } = ctxOf({ ready: true, ids: ["s1", "s2"] });
    await pruneStep(ctx, "https://x.example", "tok");
    expect(err()).toMatch(/prune: 2 snapshot\(s\) of old chains/);
    expect(err()).toMatch(/run ochost snapshot prune/); // no install in /nonexistent: the ops command fails, deploy goes on
  });

  it("a Worker that answers 500 is skipped with a warning", async () => {
    const { ctx, err } = ctxOf({ error: "x" }, 500);
    await pruneStep(ctx, "https://x.example", "tok");
    expect(err()).toBe("");
  });
});
