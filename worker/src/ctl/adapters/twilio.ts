// Twilio SMS/MMS webhook. Ack deadline 15 s (read timeout). By default Twilio retries once, and only a failed TCP
// or TLS connect (rc=1, rp=ct): a 5xx or a timeout is not retried, so a missed ack loses the message. Dedupe key: MessageSid (status callbacks reuse the sid of
// an outbound message, so their key adds MessageStatus).
// Signature: base64(HMAC-SHA1(authToken, url + sorted(key + value))), header X-Twilio-Signature, over the full
// public URL (https://www.twilio.com/docs/usage/security). The URL is the Worker hook URL, so OpenClaw's
// `publicWebhookUrl` is set to the same URL and the original signature and body replay unchanged.
// Reply: an empty TwiML <Response/>; OpenClaw sends the answer through the Messages API.
import { ctEqual, hmacSha1B64 } from "./crypto";
import type { InboundReq, InboxAdapter, PlatformSecrets, Verdict } from "./types";

export const TWILIO_ROUTE = "/webhooks/sms";
export const TWILIO_TOKEN = "OC_TWILIO_AUTH_TOKEN";
export const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
const TWIML = { "content-type": "text/xml; charset=utf-8" };

/** Twilio's signed string: URL, then each param sorted by key (code point order) as key + value. */
export async function twilioSign(token: string, url: string, form: URLSearchParams): Promise<string> {
  const keys = [...new Set(form.keys())].sort();
  let data = url;
  for (const k of keys) for (const v of form.getAll(k).sort()) data += k + v;
  return hmacSha1B64(token, data);
}

export const twilio: InboxAdapter = {
  id: "twilio",
  channel: "sms",
  route: TWILIO_ROUTE,
  hookPath: "/_ochost/hook/twilio",
  ackDeadlineMs: 15_000,
  durableHeader: true,
  secrets: [TWILIO_TOKEN],

  async receive(r: InboundReq, s: PlatformSecrets): Promise<Verdict> {
    if (r.method !== "POST") return { kind: "respond", res: { status: 405, headers: { allow: "POST" } } };
    const token = s[TWILIO_TOKEN];
    const sig = r.headers.get("x-twilio-signature") ?? "";
    const form = new URLSearchParams(r.body);
    if (!token || !sig || !ctEqual(sig, await twilioSign(token, r.url, form)))
      return { kind: "respond", res: { status: 401 } };
    const sid = form.get("MessageSid") ?? form.get("SmsSid");
    if (!sid) return { kind: "respond", res: { status: 200, body: TWIML_EMPTY, headers: TWIML } };
    const status = form.get("MessageStatus");
    const callback = !!status && form.get("SmsStatus") !== "received" && !form.has("Body");
    return {
      kind: "store",
      platformKey: callback ? `${sid}:${status}` : sid,
      senderId: form.get("From"),
      chatId: form.get("From"),
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
      ack: { status: 200, body: TWIML_EMPTY, headers: TWIML },
      // A delivery receipt for our own message is no reason to boot a container.
      hold: callback,
    };
  },

  async replayHeaders(row) {
    return {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": row.headers["x-twilio-signature"] ?? "",
    };
  },
};
