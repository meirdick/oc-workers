// `ochost channels add telegram` (docs/10-cli-spec.md §4). The webhook secret and its secret path stay on the
// Worker: the CLI never holds them. The Worker calls Telegram setWebhook itself (route W8 below); the CLI only
// checks the result with getWebhookInfo and never prints the URL path segment.
//
// Worker routes this file uses:
//   GET  /ops/config, /ops/config/<ver>, POST /ops/config   (exist)
//   POST /ops/restart                                       (exists; fallback: the gateway calls setWebhook on boot)
//   POST /ops/telegram/webhook  → {ok, url, description}    gap W8: Worker computes hookUrl(origin, secret) and
//                                 calls setWebhook with secret_token + allowed_updates; url has the seg redacted
//   GET  /ops/pairing?ch=telegram → {requests:[{code,id,name}]}, POST /ops/pairing/approve {ch, code}  gap W1
//   POST /ops/wake                                          (exists; keeps the install awake during --wait-pair)
import { randomBytes } from "node:crypto";
import type { AigDeps } from "./ai-gateway.ts";
import { currentConfig, type OpsClient, proposeConfig } from "./model.ts";
import { CliError } from "./ui.ts";

export const TELEGRAM_API = "https://api.telegram.org";
export const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{35}$/;
export const BOT_SECRET_NAME = "OC_SECRET_OC_TELEGRAM_BOT_TOKEN";
export const HOOK_PREFIX = "/_ochost/hook/telegram/";
export const LEGACY_HOOK_PATH = "/telegram-webhook";

export interface ChannelDeps
  extends Pick<AigDeps, "fetch" | "env" | "askHidden" | "readFile" | "log" | "registerSecret"> {
  ops: OpsClient;
  /** Set a Worker secret (wrangler secret put or the next deploy's secrets file). */
  putSecret: (name: string, value: string) => Promise<void>;
  /** y/N question; absent → non-interactive. */
  confirm?: (question: string) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  telegramApi?: string;
  /** random [A-Za-z0-9_-] characters for the fake token (tests pin it) */
  randomChars?: (n: number) => string;
}

export interface AddTelegramOpts {
  /** https://<name>.<sub>.workers.dev */
  origin: string;
  tokenFile?: string;
  nonInteractive?: boolean;
  waitPair?: boolean;
  pairTimeoutMs?: number;
  webhookTimeoutMs?: number;
  /** Test install (init --fake-telegram, OC_TEST=1): the Worker has its own fake Telegram; no real bot, no laptop calls. */
  fake?: boolean;
  /** Bot id stored for this install (state.json), for the one-bot rule. OpenClaw's config has no field for it. */
  storedBotId?: number;
}

export interface AddTelegramResult {
  ok: boolean;
  bot: { id: number; username: string };
  configVer: number;
  webhook: { via: "ops" | "restart"; path: "secret" | "legacy"; pending: number; url: string };
  paired?: { id: string; name: string };
}

/** The bot the Worker's fake Telegram answers getMe with (worker/src/gates/fakes.ts BOT). */
export const FAKE_BOT = { id: 7000000001, username: "oc_host_test_bot" };

/** A token of the right shape for the fake bot. The Worker's fake accepts any token. */
export function fakeBotToken(rand: (n: number) => string): string {
  return `${FAKE_BOT.id}:${rand(35)}`;
}

/** Telegram Bot API call. The token never appears in an error text (errors carry the method only). */
export async function tg<T>(d: ChannelDeps, token: string, method: string, body?: unknown): Promise<T> {
  const base = d.telegramApi ?? TELEGRAM_API;
  let res: Response;
  try {
    res = await d.fetch(`${base}/bot${token}/${method}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new CliError(
      `cannot reach Telegram (${method}: ${(e as Error).name})`,
      "check your network, then rerun",
    );
  }
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!j.ok) {
    if (method === "getMe")
      throw new CliError(
        `Telegram rejected the token (getMe ${res.status})`,
        "copy the token from @BotFather again; rerun with --token-file",
      );
    throw new CliError(`Telegram ${method} failed (${res.status} ${j.description ?? ""})`.trim(), "rerun");
  }
  return j.result as T;
}

async function resolveBotToken(o: AddTelegramOpts, d: ChannelDeps): Promise<string> {
  let t = "";
  if (o.tokenFile) {
    if (!d.readFile) throw new CliError("cannot read files here", "pass the token in TELEGRAM_BOT_TOKEN");
    const f = await d.readFile(o.tokenFile).catch((e: Error) => {
      throw new CliError(`cannot read ${o.tokenFile} (${e.message})`, "check the path, then rerun");
    });
    if ((f.mode & 0o077) !== 0)
      d.log(`WARN: ${o.tokenFile} is readable by others — fix: chmod 600 ${o.tokenFile}`);
    t = f.text.trim();
  } else if (d.env.TELEGRAM_BOT_TOKEN?.trim()) t = d.env.TELEGRAM_BOT_TOKEN.trim();
  else if (o.nonInteractive || !d.askHidden)
    throw new CliError("no Telegram bot token", "rerun with --token-file <f> (token from @BotFather)", 3);
  else {
    d.log("Make a bot with @BotFather in Telegram (/newbot), then copy its token.");
    t = (await d.askHidden("Paste the bot token (input is hidden), then Enter: ")).trim();
  }
  if (t) d.registerSecret(t);
  if (!BOT_TOKEN_RE.test(t))
    throw new CliError(
      "the bot token has the wrong shape (expected <digits>:<35 chars>)",
      "copy the token from @BotFather again; rerun with --token-file",
    );
  return t;
}

/** Pure: config doc with the Telegram channel and its binding (oc-demo cfg1.json, spec §4 step 5). */
export function withTelegram(doc: Record<string, any>, webhookUrl: string): Record<string, any> {
  const next = structuredClone(doc);
  next.channels ??= {};
  next.channels.telegram = {
    ...(next.channels.telegram ?? {}),
    enabled: true,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: OpenClaw SecretRef, not a JS template
    botToken: "${OC_TELEGRAM_BOT_TOKEN}",
    dmPolicy: next.channels.telegram?.dmPolicy ?? "pairing",
    // Answer text streams into one preview message (a few edits per turn); docs/13-cold-reply.md. Owner value wins.
    streaming: next.channels.telegram?.streaming ?? { mode: "partial" },
    webhookUrl,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: OpenClaw SecretRef, not a JS template
    webhookSecret: "${OC_TELEGRAM_WEBHOOK_SECRET}",
    webhookPath: LEGACY_HOOK_PATH,
  };
  next.bindings ??= [];
  const has = (next.bindings as any[]).some((b) => b?.match?.channel === "telegram");
  if (!has) next.bindings.push({ agentId: "main", match: { channel: "telegram", accountId: "default" } });
  return next;
}

/** Bot id from the token prefix (no API call). */
export const botIdOf = (token: string) => Number(token.split(":")[0]);

/** URL with the secret segment hidden, for printing. */
export function redactHookUrl(u: string): string {
  return u.replace(/(\/_ochost\/hook\/telegram\/)[^/?#]+/, "$1[redacted]");
}

const originOf = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return "another URL";
  }
};

interface WebhookInfo {
  url: string;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
}

/** True when Telegram points at this install: secret path (W2) or the legacy managed path. */
export function hookMatches(url: string, origin: string): "secret" | "legacy" | null {
  const o = origin.replace(/\/$/, "");
  if (!url.startsWith(`${o}/`)) return null;
  const p = url.slice(o.length);
  if (p.startsWith(HOOK_PREFIX) && /^[0-9a-f]{32}$/.test(p.slice(HOOK_PREFIX.length))) return "secret";
  if (p === LEGACY_HOOK_PATH) return "legacy";
  return null;
}

function randomChars(n: number): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  return Array.from(randomBytes(n), (b) => abc[b % abc.length]).join("");
}

/**
 * Test install: Telegram is the Worker's fake, so the laptop cannot ask api.telegram.org. GET /ops/telegram/webhook
 * (W8) reads it from inside; its url has the secret segment redacted, so a match is rebuilt for hookMatches().
 */
async function fakeWebhookInfo(d: ChannelDeps, origin: string): Promise<WebhookInfo> {
  const r = await d.ops.get("/ops/telegram/webhook");
  const b = (r.body ?? {}) as {
    path?: string;
    pending?: number | null;
    lastErrorDate?: number;
    lastErrorMessage?: string;
  };
  if (r.status !== 200 && r.status !== 502)
    throw new CliError(
      `GET /ops/telegram/webhook returned ${r.status}`,
      "this Worker is not a test install: ochost init --fake-telegram, or ochost init --no-fake-telegram for a real bot",
    );
  const path =
    b.path === "secret" ? `${HOOK_PREFIX}${"0".repeat(32)}` : b.path === "legacy" ? LEGACY_HOOK_PATH : "";
  return {
    url: path ? `${origin}${path}` : "",
    pending_update_count: b.pending ?? 0,
    last_error_date: b.lastErrorDate,
    last_error_message: b.lastErrorMessage,
  };
}

export async function addTelegram(o: AddTelegramOpts, d: ChannelDeps): Promise<AddTelegramResult> {
  const now = d.now ?? Date.now;
  const wait = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const origin = o.origin.replace(/\/$/, "");
  // 1-2: token and getMe (a test install has no real bot: fake token, fake bot)
  if (o.fake && o.tokenFile)
    d.log("WARN: --token-file ignored — this is a test install with a fake Telegram");
  const token = o.fake ? fakeBotToken(d.randomChars ?? randomChars) : await resolveBotToken(o, d);
  if (o.fake) d.registerSecret(token);
  const me = o.fake
    ? { ...FAKE_BOT, is_bot: true }
    : await tg<{ id: number; username: string; is_bot: boolean }>(d, token, "getMe");
  d.log(`Telegram bot: @${me.username}${o.fake ? " (fake, test install)" : ""}`);
  // 3: one bot only (U5)
  const cur = await currentConfig(d.ops);
  const old = cur.doc.channels?.telegram;
  if (old?.enabled && o.storedBotId !== undefined && o.storedBotId !== me.id)
    throw new CliError(
      "a second Telegram bot is not supported in v1",
      "ochost channels remove telegram first",
    );
  // 4: secret on the Worker
  await d.putSecret(BOT_SECRET_NAME, token);
  // 5: config version. The managed URL is the legacy path until the Worker accepts the secret path (W2);
  // the Worker owns the secret path either way.
  const doc = withTelegram(cur.doc, `${origin}${LEGACY_HOOK_PATH}`);
  const ver = await proposeConfig(d.ops, doc, cur.ver);
  d.log(`config version ${ver.ver}${ver.same ? " (no change)" : ""}`);
  // 6: setWebhook on the Worker (W8). 404 → planned restart; the gateway sets it on boot (M3 behaviour).
  const t0 = now();
  let via: "ops" | "restart" = "ops";
  // A new secret reaches the running Worker a few seconds after putSecret; retry while the Worker says it is unset.
  let sw = await d.ops.post("/ops/telegram/webhook", {});
  for (
    let i = 0;
    i < 10 &&
    sw.status === 409 &&
    /is not set/.test(String((sw.body as { description?: string })?.description ?? ""));
    i++
  ) {
    if (i === 0) d.log("waiting for the new secret to reach the Worker");
    await wait(3_000);
    sw = await d.ops.post("/ops/telegram/webhook", {});
  }
  if (sw.status === 404) {
    via = "restart";
    d.log("this Worker has no /ops/telegram/webhook route; restarting so the gateway sets the webhook");
    const rs = await d.ops.post("/ops/restart", {});
    if (rs.status !== 200)
      throw new CliError(`restart failed (${rs.status})`, "ochost status; then ochost restart");
  } else if (sw.status !== 200 || (sw.body as { ok?: boolean })?.ok === false)
    throw new CliError(
      `the Worker could not set the webhook (${sw.status} ${(sw.body as { description?: string })?.description ?? ""})`.trim(),
      "ochost logs --source ctl",
    );
  // 7: getWebhookInfo from the laptop. Budget 3 min → exit 4.
  const budget = o.webhookTimeoutMs ?? 180_000;
  let info: WebhookInfo | null = null;
  let kind: "secret" | "legacy" | null = null;
  for (;;) {
    info = o.fake ? await fakeWebhookInfo(d, origin) : await tg<WebhookInfo>(d, token, "getWebhookInfo");
    kind = hookMatches(info.url ?? "", origin);
    const freshErr = info.last_error_date && info.last_error_date * 1000 >= t0 - 5_000;
    if (kind && !freshErr) break;
    if (now() - t0 >= budget) {
      const why = !kind
        ? info.url
          ? `points at ${originOf(info.url)}`
          : "is empty"
        : `error: ${info.last_error_message}`;
      throw new CliError(
        `Telegram webhook not set after ${Math.round(budget / 60_000)} min (webhook ${why})`,
        "ochost logs --source ocsup; ochost restart",
        4,
      );
    }
    await wait(5_000);
  }
  d.log(
    `webhook on (${kind === "secret" ? "secret path" : "legacy path"}, ${info.pending_update_count ?? 0} pending)`,
  );
  const res: AddTelegramResult = {
    ok: true,
    bot: { id: me.id, username: me.username },
    configVer: ver.ver,
    // The secret path is the Worker's secret: shown as <secret>. Telegram has it already; nothing to paste.
    webhook: {
      via,
      path: kind,
      pending: info.pending_update_count ?? 0,
      url: kind === "secret" ? `${origin}${HOOK_PREFIX}<secret>` : `${origin}${LEGACY_HOOK_PATH}`,
    },
  };
  // 8-9
  if (!o.waitPair) {
    d.log(`Webhook URL: ${res.webhook.url}`);
    d.log(
      `Telegram bot @${me.username} is on. DM it; the request stays open 24 h: ochost pairing list, then ochost pairing approve telegram <code>`,
    );
    return res;
  }
  res.paired = await waitPair(o, d, me.username);
  return res;
}

interface PairReq {
  code: string;
  id: string;
  name?: string;
}

/** §4 step 9: keep awake, poll pairing requests, ask y/N, approve. */
export async function waitPair(
  o: Pick<AddTelegramOpts, "pairTimeoutMs" | "nonInteractive">,
  d: ChannelDeps,
  username: string,
): Promise<{ id: string; name: string }> {
  const now = d.now ?? Date.now;
  const wait = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const budget = o.pairTimeoutMs ?? 600_000;
  const t0 = now();
  let lastWake = -Infinity;
  const seen = new Set<string>();
  d.log(`DM @${username} now. Waiting up to ${Math.round(budget / 60_000)} min for the pairing request.`);
  while (now() - t0 < budget) {
    if (now() - lastWake >= 240_000) {
      await d.ops.post("/ops/wake", {});
      lastWake = now();
    }
    const r = await d.ops.get("/ops/pairing?ch=telegram");
    if (r.status === 404)
      throw new CliError(
        "this Worker has no pairing route (/ops/pairing)",
        "approve the DM in the Control UI (ochost open), or update the Worker with ochost deploy",
      );
    const reqs = r.status === 200 ? ((r.body as { requests?: PairReq[] }).requests ?? []) : [];
    for (const q of reqs) {
      if (seen.has(q.code)) continue;
      seen.add(q.code);
      const label = `${q.name ?? "?"} (id ${q.id}), code ${q.code}`;
      let yes = !!o.nonInteractive && reqs.length === 1;
      if (d.confirm && !o.nonInteractive) yes = await d.confirm(`Pair ${label}? [y/N] `);
      if (!yes) {
        d.log(`skipped ${label}`);
        continue;
      }
      const a = await d.ops.post("/ops/pairing/approve", { ch: "telegram", code: q.code });
      if (a.status !== 200)
        throw new CliError(
          `pairing approve failed (${a.status})`,
          `ochost pairing approve telegram ${q.code}`,
        );
      d.log(`paired ${label}`);
      return { id: q.id, name: q.name ?? "" };
    }
    await wait(3_000);
  }
  throw new CliError(
    `no pairing request in ${Math.round(budget / 60_000)} min`,
    "DM the bot, then ochost pairing approve telegram <code>",
    4,
  );
}
