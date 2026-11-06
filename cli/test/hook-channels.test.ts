// `ochost channels add slack|discord|twilio` (cli/src/hook-channels.ts): secrets to the Worker, HTTP-mode config
// checked against OpenClaw 2026.10.9's own channel schemas, the URL for the console, and the wait for the
// platform's call.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../../worker/src/ctl/adapters/index.ts";
import {
  type AddHookDeps,
  addHookChannel,
  HOOK_CHANNELS,
  SPECS,
  withHookChannel,
  withoutChannel,
} from "../src/hook-channels.ts";
import { fakeFetch, fakeOps } from "./fakes.ts";
import { check } from "./schema-check.ts";

const SCHEMAS = JSON.parse(
  readFileSync(new URL("./fixtures/oc-channel-schemas.json", import.meta.url), "utf8"),
);
const ORIGIN = "https://oc-x.example.workers.dev";

// fake secrets of the right shape
const ENV = {
  SLACK_BOT_TOKEN: "xoxb-fake-token-for-tests-only",
  SLACK_SIGNING_SECRET: "8f742231b10e8888abcd99yyyzzz85a5",
  DISCORD_BOT_TOKEN: "faketokenpart01.fake.faketokenthirdpartonly20",
  DISCORD_PUBLIC_KEY: "a".repeat(64),
  DISCORD_APPLICATION_ID: "111111111111111111",
  TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "2".repeat(32),
  TWILIO_PHONE_NUMBER: "+15551234567",
};

function mk(over: Partial<AddHookDeps> = {}, hooks: (n: number) => unknown = () => null) {
  const lines: string[] = [];
  const put: [string, string][] = [];
  let t = 1_000_000;
  let polls = 0;
  const o = fakeOps({
    "GET /ops/inbox": () => ({
      status: 200,
      body: { counts: {}, rows: [], hooks: { [hookId.id]: hooks(++polls) } },
    }),
  });
  o.versions.push({ ver: 1, doc: { agents: {} } });
  const net = fakeFetch([["GET https://", () => ({ status: 405 })]]);
  const d: AddHookDeps = {
    fetch: net.fetch,
    env: ENV,
    ops: o.ops,
    log: (l) => lines.push(l),
    registerSecret: () => {},
    putSecret: async (n, v) => void put.push([n, v]),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ...over,
  };
  return { d, o, lines, put, net, now: () => t };
}
const hookId = { id: "slack" };

/** Schema of a channel: Slack's http mode needs the signing secret (refine in extensions/slack config-schema.ts). */
function validate(channel: "slack" | "discord" | "sms", cfg: Record<string, any>): string[] {
  const errs = check(SCHEMAS[channel], cfg, channel);
  if (channel === "slack" && cfg.mode === "http" && !cfg.signingSecret)
    errs.push("slack: mode http requires signingSecret");
  return errs;
}

describe.each(HOOK_CHANNELS)("channels add %s", (ch) => {
  const spec = SPECS[ch];
  const hit = { at: 1_000_000 + 6_000, kind: "challenge" };

  it("stores each secret as a Worker secret, renders the config, prints the URL, verifies on the platform's call", async () => {
    hookId.id = ch;
    const m = mk({}, (n) => (n >= 3 ? hit : null));
    const r = await addHookChannel(ch, { origin: ORIGIN, verifyTimeoutMs: 300_000 }, m.d);
    expect(r).toMatchObject({ ok: true, channel: ch, url: `${ORIGIN}${spec.hookPath}`, verified: true });
    // every secret field is a Worker secret OC_SECRET_<NAME>, value exactly as given, nothing else is
    const secrets = spec.fields.filter((f) => f.secret);
    expect(m.put).toEqual(secrets.map((f) => [`OC_SECRET_${f.secret}`, ENV[f.env as keyof typeof ENV]]));
    const doc = m.o.versions.at(-1)?.doc;
    const text = JSON.stringify(doc);
    for (const f of secrets) expect(text).not.toContain(ENV[f.env as keyof typeof ENV]);
    expect(doc.bindings).toEqual([
      { agentId: "main", match: { channel: spec.channel, accountId: "default" } },
    ]);
    const out = m.lines.join("\n");
    expect(out).toContain(`${ORIGIN}${spec.hookPath}`);
    expect(out).toContain(`acks inside ${spec.ackS} s`);
    for (const f of secrets) expect(out).not.toContain(ENV[f.env as keyof typeof ENV]);
    expect(m.o.calls.filter((c) => c.path === "/ops/inbox").length).toBe(3); // polled until the call showed
  });

  it("config keys validate against the clone's schema (v2026.10.9) and use HTTP, not socket", () => {
    const a: Record<string, string> = {
      botToken: "x",
      token: "x",
      signingSecret: "x",
      publicKey: "x",
      applicationId: ENV.DISCORD_APPLICATION_ID,
      accountSid: ENV.TWILIO_ACCOUNT_SID,
      authToken: "x",
      sender: ENV.TWILIO_PHONE_NUMBER,
    };
    const url = `${ORIGIN}${spec.hookPath}`;
    const doc = withHookChannel({}, spec, a, url);
    const cfg = doc.channels[spec.channel];
    expect(validate(spec.channel as "slack", cfg)).toEqual([]);
    if (ch === "slack") {
      expect(cfg).toMatchObject({ mode: "http", webhookPath: "/slack/events" });
      expect(cfg.appToken).toBeUndefined();
    }
    if (ch === "twilio") expect(cfg).toMatchObject({ publicWebhookUrl: url, webhookPath: "/webhooks/sms" });
    // the schema is strict: a made-up key is caught, so the check above has teeth
    expect(validate(spec.channel as "slack", { ...cfg, notAKey: 1 })).toEqual([
      `${spec.channel}.notAKey: unknown key`,
    ]);
  });
});

describe("hook channels: details", () => {
  it("Slack: switching a Socket Mode account to HTTP drops appToken and keeps the rest", () => {
    const old = {
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: "xapp-1",
          dmPolicy: "allowlist",
          allowFrom: ["U1"],
        },
      },
      bindings: [{ agentId: "x", match: { channel: "slack" } }],
    };
    const next = withHookChannel(old, SPECS.slack, { botToken: "t", signingSecret: "s" }, "u");
    expect(next.channels.slack).toMatchObject({ mode: "http", dmPolicy: "pairing", allowFrom: ["U1"] });
    expect(next.channels.slack.appToken).toBeUndefined();
    expect(next.bindings).toEqual(old.bindings); // an existing binding is not duplicated
    expect(validate("slack", next.channels.slack)).toEqual([]);
  });

  it("Twilio: a Messaging Service SID becomes messagingServiceSid, a number becomes fromNumber", () => {
    const base = { accountSid: ENV.TWILIO_ACCOUNT_SID, authToken: "x" };
    const ms = SPECS.twilio.render({ ...base, sender: `MG${"3".repeat(32)}` }, "u");
    expect(ms.messagingServiceSid).toBe(`MG${"3".repeat(32)}`);
    expect(ms.fromNumber).toBeUndefined();
    expect(SPECS.twilio.render({ ...base, sender: "+15551234567" }, "u").fromNumber).toBe("+15551234567");
    expect(validate("sms", ms)).toEqual([]);
  });

  it("withoutChannel removes the channel and its binding only", () => {
    const doc = {
      channels: { slack: { enabled: true }, telegram: { enabled: true } },
      bindings: [{ match: { channel: "slack" } }, { match: { channel: "telegram" } }],
    };
    expect(withoutChannel(doc, "slack")).toEqual({
      channels: { telegram: { enabled: true } },
      bindings: [{ match: { channel: "telegram" } }],
    });
  });

  it("missing secrets non-interactive → exit 3 naming the env vars; wrong shape → one line, no value", async () => {
    hookId.id = "slack";
    const e = await addHookChannel(
      "slack",
      { origin: ORIGIN, nonInteractive: true, verifyTimeoutMs: 0 },
      mk({ env: {} }).d,
    ).catch((x) => x);
    expect(e.exit).toBe(3);
    expect(e.message).toMatch(/SLACK_BOT_TOKEN is unset.*SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET/);
    const bad = "xoxp-not-a-bot-token-1234567890";
    const e2 = await addHookChannel(
      "slack",
      { origin: ORIGIN, verifyTimeoutMs: 0 },
      mk({ env: { ...ENV, SLACK_BOT_TOKEN: bad } }).d,
    ).catch((x) => x);
    expect(e2.message).toMatch(/SLACK_BOT_TOKEN value has the wrong shape \(expected xoxb-…\)/);
    expect(e2.message).not.toContain(bad);
  });

  it("prompts for what the env lacks: hidden for secrets, plain for ids", async () => {
    hookId.id = "twilio";
    const asked: string[] = [];
    const m = mk({
      env: {},
      askHidden: async (q) => {
        asked.push(q);
        return ENV.TWILIO_AUTH_TOKEN;
      },
      ask: async (q) => {
        asked.push(q);
        return q.includes("Account SID") ? ENV.TWILIO_ACCOUNT_SID : ENV.TWILIO_PHONE_NUMBER;
      },
    });
    await addHookChannel("twilio", { origin: ORIGIN, verifyTimeoutMs: 0 }, m.d);
    expect(asked.map((q) => q.split(" (")[0])).toEqual([
      "Twilio Account SID",
      "Twilio Auth Token",
      "Twilio number",
    ]);
    expect(asked[1]).toContain("input is hidden");
    expect(asked[0]).not.toContain("hidden");
    expect(m.put).toEqual([["OC_SECRET_OC_TWILIO_AUTH_TOKEN", ENV.TWILIO_AUTH_TOKEN]]);
  });

  it("an old Worker (no hook route) → fix line before any secret is stored", async () => {
    hookId.id = "slack";
    const m = mk({ fetch: fakeFetch([["GET https://", () => ({ status: 404 })]]).fetch });
    await expect(addHookChannel("slack", { origin: ORIGIN, verifyTimeoutMs: 0 }, m.d)).rejects.toThrow(
      "Failed: this Worker has no Slack webhook route (/_ochost/hook/slack) — fix: ochost deploy, then rerun",
    );
    expect(m.put).toEqual([]);
  });

  it("the platform never calls → exit 4 after the budget with the fix line", async () => {
    hookId.id = "discord";
    const m = mk();
    const e = await addHookChannel("discord", { origin: ORIGIN, verifyTimeoutMs: 60_000 }, m.d).catch(
      (x) => x,
    );
    expect(e.exit).toBe(4);
    expect(e.message).toBe(
      "Failed: Discord has not called /_ochost/hook/discord in 1 min (Discord's PING) — fix: paste https://oc-x.example.workers.dev/_ochost/hook/discord in the Discord console, then rerun ochost channels add discord; ochost logs --source ctl",
    );
  });

  it("an older call does not count as verification", async () => {
    hookId.id = "slack";
    const m = mk({}, () => ({ at: 1_000_000 - 3_600_000, kind: "challenge" }));
    const e = await addHookChannel("slack", { origin: ORIGIN, verifyTimeoutMs: 15_000 }, m.d).catch((x) => x);
    expect(e.exit).toBe(4);
  });

  it("CLI constants match the Worker adapters: path, route, channel id; every secret the Worker reads is stored", () => {
    for (const a of ADAPTERS) {
      const s = SPECS[a.id];
      expect(s.hookPath).toBe(a.hookPath);
      expect(s.route).toBe(a.route);
      expect(s.channel).toBe(a.channel);
      expect(s.ackS * 1000).toBe(a.ackDeadlineMs);
      const stored = s.fields.flatMap((f) => (f.secret ? [f.secret] : []));
      for (const n of a.secrets) expect(stored).toContain(n);
    }
  });
});
