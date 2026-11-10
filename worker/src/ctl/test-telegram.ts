// Test installs only (OC_TEST=1, ochost init --fake-telegram): the Worker's own Bot API calls (typing, the
// "Waking up" progress message and its edits) go to a fake, not to api.telegram.org, where the fake bot token
// gets 401. Each call lands in the ring as src "telegram", kind "worker <method>". Prod never uses this.

const PREFIX = "https://api.telegram.org/bot";

export type TestRing = (src: string, kind: string, detail?: unknown) => unknown;

export function testTelegramFetch(
  real: typeof fetch,
  ring: TestRing,
  now: () => number = Date.now,
): typeof fetch {
  let nextId = 1000;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(PREFIX)) return real(input, init);
    const method = url.slice(url.indexOf("/", PREFIX.length) + 1);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const id = method === "sendMessage" ? nextId++ : undefined;
    await ring("telegram", `worker ${method}`, {
      at: now(),
      chatId: body.chat_id,
      messageId: id ?? body.message_id,
      text: typeof body.text === "string" ? body.text.slice(0, 200) : undefined,
    });
    return Response.json({
      ok: true,
      result: id === undefined ? true : { message_id: id, chat: { id: body.chat_id, type: "private" } },
    });
  }) as typeof fetch;
}
