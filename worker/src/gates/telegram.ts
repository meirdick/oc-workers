// TelegramGate (M4b L3): prod pass-through for api.telegram.org, registered with interceptOutboundHttps. The
// gateway's Bot API calls go on to Telegram unchanged; a 2xx reply-class call (sendMessage and the other send*)
// tells the Control DO which chat got a reply, so an accepted inbox row whose reply never went out is replayed
// after a restart (ctl/driver.ts). The bot token is never logged. Any failure to note the reply is ignored: the
// call itself must not depend on the Control DO.
import { REPLY_METHODS } from "../ctl/inbox";

export const TELEGRAM_ORIGIN = "https://api.telegram.org";

export interface OutboundSink {
  outbound(chatId: string | number | null, at: number, method: string): Promise<unknown> | unknown;
}

/** chat_id from a JSON, urlencoded or multipart body, or the query. null when none. */
export async function chatIdOf(req: Request, url: URL): Promise<string | number | null> {
  const q = url.searchParams.get("chat_id");
  if (q) return q;
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const b = (await req.json()) as { chat_id?: string | number } | null;
      return b?.chat_id ?? null;
    }
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const v = (await req.formData()).get("chat_id");
      return typeof v === "string" ? v : null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function handleTelegramGate(
  req: Request,
  sink: OutboundSink,
  waitUntil: (p: Promise<unknown>) => void,
  f: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Response> {
  const url = new URL(req.url);
  const method = /^\/bot[^/]+\/([A-Za-z]+)$/.exec(url.pathname)?.[1] ?? "";
  const watch = REPLY_METHODS.test(method);
  const copy = watch ? req.clone() : null;
  const res = await f(new Request(`${TELEGRAM_ORIGIN}${url.pathname}${url.search}`, req));
  if (copy && res.ok) {
    const at = now();
    waitUntil(
      chatIdOf(copy, url)
        .then((chat) => (chat === null ? null : sink.outbound(chat, at, method)))
        .catch(() => null),
    );
  }
  return res;
}
