// Self-test of the scenario world with toy DO classes (no M2 modules needed).
import { afterEach, describe, expect, it } from "vitest";
import { type Sut, World } from "./harness/world";

class ToyRt {
  ticks = 0;
  constructor(
    public ctx: DurableObjectState & { container: Container },
    public env: Record<string, unknown>,
  ) {
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }
  async ensure() {
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    return { ok: true };
  }
  async alarm() {
    this.ticks++;
    await this.ctx.container.setInactivityTimeout(1);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO kv VALUES ('phase', ?)", JSON.stringify(this.ticks));
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO kv VALUES ('rec', ?)",
        JSON.stringify({ state: "running" }),
      );
    });
    await new Promise((r) => setTimeout(r, 300));
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO kv VALUES ('after', ?)", JSON.stringify(this.ticks));
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
}
class ToyCtl {
  constructor(
    public ctx: DurableObjectState,
    public env: Record<string, unknown>,
  ) {}
  async ping() {
    return { at: Date.now() };
  }
}
const sut = { ok: true, why: "", mod: {}, Runtime: ToyRt, Control: ToyCtl } as unknown as Sut;
let w: World;
afterEach(() => w?.dispose());

describe("World", () => {
  it("fires alarms on fake time, one in flight per DO", async () => {
    w = new World(sut);
    await w.rt(1).call("ensure");
    await w.advance(5_000);
    const t = (w.rt(1).slot.inst as unknown as ToyRt).ticks;
    expect(t).toBeGreaterThanOrEqual(3);
    expect(t).toBeLessThanOrEqual(4);
    expect(w.state(1)).toBe("running");
    expect(w.rt(1).c.inactivity.length).toBe(t);
  });
  it("restart revokes the old instance: its later writes throw, storage and container stay", async () => {
    w = new World(sut);
    await w.rt(1).call("ensure");
    await w.advance(1_100); // alarm 1 is inside its 300 ms wait
    const old = w.rt(1).slot.inst;
    w.rt(1).restart();
    await w.advance(400);
    expect(w.rt(1).kv("phase")).toBe(1);
    expect(w.rt(1).kv("after")).toBeUndefined(); // old instance could not write
    expect(w.alarmErrors.some((e) => /reset/.test(e.err))).toBe(true);
    await w.rt(1).call("ensure");
    expect(w.rt(1).slot.inst).not.toBe(old);
    expect(w.rt(1).constructs()).toBe(2);
  });
  it("restartWhen cuts after the commit that matches, not inside it", async () => {
    w = new World(sut);
    const cut = w.restartWhen("Runtime", w.rtName(1), (q) => /'phase'/.test(q));
    await w.rt(1).call("ensure");
    await w.advance(1_500);
    expect(cut()).toBe(true);
    expect(w.rt(1).kv("phase")).toBe(1);
    expect(w.rt(1).kv("rec")).toEqual({ state: "running" });
    expect(w.rt(1).kv("after")).toBeUndefined();
  });
  it("down makes stubs throw; dropRequestWake drops calls", async () => {
    w = new World(sut);
    w.down.add("Control");
    await expect(w.ctl().call("ping")).rejects.toThrow(/unavailable/);
    w.down.clear();
    await expect(w.ctl().call("ping")).resolves.toMatchObject({ at: expect.any(Number) });
    w.dropRequestWake = 1;
    await expect(w.rt(1).call("requestWake", "webhook")).rejects.toThrow(/dropped/);
    expect(w.requestWakeCalls).toEqual([{ at: expect.any(Number), reason: "webhook", dropped: true }]);
  });
});
