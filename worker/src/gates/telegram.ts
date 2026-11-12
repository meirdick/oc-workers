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

/** Update type of the inline wake (docs/14). The Worker handles it at the webhook; the gateway does not. */
export const INLINE_UPDATE = "inline_query";

/**
 * The gateway calls setWebhook at each boot with its own `allowed_updates`, which replaces the Worker's list.
 * Add `inline_query` to an explicit, non-empty list (JSON or urlencoded body), so the inline wake survives a
 * boot. Left as it is: no list (Telegram keeps the list it has), an empty list (Telegram reads it as its default
 * types, which include inline_query; adding one entry would make that the only type), a body over
 * SET_WEBHOOK_MAX_BYTES, and anything not understood.
 */
export const SET_WEBHOOK_MAX_BYTES = 16 * 1024;
/** Body text of a copy of the request, or null when it is longer than `max` bytes (the read stops there). */
async function textUpTo(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (declared > max) return null;
  const r = req.clone().body?.getReader();
  if (!r) return "";
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      // Not awaited: the cancel of one branch of a cloned body settles only when the other branch ends too.
      void r.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function withInlineUpdate(req: Request): Promise<Request> {
  const ct = req.headers.get("content-type") ?? "";
  const add = (v: unknown): string[] | null =>
    Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string") && !v.includes(INLINE_UPDATE)
      ? [...(v as string[]), INLINE_UPDATE]
      : null;
  const json = ct.includes("application/json");
  if (!json && !ct.includes("application/x-www-form-urlencoded")) return req;
  try {
    // A setWebhook body is under 1 kB; a longer one is passed on unread.
    const text = await textUpTo(req, SET_WEBHOOK_MAX_BYTES);
    if (text === null) return req;
    let body: string | null = null;
    if (json) {
      const b = JSON.parse(text) as Record<string, unknown> | null;
      const next = b && typeof b === "object" && !Array.isArray(b) ? add(b.allowed_updates) : null;
      if (next) body = JSON.stringify({ ...b, allowed_updates: next });
    } else {
      const q = new URLSearchParams(text);
      const raw = q.get("allowed_updates");
      const next = raw ? add(JSON.parse(raw)) : null;
      if (next) {
        q.set("allowed_updates", JSON.stringify(next));
        body = q.toString();
      }
    }
    if (body === null) return req;
    const headers = new Headers(req.headers);
    headers.delete("content-length");
    return new Request(req.url, { method: req.method, headers, body });
  } catch {
    return req;
  }
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
  const out = method.toLowerCase() === "setwebhook" ? await withInlineUpdate(req) : req;
  const res = await f(new Request(`${TELEGRAM_ORIGIN}${url.pathname}${url.search}`, out));
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
