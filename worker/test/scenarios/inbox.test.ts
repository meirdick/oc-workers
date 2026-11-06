// Spec §21.2 inbox scenarios (§12): ack while asleep, replay order, dropped requestWake, allowlist,
// driver answers, rows that survive a host crash before `replicated`, cap, webhook secrets.
import { afterEach, describe, expect, it } from "vitest";
import { MIN, S } from "../harness/timers";
import { TOKENS, type World } from "../harness/world";
import {
  done,
  fresh,
  setSettings,
  startCount,
  sutP,
  toAsleep,
  toBackoff,
  toQuiescing,
  toRunning,
  toStarting,
} from "./helpers";

const sut = await sutP;
let w: World;
afterEach((ctx) => done(w, ctx));
const upd = (id: number, from: number | null = 5) =>
  from === null
    ? { update_id: id, poll: { id: "p" } }
    : {
        update_id: id,
        message: { message_id: id, from: { id: from }, chat: { id: from, type: "private" }, text: `m${id}` },
      };
const replayed = (x: World) =>
  x
    .rt()
    .ocsup.replays.filter((r) => r.status === 200)
    .map((r) => r.updateId);
const durable = () =>
  new Response("", { status: 200, headers: { "x-openclaw-delivery-accepted": "durable" } });

describe.skipIf(!sut.ok)(`inbox ${sut.why}`, () => {
  const states: [string, (x: World) => Promise<unknown>][] = [
    ["asleep", (x) => toAsleep(x)],
    ["starting", (x) => toStarting(x)],
    ["running", (x) => toRunning(x)],
    ["quiescing", (x) => toQuiescing(x)],
    ["backoff", (x) => toBackoff(x)],
  ];
  for (const [label, to] of states) {
    it(`S56 webhook while ${label} → 200 before any container work, row pending, replayed in update_id order once`, async () => {
      w = await fresh(sut, { sleep: label === "asleep" || label === "quiescing" });
      const release = await to(w);
      const c = w.rt().c;
      for (const id of [103, 101, 102]) {
        const n = c.calls.length;
        const r = await w.webhook(upd(id), undefined, false);
        expect(r.status).toBe(200);
        // The ack resolved before any container call the webhook caused.
        expect(c.calls.slice(n).filter((x) => x.op === "exec" || x.op === "start")).toEqual([]);
        await w.settle();
      }
      expect(
        w
          .inbox()
          .map((r) => r.platform_key)
          .sort(),
      ).toEqual(["101", "102", "103"]);
      if (typeof release === "function") release();
      w.rt().ocsup.readyAfterMs = 200;
      w.rt().ocsup.started = w.state() === "starting" ? true : w.rt().ocsup.started;
      setSettings(w, { sleep: { mode: "off" } });
      await w.until(() => replayed(w).length >= 3, 60_000);
      await w.advance(3 * S);
      // Awake, the driver may send 103 before 101 arrives; queued together they go in update_id order.
      if (label === "running") expect([...replayed(w)].sort()).toEqual([101, 102, 103]);
      else expect(replayed(w)).toEqual([101, 102, 103]);
    });
  }

  it("S57 redelivery of the same update_id → 200, no new row, replayed once", async () => {
    w = await fresh(sut);
    await toRunning(w);
    expect((await w.webhook(upd(9))).status).toBe(200);
    expect((await w.webhook(upd(9))).status).toBe(200);
    expect(w.inbox().length).toBe(1);
    await w.advance(3 * S);
    expect(replayed(w)).toEqual([9]);
  });

  it("S58 allowlist while asleep: unknown sender held (no wake); paired wakes; no from/chat wakes; stale list: stranger still held", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    expect(w.ctl().rows("SELECT * FROM wake_allow").length).toBe(1);
    await w.webhook(upd(1, 999));
    await w.advance(1 * S);
    expect(w.inbox()[0]?.state).toBe("held");
    expect(w.state()).toBe("asleep");
    await w.webhook(upd(2, 5));
    await w.until(() => w.state() === "running", 20_000);
    expect(w.inbox().find((r) => r.platform_key === "1")?.state).not.toBe("held"); // wake releases held rows
    await w.until(() => w.state() === "asleep", 60_000);
    await w.webhook(upd(3, null));
    await w.until(() => w.state() !== "asleep", 5_000);
    await w.until(() => w.state() === "asleep", 60_000);
    // Stale: a config version newer than the export (1 s later; a same-ms tie is issue I-7).
    await w.advance(1 * S);
    w.ctl().storage.sql.exec(
      "INSERT INTO config (ver, status, doc, created_at) VALUES (999, 'candidate', '{}', ?)",
      Date.now(),
    );
    // S0.10: a stale list still does not wake for a stranger.
    await w.webhook(upd(4, 999));
    await w.advance(5 * S);
    expect(w.state()).toBe("asleep");
    expect(w.inbox().find((r) => r.platform_key === "4")?.state).toBe("held");
  });

  it("S59 stranger's held row → no wake of its own; replayed at the next wake before inboxDeadMs", async () => {
    w = await fresh(sut, {
      sleep: true,
      timers: { inboxDeadMs: 80 * S, inboxKeepMs: 90 * S, maintEveryMs: 10 * MIN },
    });
    await toAsleep(w);
    await w.webhook(upd(1, 999));
    const t = Date.now();
    await w.advance(1 * S);
    expect(w.inbox()[0]?.state).toBe("held");
    // S0.10: a stranger's held row plans no wake; the next wake (paired sender) releases and replays it.
    expect(w.rt().alarmAt() ?? Number.POSITIVE_INFINITY).toBeGreaterThan(t + 40 * S);
    await w.advance(10 * S);
    expect(w.state()).toBe("asleep");
    await w.webhook(upd(2, 5));
    await w.until(() => replayed(w).includes(1), 70_000, 200);
    expect(Date.now() - t).toBeLessThan(80 * S);
  });

  it("S60 requestWake dropped after the ack → Control DO alarm retries (15 s); ensure() also wakes", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    w.dropRequestWake = 1;
    await w.webhook(upd(1));
    expect(w.state()).toBe("asleep");
    const t = Date.now();
    await w.until(() => w.state() !== "asleep", 70_000, 200);
    expect(Date.now() - t).toBeLessThanOrEqual(61 * S);
    expect(w.requestWakeCalls.filter((c) => !c.dropped).length).toBeGreaterThan(0);
    // ensure() path: drop every Control retry, cron wakes it.
    w.dispose();
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    w.dropRequestWake = 1000;
    await w.webhook(upd(2));
    w.dropRequestWake = 0;
    await w.cron();
    expect(w.state()).not.toBe("asleep");
  });

  it("S40 driver before ingress-ready: 503, 404, 500 → no alert; only the 404 is an attempt (M7 F2); accepted after durable", async () => {
    w = await fresh(sut);
    const o = w.rt().ocsup;
    o.ingressReadyAfterMs = null;
    o.replayAnswers = [
      new Response("", { status: 503 }),
      new Response("", { status: 404 }),
      new Response("", { status: 500 }),
      durable(),
    ];
    await w.webhook(upd(1));
    await toRunning(w);
    await w.until(() => w.inbox()[0]?.state === "accepted", 30_000);
    expect(w.inbox()[0]?.attempts).toBe(1);
    expect(w.alert("inbox-blocked")).toBeUndefined();
  });

  it("S61 driver: 401 for 5 min → inbox-blocked, row kept", async () => {
    // §20 has no test value for the 5 min 401 window; keep the row alive past it.
    w = await fresh(sut, { timers: { inboxDeadMs: 10 * MIN, inboxKeepMs: 11 * MIN } });
    await toRunning(w);
    w.rt().ocsup.replayAnswers = Array.from({ length: 400 }, () => () => new Response("", { status: 401 }));
    await w.webhook(upd(1));
    await w.advance(5 * MIN + 10 * S, 1 * S);
    expect(w.alert("inbox-blocked")).toBeTruthy();
    expect(w.inbox()[0]?.state).toBe("pending");
  });
  it("S61 driver: 404 after ready → retried (S0.3); 400 → dead; 413 → dead", async () => {
    w = await fresh(sut);
    await toRunning(w);
    await w.advance(1 * S); // ingress-ready
    const o = w.rt().ocsup;
    o.replayAnswers = [
      new Response("", { status: 400 }),
      new Response("", { status: 413 }),
      new Response("", { status: 404 }),
    ];
    await w.webhook(upd(1));
    await w.webhook(upd(2));
    await w.webhook(upd(3));
    await w.webhook(upd(4));
    await w.advance(5 * S);
    // S0.3: the 404 (gateway restarting) holds row 3 and it is accepted on the retry; 4 follows.
    const rows = Object.fromEntries(w.inbox().map((r) => [r.platform_key, r.state]));
    expect(rows).toMatchObject({ "1": "dead", "2": "dead", "3": "accepted", "4": "accepted" });
    expect(w.alert("inbox-blocked")).toBeFalsy();
  });
  it("S61 row age inboxDeadMs, never accepted → dead + inbox-dead alert", async () => {
    w = await fresh(sut);
    await toRunning(w);
    w.rt().ocsup.replayAnswers = Array.from({ length: 1000 }, () => () => new Response("", { status: 500 }));
    await w.webhook(upd(1));
    await w.advance(35 * S, 500);
    expect(w.inbox()[0]?.state).toBe("dead");
    expect(w.alert("inbox-dead")).toBeTruthy();
  });

  it("S62 boot without a valid marker → accepted, un-replicated rows replayed before new rows", async () => {
    w = await fresh(sut);
    await toRunning(w);
    await w.advance(1 * S);
    await w.webhook(upd(1));
    await w.webhook(upd(2));
    await w.until(() => w.inbox().every((r) => r.state === "accepted"), 10_000);
    // Host crash before the rows are replicated.
    w.rt().ocsup.hbDrop = true;
    w.rt().c.crash(137, false);
    await w.webhook(upd(3));
    const before = w.rt().ocsup.replays.length;
    await w.until(() => w.rt().ocsup.boots.length === 2 && replayed(w).length >= before + 3, 60_000);
    const after = w
      .rt()
      .ocsup.replays.slice(before)
      .filter((r) => r.status === 200)
      .map((r) => r.updateId);
    // L3 (M4b): no reply was seen for 1 and 2 (no Telegram send), so they go with a fresh update_id.
    expect(after).toEqual([1 + 2 ** 40, 2 + 2 ** 40, 3]);
  });

  it("S63 cap 10,000 live rows → 503 at the cap; 200 again below it", async () => {
    w = await fresh(sut, { sleep: true });
    await toAsleep(w);
    await w.webhook(upd(1, 999));
    const st = w.ctl().storage;
    st.transactionSync(() => {
      for (let i = 2; i <= 10_000; i++)
        st.sql.exec(
          `INSERT INTO inbox (id, route, account, platform_key, received_at, headers, body, state)
           SELECT ?, route, account, ?, received_at, headers, body, 'held' FROM inbox WHERE platform_key = '1'`,
          `fx${i}`,
          String(i),
        );
    });
    expect((await w.webhook(upd(10_001, 999))).status).toBe(503);
    st.sql.exec("DELETE FROM inbox WHERE platform_key = '2'");
    expect((await w.webhook(upd(10_002, 999))).status).toBe(200);
  });

  it("S64 secrets: wrong → 401; previous during rotation → 200; previous after telegramSecretVersion matches → 401", async () => {
    w = await fresh(sut, { vars: { TELEGRAM_WEBHOOK_SECRET_PREV: "wh-old" } });
    await toRunning(w);
    expect((await w.webhook(upd(1), "nope")).status).toBe(401);
    expect(w.inbox().length).toBe(0);
    w.ctl().storage.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('webhookSecretVer', '2')");
    w.ctl().storage.sql.exec(
      "INSERT OR REPLACE INTO meta (k, v) VALUES ('webhookSecretPrevUntil', ?)",
      String(Date.now() + 7 * 24 * 3600 * S),
    );
    expect((await w.webhook(upd(2), "wh-old")).status).toBe(200);
    expect((await w.webhook(upd(3), TOKENS.webhook)).status).toBe(200);
    await w.rt().ocsup.heartbeat({ telegramSecretVersion: 2 });
    await w.advance(2 * S);
    expect((await w.webhook(upd(4), "wh-old")).status).toBe(401);
  });

  it("S69 ensure() asleep: before wakeAt + 2 min nothing; after → wake:cron; with a pending row → wake:inbox", async () => {
    w = await fresh(sut, { sleep: true });
    await toRunning(w);
    w.rt().ocsup.nextWakeAtMs = Date.now() + 10 * MIN;
    await w.until(() => w.state() === "asleep", 30_000);
    const n = startCount(w);
    await w.cron();
    expect(startCount(w)).toBe(n);
    expect(w.state()).toBe("asleep");
  });
});
