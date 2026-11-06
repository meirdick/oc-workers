// Fake Telegram Bot API (api.telegram.org) and mock LLM (api.anthropic.com), test groups only (OC_TEST=1,
// spec §2.1, §21.3 L-4). From spike/worker/src/gates/fakes.ts. Reached through interceptOutboundHttps; the
// container must trust the CF containers CA (NODE_EXTRA_CA_CERTS). Every call goes to the Control DO ring
// (src "telegram" / "llm"), so a live test reads replies through /ops/events. The bot token is never logged.

/** Where a fake records its calls. The entrypoint maps it to the Control DO ring (GatePort.ring). */
export interface FakeSink {
  gateEvent(kind: string, msg: string, data?: unknown): Promise<void> | void;
  /** L3: outbound Bot API call to a chat (reply tracking in the Control DO inbox). */
  outbound?(chatId: string | number | null, at: number, method: string): Promise<void> | void;
}
type RtSink = FakeSink;

type Rec = Record<string, unknown>;

async function bodyOf(req: Request): Promise<Rec> {
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) return ((await req.json()) as Rec) ?? {};
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const f = await req.formData();
      const o: Rec = {};
      for (const [k, v] of f.entries()) o[k] = typeof v === "string" ? v : `[file ${(v as File).name}]`;
      return o;
    }
  } catch {
    return {};
  }
  return {};
}

const BOT = {
  id: 7000000001,
  is_bot: true,
  first_name: "oc-host-test",
  username: "oc_host_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

export class TelegramState {
  webhookUrl = "";
  nextMessageId = 1;
}

export async function handleTelegram(
  req: Request,
  rt: RtSink,
  st: TelegramState,
  now: () => number = Date.now,
): Promise<Response> {
  const url = new URL(req.url);
  const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
  if (!m) {
    await rt.gateEvent("telegram", `unknown path ${url.pathname}`);
    return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
  }
  const method = m[2] as string;
  const allBody = await bodyOf(req);
  const body = { ...Object.fromEntries(url.searchParams), ...allBody };
  const ok = (result: unknown) => Response.json({ ok: true, result });
  const at = now();
  let res: Response;
  switch (method) {
    case "getMe":
      res = ok(BOT);
      break;
    case "setWebhook":
      st.webhookUrl = String(body.url ?? "");
      res = Response.json({ ok: true, result: true, description: "Webhook was set" });
      break;
    case "deleteWebhook":
      st.webhookUrl = "";
      res = Response.json({ ok: true, result: true, description: "Webhook was deleted" });
      break;
    case "getWebhookInfo":
      res = ok({ url: st.webhookUrl, has_custom_certificate: false, pending_update_count: 0 });
      break;
    case "getUpdates":
      res = ok([]);
      break;
    case "sendMessage":
      res = ok({
        message_id: st.nextMessageId++,
        date: Math.floor(at / 1000),
        chat: { id: Number(body.chat_id) || body.chat_id, type: "private" },
        from: BOT,
        text: String(body.text ?? ""),
      });
      break;
    case "sendChatAction":
    case "setMyCommands":
    case "deleteMyCommands":
    case "answerCallbackQuery":
    case "setMessageReaction":
      res = ok(true);
      break;
    case "getMyCommands":
      res = ok([]);
      break;
    default:
      res = ok(true);
  }
  if (body.chat_id !== undefined) await rt.outbound?.(body.chat_id as string | number, at, method);
  // Never log the bot token from the path.
  await rt.gateEvent("telegram", method, {
    at,
    chatId: body.chat_id,
    text: typeof body.text === "string" ? body.text.slice(0, 200) : undefined,
    url: method === "setWebhook" ? st.webhookUrl : undefined,
  });
  return res;
}

const blockText = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c
          .map((p) => (p && typeof p === "object" ? String((p as { text?: unknown }).text ?? "") : ""))
          .join("")
      : "";

/**
 * Scripted turn (M7 live check): the last user text holds `SCRIPT:<base64 JSON [{name, args}]>`. Each call answers
 * the next tool_use (count = tool_result blocks after that message); when done it answers `FINAL <results JSON>`.
 * Returns null when the request holds no script.
 */
export function nextScript(
  messages: unknown,
): { call: { name: string; args: unknown }; n: number } | { text: string } | null {
  if (!Array.isArray(messages)) return null;
  let u = -1;
  let steps: { name: string; args: unknown }[] = [];
  let payload = "";
  // The newest SCRIPT user message names the script; OpenClaw may re-append the user text after tool results, so
  // the turn starts at the first message that carries the same payload.
  for (let i = messages.length - 1; i >= 0 && !payload; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    const x = /SCRIPT:([A-Za-z0-9+/=]+)/.exec(m.role === "user" ? blockText(m.content) : "");
    if (x) {
      try {
        steps = JSON.parse(atob(x[1] as string)) as typeof steps;
        payload = x[1] as string;
      } catch {}
    }
  }
  if (!payload) return null;
  for (let i = 0; i < messages.length && u < 0; i++) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role === "user" && blockText(m.content).includes(`SCRIPT:${payload}`)) u = i;
  }
  const results: string[] = [];
  for (const m of messages.slice(u + 1) as { content?: unknown }[])
    if (Array.isArray(m.content))
      for (const b of m.content as { type?: string; content?: unknown }[])
        if (b?.type === "tool_result") results.push(blockText(b.content));
  const step = steps[results.length];
  return step ? { call: step, n: results.length } : { text: `FINAL ${JSON.stringify(results)}` };
}

/** Role and block types of the last messages, for the scripted-turn ring event (no text). */
function shapeOf(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  return (messages as { role?: string; content?: unknown }[]).slice(-5).map((m) => {
    const c = m.content;
    const kinds = Array.isArray(c)
      ? c.map((b) => String((b as { type?: string })?.type)).join("+")
      : typeof c;
    return `${m.role}:${kinds}`;
  });
}

export async function handleLlm(
  req: Request,
  rt: RtSink,
  reply: string,
  now: () => number = Date.now,
  slowMs = 0,
): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/v1/models") {
    await rt.gateEvent("llm", "models");
    return Response.json({
      data: [
        { type: "model", id: "claude-oc-mock", display_name: "oc mock", created_at: "2026-01-01T00:00:00Z" },
      ],
      has_more: false,
      first_id: "claude-oc-mock",
      last_id: "claude-oc-mock",
    });
  }
  if (req.method !== "POST" || url.pathname !== "/v1/messages") {
    await rt.gateEvent("llm", `unknown ${req.method} ${url.pathname}`);
    return Response.json(
      { type: "error", error: { type: "not_found_error", message: "oc mock: not found" } },
      { status: 404 },
    );
  }
  const raw = await req.text().catch(() => "");
  let b: { model?: string; stream?: boolean; messages?: unknown } = {};
  try {
    b = JSON.parse(raw) as typeof b;
  } catch {}
  const script = nextScript(b.messages);
  if (script) reply = "text" in script ? script.text : reply;
  const toolUse =
    script && "call" in script
      ? {
          type: "tool_use",
          id: `toolu_oc_${script.n}_${now()}`,
          name: script.call.name,
          input: script.call.args,
        }
      : null;
  // M4b L3 live check: a prompt with the marker `m4b-slow` waits slowMs before the answer, so a kill can land
  // after the ingress event is completed and before the reply is sent.
  if (slowMs > 0 && raw.includes("m4b-slow")) {
    await rt.gateEvent("llm", "slow", { at: now(), ms: slowMs });
    await new Promise((r) => setTimeout(r, slowMs));
  }
  const model = b.model ?? "claude-oc-mock";
  const id = `msg_oc_${now()}`;
  const usage = { input_tokens: 10, output_tokens: 5 };
  await rt.gateEvent("llm", "messages", {
    at: now(),
    model,
    stream: !!b.stream,
    ...(script ? { shape: shapeOf(b.messages), next: toolUse ? toolUse.name : "final" } : {}),
  });
  if (!b.stream) {
    return Response.json({
      id,
      type: "message",
      role: "assistant",
      model,
      content: [toolUse ?? { type: "text", text: reply }],
      stop_reason: toolUse ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage,
    });
  }
  const ev = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const sse =
    ev("message_start", {
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    }) +
    (toolUse
      ? ev("content_block_start", { index: 0, content_block: { ...toolUse, input: {} } }) +
        ev("content_block_delta", {
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(toolUse.input) },
        })
      : ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } })) +
    ev("content_block_stop", { index: 0 }) +
    ev("message_delta", {
      delta: { stop_reason: toolUse ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    }) +
    ev("message_stop", {});
  return new Response(sse, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
