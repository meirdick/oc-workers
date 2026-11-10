// Restart = owner stop + owner start (§19.2) while a sleep op runs, and DO resets on the way.
// Live oc-host 2026-11-10: `ochost restart` came while quiescing; the sleep op ended asleep (row 37, desired
// asleep), the stop op ended stopped (row 53) with desired stopped, no start op. The install stayed stopped.
import { describe, expect, it } from "vitest";
import { type World, world } from "./world";

/** Run to a sleep op; at `at` the owner calls stop (and start when `restart`), as /ops/restart does. */
async function stopInSleep(w: World, o: { restart: boolean; at?: string; halt?: boolean }) {
  await w.boot();
  await w.hb();
  const at = o.at ?? "sleep-flush";
  const orig = w.ocsup.ctl[at] as (a: unknown) => unknown;
  let done = false;
  w.ocsup.ctl[at] = (a) => {
    if (!done) {
      done = true;
      void w.core.ownerStop();
      if (o.restart) void w.core.ownerStart();
      // DO reset: this instance stops acting.
      if (o.halt) w.core.halt();
    }
    return orig(a);
  };
  await w.tick(w.clock.now() + 3000);
  await w.idle();
  expect(done).toBe(true);
}

const desired = (w: World) => w.core.rec().desired;
const startOps = (w: World) => w.core.store.ops(50).filter((o) => o.kind === "start");

describe("restart while quiescing", () => {
  it("T-R55 restart while a sleep op runs: sleep ends, stop ends, then a start (live oc-host 2026-11-10)", async () => {
    const w = world();
    await stopInSleep(w, { restart: true });
    await w.until(() => w.state() === "running");
    expect(w.state()).toBe("running");
    expect(desired(w)).toBe("running");
    expect(w.c.startCount).toBe(2);
    expect(w.rows()).toEqual(expect.arrayContaining([24, 26, 53]));
  });

  it("T-R55 restart while quiescing, DO reset during the sleep op: the next instance stops, then starts", async () => {
    const w = world();
    await stopInSleep(w, { restart: true, halt: true });
    await w.restart();
    await w.until(() => w.state() === "running");
    expect(w.state()).toBe("running");
    expect(desired(w)).toBe("running");
    expect(w.c.startCount).toBe(2);
    expect(w.core.store.openOps()).toEqual([]);
  });

  it("T-R55 restart while quiescing, DO reset after row 37 (asleep, stop op open): stop, then start", async () => {
    const w = world();
    const slept = w.ctl.onSlept.bind(w.ctl);
    w.ctl.onSlept = async (a) => {
      w.core.halt();
      return slept(a);
    };
    await stopInSleep(w, { restart: true });
    expect(w.state()).toBe("asleep");
    w.ctl.onSlept = slept;
    await w.restart();
    await w.until(() => w.state() === "running");
    expect(w.state()).toBe("running");
    expect(desired(w)).toBe("running");
    expect(w.c.startCount).toBe(2);
  });

  it("T-R53 owner stop while quiescing (no start) stays stopped, desired stopped, after a DO reset too", async () => {
    const w = world();
    await stopInSleep(w, { restart: false });
    expect(w.state()).toBe("stopped");
    expect(desired(w)).toBe("stopped");
    await w.restart();
    await w.runAlarms(3);
    await w.core.ensure();
    const r = await w.core.requestWake("cli");
    await w.idle();
    expect(r.action).toBe("none");
    expect(w.state()).toBe("stopped");
    expect(w.c.startCount).toBe(1);
    expect(startOps(w).length).toBe(1);
  });

  it("T-R53 owner stop while quiescing, then the sleep op aborts on a wake flag (row 39): still stopped", async () => {
    const w = world();
    await w.boot();
    await w.hb();
    const orig = w.ocsup.ctl["sleep-check"] as (a: unknown) => unknown;
    w.ocsup.ctl["sleep-check"] = (a) => {
      void w.core.ownerStop();
      w.core.store.put("wakeRequested", { reason: "webhook", at: 0 });
      return orig(a);
    };
    await w.tick(w.clock.now() + 3000);
    await w.idle();
    await w.runAlarms(3);
    expect(w.state()).toBe("stopped");
    expect(desired(w)).toBe("stopped");
    expect(w.c.startCount).toBe(1);
  });
});

describe("stopped with desired=running (start leg cut by a DO reset)", () => {
  /** The live record at 15:31:53: stopped, desired running, no open op. */
  async function cutRestart() {
    const w = world();
    await w.boot();
    await w.core.ownerStop();
    await w.idle();
    expect(w.state()).toBe("stopped");
    w.core.patchRec({ desired: "running" });
    return w;
  }

  it("T-R55 init resumes it: the next tick starts (no row 56)", async () => {
    const w = await cutRestart();
    await w.restart();
    await w.until(() => w.state() === "running");
    expect(w.state()).toBe("running");
    expect(w.c.startCount).toBe(2);
  });

  it("T-R55 ensure starts it", async () => {
    const w = await cutRestart();
    await w.core.ensure();
    await w.idle();
    expect(w.state()).toBe("running");
    expect(w.rows()).toContain(55);
  });

  it("T-R55 wake starts it", async () => {
    const w = await cutRestart();
    const r = await w.core.requestWake("cli");
    expect(r.action).toBe("start");
    await w.idle();
    expect(w.state()).toBe("running");
  });

  it("T-R56 stopped with desired stopped: ensure and wake do nothing", async () => {
    const w = world();
    await w.boot();
    await w.core.ownerStop();
    await w.idle();
    await w.core.ensure();
    const r = await w.core.requestWake("cli");
    await w.idle();
    expect(r.action).toBe("none");
    expect(w.state()).toBe("stopped");
    expect(w.c.startCount).toBe(1);
  });
});
