import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SoakSummary } from "../../worker/src/ctl/soak/types.ts";
import { fmtMeasure, overallVerdict, renderReport } from "../src/soak.ts";
import { FakeOps, installDir, run, T0 } from "./ops-fake.ts";

let f: FakeOps;
let dir: string;
beforeEach(async () => {
  f = await new FakeOps().start();
  dir = installDir(f.url);
});
afterEach(() => f.stop());

const summary = (over: Partial<SoakSummary> = {}): SoakSummary => ({
  plan: "kill",
  state: "done",
  startedAt: T0,
  updatedAt: T0,
  endedAt: T0,
  total: 4,
  done: 4,
  failed: 0,
  pass: true,
  items: [{ item: "wake-time", bound: "≤ 3 s", unit: "ms", n: 4, p50: 1300, max: 2100, over: 0, pass: true }],
  failedSteps: [],
  skipped: [],
  ...over,
});
const failing = summary({
  plan: "loss",
  failed: 1,
  pass: false,
  items: [{ item: "sqlite-loss", bound: "0 rows", unit: "rows", n: 2, p50: 0, max: 3, over: 1, pass: false }],
  failedSteps: [{ id: "s2", checks: ["no-loss", "replayed"] }],
});

describe("soak start", () => {
  it("posts plan and params, prints queued", async () => {
    f.routes.push((r) =>
      r.method === "POST" && r.path === "/ops/soak-plan"
        ? { status: 202, body: { ok: true, queued: ["kill", "loss"] } }
        : undefined,
    );
    const r = await run("soak", ["start", "all", "--params", '{"n":2}', "--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("queued: kill, loss");
    expect(r.out).toContain("ochost soak status");
    expect(f.calls("POST", "/ops/soak-plan")[0]?.body).toEqual({ plan: "all", params: { n: 2 } });
  });
  it("400, 404, 409 are one-line failures", async () => {
    let status = 400;
    f.routes.push((r) => (r.method === "POST" ? { status, body: { error: "x" } } : undefined));
    expect((await run("soak", ["start", "nope", "--dir", dir])).err).toMatch(/Failed: unknown plan nope/);
    status = 409;
    const c = await run("soak", ["start", "kill", "--dir", dir]);
    expect(c.code).toBe(1);
    expect(c.err).toMatch(/Failed: plan kill is active.*fix: ochost soak stop <plan>/);
    status = 404;
    expect((await run("soak", ["start", "kill", "--dir", dir])).err).toMatch(
      /Failed: not a test install \(OC_TEST=1\) — fix: deploy a test install: ochost init --fake-telegram/,
    );
  });
  it("bad --params is a usage error", async () => {
    const r = await run("soak", ["start", "kill", "--params", "[1]", "--dir", dir]);
    expect(r.code).toBe(2);
  });
});

describe("soak status and stop", () => {
  it("renders the table and the catalog", async () => {
    f.routes.push((r) =>
      r.method === "GET" && r.path === "/ops/soak-plan"
        ? {
            status: 200,
            body: {
              now: T0,
              plans: [
                {
                  plan: "kill",
                  ord: 0,
                  state: "running",
                  startedAt: T0,
                  total: 4,
                  done: 1,
                  failed: 0,
                  current: { id: "k2", type: "kill", phase: "wait" },
                  nextAt: T0 + 30_000,
                },
              ],
              catalog: [
                { name: "kill", steps: 4, about: "a" },
                { name: "loss", steps: 2, about: "b" },
              ],
            },
          }
        : undefined,
    );
    const r = await run("soak", ["status", "--dir", dir]);
    expect(r.out).toMatch(/kill\s+running\s+1\/4\s+0\s+k2 kill wait\s+in 30s/);
    expect(r.out).toContain("not queued: loss");
  });
  it("stop sends DELETE with the plan", async () => {
    f.routes.push((r) =>
      r.method === "DELETE" ? { status: 200, body: { ok: true, stopped: ["kill"] } } : undefined,
    );
    const r = await run("soak", ["stop", "kill", "--dir", dir]);
    expect(r.out).toContain("stopped: kill");
    expect(f.calls("DELETE", "/ops/soak-plan?plan=kill")).toHaveLength(1);
  });
});

describe("soak report", () => {
  it("renders PASS and FAIL rows", () => {
    const md = renderReport(
      [
        { plan: "kill", summary: summary(), steps: [] },
        { plan: "loss", summary: failing, steps: [] },
        { plan: "idle", summary: null, steps: [] },
      ],
      T0,
      "https://x.dev",
    );
    expect(md).toContain("| wake-time | ≤ 3 s | 4 | 1.3 s | 2.1 s | 0 | PASS |");
    expect(md).toContain("| sqlite-loss | 0 rows | 2 | 0 rows | 3 rows | 1 | FAIL |");
    expect(md).toContain("- s2: no-loss, replayed");
    expect(md).toContain("not run");
    expect(md).toContain("Overall: FAIL");
    expect(fmtMeasure(500, "ms")).toBe("500 ms");
    expect(overallVerdict([{ plan: "kill", summary: summary(), steps: [] }])).toBe("PASS");
  });
  it("lists skipped steps as not run", () => {
    const md = renderReport(
      [
        {
          plan: "drill-i",
          summary: summary({ skipped: [{ id: "drill-i", why: "needs M6 cutover" }] }),
          steps: [],
        },
      ],
      T0,
    );
    expect(md).toContain("- not run drill-i: needs M6 cutover");
  });
  it("writes --out; exit 0 with FAILs, 1 with --strict", async () => {
    f.routes.push((r) =>
      r.path.startsWith("/ops/soak-plan/results")
        ? {
            status: 200,
            body: {
              plans: [
                { plan: "kill", summary: summary(), steps: [] },
                { plan: "loss", summary: failing, steps: [] },
              ],
            },
          }
        : undefined,
    );
    const out = join(mkdtempSync(join(tmpdir(), "soak-")), "r.md");
    const r = await run("soak", ["report", "--out", out, "--dir", dir]);
    expect(r.code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toContain("Overall: FAIL");
    expect((await run("soak", ["report", "--out", out, "--strict", "--dir", dir])).code).toBe(1);
    const d = await run("soak", ["report", "--date", "2026-1-1", "--dir", dir]);
    expect(d.code).toBe(2);
  });
});
