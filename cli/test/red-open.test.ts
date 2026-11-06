// Open red-team items (docs/research/red-team-reconciliation.md §8): ochost side.
import { describe, expect, it } from "vitest";
import { checkAlerts, checkDeadman } from "../../worker/src/ctl/panel-checks.ts";

describe("Z2.9: ochost doctor FAILs a silent dead-man", () => {
  it("sink never acked an alert, or newest send failed → FAIL; a working sink is not", () => {
    const never = checkAlerts({}, { configured: true, kind: "ntfy", lastOkAt: null });
    expect(never).toMatchObject({ result: "FAIL", detail: "ntfy sink never acked an alert" });
    const failing = checkAlerts({}, { configured: true, kind: "slack", lastOkAt: 5, failing: true });
    expect(failing.result).toBe("FAIL");
    const ok = checkAlerts({}, { configured: true, kind: "ntfy", lastOkAt: 5, failing: false });
    expect(ok.result).not.toBe("FAIL");
  });
  it("CI dead-man silent → FAIL; daily heartbeat counts as a dead-man", () => {
    expect(checkDeadman({ deadman: { silent: true, lastAt: 1 } }).result).toBe("FAIL");
    expect(checkDeadman({ sink: { heartbeatAt: 1 } })).toMatchObject({ result: "PASS" });
    expect(checkDeadman({}).result).toBe("WARN");
  });
});

describe("S1.11: ochost init --telegram-owner", () => {
  it("takes a numeric user id (tg: prefix ok); refuses a group id or a name", async () => {
    const { telegramOwnerOf } = await import("../src/init.ts");
    expect(telegramOwnerOf("tg:4242")).toBe("4242");
    expect(telegramOwnerOf(undefined)).toBeUndefined();
    expect(() => telegramOwnerOf("-100")).toThrow(/not a Telegram user id/);
    expect(() => telegramOwnerOf("@me")).toThrow(/not a Telegram user id/);
  });
});
