// Spec §20 test column vs worker/src/core/timers.ts TEST_TIMERS, and the real defaults.
import { describe, expect, it } from "vitest";
import { REAL, TEST_TIMERS as SPEC } from "./harness/timers";

const mod = await import("../src/core/timers").catch(() => null);

describe.skipIf(!mod)("timers §20", () => {
  it("test preset equals the spec test column", () => {
    const t = mod?.TEST_TIMERS as unknown as Record<string, number>;
    for (const [k, v] of Object.entries(SPEC)) expect([k, t[k]]).toEqual([k, v]);
  });
  it("defaults keep the real values; OC_TIMERS is ignored without OC_TEST=1", () => {
    const d = mod?.DEFAULT_TIMERS as unknown as Record<string, number>;
    for (const [k, v] of Object.entries(REAL)) expect([k, d[k]]).toEqual([k, v]);
    const f = mod?.timersFrom as unknown as (e: Record<string, string>) => Record<string, number>;
    expect(f({ OC_TEST: "0", OC_TIMERS: '{"preset":"test"}' }).hbLostMs).toBe(180_000);
    expect(f({ OC_TEST: "1", OC_TIMERS: '{"preset":"test"}' }).hbLostMs).toBe(6_000);
  });
});
