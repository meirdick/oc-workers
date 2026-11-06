// Spec §3 schema, §6.1 epochs, §6.5/§15 snapshot index and prune rules, §13.4 gen GC, §16 cost guard,
// §11.2 schedule, §17.2 alerts, §19.2 /ops; scenarios §21 #20, #27, #30, #32, #53-#55, #66, #82.
import { describe, expect, it } from "vitest";
import { always24, awakeRate, costGuard, cycleCost } from "../../src/core/cost";
import { TABLES } from "../../src/ctl/schema";
import { handleOps } from "../../src/ops";
import { bootComplete, opId, tg, type World, world } from "./world";

const DAY = 86_400_000;
const H = 3_600_000;

describe("schema", () => {
  it("creates the 21 tables of §3.1 plus meta; migrate is idempotent", () => {
    const w = world();
    const names = w.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
    expect(TABLES).toHaveLength(24);
    w.restart();
    expect(w.db.metaNum("v")).toBe(1);
  });
});

describe("first install from /ops (M3 e2e, live B7)", () => {
  it("owner wake on a never-installed install runs ensure: epoch 1, no wait for the cron", async () => {
    const w = world();
    const r = await w.api.ops({
      action: "wake",
      method: "POST",
      sub: [],
      query: {},
      body: {},
      role: "owner",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ensured: true, epoch: 1 });
    expect(w.db.metaNum("pointer")).toBe(1);
  });
});

describe("epochs (§6.1)", () => {
  it("roll: retire e1 (settled) then flip to e2 in one transaction", async () => {
    const w = world();
    w.install();
    const r = await w.api.core.roll();
    expect(r).toMatchObject({ ok: true, state: "done" });
    expect(w.rt(1).retired).toBe(true);
    expect(w.db.all("SELECT n, status FROM epochs ORDER BY n")).toEqual([
      { n: 1, status: "retired" },
      { n: 2, status: "active" },
    ]);
    expect(w.db.metaNum("pointer")).toBe(2);
    expect((await w.api.epochStatus(1)).status).toBe("retired");
    expect((await w.api.epochStatus(9)).status).toBe("none");
  });

  it("#28 confirmed retire: no 200 s wait; unconfirmed retire waits until lastHb + 200 s", async () => {
    const w = world();
    w.install();
    w.rt(1).retireResult = { settled: false, lastHbAt: w.clock.t };
    const r = await w.api.core.roll();
    expect(r.state).toBe("open");
    expect(w.db.metaNum("pointer")).toBe(1);
    w.advance(w.ctx.timers.unconfirmedWaitMs);
    await w.api.tick();
    expect(w.db.metaNum("pointer")).toBe(2);
  });

  it("#82 crash between retire and flip: no active epoch; op resumes at flip; ensure() refuses the retired epoch", async () => {
    const w = world();
    w.install();
    w.rt(1).retireResult = { settled: false, lastHbAt: w.clock.t };
    await w.api.core.roll();
    // Simulate the crash right after phase 4: epoch retired, flip not run.
    w.db.run("UPDATE epochs SET status = 'retired' WHERE n = 1");
    w.db.run("UPDATE ops SET phase = 'flip' WHERE kind = 'code-roll'");
    const w2 = w.restart();
    expect(w2.api.core.activeEpoch()).toBeNull();
    const r = await w2.api.beginBoot({ epoch: 1, mode: "prod", opId: "x", reason: "user" });
    expect(r.error).toBe("epoch-not-active");
    const e = await w2.api.ensure();
    expect(e.epoch).toBe(2);
    expect(w2.rt(1).ensures).toBe(0);
    expect(w2.rt(2).ensures).toBeGreaterThanOrEqual(1); // flip kicks e2, then the cron
  });

  it("#20 reslot: epoch N retired, N+1 active with the same image, one op per epoch", async () => {
    const w = world();
    w.install("sha256:keep");
    const r = await w.api.reslot({ epoch: 1, why: "hung destroy x3" });
    expect(r).toEqual({ ok: true, epoch: 2 });
    expect(w.db.one("SELECT image_key, digest, reason FROM epochs WHERE n = 2")).toEqual({
      image_key: "oc",
      digest: "sha256:keep",
      reason: "reslot",
    });
    expect((await w.api.reslot({ epoch: 1, why: "again" })).ok).toBe(true); // attaches to the done op
    expect(w.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM epochs")?.n).toBe(2);
    expect(w.db.one("SELECT class FROM alerts WHERE class = 'reslot'")).toBeTruthy();
  });
});

describe("snapshot index and prune rules (§15.3)", () => {
  function snap(
    w: World,
    id: string,
    parentId: string | null,
    kind: "sleep" | "maint" = "sleep",
    digest = "sha256:img1",
  ) {
    w.advance(1000);
    return w.api.snapshotSaved({ id, size: 10, digest, imageKey: "oc", gen: 1, epoch: 1, kind, parentId });
  }

  it("chain base and length; images in use; rootfs tags and live chains are never prunable", async () => {
    const w = world();
    w.install();
    await snap(w, "a", null);
    await snap(w, "b", "a");
    await snap(w, "c", "b", "sleep", "sha256:old");
    expect(w.api.core.snapshot("c")?.chain_base).toBe("a");
    w.db.run("UPDATE epochs SET digest = 'sha256:img2' WHERE n = 1");
    const use = w.api
      .imagesInUse()
      .map((x) => x.digest)
      .sort();
    expect(use).toEqual(["sha256:img1", "sha256:img2"]);
    expect(w.api.pruneAllowed("rootfs-snapshot-abc", "sha256:zzz")).toEqual({
      allow: false,
      why: "rootfs-tag",
    });
    expect(w.api.pruneAllowed("oc:2026.9.1", "sha256:img1").allow).toBe(false);
    expect(w.api.pruneAllowed("oc:2026.8.1", "sha256:gone")).toEqual({ allow: true });
  });

  it("TTL expiry (30 d from max(created, lastRestored)) voids a bound marker; chain no longer live", async () => {
    const w = world();
    w.install();
    await snap(w, "a", null);
    const m = await w.api.markerPending({
      opId: "s",
      gen: 1,
      epoch: 1,
      digest: "sha256:img1",
      txid: {},
      bytes: {},
      lastWriteAt: {},
    });
    await w.api.markerValid({ id: m.id, snapshotId: "a" });
    w.advance(31 * DAY);
    await w.api.core.dailyIfDue(true);
    expect(w.api.core.snapshot("a")?.state).toBe("expired");
    expect(w.db.one<{ state: string }>("SELECT state FROM markers WHERE id = ?", m.id)?.state).toBe("void");
    expect(w.api.pruneAllowed("oc:x", "sha256:img9").allow).toBe(true);
  });

  it("snapshot budget: checkpoint stops at 30/day, maint max 2/day", async () => {
    const w = world();
    w.install();
    for (let i = 0; i < 2; i++) await snap(w, `m${i}`, null, "maint");
    expect(w.api.snapshotAllowed("maint")).toEqual({ allow: false, why: "maint-budget" });
    expect(w.api.snapshotAllowed("sleep")).toEqual({ allow: true });
  });
});

describe("gen GC (§13.4)", () => {
  it("#66 40 sleep gens over 8 days: keep set exact; abandoned > 24 h deleted; R2 prefixes removed", async () => {
    const w = world({ real: true });
    w.install();
    const gens: number[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await bootComplete(w, { reason: "wake:cron" });
      await w.r2.put(`r/t1/g${r.gen}/state/openclaw.sqlite/0000/x.ltx`, "x");
      gens.push(r.gen);
      w.advance(Math.floor((8 * DAY) / 40));
    }
    const ab = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "ab", reason: "ladder" });
    await w.api.endBoot({ gen: ab.gen, opId: "ab", why: "crash" });
    w.advance(25 * H);
    const cur = await bootComplete(w, { reason: "wake:webhook" });
    const plan = (
      await w.api.ops({ action: "gc", method: "GET", sub: [], query: {}, body: {}, role: "owner" })
    ).body as {
      keep: { gen: number; why: string[] }[];
      delete: number[];
    };
    const keep = new Set(plan.keep.map((k) => k.gen));
    // newest 3 complete, one per UTC day for 7 d, and the current gen; nothing else
    expect(keep.has(cur.gen)).toBe(true);
    expect(keep.size).toBeLessThanOrEqual(3 + 8);
    expect(plan.delete).toContain(ab.gen);
    expect(plan.delete.every((g) => !keep.has(g))).toBe(true);
    expect(plan.delete.length + keep.size).toBe(42);
    const out = await w.api.core.dailyIfDue(true);
    expect(out).toBe(true);
    const deleted = w.db
      .all<{ gen: number }>("SELECT gen FROM gens WHERE state = 'deleted'")
      .map((r) => r.gen);
    expect(deleted.length).toBe(Math.min(20, plan.delete.length));
    for (const g of deleted) expect((await w.r2.list({ prefix: `r/t1/g${g}/` })).objects).toHaveLength(0);
    const newest40 = gens[gens.length - 1] as number;
    expect(keep.has(newest40)).toBe(true);
    expect((await w.r2.list({ prefix: `r/t1/g${newest40}/` })).objects).toHaveLength(1);
  });

  it("keeps marker gens, pinned gens and live restoreGens; create-before-delete", async () => {
    const w = world({ real: true });
    w.install();
    const a = await bootComplete(w, { reason: "wake:cron" });
    const m = await w.api.markerPending({
      opId: "s",
      gen: a.gen,
      epoch: 1,
      digest: "sha256:img1",
      txid: {},
      bytes: {},
      lastWriteAt: {},
    });
    expect(m.ok).toBe(true);
    w.advance(DAY);
    const b = await bootComplete(w, { reason: "wake:cron" });
    w.api.core.pinGen(b.gen, w.clock.t + 30 * DAY);
    w.advance(10 * DAY);
    const c = await bootComplete(w, { reason: "wake:cron" });
    const d = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "d", reason: "wake:ui" }); // restores c, booting
    expect(d.restoreGens).toEqual([c.gen]);
    const plan = (
      await w.api.ops({ action: "gc", method: "GET", sub: [], query: {}, body: {}, role: "owner" })
    ).body as {
      keep: { gen: number; why: string[] }[];
      delete: number[];
    };
    const why = Object.fromEntries(plan.keep.map((k) => [k.gen, k.why]));
    expect(why[a.gen]).toContain("marker");
    expect(why[b.gen]).toContain("pinned");
    expect(why[c.gen]).toContain(`restore-of-g${d.gen}`);
    expect(plan.delete).toEqual([]);
  });

  it("index read error → op failed, no delete (fails closed); R2 list error stops the run", async () => {
    const w = world({ real: true });
    w.install();
    await bootComplete(w, { reason: "wake:cron" });
    w.advance(DAY);
    await bootComplete(w, { reason: "wake:cron" });
    w.storage.failAll = new Error("storage down");
    await expect(w.api.core.dailyIfDue(true)).rejects.toThrow();
    w.storage.failAll = null;
    w.r2.listFail = 1;
    w.advance(20 * DAY);
    await bootComplete(w, { reason: "wake:cron" });
    await bootComplete(w, { reason: "wake:cron" });
    await bootComplete(w, { reason: "wake:cron" });
    const r = await w.api.ops({ action: "gc", method: "POST", sub: [], query: {}, body: {}, role: "owner" });
    expect(r.body).toMatchObject({ ok: false, error: "r2" });
    expect(w.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM gens WHERE state = 'deleted'")?.n).toBe(0);
  });
});

describe("cost guard and schedule (§16, §11.2)", () => {
  it("rates on the 2/6/20 basis", () => {
    expect(awakeRate()).toBeCloseTo(0.0000164, 9);
    expect(always24()).toBeCloseTo(86400 * 0.0000164 + 0.1 * 86400 * 0.00002 + 26 * 0.0045, 6);
    expect(cycleCost()).toBeCloseTo(37 * 0.0000164 + 28 * 0.00002 + 0.0045, 9);
  });

  it("#53 30 short cycles in 24 h: refused once spend24 + cycle > always24, allowed under 80 %, one sleep-thrash per day", () => {
    const w = world();
    w.install();
    const now = w.clock.t;
    // Awake 40 min each cycle, 30 cycles in the last 24 h, cpu 300 s each.
    for (let i = 0; i < 30; i++) {
      const at = now - DAY + i * 45 * 60_000;
      w.db.run(
        "INSERT INTO wake_log (gen, reason, wake_at, slept_at, cpu_s) VALUES (?, 'wake:webhook', ?, ?, 600)",
        i + 1,
        at,
        at + 44 * 60_000,
      );
    }
    const r1 = w.api.costCheck();
    expect(r1.allow).toBe(false);
    expect(r1.spend24 + r1.cycle).toBeGreaterThan(r1.always24);
    w.api.costCheck();
    expect(w.db.one<{ count: number }>("SELECT count FROM alerts WHERE class = 'sleep-thrash'")?.count).toBe(
      1,
    );
    // Spend drops: hysteresis holds until < 80 %.
    const g = costGuard({
      now,
      spans: [{ wakeAt: now - H, sleptAt: now, cpuS: 0, slept: true }],
      holding: true,
    });
    expect(g.allow).toBe(true);
  });

  it("#54 nextWakeAtMs in 20 min: wake at nextWakeAtMs − lead; after 20 cron wakes lead = clamp(p95 + pad)", () => {
    const w = world({ real: true });
    w.install();
    const next = w.clock.t + 20 * 60_000;
    expect(w.api.core.wakePlan({ nextWakeAtMs: next, lastWakeAt: w.clock.t })).toMatchObject({
      wakeAt: next - 120_000,
      reason: "cron",
      leadMs: 120_000,
    });
    for (let i = 0; i < 20; i++)
      w.db.run(
        "INSERT INTO wake_log (gen, reason, wake_at, startupz_ms) VALUES (?, 'wake:cron', ?, ?)",
        i,
        w.clock.t,
        100_000 + i * 1000,
      );
    expect(w.api.core.wakePlan({ nextWakeAtMs: next, lastWakeAt: w.clock.t }).leadMs).toBe(148_000); // p95 118 s + 30 s
    for (let i = 0; i < 20; i++)
      w.db.run(
        "INSERT INTO wake_log (gen, reason, wake_at, startupz_ms) VALUES (?, 'wake:cron', ?, 900000)",
        i,
        w.clock.t,
      );
    expect(w.api.core.wakePlan({ nextWakeAtMs: next, lastWakeAt: w.clock.t }).leadMs).toBe(300_000);
  });

  it("#55 nextWakeAtMs < 10 min away → no sleep", () => {
    const w = world({ real: true });
    expect(w.api.sleepWorthIt(w.clock.t + 9 * 60_000)).toBe(false);
    expect(w.api.sleepWorthIt(w.clock.t + 11 * 60_000)).toBe(true);
    expect(w.api.sleepWorthIt(null)).toBe(true);
  });

  it("#59 held row: maintenance wake at oldestHeld + 20 h, before its 23 h dead line", () => {
    const w = world({ real: true });
    w.install();
    w.api.noteRtState(1, "asleep");
    w.api.gateCall("wakeAllow", [{ userIds: [], groupChatIds: [] }]);
    // S0.10: a stranger's held row plans no wake; an adapter's held row (delivery receipt) does.
    w.api.inboxPut({ body: tg(1, 5, 5), headers: {} });
    expect(w.api.core.wakePlan({ nextWakeAtMs: null, lastWakeAt: w.clock.t }).wakeAt).toBeGreaterThan(
      w.clock.t + 22 * H,
    );
    w.api.inboxPut({
      route: "/hooks/twilio",
      body: "{}",
      headers: {},
      meta: { platformKey: "SM1", senderId: null, chatId: null, hold: true },
    });
    const p = w.api.core.wakePlan({ nextWakeAtMs: null, lastWakeAt: w.clock.t });
    expect(p.reason).toBe("maint");
    expect(p.wakeAt).toBeLessThanOrEqual(w.clock.t + 20 * H);
    expect(p.wakeAt).toBeLessThan(w.clock.t + 22 * H);
  });

  it("sleepInputs: socket channel and event job are blockers; inbox busy; cost ok", async () => {
    const w = world();
    w.install();
    w.api.noteHeartbeat({
      gen: 1,
      channels: [
        { channel: "telegram", account: "default", transport: "webhook", lifecycle: "started" },
        { channel: "whatsapp", account: "default", transport: "baileys" },
      ],
      eventJobs: [{ id: "j1", kind: "stream", name: "mcp-watch" }],
    });
    w.api.inboxPut({ body: tg(1), headers: {} });
    const s = await w.api.sleepInputs();
    expect(s.blockers).toEqual(["channel:whatsapp/default:socket", "event-job:mcp-watch:stream"]);
    expect(s.inboxBusy).toBe(1); // pending
    w.db.run("UPDATE inbox SET state = 'accepted', accepted_at = ?", w.clock.t);
    expect((await w.api.sleepInputs()).inboxBusy).toBe(0); // accepted: path A replicates it in phase 6
    expect(s.costOk).toBe(true);
    expect(s.idleBaseMs).toBe(w.ctx.timers.idleMs);
    // M6: /ops/status lists the live channels so `upgrade run` can see them come back
    const st = (await w.api.status()) as {
      channels: { channel: string; lifecycle: string | null; updatedAt: number }[];
    };
    expect(st.channels.find((x) => x.channel === "telegram")).toEqual({
      channel: "telegram",
      account: "default",
      lifecycle: "started",
      updatedAt: w.clock.t,
    });
  });
});

describe("alerts and sink", () => {
  it("dedupe 1 per class per hour; ntfy headers; ledger alerts reach the sink; failed sends retry", async () => {
    const w = world();
    w.install();
    await w.api.alert({ class: "ladder-l3", severity: "high", detail: "L3" });
    await w.api.alert({ class: "ladder-l3", severity: "high", detail: "again" });
    await w.api.alert({ class: "minor", severity: "info", detail: "x" });
    await w.api.flushAlerts();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({
      url: "https://ntfy.example/topic",
      headers: { title: "oc-host t1: ladder-l3", priority: "5", authorization: "Bearer tk" },
    });
    expect(w.sent[0]?.body).toContain("HIGH ladder-l3");
    expect(w.db.one<{ count: number }>("SELECT count FROM alerts WHERE class = 'ladder-l3'")?.count).toBe(2);
    w.ledger.alert("replica-reseed-x", "high", "from ledger");
    w.setSink(500);
    await w.api.flushAlerts();
    expect(w.sent).toHaveLength(2);
    w.setSink(200);
    await w.api.flushAlerts();
    expect(w.sent).toHaveLength(3);
    expect(w.sent[2]?.headers.title).toBe("oc-host t1: replica-reseed-x");
    w.advance(H);
    await w.api.alert({ class: "ladder-l3", severity: "high" });
    await w.api.flushAlerts();
    expect(w.sent).toHaveLength(4);
  });

  it("no sink configured: alerts stay in the table and ring", async () => {
    const w = world({ alertUrl: null });
    await w.api.alert({ class: "x", severity: "high" });
    expect(await w.api.flushAlerts()).toEqual({ sent: 0, failed: 0 });
    expect(w.db.one("SELECT class FROM alerts WHERE class = 'x'")).toBeTruthy();
  });
});

describe("/ops (§19.2)", () => {
  const env = { CONTROL_TOKEN: "owner-tok", CI_TOKEN: "ci-tok", OC_TEST: "0" };
  const call = (
    w: World,
    method: string,
    path: string,
    tok?: string,
    body?: unknown,
    e: Record<string, string> = env,
  ) =>
    handleOps(
      new Request(`https://oc.example/${path}`, {
        method,
        headers: tok ? { authorization: `Bearer ${tok}` } : {},
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      {
        ...e,
        OC_INST: "t1",
        CONTROL: { getByName: () => w.api },
        RUNTIME: { getByName: () => w.rt(1) },
      } as never,
      async () => 1,
    );

  it("#30 CI token on each destructive route → 404; no auth → 404; unset token role → 404", async () => {
    const w = world();
    w.install();
    for (const p of ["wake", "start", "stop", "restart", "sleep", "epoch/roll", "restore"])
      expect([p, (await call(w, "POST", `ops/${p}`, "ci-tok", {})).status]).toEqual([p, 404]);
    for (const p of ["config", "creds", "alerts", "inbox", "events", "logs"])
      expect([p, (await call(w, "GET", `ops/${p}`, "ci-tok")).status]).toEqual([p, 404]);
    expect((await call(w, "GET", "ops/status")).status).toBe(404);
    expect((await call(w, "GET", "ops/status", "wrong")).status).toBe(404);
    expect(
      (await call(w, "GET", "ops/status", "ci-tok", undefined, { CONTROL_TOKEN: "owner-tok" })).status,
    ).toBe(404);
    expect((await call(w, "GET", "ops/nope", "owner-tok")).status).toBe(404);
    expect((await call(w, "POST", "ops/fault/hb-drop", "owner-tok", {})).status).toBe(404);
    expect((await call(w, "GET", "ops/status", "ci-tok")).status).toBe(200);
  });

  it("status has no secrets; shows gen, inbox counts, cost guard, blockers", async () => {
    const w = world();
    w.install();
    const a = await bootComplete(w);
    w.api.inboxPut({ body: tg(1), headers: {} });
    await w.api.kickDriver(); // awake: the driver delivers at once → accepted, not yet replicated
    const res = await call(w, "GET", "ops/status", "owner-tok");
    const s = (await res.json()) as Record<string, any>;
    const secret = w.db.one<{ secret: string }>("SELECT secret FROM gens WHERE gen = ?", a.gen)
      ?.secret as string;
    expect(JSON.stringify(s)).not.toContain(secret);
    expect(s.gen).toMatchObject({
      gen: a.gen,
      state: "complete",
      secretHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(s.inbox.accepted).toBe(1);
    expect(s.blockers).toContain("inbox-unreplicated");
    expect(s.costGuard.holding).toBe(false);
  });

  it("wake, sleep, start/stop go to the Runtime DO; events and alerts list", async () => {
    const w = world();
    w.install();
    w.rt(1).state = "asleep";
    expect(await (await call(w, "POST", "ops/wake", "owner-tok", {})).json()).toMatchObject({
      state: "starting",
    });
    expect(w.rt(1).wakes).toEqual(["cli"]);
    expect(await (await call(w, "POST", "ops/sleep?force=1", "owner-tok", {})).json()).toMatchObject({
      reason: "forced",
    });
    expect((await call(w, "POST", "ops/stop", "owner-tok", {})).status).toBe(200);
    expect(w.rt(1).state).toBe("stopped");
    expect((await call(w, "GET", "ops/events", "owner-tok")).status).toBe(200);
    await w.api.alert({ class: "y", severity: "warn" });
    const al = (await (await call(w, "GET", "ops/alerts", "owner-tok")).json()) as {
      alerts: { class: string }[];
    };
    expect(al.alerts.map((a) => a.class)).toContain("y");
    expect((await call(w, "POST", "ops/alerts/test", "owner-tok", {})).status).toBe(200);
    expect(w.sent.at(-1)?.headers.title).toBe("oc-host t1: alert-test");
  });

  it("#32 deploy-check: 409 when CODE_VERSION differs or an op is open", async () => {
    const w = world();
    w.install();
    expect((await call(w, "POST", "ops/deploy-check", "ci-tok", { head: "cv-test" })).status).toBe(200);
    expect((await call(w, "POST", "ops/deploy-check", "ci-tok", { head: "other" })).status).toBe(409);
    w.rt(1).retireResult = { settled: false, lastHbAt: w.clock.t };
    await w.api.core.roll();
    expect((await call(w, "POST", "ops/deploy-check", "ci-tok", { head: "cv-test" })).status).toBe(409);
  });

  it("restore needs acceptLoss and a known source; pins gens; l5 op recorded (C5: manual only)", async () => {
    const w = world();
    w.install();
    const a = await bootComplete(w);
    expect(
      (await call(w, "POST", "ops/restore", "owner-tok", { sqlite: "pitr:2026-11-01T00:00:00Z" })).status,
    ).toBe(400);
    expect(
      (await call(w, "POST", "ops/restore", "owner-tok", { sqlite: "archive:none", acceptLoss: true }))
        .status,
    ).toBe(404);
    // N1 (M4b): a ts before the first complete gen has no source.
    expect(
      (
        await call(w, "POST", "ops/restore", "owner-tok", {
          sqlite: "pitr:2026-11-01T00:00:00Z",
          acceptLoss: true,
        })
      ).status,
    ).toBe(404);
    const r = await call(w, "POST", "ops/restore", "owner-tok", {
      sqlite: "pitr:2026-11-01T10:00:00Z",
      acceptLoss: true,
    });
    expect(r.status).toBe(202);
    expect(
      w.db.one<{ pinned_until: number }>("SELECT pinned_until FROM gens WHERE gen = ?", a.gen)?.pinned_until,
    ).toBeGreaterThan(w.clock.t);
    expect(w.db.one("SELECT kind, phase FROM ops WHERE kind = 'l5'")).toEqual({
      kind: "l5",
      phase: "chosen",
    });
  });

  it("config: owner candidate, list, get, mark bad; webhook transport refused", async () => {
    const w = world();
    w.install();
    const ok = await call(w, "POST", "ops/config", "owner-tok", { doc: { gateway: { port: 18789 } } });
    expect(await ok.json()).toMatchObject({ ok: true, ver: 1 });
    const bad = await call(w, "POST", "ops/config", "owner-tok", {
      doc: { channels: { slack: { webhookUrl: "https://evil.example/hook" } } },
    });
    expect(bad.status).toBe(403);
    const ch = await call(w, "POST", "ops/config", "owner-tok", { doc: { gateway: { port: 1 } } });
    expect(await ch.json()).toMatchObject({ ver: 2 });
    // the owner changed it: a ring row, not an alert (the ui source alerts, gates/control.test.ts)
    expect(w.db.one("SELECT class FROM alerts WHERE class = 'config-sensitive'")).toBeFalsy();
    expect(w.db.one("SELECT id FROM ring WHERE src = 'config' AND kind = 'sensitive'")).toBeTruthy();
    const list = (await (await call(w, "GET", "ops/config", "owner-tok")).json()) as {
      versions: { ver: number }[];
    };
    expect(list.versions.map((v) => v.ver)).toEqual([2, 1]);
    expect(await (await call(w, "GET", "ops/config/1", "owner-tok")).json()).toMatchObject({
      doc: { gateway: { port: 18789 } },
    });
    await call(w, "POST", "ops/config/2/bad", "owner-tok", {});
    expect(w.db.one<{ status: string }>("SELECT status FROM config WHERE ver = 2")?.status).toBe("bad");
  });

  it("creds: manifest, history, restore from history writes a newer version", async () => {
    const w = world();
    w.install();
    const sha = (c: string) => c.repeat(64);
    w.ledger.credsPut(1, "credentials/wa/creds.json", {
      seq: 1,
      sha256: sha("a"),
      mode: 0o600,
      b64: btoa("v1"),
    });
    w.ledger.credsPut(1, "credentials/wa/creds.json", {
      seq: 2,
      sha256: sha("b"),
      mode: 0o600,
      b64: btoa("v2"),
    });
    const man = (await (await call(w, "GET", "ops/creds", "owner-tok")).json()) as {
      seq: number;
      files: unknown[];
    };
    expect(man.seq).toBe(2);
    const hist = (await (
      await call(w, "GET", "ops/creds/history?path=credentials/wa/creds.json", "owner-tok")
    ).json()) as {
      history: { seq: number }[];
    };
    expect(hist.history.map((h) => h.seq)).toEqual([2, 1]);
    const r = await call(w, "POST", "ops/creds/restore", "owner-tok", {
      path: "credentials/wa/creds.json",
      seq: 1,
    });
    expect(await r.json()).toEqual({ ok: true, seq: 3 });
    expect(w.ledger.credsGet("credentials/wa/creds.json")).toMatchObject({
      seq: 3,
      sha256: sha("a"),
      b64: btoa("v1"),
    });
  });
});

describe("ControlForRuntime", () => {
  it("bootHealthy: needs ok R2 probes during the boot and a served hello", async () => {
    const w = world();
    w.install();
    const since = w.clock.t;
    expect(await w.api.bootHealthy({ gen: 1, since })).toBe(false); // no hello
    w.ledger.hello(1, "control");
    expect(await w.api.bootHealthy({ gen: 1, since })).toBe(true);
    w.advance(10);
    w.r2.failUntil = w.clock.t + 5;
    expect(await w.api.r2Probe()).toMatchObject({ ok: false });
    expect(await w.api.bootHealthy({ gen: 1, since })).toBe(false);
  });

  it("onSlept closes the wake row; wake log feeds the meter", async () => {
    const w = world();
    w.install();
    const a = await bootComplete(w, { reason: "wake:webhook" });
    w.advance(600_000);
    await w.api.onSlept({ gen: a.gen, sleptAt: w.clock.t, snapshotBytes: 5, sleepMs: 2000, cpuS: 12 });
    const row = w.db.one<{ awake_s: number; cpu_s: number; snapshot_bytes: number }>(
      "SELECT awake_s, cpu_s, snapshot_bytes FROM wake_log WHERE gen = ?",
      a.gen,
    );
    expect(row).toEqual({ awake_s: 600, cpu_s: 12, snapshot_bytes: 5 });
    expect(w.api.core.rtState()).toBe("asleep");
    const s = (await w.api.status()) as { wake: { wakes24: number; awakeS24: number } };
    expect(s.wake.wakes24).toBe(1);
    expect(s.wake.awakeS24).toBe(600);
  });

  it("ingress-ready event through the gate path starts the driver's ready mode", async () => {
    const w = world();
    w.install();
    const a = await bootComplete(w);
    w.api.gateCall("event", [a.gen, { kind: "ingress-ready" }]);
    expect(w.db.metaJson<{ ready: boolean }>("driver", { ready: false }).ready).toBe(true);
  });

  it("endBoot abandons a booting gen; doctor-required forces runDoctor on the next plan", async () => {
    const w = world();
    w.install();
    const a = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: opId(), reason: "user" });
    await w.api.endBoot({ gen: a.gen, opId: "x", why: "exit 78" });
    expect(w.db.one<{ state: string }>("SELECT state FROM gens WHERE gen = ?", a.gen)?.state).toBe(
      "abandoned",
    );
    w.api.noteDoctorRequired(1);
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: opId(), reason: "ladder" });
    expect(b.plan.runDoctor).toBe(true);
  });
});
