// Cold-path typing: first sendChatAction from the Worker at ack time, repeats from the Control DO alarm every 4 s
// until a reply, a dead row or 60 s. Fake Telegram = the world's fetch.
import { describe, expect, it } from "vitest";
import { TYPING_EVERY_MS, TYPING_MAX_MS, typingDueAt } from "../../src/ctl/typing";
import { handleWebhook } from "../../src/ctl/webhook";
import { tg, type World, world } from "./world";

const TOKEN = "123:TESTTOKEN";
const actions = (w: World) =>
  w.sent
    .filter((s) => s.url === `https://api.telegram.org/bot${TOKEN}/sendChatAction`)
    .map((s) => JSON.parse(s.body) as { chat_id: string; action: string });

function cold(state: "asleep" | "starting" = "asleep", token: string | null = TOKEN, real = false) {
  const w = world({ real });
  w.ctx.secrets.botToken = token ?? undefined;
  w.install();
  w.api.noteRtState(1, state);
  w.rt(1).state = state;
  return w;
}
const put = (w: World, id: number, chat = 111) =>
  w.api.inboxPut({ body: tg(id, chat), headers: { host: "oc.example.workers.dev" } });

describe("cold-path typing", () => {
  it("asleep: put names the chat; repeats every 4 s, 14 sends in 60 s, then stops", async () => {
    const w = cold("asleep", TOKEN, true); // real timers: the test preset kills a row after 30 s
    expect(put(w, 1, 555)).toMatchObject({ wake: true, typing: "555" });
    expect(typingDueAt(w.ctx)).toBe(w.clock.t + TYPING_EVERY_MS);
    await w.api.tick();
    expect(actions(w)).toHaveLength(0); // the Worker sends the first one, not the alarm
    for (let t = 0; t < TYPING_MAX_MS + 8_000; t += 1_000) {
      w.advance(1_000);
      await w.api.tick();
    }
    const got = actions(w);
    expect(got.length).toBe(14); // at 4, 8, ... 56 s; the 60 s tick is past the limit
    expect(got.every((a) => a.chat_id === "555" && a.action === "typing")).toBe(true);
    expect(typingDueAt(w.ctx)).toBeNull();
  });

  it("starting counts as cold; a reply to the chat stops the repeats", async () => {
    const w = cold("starting");
    expect(put(w, 1, 9)).toMatchObject({ typing: "9" });
    w.advance(TYPING_EVERY_MS);
    await w.api.tick();
    expect(actions(w)).toHaveLength(1);
    // the gateway accepts the row, then sends its first message to that chat
    w.db.run("UPDATE inbox SET state = 'accepted', accepted_at = ?", w.clock.t);
    w.advance(1_000);
    w.core.noteOutbound(9, w.clock.t, "sendMessage");
    w.advance(TYPING_EVERY_MS);
    await w.api.tick();
    expect(actions(w)).toHaveLength(1);
    expect(typingDueAt(w.ctx)).toBeNull();
  });

  it("a typing action from the gateway is not a reply", async () => {
    const w = cold();
    put(w, 1, 9);
    w.db.run("UPDATE inbox SET state = 'accepted', accepted_at = ?", w.clock.t);
    w.core.noteOutbound(9, w.clock.t + 1, "sendChatAction");
    w.advance(TYPING_EVERY_MS);
    await w.api.tick();
    expect(actions(w)).toHaveLength(1);
  });

  it("no typing when warm, without a token, or for a duplicate", () => {
    const warm = cold("asleep");
    warm.api.noteRtState(1, "running");
    warm.db.setMeta("driver", { gen: 1, epoch: 1, ready: true, active: true, queues: {} });
    expect(put(warm, 1)).not.toHaveProperty("typing");
    expect(put(cold("asleep", null), 1)).not.toHaveProperty("typing");
    const dup = cold();
    put(dup, 1);
    expect(put(dup, 1)).not.toHaveProperty("typing");
  });

  it("running but ingress not ready is cold", () => {
    const w = cold("asleep");
    w.api.noteRtState(1, "running");
    w.db.setMeta("driver", { gen: 1, epoch: 1, ready: false, active: true, queues: {} });
    expect(put(w, 1)).toMatchObject({ typing: "111" });
  });

  it("a 403 (bot blocked) drops the chat; a 429 keeps it", async () => {
    const w = cold();
    put(w, 1, 5);
    w.setSink(429);
    w.advance(TYPING_EVERY_MS);
    await w.api.tick();
    expect(typingDueAt(w.ctx)).not.toBeNull();
    w.setSink(403);
    w.advance(TYPING_EVERY_MS);
    await w.api.tick();
    expect(typingDueAt(w.ctx)).toBeNull();
  });

  it("the alarm is planned no later than the next repeat", () => {
    const w = cold();
    put(w, 1);
    expect(w.api.nextAlarmAt() as number).toBeLessThanOrEqual(w.clock.t + TYPING_EVERY_MS);
  });

  it("webhook handler sends the first action through waitUntil after the 200", async () => {
    const w = cold();
    const calls: string[] = [];
    const pending: Promise<unknown>[] = [];
    const res = await handleWebhook(
      new Request("https://oc.example.workers.dev/telegram-webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "s" },
        body: tg(1, 42),
      }),
      {
        env: { TELEGRAM_WEBHOOK_SECRET: "s" },
        ctl: { inboxPut: async (p: never) => w.api.inboxPut(p), webhookPrevOk: async () => false },
        wake: async () => undefined,
        typing: async (chat) => void calls.push(chat),
        waitUntil: (p) => void pending.push(p),
      },
    );
    await Promise.all(pending);
    expect([res.status, calls]).toEqual([200, ["42"]]);
  });
});
