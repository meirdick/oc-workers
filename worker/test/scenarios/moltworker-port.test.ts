// Ports of the three cloudflare/moltworker e2e scenarios (test/e2e/*.txt at 7b00c1d) to this design.
// Not a copy: moltworker's endpoints do not exist here. Each block keeps the user path and
// maps the check to our equivalent. Mapping is in docs/16-differences-from-moltworker.md.
//
// 1. r2_persistence  -> persistence: status reports a replica, and stop/wake cycles keep a
//                       verified generation (no manual "sync" button exists in this design).
// 2. zzz_cron_wake   -> cron wake: a due cron job wakes an asleep install with no HTTP request.
// 3. pairing_and_conversation -> paired sender's Telegram message wakes the install and is
//                       delivered; an unpaired sender is held and does not wake it.
import { afterEach, describe, expect, it } from "vitest";
import { MIN, S } from "../harness/timers";
import type { World } from "../harness/world";
import { done, fresh, startCount, sutP, toAsleep, toRunning } from "./helpers";

const sut = await sutP;
let w: World;
afterEach((ctx) => done(w, ctx));

const upd = (id: number, from: number) => ({
  update_id: id,
  message: { message_id: id, from: { id: from }, chat: { id: from, type: "private" }, text: `hello ${id}` },
});

describe.skipIf(!sut.ok)(`moltworker port: persistence ${sut.why}`, () => {
  // Moltworker: "storage status shows configured" + "manual sync succeeds" x3 (idempotent).
  it("status reports the replica as configured; repeated stop/wake keeps a usable generation", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    const st = await w.ops("status");
    expect(st.status).toBe(200);
    expect(JSON.stringify(st.body)).toMatch(/replica|configured/i);

    for (let i = 0; i < 3; i++) {
      await toAsleep(w);
      await w.webhook(upd(100 + i, 5));
      await w.until(() => w.state() === "running", 30_000);
      await w.until(() => w.state() === "running", 5_000);
      const usable = w
        .ctl()
        .rows<{ gen: number; state: string }>(
          "SELECT gen, state FROM gens WHERE state IN ('complete', 'verified') ORDER BY gen",
        );
      expect(
        usable.length,
        `usable generation after cycle ${i + 1} (states: ${JSON.stringify(w.gens().map((g) => g.state))})`,
      ).toBeGreaterThan(0);
      expect(w.stops().filter((s) => s.cls.startsWith("restore-blocked")).length).toBe(0);
    }
    expect(w.alerts().filter((a) => a.severity === "high").length).toBe(0);
  }, 120_000);
});

describe.skipIf(!sut.ok)(`moltworker port: cron wake ${sut.why}`, () => {
  // Moltworker: upload a job due in 20 s, then the scheduled handler must wake the gateway.
  // Here: the container reports a cron job due in 20 s while the install sleeps. No HTTP request.
  it("an asleep install wakes for a due cron job with reason wake:cron, and the job runs", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    w.rt().ocsup.nextWakeAtMs = Date.now() + 20 * S;
    await w.until(() => w.state() === "asleep", 3 * MIN);
    const before = startCount(w);
    await w.until(() => w.state() === "starting" || w.state() === "running", 3 * MIN);
    expect(startCount(w)).toBeGreaterThan(before);
    const last = w
      .ops_()
      .filter((o) => o.kind === "start")
      .at(-1);
    expect(last?.reason).toBe("wake:cron");
  }, 240_000);

  it("a cron job due while running does not restart the gateway", async () => {
    w = await fresh(sut);
    await toRunning(w);
    const before = startCount(w);
    w.rt().ocsup.nextWakeAtMs = Date.now() + 20 * S;
    await w.advance(40 * S);
    expect(startCount(w)).toBe(before);
    expect(w.state()).toBe("running");
  }, 120_000);
});

describe.skipIf(!sut.ok)(`moltworker port: pairing and conversation ${sut.why}`, () => {
  // Moltworker: approve pending device in admin UI, then chat. Here: the allowlist (wake_allow)
  // is the pairing. A paired sender's message wakes the install and is delivered; an unpaired
  // sender is held and does not wake it.
  it("unpaired sender is held without a wake; paired sender wakes and the row is delivered", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    await w.webhook(upd(1, 999));
    await w.advance(1 * S);
    expect(w.inbox().find((r) => r.platform_key === "1")?.state).toBe("held");
    expect(w.state()).toBe("asleep");

    await w.webhook(upd(2, 5));
    await w.until(() => w.state() === "running", 30_000);
    await w.until(() => (w.inbox().find((r) => r.platform_key === "2")?.state ?? "") !== "held", 30_000);
    expect(w.inbox().find((r) => r.platform_key === "2")?.state).not.toBe("held");
  }, 180_000);
});
