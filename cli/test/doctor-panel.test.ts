// `ochost doctor --json` equals the owner panel JSON. The fake /ops server answers GET /ops/doctor with the real
// ownerPanel() of a Control DO test world (worker/src/ctl/panel.ts), so the CLI and the page read one document.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPropose } from "../../worker/src/ctl/config.ts";
import { world } from "../../worker/test/ctl/world.ts";
import { FakeOps, installDir, run } from "./ops-fake.ts";

let f: FakeOps;
beforeEach(async () => {
  f = await new FakeOps().start();
});
afterEach(() => f.stop());

describe("doctor and the owner panel", () => {
  it("--json is the ownerPanel JSON; the text table lists the same checks", async () => {
    const w = world({ settings: { publicOrigin: f.url } });
    w.install();
    w.rt(1).state = "running";
    await configPropose(w.ctx, {
      source: "owner",
      doc: {
        agents: { defaults: { model: { primary: "cfgw/@cf/m/n" } } },
        models: { providers: { cfgw: { baseUrl: "http://15.0.0.3/ai/v1", models: [] } } },
      },
    });
    w.core.panelProbes = {
      hop: async () => ({ status: 200, ms: 321 }),
      sandbox: async () => null,
      env: { access: null, gateway: "default" },
    };
    const panel = JSON.parse(JSON.stringify(await w.core.ownerPanel({ origin: f.url, fresh: true })));
    f.routes.push((q) => (q.path === "/ops/doctor?fresh=1" ? { status: 200, body: panel } : undefined));
    const dir = installDir(f.url);
    const j = await run("doctor", ["--dir", dir, "--json"]);
    expect(JSON.parse(j.out)).toEqual(panel);
    expect(panel.checks.map((c: { name: string }) => c.name)).toContain("model hop");
    const t = await run("doctor", ["--dir", dir]);
    for (const c of panel.checks) expect(t.out).toContain(c.detail);
    expect(t.out).toMatch(/^model hop\s+PASS\s+200 in 321 ms \(@cf\/m\/n\) through the gate/m);
  });
});
