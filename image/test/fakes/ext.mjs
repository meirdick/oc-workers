// Fake external APIs for M1: Telegram Bot API and a mock LLM (Anthropic Messages + OpenAI Chat).
// usage: node ext.mjs telegram|llm. Serves :443 (TLS, test CA leaf from /t/.tls) and :80.
// Every call is sent to the fake gate record log (POST 15.0.0.1:9000/_ctl/record), never the bot token.
// Harness API on :9000: POST /_enqueue {update} (telegram getUpdates), POST /_reply {text, delayMs} (llm).
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const role = process.argv[2];
const GATE_CTL = process.env.OCM1_GATE_CTL || "http://15.0.0.1:9000";
const st = {
  webhookUrl: "",
  nextMessageId: 1,
  updates: [],
  nextUpdateId: 1,
  reply: "m1 mock reply",
  delayMs: 0,
  chunks: 0, // >1: the Anthropic stream sends the reply in this many deltas spread over delayMs
};

function record(kind, ev, fields = {}) {
  const body = JSON.stringify({ plane: kind, route: ev, ...fields });
  fetch(`${GATE_CTL}/_ctl/record`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}
const readBody = (req) =>
  new Promise((resolve) => {
    const parts = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
  });
function parse(req, raw) {
  const ct = req.headers["content-type"] || "";
  try {
    if (ct.includes("json")) return JSON.parse(raw || "{}");
    if (ct.includes("x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  } catch {}
  return {};
}
const json = (res, status, obj, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
};

const BOT = {
  id: 7000000001,
  is_bot: true,
  first_name: "oc-m1",
  username: "oc_m1_bot",
  can_join_groups: true,
};

async function telegram(req, res, raw) {
  const u = new URL(req.url, "http://x");
  const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(u.pathname);
  if (!m) return json(res, 404, { ok: false, error_code: 404, description: "Not Found" });
  const method = m[2];
  const body = { ...Object.fromEntries(u.searchParams), ...parse(req, raw) };
  const ok = (result) => json(res, 200, { ok: true, result });
  record("tg", method, {
    tls: !!req.socket.encrypted,
    chatId: body.chat_id,
    text: typeof body.text === "string" ? body.text.slice(0, 200) : undefined,
    url: method === "setWebhook" ? String(body.url || "") : undefined,
  });
  switch (method) {
    case "getMe":
      return ok(BOT);
    case "setWebhook":
      st.webhookUrl = String(body.url || "");
      return json(res, 200, { ok: true, result: true, description: "Webhook was set" });
    case "deleteWebhook":
      st.webhookUrl = "";
      return json(res, 200, { ok: true, result: true, description: "Webhook was deleted" });
    case "getWebhookInfo":
      return ok({
        url: st.webhookUrl,
        has_custom_certificate: false,
        pending_update_count: st.updates.length,
      });
    case "getUpdates": {
      const off = Number(body.offset || 0);
      st.updates = st.updates.filter((x) => x.update_id >= off);
      if (!st.updates.length)
        await new Promise((r) => setTimeout(r, Math.min(Number(body.timeout || 0), 5) * 1000));
      return ok(st.updates.slice(0, 100));
    }
    case "sendMessage":
      return ok({
        message_id: st.nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(body.chat_id) || body.chat_id, type: "private" },
        from: BOT,
        text: String(body.text || ""),
      });
    case "editMessageText":
      return ok({
        message_id: Number(body.message_id),
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(body.chat_id) || body.chat_id, type: "private" },
        from: BOT,
        text: String(body.text || ""),
      });
    case "getMyCommands":
      return ok([]);
    default:
      return ok(true);
  }
}

async function llm(req, res, raw) {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  if (req.method === "GET" && /\/v1\/models$/.test(p)) {
    record("llm", "models");
    return json(res, 200, {
      object: "list",
      data: [
        {
          type: "model",
          id: "m1-mock",
          object: "model",
          display_name: "m1 mock",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      has_more: false,
    });
  }
  const b = parse(req, raw);
  const spread = st.chunks > 1 && b.stream;
  if (st.delayMs && !spread) await new Promise((r) => setTimeout(r, st.delayMs));
  const model = b.model || "m1-mock";
  if (req.method === "POST" && /\/v1\/messages$/.test(p)) {
    record("llm", "anthropic.messages", {
      model,
      stream: !!b.stream,
      key: !!req.headers["x-api-key"],
      tls: !!req.socket.encrypted,
    });
    const id = `msg_m1_${Date.now()}`;
    if (!b.stream)
      return json(res, 200, {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: st.reply }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (spread) {
      const words = st.reply.split(" ");
      const per = Math.ceil(words.length / st.chunks);
      res.write(
        ev("message_start", {
          message: {
            id,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        }) + ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      );
      for (let i = 0; i < words.length; i += per) {
        await new Promise((r) => setTimeout(r, st.delayMs / st.chunks));
        const text = `${i ? " " : ""}${words.slice(i, i + per).join(" ")}`;
        res.write(ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
      }
      res.end(
        ev("content_block_stop", { index: 0 }) +
          ev("message_delta", {
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 5 },
          }) +
          ev("message_stop", {}),
      );
      return;
    }
    res.end(
      ev("message_start", {
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      }) +
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: st.reply } }) +
        ev("content_block_stop", { index: 0 }) +
        ev("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        }) +
        ev("message_stop", {}),
    );
    return;
  }
  if (req.method === "POST" && /\/chat\/completions$/.test(p)) {
    record("llm", "openai.chat", {
      model,
      stream: !!b.stream,
      key: !!req.headers.authorization,
      tls: !!req.socket.encrypted,
    });
    const id = `chatcmpl-m1-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    if (!b.stream)
      return json(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: st.reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, fin) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`;
    res.end(`${chunk({ role: "assistant", content: st.reply }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
    return;
  }
  record("llm", `unknown ${req.method} ${p}`);
  return json(res, 404, { type: "error", error: { type: "not_found_error", message: "m1 mock: not found" } });
}

const handler = async (req, res) => {
  const raw = await readBody(req);
  try {
    if (role === "telegram") return await telegram(req, res, raw);
    return await llm(req, res, raw);
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
};
http.createServer(handler).listen(80, "0.0.0.0");
try {
  https
    .createServer(
      { key: fs.readFileSync("/t/.tls/leaf.key"), cert: fs.readFileSync("/t/.tls/leaf.pem") },
      handler,
    )
    .listen(443, "0.0.0.0");
} catch (e) {
  console.log(JSON.stringify({ ev: "no-tls", err: String(e) }));
}
http
  .createServer(async (req, res) => {
    const raw = await readBody(req);
    const b = parse({ headers: { "content-type": "application/json" } }, raw);
    if (req.url === "/_enqueue") {
      st.updates.push({ update_id: st.nextUpdateId++, ...b.update });
      return json(res, 200, { ok: true, n: st.updates.length });
    }
    if (req.url === "/_reply") {
      if (typeof b.text === "string") st.reply = b.text;
      if (Number.isFinite(b.delayMs)) st.delayMs = b.delayMs;
      if (Number.isFinite(b.chunks)) st.chunks = b.chunks;
      return json(res, 200, { ok: true });
    }
    if (req.url === "/_state")
      return json(res, 200, { webhookUrl: st.webhookUrl, queued: st.updates.length });
    json(res, 404, {});
  })
  .listen(9000, "0.0.0.0", () => console.log(JSON.stringify({ ev: "ext listening", role })));
