// Slack Events API over HTTP (Request URL). Ack deadline 3 s; Slack retries a missed ack three times (at once, after
// 1 min, after 5 min; header x-slack-retry-num; hourly for 24 h with Delayed Events) with the same event_id, so the
// dedupe key is event_id.
// Signature: v0=hex(HMAC-SHA256(signingSecret, "v0:" + ts + ":" + rawBody)), ts within 5 min of now
// (https://docs.slack.dev/authentication/verifying-requests-from-slack).
// Replay goes to OpenClaw's Slack HTTP route (channels.slack.mode "http", default webhookPath /slack/events). Its
// receiver (Bolt) checks the same signature and the same 5 min window, so the replay is re-signed with a fresh
// timestamp; the body, and so event_id, stays byte for byte the original.
import { ctEqual, hmacSha256Hex } from "./crypto";
import type { AdapterResponse, InboundReq, InboxAdapter, PlatformSecrets, Verdict } from "./types";

export const SLACK_ROUTE = "/slack/events";
export const SLACK_SECRET = "OC_SLACK_SIGNING_SECRET";
export const SLACK_WINDOW_S = 300;

const json = (o: unknown, status = 200): AdapterResponse => ({
  status,
  body: JSON.stringify(o),
  headers: { "content-type": "application/json" },
});
const ok: AdapterResponse = { status: 200 };
const denied: AdapterResponse = { status: 401 };

export async function slackSign(secret: string, ts: string, body: string): Promise<string> {
  return `v0=${await hmacSha256Hex(secret, `v0:${ts}:${body}`)}`;
}

/** Slash commands and interactivity arrive form-encoded; events arrive as JSON. */
function fromForm(body: string): Verdict | null {
  const f = new URLSearchParams(body);
  let trigger = f.get("trigger_id");
  let user = f.get("user_id");
  let channel = f.get("channel_id");
  const payload = f.get("payload");
  if (payload) {
    try {
      const p = JSON.parse(payload) as Record<string, any>;
      trigger = p.trigger_id ?? trigger;
      user = p.user?.id ?? user;
      channel = p.channel?.id ?? p.container?.channel_id ?? channel;
    } catch {
      return null;
    }
  }
  if (!trigger) return null;
  return {
    kind: "store",
    platformKey: `trigger:${trigger}`,
    senderId: user,
    chatId: channel,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    ack: ok,
  };
}

export const slack: InboxAdapter = {
  id: "slack",
  channel: "slack",
  route: SLACK_ROUTE,
  hookPath: "/_ochost/hook/slack",
  ackDeadlineMs: 3_000,
  durableHeader: false,
  secrets: [SLACK_SECRET],

  async receive(r: InboundReq, s: PlatformSecrets): Promise<Verdict> {
    if (r.method !== "POST") return { kind: "respond", res: { status: 405, headers: { allow: "POST" } } };
    const secret = s[SLACK_SECRET];
    const sig = r.headers.get("x-slack-signature") ?? "";
    const ts = r.headers.get("x-slack-request-timestamp") ?? "";
    if (!secret || !/^\d{1,12}$/.test(ts) || Math.abs(r.now / 1000 - Number(ts)) > SLACK_WINDOW_S)
      return { kind: "respond", res: denied };
    if (!ctEqual(sig, await slackSign(secret, ts, r.body))) return { kind: "respond", res: denied };

    const ct = r.headers.get("content-type") ?? "";
    if (ct.includes("application/x-www-form-urlencoded"))
      return fromForm(r.body) ?? { kind: "respond", res: ok };
    let e: Record<string, any>;
    try {
      e = JSON.parse(r.body);
    } catch {
      return { kind: "respond", res: ok };
    }
    if (e.type === "url_verification" && typeof e.challenge === "string")
      return { kind: "respond", res: json({ challenge: e.challenge }), seen: "challenge" };
    if (e.type !== "event_callback" || typeof e.event_id !== "string") return { kind: "respond", res: ok };
    return {
      kind: "store",
      platformKey: e.event_id,
      senderId: e.event?.user ?? null,
      chatId: e.event?.channel ?? e.event?.item?.channel ?? null,
      headers: { "content-type": "application/json" },
      ack: ok,
    };
  },

  async replayHeaders(row, s, now) {
    const secret = s[SLACK_SECRET];
    if (!secret) throw new Error(`${SLACK_SECRET} is not set`);
    const ts = String(Math.floor(now / 1000));
    return {
      "content-type": row.headers["content-type"] ?? "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": await slackSign(secret, ts, row.body),
    };
  },
};
