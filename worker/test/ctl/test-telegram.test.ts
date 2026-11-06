// Test installs: the Worker's own Bot API calls go to a fake that rings; other URLs pass through.
import { describe, expect, it } from "vitest";
import { testTelegramFetch } from "../../src/ctl/test-telegram";
import { sendTyping, tgCall } from "../../src/ctl/typing";

describe("testTelegramFetch", () => {
  it("answers typing and progress calls and records them", async () => {
    const rung: { s: string; k: string; d: unknown }[] = [];
    const real = (() => Promise.reject(new Error("real fetch must not run"))) as unknown as typeof fetch;
    const f = testTelegramFetch(
      real,
      (s, k, d) => void rung.push({ s, k, d }),
      () => 5,
    );
    expect(await sendTyping(f, "1:FAKE", 42)).toBe(200);
    let id: unknown;
    expect(
      await tgCall(f, "1:FAKE", "sendMessage", { chat_id: 42, text: "Waking up" }, (j) => {
        id = (j as { result: { message_id: number } }).result.message_id;
      }),
    ).toBe(200);
    expect(typeof id).toBe("number");
    expect(await tgCall(f, "1:FAKE", "editMessageText", { chat_id: 42, message_id: id, text: "x" })).toBe(
      200,
    );
    expect(rung.map((r) => r.k)).toEqual([
      "worker sendChatAction",
      "worker sendMessage",
      "worker editMessageText",
    ]);
    expect(rung[2]).toMatchObject({ s: "telegram", d: { chatId: 42, messageId: id, text: "x", at: 5 } });
    expect(JSON.stringify(rung)).not.toContain("FAKE");
  });
  it("passes other URLs to the real fetch", async () => {
    const real = (async () => new Response("ok")) as unknown as typeof fetch;
    const f = testTelegramFetch(real, () => undefined);
    expect(await (await f("https://example.com/")).text()).toBe("ok");
  });
});
