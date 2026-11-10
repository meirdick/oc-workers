// M4 fixes in the Runtime DO: F12 cold-pull start budget, A4 hourly dirty-only checkpoint, WS bridge policy
// (close on session end and at 24 h, UI idle-close, latch) (M3-STATUS §1, §5, §8).
import { describe, expect, it } from "vitest";
import { bridgeDecision, classifyFrame, noteFrame, watchRound } from "../../src/rt/bridge-policy";
import { Bridges, gatewayHeaders } from "../../src/rt/proxy";
import { DEFAULT_RT_TIMERS, rtTimersFrom } from "../../src/rt/rt-timers";
import { Latches, proxyClass, proxyGateOpts } from "../../src/rt/runtime";
import { world } from "./world";

const req = (method: string) => JSON.stringify({ type: "req", id: "1", method, params: {} });

describe("F12 cold pull: start budget from the epoch's image-known flag", () => {
  it("first start of a new image waits coldStartTimeoutMs, no hung-start, no alert; then image known", async () => {
    // Pull takes 3 s; startTimeoutMs (test) 1 s; cold budget 10 s.
    const w = world({ readyAfterMs: 3000, rtTimers: { coldStartTimeoutMs: 10_000 } });
    expect(await w.boot()).toBe("running");
    expect(w.ctl.rings.filter((r) => r.kind === "stuck")).toHaveLength(0);
    expect(w.ctl.alerts).toHaveLength(0);
    const known = w.ctl.rings.find((r) => r.kind === "image-known");
    expect(known?.detail).toMatchObject({ firstAliveMs: expect.any(Number) });
    expect((known?.detail as { firstAliveMs: number } | undefined)?.firstAliveMs).toBeGreaterThanOrEqual(
      3000,
    );
    expect(w.core.imageKnown("sha256:beef")).toBe(true);
    expect(w.core.startTimeout({ digest: "sha256:beef" })).toBe(w.timers.startTimeoutMs);
    expect(w.core.startTimeout({ digest: "sha256:new" })).toBe(10_000);
  });

  it("control: without the cold budget the same 3 s pull is a hung-start (the M3 e2e F12 shape)", async () => {
    const w = world({ readyAfterMs: 3000, rtTimers: { coldStartTimeoutMs: 0 } });
    await w.core.init();
    await w.core.ensure();
    await w.idle();
    expect(
      w.ctl.rings.some((r) => r.kind === "stuck" && (r.detail as { what: string }).what === "start"),
    ).toBe(true);
    expect(w.state()).toBe("backoff");
  });

  it("a known image keeps the short budget: a hung start is still caught at startTimeoutMs", async () => {
    const w = world({ rtTimers: { coldStartTimeoutMs: 60_000 } });
    expect(await w.boot()).toBe("running");
    expect(w.core.imageKnown("sha256:beef")).toBe(true);
    w.c.readyAfterMs = 3_600_000;
    w.c.exit(); // crash: the restart must not wait 60 s per attempt
    await w.until(() => w.ctl.rings.some((r) => r.kind === "stuck"), 40);
    const stuck = w.ctl.rings.find((r) => r.kind === "stuck");
    expect(stuck).toBeTruthy();
  });

  it("rtTimersFrom: OC_TIMERS only under OC_TEST=1; preset test", () => {
    expect(rtTimersFrom({ OC_TIMERS: '{"checkpointMs":5}' }).checkpointMs).toBe(
      DEFAULT_RT_TIMERS.checkpointMs,
    );
    expect(rtTimersFrom({ OC_TEST: "1", OC_TIMERS: '{"checkpointMs":5}' }).checkpointMs).toBe(5);
    expect(rtTimersFrom({ OC_TEST: "1", OC_TIMERS: '{"preset":"test"}' }).wsCheckMs).toBe(100);
    expect(DEFAULT_RT_TIMERS.coldStartTimeoutMs).toBeGreaterThanOrEqual(120_000);
  });
});

describe("A4 hourly dirty-only checkpoint (plan §5.4 step 8, §6.1 row 6; spec 08 §15.1)", () => {
  const alwaysOn = (rt = {}) => {
    // Heartbeats are not driven here: hbLostMs and maintEveryMs long, so only the checkpoint rule acts.
    const w = world({
      timers: { hbLostMs: 24 * 3600_000, maintEveryMs: 24 * 3600_000 },
      rtTimers: { checkpointMs: 60_000, ...rt },
    });
    w.ctl.inputs.mode = "off"; // always-on: the sleep gate never fires
    const dirtySince: number | null = null;
    w.ocsup.ctl.dirty = () => ({ ok: true, dirty: true, count: 3, bytes: 1200, sample: ["workspace/m.md"] });
    w.ocsup.ctl["shadow-backup"] = () => ({ ok: true, results: [] });
    return {
      w,
      setClean: () => (w.ocsup.ctl.dirty = () => ({ ok: true, dirty: false, count: 0 })),
      dirtySince,
    };
  };
  const ckpts = (w: ReturnType<typeof world>) =>
    w.ctl.calls.filter((c) => c.m === "snapshotSaved" && (c.a as { kind: string }).kind === "checkpoint");

  it("awake 60 min + dirty → shadow, sync, snapshot, saved kind checkpoint (gen, digest, parent)", async () => {
    const { w } = alwaysOn();
    await w.boot();
    await w.hb();
    const t0 = w.clock.now();
    await w.tick(t0 + 30_000);
    expect(ckpts(w)).toHaveLength(0);
    await w.tick(t0 + 61_000);
    expect(ckpts(w)).toHaveLength(1);
    const h = ckpts(w)[0]?.a as { kind: string; gen: number; digest: string; parentId: string | null };
    expect(h).toMatchObject({ kind: "checkpoint", gen: 1, digest: "sha256:beef", parentId: null });
    expect(w.ocsup.ops.filter((o) => ["dirty", "shadow-backup"].includes(o))).toEqual([
      "dirty",
      "shadow-backup",
    ]);
    expect(w.c.snapshotCount).toBe(1);
    const op = w.core.store.ops(10).find((o) => o.kind === "checkpoint");
    expect(op?.state).toBe("done");
    expect(Object.keys(op?.phaseAt ?? {})).toEqual(
      expect.arrayContaining(["shadow", "sync", "snapshot", "save"]),
    );
    // The next one is an hour after this one, and chains on it.
    await w.tick(w.clock.now() + 30_000);
    expect(ckpts(w)).toHaveLength(1);
    await w.tick(w.clock.now() + 31_000);
    expect(ckpts(w)).toHaveLength(2);
    const a1 = ckpts(w)[1]?.a as { parentId: string } | undefined;
    const a0 = ckpts(w)[0]?.a as { id: string } | undefined;
    expect(h).toBeTruthy();
    expect(a1?.parentId).toBe(a0?.id);
    expect(w.state()).toBe("running");
  });

  it("clean → no snapshot; checked again an hour later", async () => {
    const { w, setClean } = alwaysOn();
    setClean();
    await w.boot();
    await w.hb();
    const t0 = w.clock.now();
    await w.tick(t0 + 61_000);
    expect(ckpts(w)).toHaveLength(0);
    expect(w.ctl.rings.some((r) => r.kind === "checkpoint-skip")).toBe(true);
    const n = w.ocsup.ops.filter((o) => o === "dirty").length;
    await w.tick(w.clock.now() + 30_000);
    expect(w.ocsup.ops.filter((o) => o === "dirty").length).toBe(n);
  });

  it("day cap: checkpoints stop at checkpointsPerDay", async () => {
    const { w } = alwaysOn({ checkpointsPerDay: 2 });
    await w.boot();
    for (let i = 0; i < 5; i++) {
      await w.hb();
      await w.tick(w.clock.now() + 61_000);
    }
    expect(ckpts(w)).toHaveLength(2);
  });

  it("snapshot error: op failed, counted, no retry until the next hour; state stays running", async () => {
    const { w } = alwaysOn();
    w.c.snapshotErrors.push(new Error("snapshot refused"));
    await w.boot();
    await w.hb();
    await w.tick(w.clock.now() + 61_000);
    expect(ckpts(w)).toHaveLength(0);
    expect(w.ctl.rings.some((r) => r.kind === "checkpoint-failed")).toBe(true);
    expect(w.state()).toBe("running");
    await w.hb();
    await w.tick(w.clock.now() + 61_000);
    expect(ckpts(w)).toHaveLength(1);
  });

  it("duty cycle: an awake period under checkpointMs sleeps first; the sleep snapshot covers bulk (no checkpoint)", async () => {
    const w = world({ rtTimers: { checkpointMs: 60_000 } });
    w.ocsup.ctl.dirty = () => ({ ok: true, dirty: true });
    await w.boot();
    await w.hb();
    await w.tick(w.clock.now() + 3000);
    await w.idle();
    expect(w.state()).toBe("asleep");
    expect(ckpts(w)).toHaveLength(0);
    expect(
      w.ctl.calls.some((c) => c.m === "snapshotSaved" && (c.a as { kind: string }).kind === "sleep"),
    ).toBe(true);
  });

  it("crash after a checkpoint: the restart boots from the checkpoint snapshot (bulk RPO = checkpoint age)", async () => {
    const { w } = alwaysOn();
    await w.boot();
    await w.hb();
    await w.tick(w.clock.now() + 61_000);
    const id = (ckpts(w)[0]?.a as { id: string } | undefined)?.id;
    expect(id).toBeTruthy();
    w.c.exit(); // SIGKILL shape
    await w.until(() => w.state() === "running" && (w.core.boot()?.gen ?? 0) > 1, 40);
    expect(w.core.boot()?.snapshotId).toBe(id);
  });

  it("an unknown answer to `dirty` (old ocsup) takes the checkpoint", async () => {
    const { w } = alwaysOn();
    delete w.ocsup.ctl.dirty;
    await w.boot();
    await w.hb();
    await w.tick(w.clock.now() + 61_000);
    expect(ckpts(w)).toHaveLength(1);
  });
});

describe("WS bridge policy (plan §7; add §2.5 rule 2, latch)", () => {
  const T = { wsMaxAgeMs: 24 * 3600_000, uiIdleMs: 15 * 60_000, uiMaxMs: 60 * 60_000 };

  it("classifyFrame: presence.activity intent; chat.send and writes chat-or-write; polls and junk poll", () => {
    expect(classifyFrame(req("presence.activity"))).toBe("intent");
    expect(classifyFrame(req("chat.send"))).toBe("chat-or-write");
    expect(classifyFrame(req("chat.abort"))).toBe("chat-or-write");
    expect(classifyFrame(req("config.set"))).toBe("chat-or-write");
    expect(classifyFrame(req("cron.add"))).toBe("chat-or-write");
    expect(classifyFrame(req("channels.pairing.approve"))).toBe("chat-or-write");
    expect(classifyFrame(req("chat.history"))).toBe("poll");
    expect(classifyFrame(req("channels.status"))).toBe("poll");
    expect(classifyFrame(req("health"))).toBe("poll");
    expect(classifyFrame(req("logs.tail"))).toBe("poll");
    expect(classifyFrame('{"type":"res","method":"chat.send"}')).toBe("poll");
    expect(classifyFrame("not json")).toBe("poll");
    expect(classifyFrame(new ArrayBuffer(8))).toBe("poll");
  });

  it("bridgeDecision: session end 1008, 24 h 1008, idle 15 min 1000 + latch, 60 min without chat 1000 + latch", () => {
    const m = { sid: "s", openedAt: 0, lastIntentAt: 0, lastChatAt: 0 };
    expect(bridgeDecision(m, 1000, T, true)).toBeNull();
    expect(bridgeDecision(m, 1000, T, false)).toEqual({ code: 1008, reason: "session ended", latch: false });
    expect(bridgeDecision(m, T.uiIdleMs, T, null)).toMatchObject({ code: 1000, latch: true });
    // presence.activity every minute keeps it, until 60 min with no chat/write frame.
    const k = { ...m };
    for (let t = 60_000; t < T.uiMaxMs; t += 60_000) {
      noteFrame(k, req("presence.activity"), t);
      expect(bridgeDecision(k, t + 1, T, true)).toBeNull();
    }
    expect(bridgeDecision(k, T.uiMaxMs, T, true)).toMatchObject({
      code: 1000,
      reason: "idle (max)",
      latch: true,
    });
    // A chat frame each 10 min: open until 24 h.
    const c = { ...m };
    for (let t = 600_000; t < T.wsMaxAgeMs; t += 600_000) noteFrame(c, req("chat.send"), t);
    expect(bridgeDecision(c, T.wsMaxAgeMs - 1, T, true)).toBeNull();
    expect(bridgeDecision(c, T.wsMaxAgeMs, T, true)).toMatchObject({ code: 1008, reason: "max age 24 h" });
    // Polls do not count.
    const p = { ...m };
    noteFrame(p, req("channels.status"), 10 * 60_000);
    expect(bridgeDecision(p, T.uiIdleMs, T, true)).toMatchObject({ reason: "idle" });
  });

  it("watchRound: revoked session closes its sockets 1008 (one check per sid); idle latches; Auth error keeps", async () => {
    const closed: string[] = [];
    const mk = (sid: string | null, name: string, lastIntentAt = 0) => ({
      meta: { sid, openedAt: 0, lastIntentAt, lastChatAt: lastIntentAt },
      close: (code: number, reason: string) => closed.push(`${name}:${code}:${reason}`),
    });
    const checks: string[] = [];
    const latched: string[] = [];
    const n = await watchRound(
      [
        mk("revoked", "a", 5000),
        mk("revoked", "b", 5000),
        mk("ok", "c", 5000),
        mk("idle", "d", 0),
        mk(null, "e", 5000),
      ],
      {
        now: () => T.uiIdleMs + 1,
        timers: T,
        check: async (sid) => {
          checks.push(sid);
          if (sid === "idle") throw new Error("auth down");
          return sid !== "revoked";
        },
        latch: (sid) => latched.push(sid),
        log: () => {},
      },
    );
    expect(n).toBe(3);
    expect(closed.sort()).toEqual(["a:1008:session ended", "b:1008:session ended", "d:1000:idle"]);
    expect(checks.sort()).toEqual(["idle", "ok", "revoked"]);
    expect(latched).toEqual(["idle"]);
  });

  it("Bridges.closeSession and list; Latches set/has/clear, newest 32 kept", () => {
    const b = new Bridges();
    const got: string[] = [];
    const add = (sid: string) =>
      b.add({
        meta: { sid, openedAt: 0, lastIntentAt: 0, lastChatAt: 0 },
        close: (c) => got.push(`${sid}:${c}`),
      });
    add("x");
    add("y");
    add("x");
    expect(b.closeSession("x", 1008, "revoked")).toBe(2);
    expect(got).toEqual(["x:1008", "x:1008"]);
    const kv = new Map<string, unknown>();
    const l = new Latches({ get: <T>(k: string) => kv.get(k) as T | undefined, put: (k, v) => kv.set(k, v) });
    l.set("s1", 1);
    expect(l.has("s1")).toBe(true);
    expect(l.clear("s1")).toBe(true);
    expect(l.has("s1")).toBe(false);
    for (let i = 0; i < 40; i++) l.set(`s${i}`, i);
    expect(l.has("s0")).toBe(false);
    expect(l.has("s39")).toBe(true);
  });

  it("the session id header never reaches the gateway", () => {
    const h = gatewayHeaders(new Headers({ "x-ochost-sid": "abc", "x-ochost-user": "owner", cookie: "a=b" }));
    expect(h.get("x-ochost-sid")).toBeNull();
    expect(h.get("x-ochost-user")).toBe("owner");
  });

  it("a user-intent frame counts as activity (rule 3); a poll does not", async () => {
    const w = world();
    w.ctl.inputs.mode = "off";
    await w.boot();
    const a0 = w.core.rec().lastActivityAt as number;
    await w.clock.advance(5000);
    w.core.noteUiIntent();
    expect(w.core.rec().lastActivityAt).toBe(a0 + 5000);
  });

  it("proxyClass: latched WS refused; latched fetch and /healthz get no activity; latched fetch no wake", () => {
    const r = (path: string, h: Record<string, string> = {}) =>
      new Request(`https://oc.example${path}`, { headers: h });
    const ws = { upgrade: "websocket" };
    const html = { accept: "text/html" };
    expect(proxyClass(r("/", ws), true)).toBe("refuse");
    expect(proxyClass(r("/healthz"), true)).toBe("latched");
    expect(proxyClass(r("/api/x"), true)).toBe("latched");
    expect(proxyClass(r("/", html), true)).toBe("normal"); // a page load clears the latch
    expect(proxyClass(r("/healthz"), false)).toBe("probe");
    expect(proxyClass(r("/readyz"), false)).toBe("probe");
    expect(proxyClass(r("/", ws), false)).toBe("normal");
    expect(proxyClass(r("/api/x"), false)).toBe("normal");
    expect(proxyGateOpts("latched")).toEqual({ activity: false, wake: false });
    expect(proxyGateOpts("probe")).toEqual({ activity: false, wake: true });
    expect(proxyGateOpts("normal")).toEqual({ activity: true, wake: true });
  });

  it("live 2026-11-10: a latched tab's /healthz every 15 s no longer holds the install awake (rule 3)", async () => {
    const run = async (opts: { activity?: boolean; wake?: boolean }) => {
      const w = world({ timers: { maintEveryMs: 24 * 3600_000 } });
      await w.boot();
      for (let i = 0; i < 60 && w.state() !== "asleep"; i++) {
        expect(await w.core.proxyAllowed(opts)).toBe("serve");
        await w.hb();
        await w.tick(w.clock.now() + 1000);
      }
      return w;
    };
    const held = await run({});
    expect(held.state()).toBe("running");
    expect(held.core.sleepRec().blockedOn).toBe("3:idle");
    const latched = proxyGateOpts("latched");
    const w = await run(latched);
    expect(w.state()).toBe("asleep");
    // Asleep: the latched probe wakes nothing.
    expect(await w.core.proxyAllowed(latched)).toBe("waking");
    await w.idle();
    expect(w.state()).toBe("asleep");
    // A probe of a session that is not latched still wakes (the UI's reconnect after a sleep).
    expect(await w.core.proxyAllowed(proxyGateOpts("probe"))).toBe("waking");
    await w.idle();
    expect(w.state()).not.toBe("asleep");
  });
});
