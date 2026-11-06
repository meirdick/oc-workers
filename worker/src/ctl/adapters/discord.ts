// Discord interactions endpoint (HTTP). Ack deadline 3 s. Signature: Ed25519 over timestamp + rawBody with the
// application's public key (headers X-Signature-Ed25519, X-Signature-Timestamp); a bad one is 401, and Discord
// probes this on purpose. PING (type 1) is answered PONG here and never stored. Everything else is acked with a
// deferred response: type 5 (deferred channel message) for slash commands and modal submits, type 6 (deferred
// update) for component clicks. Autocomplete (type 4) cannot be deferred: it gets an empty choice list.
// The interaction token lives 15 min. A follow-up after that cannot use the webhook endpoints; the reply has to go
// out through the bot REST path (POST /channels/{id}/messages with the bot token). The id of the interaction is
// the dedupe key; the signed timestamp and body replay unchanged (the signature has no time window).
// OpenClaw 2026.10.9 has no HTTP route for interactions (its Discord account runs on the gateway socket), so the
// replay target below is a guess for a future route; see docs/14-webhook-channels.md.
import { ed25519Verify } from "./crypto";
import type { AdapterResponse, InboundReq, InboxAdapter, PlatformSecrets, Verdict } from "./types";

export const DISCORD_ROUTE = "/discord/interactions";
export const DISCORD_KEY = "OC_DISCORD_PUBLIC_KEY";

const json = (o: unknown): AdapterResponse => ({
  status: 200,
  body: JSON.stringify(o),
  headers: { "content-type": "application/json" },
});

export const discord: InboxAdapter = {
  id: "discord",
  channel: "discord",
  route: DISCORD_ROUTE,
  hookPath: "/_ochost/hook/discord",
  ackDeadlineMs: 3_000,
  durableHeader: true,
  secrets: [DISCORD_KEY],

  async receive(r: InboundReq, s: PlatformSecrets): Promise<Verdict> {
    if (r.method !== "POST") return { kind: "respond", res: { status: 405, headers: { allow: "POST" } } };
    const key = s[DISCORD_KEY];
    const sig = r.headers.get("x-signature-ed25519") ?? "";
    const ts = r.headers.get("x-signature-timestamp") ?? "";
    if (!key || !sig || !ts || !(await ed25519Verify(key, sig, ts + r.body)))
      return { kind: "respond", res: { status: 401, body: "invalid request signature" } };
    let i: Record<string, any>;
    try {
      i = JSON.parse(r.body);
    } catch {
      return { kind: "respond", res: { status: 400 } };
    }
    if (i.type === 1) return { kind: "respond", res: json({ type: 1 }), seen: "ping" };
    if (i.type === 4) return { kind: "respond", res: json({ type: 8, data: { choices: [] } }) };
    if (typeof i.id !== "string") return { kind: "respond", res: { status: 400 } };
    return {
      kind: "store",
      platformKey: i.id,
      senderId: i.member?.user?.id ?? i.user?.id ?? null,
      chatId: i.channel_id ?? i.channel?.id ?? null,
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": sig,
        "x-signature-timestamp": ts,
      },
      ack: json({ type: i.type === 3 ? 6 : 5 }),
    };
  },

  async replayHeaders(row) {
    return {
      "content-type": "application/json",
      "x-signature-ed25519": row.headers["x-signature-ed25519"] ?? "",
      "x-signature-timestamp": row.headers["x-signature-timestamp"] ?? "",
    };
  },
};
