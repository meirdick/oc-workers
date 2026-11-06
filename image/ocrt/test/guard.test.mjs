import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRuntimeGuard } from "../lib/guard.mjs";
import { put, tmpdir } from "./fixtures.mjs";

const G = 1024 ** 3;

describe("runtime guard façade", () => {
  function setup(o = {}) {
    const root = tmpdir("guard");
    put(root, "ocrt/gw/memory.current", String(o.gwCurrent ?? 1 * G));
    put(root, "ocrt/gw/memory.max", String(5 * G));
    put(root, "ocrt/gw/memory.events", "high 0\noom_kill 0\n");
    put(root, "ocrt/cpu.stat", "usage_usec 3000000\n");
    const ev = [];
    const g = createRuntimeGuard({
      dirs: { root: `${root}/ocrt`, gw: `${root}/ocrt/gw`, sys: `${root}/ocrt/sys` },
      plan: { runtime: { maintenanceHour: 4, tz: "UTC", maxUptimeHours: 12, proactive: "2h@08-22" } },
      now: () => o.now ?? Date.parse("2026-11-01T01:00:00Z"),
      log: () => {},
      alert: (c, s, d) => ev.push(["alert", c, s, d]),
      gatewayPid: () => 4242,
      gatewayUptimeMs: () => o.uptime ?? 3600_000,
      restartGateway: async (x) => ev.push(["restart", x.reason, x.forced]),
      isIdle: async () => ({ idle: true }),
      runCli: async (a) => {
        ev.push(["cli", a.join(" ")]);
        return { code: 0, out: JSON.stringify({ enabled: true, nextWakeAtMs: 0 }) };
      },
      readProactive: async () => ({ receipts: [], jobs: [] }),
      pluginManifest: { plugins: [] },
    });
    return { g, ev };
  }

  it("heartbeat fields: cpuS from ocrt/cpu.stat, gw memory", () => {
    const { g } = setup();
    const h = g.heartbeat();
    assert.equal(h.cpuS, 3);
    assert.equal(h.mem.gw.current, G);
    assert.equal(h.restartPending, null);
  });

  it("maxUptimeHours from the plan sets the limit; idle → restart", async () => {
    const { g, ev } = setup({ uptime: 12 * 3600_000 });
    const r = await g.maint.tick();
    assert.equal(r.reason, "uptime>=12h");
    assert.deepEqual(ev.at(-1), ["restart", "uptime>=12h", false]);
  });

  it("onStartupz runs cron status and the Proactive read; a stall requests a restart", async () => {
    const { g, ev } = setup();
    await g.onStartupz();
    await new Promise((r) => setTimeout(r, 10));
    g.stop();
    assert.ok(ev.some((e) => e[0] === "cli" && e[1] === "/app/openclaw.mjs cron status --json"));
    assert.ok(ev.some((e) => e[1] === "cron-stalled"));
    assert.equal(g.maint.state.pending.reason, "cron-stalled");
  });
});

describe("heap source", async () => {
  const { heapUsedFromSystemInfo, makeHeapReader } = await import("../lib/guard.mjs");
  it("reads processMemory.heapUsedBytes (2026.10.9 system.info shape)", async () => {
    const out = `banner\n${JSON.stringify({ pid: 7, processMemory: { rssBytes: 1217937408, heapUsedBytes: 337884688 } })}`;
    assert.equal(heapUsedFromSystemInfo(out), 337884688);
    assert.equal(heapUsedFromSystemInfo("{}"), null);
    const h = await makeHeapReader(async () => ({ code: 0, out }), 2240 * 1024 ** 2)();
    assert.deepEqual(h, { used: 337884688, limit: 2240 * 1024 ** 2 });
  });
});

describe("openclawCli adapter", async () => {
  const { openclawCli } = await import("../lib/guard.mjs");
  it("prefixes /app/openclaw.mjs and merges env", async () => {
    const seen = [];
    const run = openclawCli(
      async (a, o) => seen.push([a, o.env]),
      () => ({ HOME: "/home/node", PATH: "/bin" }),
    );
    await run(["cron", "status", "--json"]);
    await run(["/app/openclaw.mjs", "doctor"], { env: { OPENCLAW_CONFIG_PATH: "/s" } });
    await run(["-e", "1"]);
    assert.deepEqual(seen[0], [["/app/openclaw.mjs", "cron", "status", "--json"], undefined]);
    assert.deepEqual(seen[1], [
      ["/app/openclaw.mjs", "doctor"],
      { HOME: "/home/node", PATH: "/bin", OPENCLAW_CONFIG_PATH: "/s" },
    ]);
    assert.deepEqual(seen[2][0], ["-e", "1"]);
  });
});
