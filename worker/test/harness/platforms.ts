// Fake Slack, Discord and Twilio for the inbox adapter tests (the way gates/fakes.ts fakes Telegram). The platform
// side signs requests with node:crypto and the platform docs' recipes, independent of ctl/adapters, so a wrong
// adapter fails here. FakeGateway is the OpenClaw side of a replay: it checks what the real route checks
// (Slack: signature and 5 min window; Twilio: signature over publicWebhookUrl; Discord: Ed25519) and dedupes on the
// platform's own key, so a replay that breaks a dedupe key or a signature shows up as a drop or a 401.
import {
  createHmac,
  sign as edSign,
  verify as edVerify,
  generateKeyPairSync,
  timingSafeEqual,
} from "node:crypto";

export const WORKER = "https://oc.example.workers.dev";
const hmacHex = (k: string, m: string) => createHmac("sha256", k).update(m).digest("hex");

export const req = (path: string, init: { body: string; headers: Record<string, string>; method?: string }) =>
  new Request(WORKER + path, { method: init.method ?? "POST", body: init.body, headers: init.headers });

export class FakeSlack {
  secret = "8f742231b10e8888abcd99yyyzzz85a5";
  constructor(public now: () => number) {}
  /** A signed request exactly as Slack sends it. */
  send(
    body: string,
    o: { contentType?: string; ts?: number; secret?: string; retry?: number } = {},
  ): Request {
    const ts = String(o.ts ?? Math.floor(this.now() / 1000));
    const headers: Record<string, string> = {
      "content-type": o.contentType ?? "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": `v0=${hmacHex(o.secret ?? this.secret, `v0:${ts}:${body}`)}`,
    };
    if (o.retry) {
      headers["x-slack-retry-num"] = String(o.retry);
      headers["x-slack-retry-reason"] = "http_timeout";
    }
    return req("/_ochost/hook/slack", { body, headers });
  }
  event(eventId: string, o: { user?: string; channel?: string; text?: string } = {}) {
    return JSON.stringify({
      token: "legacy",
      team_id: "T1",
      api_app_id: "A1",
      type: "event_callback",
      event_id: eventId,
      event_time: Math.floor(this.now() / 1000),
      event: {
        type: "message",
        user: o.user ?? "U1",
        channel: o.channel ?? "D1",
        text: o.text ?? "hi",
        ts: "1700000000.000100",
      },
    });
  }
}

export class FakeDiscord {
  private kp = generateKeyPairSync("ed25519");
  /** Application public key as the developer portal shows it: 32 raw bytes, hex. */
  publicKey = (this.kp.publicKey.export({ format: "der", type: "spki" }) as Buffer)
    .subarray(-32)
    .toString("hex");
  constructor(public now: () => number) {}
  send(body: string, o: { ts?: string; sigOver?: string } = {}): Request {
    const ts = o.ts ?? String(Math.floor(this.now() / 1000));
    const sig = edSign(null, Buffer.from(o.sigOver ?? ts + body), this.kp.privateKey).toString("hex");
    return req("/_ochost/hook/discord", {
      body,
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": sig,
        "x-signature-timestamp": ts,
      },
    });
  }
  command(id: string, o: { user?: string; channel?: string } = {}) {
    return JSON.stringify({
      id,
      application_id: "100",
      type: 2,
      token: "itok",
      version: 1,
      channel_id: o.channel ?? "555",
      member: { user: { id: o.user ?? "777" } },
      data: { id: "1", name: "ask", type: 1 },
    });
  }
}

export class FakeTwilio {
  authToken = "12345";
  url = `${WORKER}/_ochost/hook/twilio`;
  signature(url: string, p: Record<string, string>, token = this.authToken): string {
    const data =
      url +
      Object.keys(p)
        .sort()
        .map((k) => k + p[k])
        .join("");
    return createHmac("sha1", token).update(data).digest("base64");
  }
  send(p: Record<string, string>, o: { token?: string } = {}): Request {
    return req("/_ochost/hook/twilio", {
      body: new URLSearchParams(p).toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": this.signature(this.url, p, o.token),
      },
    });
  }
  sms(sid: string, from = "+14158675310", body = "hello") {
    return {
      MessageSid: sid,
      SmsSid: sid,
      AccountSid: "AC123",
      From: from,
      To: "+18005551212",
      Body: body,
      NumMedia: "0",
      SmsStatus: "received",
    };
  }
}

export interface GatewayCall {
  path: string;
  body: string;
  headers: Record<string, string>;
}

/** The gateway's side of a replay. Returns the {status, durable} the Runtime DO would report. */
export class FakeGateway {
  seen = new Map<string, number>();
  /** Everything the gateway accepted, in order. */
  accepted: GatewayCall[] = [];
  rejected: { call: GatewayCall; why: string }[] = [];
  down = false;
  constructor(
    public now: () => number,
    public cfg: { slackSecret?: string; twilioToken?: string; twilioUrl?: string; discordKey?: string } = {},
  ) {}

  handle = (c: GatewayCall): { status: number; durable: boolean } => {
    if (this.down) return { status: 503, durable: false };
    const why = this.check(c);
    if (why) {
      this.rejected.push({ call: c, why });
      return { status: why === "bad-body" ? 400 : 401, durable: false };
    }
    const key = this.dedupeKey(c);
    const first = !this.seen.has(key);
    this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
    if (first) this.accepted.push(c);
    // OpenClaw's SMS route sets the durable header; the Slack Bolt receiver does not.
    return { status: 200, durable: c.path === "/webhooks/sms" };
  };

  private check(c: GatewayCall): string | null {
    const h = c.headers;
    if (c.path === "/slack/events") {
      const ts = h["x-slack-request-timestamp"] ?? "";
      if (Math.abs(this.now() / 1000 - Number(ts)) > 300) return "stale-timestamp";
      const want = `v0=${hmacHex(this.cfg.slackSecret ?? "", `v0:${ts}:${c.body}`)}`;
      const got = h["x-slack-signature"] ?? "";
      return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want))
        ? null
        : "bad-signature";
    }
    if (c.path === "/webhooks/sms") {
      const p = Object.fromEntries(new URLSearchParams(c.body));
      const data =
        (this.cfg.twilioUrl ?? "") +
        Object.keys(p)
          .sort()
          .map((k) => k + p[k])
          .join("");
      const want = createHmac("sha1", this.cfg.twilioToken ?? "")
        .update(data)
        .digest("base64");
      return h["x-twilio-signature"] === want ? null : "bad-signature";
    }
    if (c.path === "/discord/interactions") {
      const der = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(this.cfg.discordKey ?? "", "hex"),
      ]);
      const key = { key: der, format: "der", type: "spki" } as const;
      const msg = Buffer.from((h["x-signature-timestamp"] ?? "") + c.body);
      return edVerify(null, msg, key, Buffer.from(h["x-signature-ed25519"] ?? "", "hex"))
        ? null
        : "bad-signature";
    }
    return "no-route";
  }

  private dedupeKey(c: GatewayCall): string {
    if (c.path === "/slack/events") {
      const j = JSON.parse(c.body);
      return `slack:${j.event_id}`;
    }
    if (c.path === "/webhooks/sms") return `sms:${new URLSearchParams(c.body).get("MessageSid")}`;
    return `discord:${JSON.parse(c.body).id}`;
  }
}
