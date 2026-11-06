// Telegram webhook on a secret path (D4, add §5.4): `/_ochost/hook/telegram/<seg>`, seg = first 32 hex of
// sha256("oc-host:telegram-hook:" + secret). No new secret to set: the path rotates with the header secret.
// Exact bytes, no decoding, no query. A wrong path → 404; then ctl/webhook.ts checks the
// X-Telegram-Bot-Api-Secret-Token header (401) and hands the update to the inbox.
import { sha256Hex } from "../core/ids";

export const HOOK_PREFIX = "/_ochost/hook/telegram/";

export async function hookPath(secret: string): Promise<string> {
  return HOOK_PREFIX + (await sha256Hex(`oc-host:telegram-hook:${secret}`)).slice(0, 32);
}

/** The URL to give Telegram setWebhook. */
export async function hookUrl(origin: string, secret: string): Promise<string> {
  return origin.replace(/\/$/, "") + (await hookPath(secret));
}

export function isHook(req: Request): boolean {
  return rawPath(req).startsWith(HOOK_PREFIX);
}

/** Path and query as sent, no decoding. */
export function rawPath(req: Request): string {
  return req.url.replace(/^[a-z]+:\/\/[^/]+/i, "");
}

/** True when the raw path is the current or (during a rotation) the previous secret path. */
export async function hookPathOk(
  req: Request,
  env: { TELEGRAM_WEBHOOK_SECRET?: string; TELEGRAM_WEBHOOK_SECRET_PREV?: string },
): Promise<boolean> {
  const p = rawPath(req);
  for (const s of [env.TELEGRAM_WEBHOOK_SECRET, env.TELEGRAM_WEBHOOK_SECRET_PREV])
    if (s && p === (await hookPath(s))) return true;
  return false;
}
