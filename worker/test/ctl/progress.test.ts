// Wake progress message: one per chat per wake, edited with phase + elapsed seconds, removed (or "Ready in N s")
// when the gateway's first outbound send to the chat is seen. Fake Telegram = ctx.fetch.
import { describe, expect, it } from "vitest";
import { PROGRESS_EVERY_MS, progressDueAt } from "../../src/ctl/progress";
import { handleWebhook } from "../../src/ctl/webhook";
import { tg, type World, world } from "./world";

const TOKEN = "123:TESTTOKEN";
interface Call {
  method: string;
  body: Record<string, unknown>;
}

function cold(state: "asleep" | "starting" | "running" = "asleep", mode?: "delete" | "ready" | "off") {
  const w = world({
    real: true,
    settings: mode ? ({ telegram: { wakeProgress: mode } } as never) : undefined,
  });
  w.ctx.secrets.botToken = TOKEN;
  const calls: Call[] = [];
  w.ctx.fetch = (async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop() as string;
    calls.push({ method, body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true, result: { message_id: 900 } });
  }) as unknown as typeof fetch;
  w.install();
  w.api.noteRtState(1, state);
  w.rt(1).state = state;
  return { w, calls };
}
const put = (w: World, id: number, chat = 111) =>
  w.api.inboxPut({ body: tg(id, chat), headers: { host: "oc.example.workers.dev" } });
const of = (calls: Call[], m: string) => calls.filter((c) => c.method === m);

describe("wake progress", () => {
  it("asleep: first update asks for the message; a second update to the same chat shares it", () => {
    const { w } = cold();
    expect(put(w, 1, 5)).toMatchObject({ progress: "5" });
    expect(put(w, 2, 5)).not.toHaveProperty("progress");
    expect(put(w, 3, 6)).toMatchObject({ progress: "6" });
  });

  it("never into a chat that did not write: bot added to a group, reactions, service messages", () => {
    const { w, calls } = cold();
    const raw = (u: Record<string, unknown>) =>
      w.api.inboxPut({ body: JSON.stringify(u), headers: { host: "oc.example.workers.dev" } });
    const added = raw({
      update_id: 10,
      my_chat_member: { chat: { id: -100 }, from: { id: 111 }, new_chat_member: { status: "member" } },
    });
    expect(added).not.toHaveProperty("progress");
    expect(added).not.toHaveProperty("typing");
    const service = raw({
      update_id: 11,
      message: { message_id: 1, chat: { id: -101 }, from: { id: 111 }, new_chat_members: [{ id: 9 }] },
    });
    expect(service).not.toHaveProperty("progress");
    const react = raw({
      update_id: 12,
      message_reaction: { chat: { id: -102 }, user: { id: 111 }, message_id: 5 },
    });
    expect(react).not.toHaveProperty("progress");
    const bot = raw({
      update_id: 13,
      message: { message_id: 2, chat: { id: 7 }, from: { id: 8, is_bot: true }, text: "x" },
    });
    expect(bot).not.toHaveProperty("progress");
    expect(calls).toHaveLength(0);
    const button = raw({
      update_id: 14,
      callback_query: { id: "q", from: { id: 111 }, message: { message_id: 3, chat: { id: 77 } } },
    });
    expect(button).toMatchObject({ progress: "77", typing: "77" });
  });

  it("never when running, or without a token, or in mode off", () => {
    expect(put(cold("running").w, 1)).not.toHaveProperty("progress");
    const nt = cold();
    nt.w.ctx.secrets.botToken = undefined;
    expect(put(nt.w, 1)).not.toHaveProperty("progress");
    expect(put(cold("asleep", "off").w, 1)).not.toHaveProperty("progress");
  });

  it("the webhook handler sends the message once for N updates in one wake", async () => {
    const { w } = cold();
    const asked: string[] = [];
    const pending: Promise<unknown>[] = [];
    const d = {
      env: { TELEGRAM_WEBHOOK_SECRET: "s" },
      ctl: { inboxPut: async (p: never) => w.api.inboxPut(p), webhookPrevOk: async () => false },
      wake: async () => undefined,
      progress: async (chat: string) => void asked.push(chat),
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
    };
    for (const id of [1, 2, 3]) {
      const req = new Request("https://oc.example.workers.dev/telegram-webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "s" },
        body: tg(id, 42),
      });
      await handleWebhook(req, d);
    }
    await Promise.all(pending);
    expect(asked).toEqual(["42"]);
  });

  it("edits with the phase and elapsed seconds as the wake advances", async () => {
    const { w, calls } = cold();
    put(w, 1, 5);
    w.api.progressSent("5", 900);
    w.advance(PROGRESS_EVERY_MS);
    await w.api.tick();
    expect(of(calls, "editMessageText").at(-1)?.body).toMatchObject({
      chat_id: "5",
      message_id: 900,
      text: "Waking up: restoring (5 s)",
    });
    w.api.noteRtState(1, "starting");
    w.rt(1).state = "starting";
    w.core.event(1, { kind: "gateway-starting" });
    w.advance(PROGRESS_EVERY_MS);
    await w.api.tick();
    expect(of(calls, "editMessageText").at(-1)?.body.text).toBe("Waking up: starting gateway (10 s)");
    w.core.event(1, { kind: "startupz" });
    w.advance(PROGRESS_EVERY_MS);
    await w.api.tick();
    expect(of(calls, "editMessageText").at(-1)?.body.text).toBe("Waking up: almost ready (15 s)");
  });

  it("phase labels follow the ocsup events that reach the Control DO through the gate route", async () => {
    const { w, calls } = cold();
    put(w, 1, 5);
    w.api.progressSent("5", 900);
    w.api.noteRtState(1, "starting");
    w.rt(1).state = "starting";
    w.api.gateCall("event", [1, { kind: "gateway-starting" }]);
    w.advance(PROGRESS_EVERY_MS);
    await w.api.tick();
    expect(of(calls, "editMessageText").at(-1)?.body.text).toBe("Waking up: starting gateway (5 s)");
    w.api.gateCall("event", [1, { kind: "startupz" }]);
    w.advance(PROGRESS_EVERY_MS);
    await w.api.tick();
    expect(of(calls, "editMessageText").at(-1)?.body.text).toBe("Waking up: almost ready (10 s)");
  });

  it("first outbound send to the chat deletes the message; a send to another chat does not", async () => {
    const { w, calls } = cold();
    put(w, 1, 5);
    w.api.progressSent("5", 900);
    w.advance(3_000);
    w.core.noteOutbound(6, w.clock.t, "sendMessage");
    w.core.noteOutbound(5, w.clock.t, "sendChatAction"); // not a reply
    await w.api.tick();
    expect(of(calls, "deleteMessage")).toHaveLength(0);
    w.core.noteOutbound(5, w.clock.t, "sendMessage");
    await w.api.tick();
    expect(of(calls, "deleteMessage")).toEqual([
      { method: "deleteMessage", body: { chat_id: "5", message_id: 900 } },
    ]);
    expect(progressDueAt(w.ctx)).toBeNull();
    // a later wake gets a new message
    expect(put(w, 2, 5)).toMatchObject({ progress: "5" });
  });

  it("mode ready edits to 'Ready in N s' instead of deleting", async () => {
    const { w, calls } = cold("asleep", "ready");
    put(w, 1, 5);
    w.api.progressSent("5", 900);
    w.advance(27_400);
    w.core.noteOutbound(5, w.clock.t, "sendMessage");
    await w.api.tick();
    expect(of(calls, "deleteMessage")).toHaveLength(0);
    expect(of(calls, "editMessageText").at(-1)?.body).toMatchObject({
      message_id: 900,
      text: "Ready in 27 s",
    });
  });

  it("a reply seen before the Worker reports the message id still finishes it", async () => {
    const { w, calls } = cold();
    put(w, 1, 5);
    w.core.noteOutbound(5, w.clock.t, "sendMessage");
    await w.api.tick();
    expect(calls).toHaveLength(0);
    w.api.progressSent("5", 900);
    await w.api.tick();
    expect(of(calls, "deleteMessage")).toHaveLength(1);
  });

  it("a failed send drops the entry so the next update can try again", () => {
    const { w } = cold();
    put(w, 1, 5);
    w.api.progressSent("5", null);
    expect(put(w, 2, 5)).toMatchObject({ progress: "5" });
  });

  it("phase labels reset when the runtime sleeps", async () => {
    const { w, calls } = cold();
    w.core.event(1, { kind: "startupz" });
    w.api.noteRtState(1, "asleep");
    put(w, 1, 5);
    w.api.progressSent("5", 900);
    w.advance(PROGRESS_EVERY_MS);
    await w.api.tick();
    expect(of(calls, "editMessageText").at(-1)?.body.text).toBe("Waking up: restoring (5 s)");
  });
});
