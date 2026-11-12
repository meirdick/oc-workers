// W8 /ops/telegram/webhook (M5-STATUS §7, docs/10-cli-spec.md §4 step 6). The Worker sets and reads the Telegram
// webhook itself, so the webhook secret and its secret path (`/_ochost/hook/telegram/<seg>`, ingress/telegram.ts)
// never leave it. Answers carry the URL with the segment redacted.
//   POST {allowedUpdates?, dropPending?, config?}: setWebhook(url = hookUrl(origin, secret), secret_token,
//        allowed_updates = message types and inline_query), then getWebhookInfo. config (default true): the newest config
//        version gets the same URL in channels.telegram.webhookUrl, so the gateway's own setWebhook at boot
//        keeps it (W2 accepts it).
//   GET: getWebhookInfo, and whether the URL is this install's secret path, the legacy path, or other.
// OC_TEST=1: calls go to a fake in the Control DO (state in meta, calls in the ring as src "telegram").
import type { Env } from "./core/types";
import { UPDATE_FIELDS } from "./ctl/inbox";
import { HOOK_PREFIX, hookUrl } from "./ingress/telegram";

export const TELEGRAM_API = "https://api.telegram.org";
/** Message updates only (no member, reaction, poll or query updates): fewer wakes for updates nobody reads. */
/** `inline_query` is the inline wake (docs/14): the Worker takes it, the gateway never sees it. */
export const MESSAGE_UPDATES = ["message", "edited_message", "inline_query"];
const LEGACY = "/telegram-webhook";

type Res = { status: number; body: Record<string, unknown> };
type Internal = (a: {
  sub: string[];
  body: Record<string, unknown>;
}) => Promise<{ status: number; body: unknown }>;

export function redactHook(u: string): string {
  return u.replace(/(\/_ochost\/hook\/telegram\/)[^/?#]+/, "$1[redacted]");
}

export function publicOrigin(env: Pick<Env, "OC_SETTINGS">, req: Request): string {
  try {
    const s = JSON.parse(env.OC_SETTINGS ?? "{}") as { publicOrigin?: unknown };
    if (typeof s.publicOrigin === "string" && /^https:\/\/[^/]+\/?$/.test(s.publicOrigin))
      return s.publicOrigin.replace(/\/$/, "");
  } catch {}
  return new URL(req.url).origin;
}

/** Where a webhook URL points, from this install's view. */
export function hookKind(
  url: string,
  origin: string,
  managed: string,
): "secret" | "secret-other" | "legacy" | "other" | "none" {
  if (!url) return "none";
  if (url === managed) return "secret";
  if (url === `${origin}${LEGACY}`) return "legacy";
  if (url.startsWith(`${origin}${HOOK_PREFIX}`)) return "secret-other";
  return "other";
}

interface TgAnswer {
  ok?: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
}

async function call(
  env: Env,
  internal: Internal,
  token: string,
  method: string,
  params: Record<string, unknown> | undefined,
  f: typeof fetch,
): Promise<TgAnswer & { http: number }> {
  if (env.OC_TEST === "1") {
    const r = await internal({ sub: ["fake"], body: { method, params: params ?? {} } });
    return { ...(r.body as TgAnswer), http: r.status };
  }
  try {
    const res = await f(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: params ? "POST" : "GET",
      headers: params ? { "content-type": "application/json" } : {},
      body: params ? JSON.stringify(params) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as TgAnswer;
    return { ...j, http: res.status };
  } catch (e) {
    // Never the URL: it holds the bot token.
    return { ok: false, description: `fetch failed (${(e as Error).name})`, http: 0 };
  }
}

export async function handleTelegramOps(
  req: Request,
  env: Env,
  sub: string[],
  body: Record<string, unknown>,
  internal: Internal,
  f: typeof fetch = (i, o) => fetch(i, o),
): Promise<Res> {
  if (sub[0] !== "webhook" || sub.length !== 1) return { status: 404, body: { error: "not found" } };
  if (req.method !== "GET" && req.method !== "POST") return { status: 405, body: { error: "method" } };
  const token = env.OC_SECRET_OC_TELEGRAM_BOT_TOKEN ?? "";
  if (!token)
    return {
      status: 409,
      body: {
        ok: false,
        error: "no-bot-token",
        description:
          "Worker secret OC_SECRET_OC_TELEGRAM_BOT_TOKEN is not set (ochost channels add telegram)",
      },
    };
  const secret = env.TELEGRAM_WEBHOOK_SECRET ?? "";
  if (!secret)
    return {
      status: 409,
      body: {
        ok: false,
        error: "no-webhook-secret",
        description: "Worker secret TELEGRAM_WEBHOOK_SECRET is not set",
      },
    };
  const origin = publicOrigin(env, req);
  const managed = await hookUrl(origin, secret);
  const info = async () => {
    const i = await call(env, internal, token, "getWebhookInfo", undefined, f);
    const r = (i.result ?? {}) as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url : "";
    return {
      ok: i.ok === true,
      url: redactHook(url),
      path: hookKind(url, origin, managed),
      pending: typeof r.pending_update_count === "number" ? r.pending_update_count : null,
      allowedUpdates: Array.isArray(r.allowed_updates) ? r.allowed_updates : null,
      lastErrorDate: typeof r.last_error_date === "number" ? r.last_error_date : null,
      lastErrorMessage: typeof r.last_error_message === "string" ? r.last_error_message.slice(0, 300) : null,
      maxConnections: typeof r.max_connections === "number" ? r.max_connections : null,
      ...(i.ok ? {} : { description: i.description ?? `getWebhookInfo http ${i.http}` }),
    };
  };
  if (req.method === "GET") {
    const x = await info();
    return { status: x.ok ? 200 : 502, body: x };
  }
  let allowed = MESSAGE_UPDATES;
  if (body.allowedUpdates !== undefined) {
    const a = body.allowedUpdates;
    if (!Array.isArray(a) || !a.length || a.some((x) => typeof x !== "string" || !UPDATE_FIELDS.includes(x)))
      return {
        status: 400,
        body: { error: "allowedUpdates must be a non-empty list of Telegram update types" },
      };
    allowed = [...new Set(a as string[])];
  }
  const set = await call(
    env,
    internal,
    token,
    "setWebhook",
    {
      url: managed,
      secret_token: secret,
      allowed_updates: allowed,
      drop_pending_updates: body.dropPending === true,
    },
    f,
  );
  await internal({
    sub: ["note"],
    body: {
      kind: set.ok ? "webhook-set" : "webhook-set-failed",
      detail: { url: redactHook(managed), allowed, http: set.http, description: set.description ?? null },
    },
  }).catch(() => undefined);
  if (set.ok !== true)
    return {
      status: 502,
      body: { ok: false, error: "set-webhook-failed", http: set.http, description: set.description ?? null },
    };
  let config: unknown = null;
  if (body.config !== false)
    config = (
      await internal({ sub: ["managed-url"], body: { url: managed } }).catch((e: Error) => ({
        body: { changed: false, error: e.message },
      }))
    ).body;
  const x = await info();
  return {
    status: 200,
    body: { ...x, ok: true, description: set.description ?? null, set: { allowedUpdates: allowed }, config },
  };
}
