import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMaint, cronBusy, localHour, MAINT, uptimeLimitMs, windowKey } from "../lib/maint.mjs";

const H = 3600_000;
const T = Date.parse("2026-11-01T00:00:00Z");

describe("maint", () => {
  it("uptime limit 16 h, -25% per heap-abort in 7 d, floor 6 h", () => {
    assert.equal(uptimeLimitMs(T), 16 * H);
    assert.equal(uptimeLimitMs(T, [T - H]), 12 * H);
    assert.equal(uptimeLimitMs(T, [T - H, T - 2 * H]), 9 * H);
    assert.equal(uptimeLimitMs(T, [T - H, T - 2 * H, T - 3 * H, T - 4 * H]), 6 * H);
    assert.equal(uptimeLimitMs(T, [T - 8 * 24 * H]), 16 * H);
  });

  it("windows at H and H+12 local", () => {
    assert.equal(localHour(T, "Asia/Jerusalem").hour, 2);
    assert.equal(windowKey(T + 4 * H, 4, "UTC"), "2026-11-01T04");
    assert.equal(windowKey(T + 16 * H, 4, "UTC"), "2026-11-01T16");
    assert.equal(windowKey(T + 5 * H, 4, "UTC"), null);
    assert.equal(windowKey(T + 2 * H, 4, "Asia/Jerusalem"), "2026-11-01T04");
  });

  it("cron busy: running < 6 h blocks, stale running is ignored", () => {
    assert.equal(cronBusy([{ status: "running", started_at_ms: T - H }], T), true);
    assert.equal(cronBusy([{ status: "running", started_at_ms: T - 7 * H }], T), false);
    assert.equal(cronBusy([{ status: "ok", started_at_ms: T }], T), false);
  });

  function harness(o = {}) {
    const clock = { t: o.t ?? T + 1 * H };
    const ev = [];
    let idle = o.idle ?? { idle: true };
    const m = createMaint({
      now: () => clock.t,
      gatewayUptimeMs: () => o.uptime ?? 9 * H,
      heapAborts: () => [],
      isIdle: () => idle,
      restart: (x) => ev.push(["restart", x]),
      windowRun: (k) => ev.push(["window", k]),
      maintenanceHour: 4,
      tz: "UTC",
      log: (e, f) => ev.push([e, f?.key ?? f?.reason]),
    });
    return { m, clock, ev, setIdle: (v) => (idle = v) };
  }

  it("busy window retried every 5 min for 60 min, then missed", async () => {
    const h = harness({ t: T + 4 * H, idle: { idle: false, why: "cron" } });
    let r = await h.m.tick();
    assert.equal(r.action, "busy");
    h.clock.t += 60_000;
    assert.equal(await h.m.tick(), null); // < 5 min since the last try
    for (let i = 0; i < 11; i++) {
      h.clock.t += MAINT.retryMs;
      r = await h.m.tick();
    }
    assert.equal(r.action, "busy");
    h.clock.t += MAINT.retryMs;
    r = await h.m.tick();
    assert.equal(r.action, "missed");
    h.clock.t += MAINT.retryMs;
    assert.equal(await h.m.tick(), null, "same window does not fire again");
  });

  it("window runs when idle; skipped when gateway uptime < 8 h", async () => {
    const h = harness({ t: T + 4 * H });
    assert.equal((await h.m.tick()).action, "window");
    assert.deepEqual(h.ev.at(-1), ["window", "2026-11-01T04"]);
    const h2 = harness({ t: T + 4 * H, uptime: 2 * H });
    assert.equal(await h2.m.tick(), null);
    assert.ok(h2.ev.some((e) => e[0] === "maint-window-skip"));
  });

  it("uptime limit: idle restart, forced after 2 h when busy", async () => {
    const h = harness({ uptime: 16 * H, idle: { idle: false, why: "prepare-busy" } });
    assert.equal((await h.m.tick()).action, "busy");
    h.clock.t += 2 * H;
    const r = await h.m.tick();
    assert.deepEqual(r, { action: "restart", reason: "uptime>=16h", forced: true });
  });

  it("an idle request (memwatch tier 1, cron-stalled) merges with a pending one", async () => {
    const h = harness({ idle: { idle: false, why: "x" } });
    assert.equal(h.m.request("memwatch:heap>80%"), true);
    assert.equal(h.m.request("cron-stalled"), false);
    h.setIdle({ idle: true });
    const r = await h.m.tick();
    assert.equal(r.reason, "memwatch:heap>80%");
  });
});
