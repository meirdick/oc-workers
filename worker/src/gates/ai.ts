// Model calls through the Workers AI binding (env.AI), no token. The binding authenticates as the account; with a
// gateway id it routes through AI Gateway (logs, spend limit). Used by CapGate /ai/v1 (gates/cap.ts).
// Chat: OpenAI chat.completions in, OpenAI out (streaming too), whichever shape the model returns.
// Embeddings: OpenAI embeddings in and out. Speech, transcription, images: the binding's native shapes.
// docs/09-llm-setup.md "Zero-token install".
import { estimateNeurons } from "./caps";

/** What the gate needs from `env.AI`. The real `Ai` is cast to this in entry.ts. */
export interface AiBinding {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: { gateway?: { id: string; skipCache?: boolean; cacheTtl?: number } },
  ): Promise<unknown>;
}

export interface AiCtx {
  ai: AiBinding;
  /** AI Gateway id; empty → the binding runs without a gateway (no logs, no spend limit). */
  gateway?: string;
  now: () => number;
  /** Charge neurons to today's budget. */
  charge: (neurons: number) => Promise<unknown>;
}

/** Workers AI ids and `anthropic/<model>` (key in the gateway BYOK store, alias `default`). Nothing else. */
export const CHAT_MODEL_RE = /^(@cf\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|anthropic\/[A-Za-z0-9._-]+)$/;
export const CF_MODEL_RE = /^@cf\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });
const oaiError = (status: number, message: string, code: string, headers: Record<string, string> = {}) =>
  json({ error: { message, type: "oc_host_ai", code } }, status, headers);

/** Run options: gateway routing, never the gateway cache for chat (an agent reply must not repeat). */
const gw = (c: AiCtx, skipCache: boolean) =>
  c.gateway ? { gateway: { id: c.gateway, ...(skipCache ? { skipCache: true } : {}) } } : undefined;

/** Binding errors → HTTP. 3040 capacity → 429 (OpenClaw retries); 5006 and other bad input → 400; else 502. */
function failure(e: unknown): Response {
  const msg = (e instanceof Error ? e.message : String(e)).slice(0, 400);
  if (/\b3040\b|capacity/i.test(msg)) return oaiError(429, msg, "capacity", { "retry-after": "2" });
  if (/\b5006\b|bad input|\b3010\b|invalid|too large|must be/i.test(msg))
    return oaiError(400, msg, "bad_input");
  return oaiError(502, msg, "upstream");
}

/** DeepSeek leaks `<ds_safety>` tags into content (docs/09). */
export const stripSafety = (s: string) => s.replace(/<\/?ds_safety>[^<]*(<\/ds_safety>)?/g, "").trim();

const CHAT_KEYS = [
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "response_format",
  "reasoning_effort",
  "chat_template_kwargs",
  "stream",
] as const;

/**
 * Gemma 4 has no `reasoning_effort`; its catalogue schema takes `chat_template_kwargs.enable_thinking` (default true).
 * OpenClaw sends an effort level, so the gate turns `none` into enable_thinking false and any other level into true.
 */
const THINKING_SWITCH_RE = /^@cf\/google\/gemma-4/;
function mapEffort(model: string, input: Record<string, unknown>): void {
  if (!THINKING_SWITCH_RE.test(model) || input.reasoning_effort === undefined) return;
  const effort = input.reasoning_effort;
  delete input.reasoning_effort;
  if (effort === null) return;
  const kw = (input.chat_template_kwargs ?? {}) as Record<string, unknown>;
  input.chat_template_kwargs = { ...kw, enable_thinking: effort !== "none" };
}

/** Reasoning text of a message or delta: OpenClaw reads `reasoning_content` and `reasoning`; `thinking` is renamed. */
const REASONING_KEYS = ["reasoning_content", "reasoning", "thinking"] as const;
const reasoningText = (o: Record<string, unknown>): string => {
  for (const k of REASONING_KEYS) if (typeof o[k] === "string" && o[k] !== "") return o[k] as string;
  return "";
};
/** Rename `thinking` to `reasoning_content` on a message or delta. Other fields stay. */
function renameThinking<T extends Record<string, unknown>>(m: T): T {
  if (typeof m.thinking !== "string") return m;
  const { thinking, ...rest } = m;
  return (
    rest.reasoning_content === undefined && rest.reasoning === undefined
      ? { ...rest, reasoning_content: thinking }
      : rest
  ) as T;
}

type Msg = { role?: unknown; content?: unknown; [k: string]: unknown };

/**
 * gpt-oss-120b, llama-3.3-70b and qwen3-30b refuse an assistant message whose content is null (AiError 5006,
 * docs/09 M5b); DeepSeek, Nemotron and Gemma take "" too. OpenClaw sends null on a tool-call-only message.
 */
function fixMessages(messages: Msg[]): Msg[] {
  return messages.map((m) => (m && typeof m === "object" && m.content == null ? { ...m, content: "" } : m));
}

// ---------------------------------------------------------------- chat

export async function chat(body: Record<string, unknown>, c: AiCtx): Promise<Response> {
  const model = String(body.model ?? "");
  if (!CHAT_MODEL_RE.test(model))
    return oaiError(400, "model must be @cf/<org>/<name> or anthropic/<model>", "bad_model");
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    return oaiError(400, "messages required", "bad_input");
  const input: Record<string, unknown> = {};
  for (const k of CHAT_KEYS) if (body[k] !== undefined) input[k] = body[k];
  input.messages = fixMessages(body.messages as Msg[]);
  mapEffort(model, input);
  const stream = body.stream === true;
  const billed = CF_MODEL_RE.test(model); // a provider key is billed by the provider, not in neurons
  const reqChars = JSON.stringify(input.messages).length;
  let out: unknown;
  try {
    out = await c.ai.run(model, input, gw(c, true));
  } catch (e) {
    return failure(e);
  }
  const created = Math.floor(c.now() / 1000);
  if (stream) {
    if (!(out instanceof ReadableStream)) return oaiError(502, "model did not stream", "upstream");
    return new Response(
      sseToOpenAi(out as ReadableStream<Uint8Array>, {
        model,
        created,
        reqChars,
        charge: billed ? c.charge : undefined,
      }),
      { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
    );
  }
  const done = toChatCompletion(out, model, created);
  if (!done) return oaiError(502, "unexpected reply from the model", "upstream");
  if (billed)
    await c.charge(
      chatNeurons(done.usage as Usage | undefined, reqChars, JSON.stringify(done.choices).length),
    );
  return json(done);
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  neurons?: number;
}

/** Neurons for one chat call: the model's own count when it reports one, else a token estimate (caps.ts). */
function chatNeurons(u: Usage | undefined, reqChars: number, outChars: number): number {
  if (typeof u?.neurons === "number") return u.neurons;
  const usage =
    u?.prompt_tokens !== undefined
      ? u
      : { prompt_tokens: Math.ceil(reqChars / 4), completion_tokens: Math.ceil(outChars / 4) };
  return estimateNeurons("chat/completions", { bytes: reqChars }, { usage });
}

interface LegacyToolCall {
  id?: string;
  name?: string;
  arguments?: unknown;
  function?: { name?: string; arguments?: unknown };
}
const argString = (a: unknown) => (typeof a === "string" ? a : JSON.stringify(a ?? {}));
const toolCalls = (calls: LegacyToolCall[], mkId: (i: number) => string) =>
  calls.map((t, i) => ({
    id: t.id ?? mkId(i),
    type: "function" as const,
    function: {
      name: t.function?.name ?? t.name ?? "",
      arguments: argString(t.function?.arguments ?? t.arguments),
    },
  }));

/** Either model shape → OpenAI chat.completion. `choices` replies pass through (content cleaned). */
export function toChatCompletion(r: unknown, model: string, created: number): Record<string, unknown> | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (Array.isArray(o.choices)) {
    const choices = (o.choices as { message?: Record<string, unknown> }[]).map((ch) => {
      const m = ch.message ? renameThinking(ch.message) : undefined;
      if (!m) return ch;
      return typeof m.content === "string"
        ? { ...ch, message: { ...m, content: stripSafety(m.content) } }
        : { ...ch, message: m };
    });
    return { id: `chatcmpl-${created}`, object: "chat.completion", created, model, ...o, choices };
  }
  if (typeof o.response !== "string" && !Array.isArray(o.tool_calls) && !reasoningText(o)) return null;
  const calls = Array.isArray(o.tool_calls)
    ? toolCalls(o.tool_calls as LegacyToolCall[], (i) => `call_${created}_${i}`)
    : [];
  const text = typeof o.response === "string" ? stripSafety(o.response) : "";
  const reasoning = reasoningText(o);
  return {
    id: `chatcmpl-${created}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || (calls.length ? null : ""),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        finish_reason: calls.length ? "tool_calls" : "stop",
      },
    ],
    usage: o.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Binding SSE → OpenAI chunks. OpenAI-shaped chunks (`choices`) pass through unchanged; legacy chunks
 * (`{response}`, `{tool_calls}`) become deltas. Charges once at the end (or on cancel) from the last `usage`.
 */
export function sseToOpenAi(
  src: ReadableStream<Uint8Array>,
  o: { model: string; created: number; reqChars: number; charge?: (n: number) => Promise<unknown> },
): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  let usage: Usage | undefined;
  let outChars = 0;
  let started = false;
  let finished = false;
  let sentDone = false;
  const id = `chatcmpl-${o.created}`;
  const chunk = (delta: Record<string, unknown>) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: o.created, model: o.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
  const settle = async () => {
    if (finished) return;
    finished = true;
    await o.charge?.(chatNeurons(usage, o.reqChars, outChars));
  };
  const line = (l: string): string => {
    if (!l.startsWith("data:")) return "";
    const data = l.slice(5).trim();
    if (!data) return "";
    if (data === "[DONE]") {
      sentDone = true;
      return "data: [DONE]\n\n";
    }
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return "";
    }
    if (j.usage && typeof j.usage === "object") usage = j.usage as Usage;
    if (Array.isArray(j.choices)) {
      const ch = j.choices[0] as { delta?: Record<string, unknown> } | undefined;
      if (typeof ch?.delta?.content === "string") outChars += ch.delta.content.length;
      if (ch?.delta) outChars += reasoningText(ch.delta).length;
      if (typeof ch?.delta?.thinking === "string") {
        const choices = [{ ...ch, delta: renameThinking(ch.delta) }, ...j.choices.slice(1)];
        return `data: ${JSON.stringify({ ...j, choices })}\n\n`;
      }
      return `data: ${data}\n\n`;
    }
    const delta: Record<string, unknown> = started ? {} : { role: "assistant" };
    let any = false;
    if (typeof j.response === "string" && j.response !== "") {
      delta.content = j.response;
      outChars += j.response.length;
      any = true;
    }
    const reasoning = reasoningText(j);
    if (reasoning) {
      delta.reasoning_content = reasoning;
      outChars += reasoning.length;
      any = true;
    }
    if (Array.isArray(j.tool_calls) && j.tool_calls.length) {
      delta.tool_calls = toolCalls(j.tool_calls as LegacyToolCall[], (i) => `call_${o.created}_${i}`).map(
        (t, i) => ({ index: i, ...t }),
      );
      outChars += JSON.stringify(delta.tool_calls).length;
      any = true;
    }
    if (!any) return "";
    started = true;
    return chunk(delta);
  };
  const reader = src.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            const rest = buf.trim() ? line(buf.trim()) : "";
            ctl.enqueue(enc.encode(rest + (sentDone ? "" : "data: [DONE]\n\n")));
            await settle();
            ctl.close();
            return;
          }
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          const out = lines.map((l) => line(l.trim())).join("");
          if (out) {
            ctl.enqueue(enc.encode(out));
            return;
          }
        }
      } catch (e) {
        await settle();
        ctl.error(e);
      }
    },
    async cancel(reason) {
      await settle();
      await reader.cancel(reason);
    },
  });
}

// ---------------------------------------------------------------- embeddings

type Embeddings = { data?: unknown; usage?: Usage; object?: string };

export async function embeddings(
  body: Record<string, unknown>,
  c: AiCtx,
  defaultModel: string,
): Promise<Response> {
  const model = body.model === undefined || body.model === "" ? defaultModel : String(body.model);
  if (!CF_MODEL_RE.test(model)) return oaiError(400, "bad model", "bad_model");
  const raw = body.input;
  const text =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw) && raw.every((x) => typeof x === "string")
        ? (raw as string[])
        : null;
  if (text === null || text === "" || (Array.isArray(text) && text.length === 0))
    return oaiError(400, "input must be a string or an array of strings", "bad_input");
  let out: unknown;
  try {
    out = await c.ai.run(model, { text }, gw(c, false));
  } catch (e) {
    return failure(e);
  }
  const r = (out ?? {}) as Embeddings;
  const chars = Array.isArray(text) ? text.reduce((n, s) => n + s.length, 0) : text.length;
  let res: Record<string, unknown>;
  if (r.object === "list" && Array.isArray(r.data)) res = r as Record<string, unknown>;
  else if (Array.isArray(r.data) && r.data.every(Array.isArray))
    res = {
      object: "list",
      model,
      data: (r.data as number[][]).map((embedding, index) => ({ object: "embedding", index, embedding })),
      usage: r.usage ?? { prompt_tokens: Math.ceil(chars / 4), total_tokens: Math.ceil(chars / 4) },
    };
  else return oaiError(502, "unexpected reply from the embedding model", "upstream");
  await c.charge(estimateNeurons("embeddings", { bytes: chars }, res));
  return json(res);
}

// ---------------------------------------------------------------- media (binding-native shapes)

export const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

/** Run a media model on the binding, without the gateway (account auth only). Result or the HTTP failure. */
export async function runMedia(
  c: AiCtx,
  model: string,
  input: Record<string, unknown>,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; res: Response }> {
  try {
    const v = await c.ai.run(model, input);
    return { ok: true, value: (v && typeof v === "object" ? v : {}) as Record<string, unknown> };
  } catch (e) {
    return { ok: false, res: failure(e) };
  }
}
