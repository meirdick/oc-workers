// Scope §4 M1 row 6 (part 2) [Z1.14]: a gateway heap ramp past 90% restarts at once (no idle-point wait).
// The gateway heap is not reachable from outside the gateway, so the test feeds memwatch through the
// ocsupctl test fault `heap <usedPct>` (harness-issues.md asks for it). Without it the test is blocked.
export default {
  name: "memwatch-heap-ramp",
  source: "scope §4 M1 'A heap ramp past 90% restarts at once'; plan §4.6",
  rule: "Fault heap 80 -> tier-1 scheduled restart only (no restart within 5 s); heap 92 -> graceful gateway restart starts within 2 s; /startupz again.",
  needs: ["ocsupctl", "heapFault"],
  timeoutMs: 600_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1, env: { OCRT_MEMWATCH_MS: "1000" } });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    const f80 = b.ctl("fault", { args: { line: "heap 80" } });
    if (!f80.ok)
      return t.block(`ocsupctl fault 'heap <pct>' not supported: ${JSON.stringify(f80).slice(0, 200)}`);
    const n0 = b.ev("gateway-exit").length;
    await t.sleep(5000);
    t.check("heap 80: no restart within 5 s", b.ev("gateway-exit").length === n0);
    const k = Date.now();
    b.ctl("fault", { args: { line: "heap 92" } });
    // Restart start = ocsup's gateway-stop (SIGTERM sent); the graceful exit follows 10-15 s later.
    const s0 = b.ev("gateway-stop").length;
    const ex = await b.waitEv(
      () => b.ev("gateway-stop").length > s0 || b.ev("gateway-exit").length > n0,
      30_000,
    );
    const ms = ex ? Date.now() - k : null;
    t.measure("restartStartMs", ms);
    t.check("heap 92: restart starts within 2 s", ms !== null && ms <= 2000, ms);
    const z = await b.waitEv(() => b.ev("startupz").length > 1, 240_000);
    t.check("/startupz again", !!z);
  },
};
