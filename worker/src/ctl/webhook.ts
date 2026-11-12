// POST /telegram-webhook (spec §12.1, add §2.2). Verify, store via the Control DO in one write, ack 200, then
// wake through waitUntil unless the row is held. The ack never waits for the container.
import { safeEqual } from "../core/ids";
import type { Env, PutOut } from "./webhook-types";

export const WEBHOOK_PATH = "/telegram-webhook";
const MAX = 1024 * 1024;

export interface WebhookCtl {
  inboxPut(p: { body: string; headers: Record<string, string> }): Promise<PutOut>;
  webhookPrevOk(): Promise<boolean>;
}
export interface WebhookDeps {
  env: Pick<Env, "TELEGRAM_WEBHOOK_SECRET" | "TELEGRAM_WEBHOOK_SECRET_PREV">;
  ctl: WebhookCtl;
  /** rt(active).requestWake("webhook"); called through waitUntil after the ack. */
  wake(): Promise<unknown>;
  waitUntil(p: Promise<unknown>): void;
  /** First sendChatAction typing for a cold-path update (the Control DO alarm repeats it). */
  typing?(chatId: string): Promise<unknown>;
  /** One wake progress message for a non-running install; the Control DO edits and removes it. */
  progress?(chatId: string): Promise<unknown>;
  /** answerInlineQuery for an inline wake (docs/14): no results; `cold` adds the "waking" line. */
  answerInline?(queryId: string, cold: boolean): Promise<unknown>;
}

/** Text over the (empty) inline results while the install is not up. Telegram allows 64 characters. */
export const INLINE_COLD_TEXT = "Waking up. Send your message in the bot chat.";

/** answerInlineQuery body: no results, never cached, so each keystroke reaches the Worker again. */
export function inlineAnswer(queryId: string, cold: boolean): Record<string, unknown> {
  return {
    inline_query_id: queryId,
    results: [],
    cache_time: 0,
    is_personal: true,
    ...(cold ? { button: { text: INLINE_COLD_TEXT, start_parameter: "wake" } } : {}),
  };
}

/** True when this request is for the webhook route (exact bytes, no decoding). */
export function isWebhook(req: Request): boolean {
  const raw = req.url.replace(/^[a-z]+:\/\/[^/]+/i, "").split("?")[0];
  return raw === WEBHOOK_PATH;
}

export async function handleWebhook(req: Request, d: WebhookDeps): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX) return new Response(null, { status: 413 });
  const tok = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  const cur = d.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  let ok = !!cur && safeEqual(tok, cur);
  if (!ok && d.env.TELEGRAM_WEBHOOK_SECRET_PREV && safeEqual(tok, d.env.TELEGRAM_WEBHOOK_SECRET_PREV))
    ok = await d.ctl.webhookPrevOk();
  if (!ok) return new Response(null, { status: 401 });
  const body = await req.text();
  if (body.length > MAX) return new Response(null, { status: 413 });
  const headers: Record<string, string> = { host: req.headers.get("host") ?? new URL(req.url).host };
  let r: PutOut;
  try {
    r = await d.ctl.inboxPut({ body, headers });
  } catch {
    return new Response(null, { status: 503 }); // Telegram retries
  }
  if (r.status !== 200) return new Response(null, { status: r.status });
  if ("inline" in r) {
    if (r.wake) d.waitUntil(d.wake().catch(() => undefined));
    if (r.queryId && d.answerInline)
      d.waitUntil(d.answerInline(r.queryId, r.cold === true).catch(() => undefined));
    return new Response(null, { status: 200 });
  }
  if (r.wake) d.waitUntil(d.wake().catch(() => undefined));
  if (r.progress && d.progress) d.waitUntil(d.progress(r.progress).catch(() => undefined));
  if (r.typing && d.typing) d.waitUntil(d.typing(r.typing).catch(() => undefined));
  return new Response(null, { status: 200 });
}
