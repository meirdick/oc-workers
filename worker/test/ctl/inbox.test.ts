// Spec §12 (inbox, allowlist, driver, replicated, secret), add §2.2; scenarios §21 #40, #56-#64, #69.
import { describe, expect, it } from "vitest";
import { parseTelegram } from "../../src/ctl/inbox";
import { handleWebhook } from "../../src/ctl/webhook";
import { tg, type World, world } from "./world";

const put = (w: World, body: string) => w.api.inboxPut({ body, headers: { host: "oc.example.workers.dev" } });
const rows = (w: World) =>
  w.db.all<{ platform_key: string; state: string; attempts: number; dead_reason: string | null }>(
    "SELECT platform_key, state, attempts, dead_reason FROM inbox ORDER BY CAST(platform_key AS INTEGER)",
  );
const alertOf = (w: World, cls: string) =>
  w.db.one<{ count: number; severity: string }>("SELECT count, severity FROM alerts WHERE class = ?", cls);

function awake(w: World, gen = 1) {
  w.install();
  w.api.noteRtState(1, "running");
  w.rt(1).state = "running";
  w.db.run(
    `INSERT INTO gens (gen, epoch, op_id, reason, mode, secret, restore_gens, plan, plan_kind, state, unplanned, issued_at)
     VALUES (?, 1, ?, 'user', 'prod', 's', '[]', '{"sqlite":{"kind":"fresh"}}', 'fresh', 'booting', 0, 0)`,
    gen,
    `op-${gen}`,
  );
}

describe("parseTelegram", () => {
  it("reads update_id, from.id and chat.id from the first Update field", () => {
    expect(parseTelegram(tg(5, 7, -100))).toEqual({ updateId: "5", fromId: "7", chatId: "-100" });
    expect(
      parseTelegram(
        JSON.stringify({ update_id: 6, callback_query: { from: { id: 9 }, message: { chat: { id: 3 } } } }),
      ),
    ).toEqual({ updateId: "6", fromId: "9", chatId: "3" });
    expect(parseTelegram(JSON.stringify({ update_id: 8, poll: { id: "x" } }))).toEqual({
      updateId: "8",
      fromId: null,
      chatId: null,
    });
    expect(parseTelegram("not json")).toBeNull();
    expect(parseTelegram(JSON.stringify({ message: {} }))).toBeNull();
  });
});

describe("arrival", () => {
  it("#57 redelivery of the same update_id: no new row, 200", () => {
    const w = world();
    w.install();
    expect(put(w, tg(1))).toMatchObject({ status: 200, dup: false, state: "pending", wake: true });
    expect(put(w, tg(1))).toMatchObject({ status: 200, dup: true, wake: false });
    expect(rows(w)).toHaveLength(1);
  });

  it("malformed body → 200 drop + ring event", () => {
    const w = world();
    w.install();
    expect(put(w, "{")).toMatchObject({ status: 200, malformed: true });
    expect(rows(w)).toHaveLength(0);
    expect(w.db.one("SELECT kind FROM ring WHERE kind = 'webhook-malformed'")).toBeTruthy();
  });

  it("#58 asleep: unknown sender held (no wake, stale list too); paired sender, no from/chat wake", () => {
    const w = world();
    w.install();
    w.db.run(
      "INSERT INTO config (ver, status, source, doc, created_at) VALUES (1, 'good', 'seed', '{}', ?)",
      w.clock.t - 10,
    );
    w.api.noteRtState(1, "asleep");
    w.api.gateCall("wakeAllow", [{ userIds: ["111"], groupChatIds: ["-5"] }]);
    expect(put(w, tg(1, 999, 999))).toMatchObject({ state: "held", wake: false });
    expect(put(w, tg(2, 111, 111))).toMatchObject({ state: "pending", wake: true });
    expect(put(w, tg(3, 999, -5))).toMatchObject({ state: "pending", wake: true });
    expect(put(w, JSON.stringify({ update_id: 4, poll: { id: "p" } }))).toMatchObject({
      state: "pending",
      wake: true,
    });
    w.advance(10);
    w.db.run(
      "INSERT INTO config (ver, status, source, doc, created_at) VALUES (2, 'candidate', 'ui', '{}', ?)",
      w.clock.t,
    );
    // S0.10: a stale list still knows 111 and the group, and still does not wake for a stranger.
    expect(put(w, tg(5, 999, 999))).toMatchObject({ state: "held", wake: false });
    expect(put(w, tg(6, 111, 111))).toMatchObject({ state: "pending", wake: true });
  });

  it("msg_day: one row per UTC day of receipt; a reply counts on the day the message came in; last chat meta", () => {
    const w = world();
    awake(w);
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const d0 = day(w.clock.t);
    expect(put(w, tg(1, 111, 111))).toMatchObject({ status: 200 });
    expect(put(w, tg(2, 111, 111))).toMatchObject({ status: 200 });
    expect(put(w, tg(2, 111, 111))).toMatchObject({ dup: true }); // not counted twice
    w.db.run("UPDATE inbox SET state = 'accepted', accepted_at = ?", w.clock.t);
    w.advance(10);
    expect(w.core.noteOutbound(111, w.clock.t, "sendMessage")).toBe(2);
    expect(w.db.all("SELECT day, received, replied FROM msg_day ORDER BY day")).toEqual([
      { day: d0, received: 2, replied: 2 },
    ]);
    expect(w.db.metaNum("lastInboundAt", 0)).toBe(w.clock.t - 10);
    expect(w.db.meta("lastInboundRoute")).toBe("/telegram-webhook");
    const s = w.core.chatSummary();
    expect(s.days).toHaveLength(7);
    expect(s.days[6]).toEqual({ day: d0, received: 2, replied: 2 });
    expect(s.days[0]?.received).toBe(0);
    expect(s).toMatchObject({
      lastInAt: w.clock.t - 10,
      lastInRoute: "/telegram-webhook",
      lastOutAt: w.clock.t,
    });
  });

  it("awake: nothing is held", () => {
    const w = world();
    awake(w);
    w.api.gateCall("wakeAllow", [{ userIds: ["111"], groupChatIds: [] }]);
    expect(put(w, tg(1, 999, 999))).toMatchObject({ state: "pending" });
  });

  it("#63 cap 10,000 live rows → 503; 200 again below it", () => {
    const w = world();
    w.install();
    w.db.tx(() => {
      for (let i = 0; i < 10_000; i++)
        w.db.run(
          "INSERT INTO inbox (id, route, account, platform_key, received_at, headers, body, state) VALUES (?, '/telegram-webhook', 'default', ?, ?, '{}', '{}', 'held')",
          `id${i}`,
          String(i),
          w.clock.t,
        );
    });
    expect(put(w, tg(20_000))).toMatchObject({ status: 503 });
    w.db.run("UPDATE inbox SET state = 'replicated' WHERE platform_key = '0'");
    expect(put(w, tg(20_000))).toMatchObject({ status: 200 });
  });

  it("#59/#61 age: pending 23 h → dead + inbox-dead; replicated/dead deleted at 24 h", async () => {
    const w = world();
    w.install();
    put(w, tg(1));
    put(w, tg(2));
    w.db.run("UPDATE inbox SET state = 'replicated' WHERE platform_key = '2'");
    w.advance(w.ctx.timers.inboxDeadMs + 1);
    await w.api.tick();
    expect(rows(w).map((r) => [r.platform_key, r.state, r.dead_reason])).toEqual([
      ["1", "dead", "age"],
      ["2", "replicated", null],
    ]);
    expect(alertOf(w, "inbox-dead")?.severity).toBe("high");
    w.advance(w.ctx.timers.inboxKeepMs);
    await w.api.tick();
    expect(rows(w)).toHaveLength(0);
  });
});

describe("webhook handler (Worker)", () => {
  const env = { TELEGRAM_WEBHOOK_SECRET: "new", TELEGRAM_WEBHOOK_SECRET_PREV: "old" };
  const req = (tok: string, body = tg(1)) =>
    new Request("https://oc.example.workers.dev/telegram-webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": tok, "content-type": "application/json" },
      body,
    });

  it("#64 wrong secret 401; previous secret during rotation 200; after telegramSecretVersion matches 401", async () => {
    const w = world();
    w.install();
    const wakes: number[] = [];
    const d = {
      env,
      ctl: {
        inboxPut: async (p: never) => w.api.inboxPut(p),
        webhookPrevOk: async () => w.api.webhookPrevOk(),
      },
      wake: async () => wakes.push(1),
      waitUntil: (p: Promise<unknown>) => void p,
    };
    expect((await handleWebhook(req("nope"), d)).status).toBe(401);
    expect(rows(w)).toHaveLength(0);
    w.api.core.webhookRotated();
    expect((await handleWebhook(req("old", tg(2)), d)).status).toBe(200);
    w.api.noteHeartbeat({ gen: 1, telegramSecretVersion: 1 });
    expect((await handleWebhook(req("old", tg(3)), d)).status).toBe(401);
    expect((await handleWebhook(req("new", tg(4)), d)).status).toBe(200);
    expect(wakes.length).toBe(2);
  });

  it("#56 ack 200 before any container work, in every Runtime state", async () => {
    for (const st of ["asleep", "starting", "running", "quiescing", "backoff"] as const) {
      const w = world();
      w.install();
      w.api.noteRtState(1, st);
      let waited = false;
      const res = await handleWebhook(req("new", tg(7)), {
        env,
        ctl: { inboxPut: async (p: never) => w.api.inboxPut(p), webhookPrevOk: async () => false },
        wake: () => new Promise(() => {}), // never resolves: the ack must not wait for it
        waitUntil: () => {
          waited = true;
        },
      });
      expect([st, res.status, waited]).toEqual([st, 200, true]);
      expect(w.rt(1).delivered).toHaveLength(0);
      expect(rows(w)[0]?.state).toBe("pending");
    }
  });

  it("only POST; body > 1 MiB → 413", async () => {
    const w = world();
    const d = {
      env,
      ctl: { inboxPut: async (p: never) => w.api.inboxPut(p), webhookPrevOk: async () => false },
      wake: async () => 0,
      waitUntil: () => {},
    };
    expect((await handleWebhook(new Request("https://x/telegram-webhook"), d)).status).toBe(405);
    const big = `{"update_id":1,"x":"${"a".repeat(1024 * 1024)}"}`;
    expect((await handleWebhook(req("new", big), d)).status).toBe(413);
  });
});

describe("wake retry and ensure", () => {
  it("#60 requestWake dropped: Control DO alarm wakes at 15 s, 30 s, then every 60 s (test timers)", async () => {
    const w = world();
    w.install();
    w.api.noteRtState(1, "asleep");
    w.rt(1).state = "asleep";
    await w.api.tick(); // daily job and alert flush out of the way
    put(w, tg(1)); // the Worker's waitUntil wake was lost
    const t = w.ctx.timers;
    expect(w.api.nextAlarmAt()).toBe(w.clock.t + t.inboxWakeFirstMs);
    w.advance(t.inboxWakeFirstMs);
    w.rt(1).failNext = "DO reset";
    w.rt(1).state = "asleep";
    await w.api.tick();
    expect(w.rt(1).wakes).toEqual([]);
    expect(w.api.nextAlarmAt()).toBe(w.clock.t + (t.inboxWakeSecondMs - t.inboxWakeFirstMs));
    w.advance(t.inboxWakeSecondMs - t.inboxWakeFirstMs);
    await w.api.tick();
    expect(w.rt(1).wakes).toEqual(["inbox"]);
    expect(w.api.nextAlarmAt()).toBeLessThanOrEqual(w.clock.t + t.inboxWakeEveryMs);
  });

  it("no wake retry while the Runtime DO is starting or running", async () => {
    const w = world();
    w.install();
    w.rt(1).state = "running";
    put(w, tg(1));
    w.advance(w.ctx.timers.inboxWakeFirstMs);
    await w.api.tick();
    expect(w.rt(1).wakes).toEqual([]);
  });

  it("#69 ensure(): pending row wakes `inbox`; no rows → only rt.ensure()", async () => {
    const w = world();
    w.install();
    w.rt(1).state = "asleep";
    let r = await w.api.ensure();
    expect(r).toMatchObject({ epoch: 1, state: "asleep", woke: false });
    put(w, tg(1));
    r = await w.api.ensure();
    expect(r.woke).toBe(true);
    expect(w.rt(1).wakes).toEqual(["inbox"]);
    expect(w.rt(1).ensures).toBe(2);
  });

  it("ensure() installs e1 on first call", async () => {
    const w = world();
    const r = await w.api.ensure({ imageKey: "oc", digest: "sha256:z" });
    expect(r.epoch).toBe(1);
    expect(w.api.core.activeEpoch()?.digest).toBe("sha256:z");
  });
});

describe("replay driver", () => {
  it("#40 before ingress-ready: 503, 404, 500 → retry, no alert, only the 404 is an attempt (M7 F2); durable → accepted; order by update_id", async () => {
    const w = world();
    awake(w);
    for (const id of [12, 3, 7]) put(w, tg(id));
    w.api.core.ingressReady(99); // other gen: ignored
    await w.api.onStarted({
      epoch: 1,
      gen: 1,
      opId: "op-1",
      reason: "user",
      digest: "d",
      wakeAt: 0,
      aliveMs: 1,
      startupzMs: 1,
    });
    const answers = [503, 404, 500];
    w.rt(1).deliverFn = () => {
      const s = answers.shift();
      return s ? { status: s, durable: false } : { status: 200, durable: true };
    };
    for (let i = 0; i < 6; i++) {
      await w.api.kickDriver();
      w.advance(200);
    }
    expect(w.rt(1).delivered.map((d) => JSON.parse(d.body).update_id)).toEqual([3, 3, 3, 3, 7, 12]);
    expect(rows(w).map((r) => [r.platform_key, r.state, r.attempts])).toEqual([
      ["3", "accepted", 1],
      ["7", "accepted", 0],
      ["12", "accepted", 0],
    ]);
    expect(alertOf(w, "inbox-blocked")).toBeNull(); // one 404, below BLOCKED_AFTER_MISSES
    const h = w.rt(1).delivered[0]?.headers;
    expect(h).toMatchObject({
      "x-telegram-bot-api-secret-token": "wh-secret-1",
      host: "oc.example.workers.dev",
    });
    expect(w.db.one<{ first_replay_ms: number | null }>("SELECT first_replay_ms FROM wake_log")).toBeNull(); // no wake row here
  });

  it("#61 after ready: 404 retries, alert after 3 (S0.3); 400 and 413 → dead; 401 for 5 min → inbox-blocked, row kept", async () => {
    const w = world();
    awake(w);
    put(w, tg(1));
    put(w, tg(2));
    put(w, tg(3));
    put(w, tg(4));
    await w.api.onStarted({
      epoch: 1,
      gen: 1,
      opId: "op-1",
      reason: "user",
      digest: "d",
      wakeAt: 0,
      aliveMs: 1,
      startupzMs: 1,
    });
    w.api.core.ingressReady(1);
    const seq = [400, 413];
    w.rt(1).deliverFn = (r) => {
      const id = JSON.parse(r.body).update_id;
      if (id <= 2) return { status: seq.shift() ?? 500, durable: false };
      if (id === 3) return { status: 401, durable: false };
      return { status: 200, durable: true };
    };
    await w.api.kickDriver();
    expect(
      rows(w)
        .slice(0, 2)
        .map((r) => [r.state, r.dead_reason]),
    ).toEqual([
      ["dead", "http-400"],
      ["dead", "http-413"],
    ]);
    for (let i = 0; i < 40; i++) {
      w.advance(w.ctx.timers.driverRetryCapMs);
      await w.api.kickDriver();
    }
    expect(rows(w)[2]).toMatchObject({ platform_key: "3", state: "pending" });
    expect(rows(w)[2]?.attempts).toBeGreaterThan(5);
    expect(alertOf(w, "inbox-blocked")?.severity).toBe("high");
    expect(rows(w)[3]?.state).toBe("pending"); // serial queue: 4 waits behind 3

    const w2 = world();
    awake(w2);
    put(w2, tg(1));
    put(w2, tg(2));
    await w2.api.onStarted({
      epoch: 1,
      gen: 1,
      opId: "op-1",
      reason: "user",
      digest: "d",
      wakeAt: 0,
      aliveMs: 1,
      startupzMs: 1,
    });
    w2.api.core.ingressReady(1);
    // S0.3: a 404 after ready (gateway stopping) does not stop the queue; 3 in a row alert; after the restart
    // the same row is accepted.
    w2.rt(1).deliverFn = () => ({ status: 404, durable: false });
    await w2.api.kickDriver();
    expect(alertOf(w2, "inbox-blocked")).toBeNull();
    for (let i = 0; i < 3; i++) {
      w2.advance(w2.ctx.timers.driverRetryCapMs);
      await w2.api.kickDriver();
    }
    expect(rows(w2).map((r) => r.state)).toEqual(["pending", "pending"]);
    expect(alertOf(w2, "inbox-blocked")).toBeTruthy();
    w2.rt(1).deliverFn = () => ({ status: 200, durable: true });
    w2.advance(w2.ctx.timers.driverRetryCapMs);
    await w2.api.kickDriver();
    expect(rows(w2).map((r) => r.state)).toEqual(["accepted", "accepted"]);
  });

  it("#62 boot without a valid marker: accepted un-replicated rows replayed before new rows", async () => {
    const w = world();
    awake(w);
    put(w, tg(1));
    put(w, tg(2));
    w.db.run(
      "UPDATE inbox SET state = 'accepted', accepted_at = ?, accepted_boot_gen = 0 WHERE platform_key IN ('1', '2')",
      w.clock.t,
    );
    w.db.run("UPDATE inbox SET state = 'replicated' WHERE platform_key = '1'");
    put(w, tg(3));
    await w.api.onStarted({
      epoch: 1,
      gen: 1,
      opId: "op-1",
      reason: "user",
      digest: "d",
      wakeAt: 0,
      aliveMs: 1,
      startupzMs: 1,
    });
    await w.api.kickDriver();
    expect(w.rt(1).delivered.map((d) => JSON.parse(d.body).update_id)).toEqual([2, 3]);
  });

  it("driver stops when the Runtime DO leaves running; rows stay", async () => {
    const w = world();
    awake(w);
    await w.api.onStarted({
      epoch: 1,
      gen: 1,
      opId: "op-1",
      reason: "user",
      digest: "d",
      wakeAt: 0,
      aliveMs: 1,
      startupzMs: 1,
    });
    w.api.noteRtState(1, "quiescing");
    put(w, tg(1));
    await w.api.kickDriver();
    expect(w.rt(1).delivered).toHaveLength(0);
    expect(rows(w)[0]?.state).toBe("pending");
  });

  it("sleep phase 6 path A: accepted rows up to lastWriteAt of the state DB → replicated", async () => {
    const w = world();
    awake(w);
    put(w, tg(1));
    put(w, tg(2));
    w.db.run(
      "UPDATE inbox SET state = 'accepted', accepted_at = ? WHERE platform_key = '1'",
      w.clock.t - 100,
    );
    w.db.run(
      "UPDATE inbox SET state = 'accepted', accepted_at = ? WHERE platform_key = '2'",
      w.clock.t + 100,
    );
    expect(await w.api.markReplicated({ upTo: w.clock.t })).toEqual({ count: 1 });
    expect(rows(w).map((r) => r.state)).toEqual(["replicated", "accepted"]);
    expect(w.api.core.inboxBlocksSleep()).toEqual({ pending: 0, unreplicated: 1 });
  });
});
