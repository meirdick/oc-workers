// docs/14 (M7 live F2): the Slack and SMS channel plugins are baked into the image and loaded by path. Offline,
// with fake credentials, the gateway mounts /slack/events and /webhooks/sms, and a replay signed the way the Worker
// signs it is accepted (Slack: 2xx; SMS: 200 + x-openclaw-delivery-accepted: durable). Without the plugins these
// routes answer 404 and the inbox rows never leave `pending`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dk } from "../harness/docker.mjs";

const SLACK_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const TWILIO_TOKEN = "0".repeat(32);
const HOOK = "https://oc-test.example.workers.dev/_ochost/hook/twilio";
const ref = (id) => ({ source: "env", provider: "default", id });

const CFG = {
  gateway: { bind: "loopback", port: 18789, mode: "local" },
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      webhookPath: "/slack/events",
      botToken: ref("OC_SLACK_BOT_TOKEN"),
      signingSecret: ref("OC_SLACK_SIGNING_SECRET"),
      dmPolicy: "pairing",
    },
    sms: {
      enabled: true,
      accountSid: `AC${"0".repeat(32)}`,
      authToken: ref("OC_TWILIO_AUTH_TOKEN"),
      fromNumber: "+15550001111",
      publicWebhookUrl: HOOK,
      webhookPath: "/webhooks/sms",
      dmPolicy: "pairing",
    },
  },
  // Same keys as cli/src/hook-channels.ts withHookChannel.
  plugins: {
    load: { paths: ["/opt/oc-plugins/slack", "/opt/oc-plugins/sms"] },
    entries: { slack: { enabled: true }, sms: { enabled: true } },
  },
  bindings: [
    { agentId: "main", match: { channel: "slack", accountId: "default" } },
    { agentId: "main", match: { channel: "sms", accountId: "default" } },
  ],
};

// Runs inside the container: signs like worker/src/ctl/adapters (Slack re-signed now, Twilio over the hook URL).
const POST = `
import crypto from "node:crypto";
const b = "http://127.0.0.1:18789";
const out = async (n, r) => console.log("@@" + n, r.status, r.headers.get("x-openclaw-delivery-accepted") || "-");
const ev = JSON.stringify({ type: "event_callback", team_id: "T1", api_app_id: "A1", event_id: "EvT1", event_time: 1,
  event: { type: "message", channel_type: "im", user: "U1", channel: "D1", text: "hi", ts: "1.1" } });
const ts = String(Math.floor(Date.now() / 1000));
const sig = "v0=" + crypto.createHmac("sha256", "${SLACK_SECRET}").update("v0:" + ts + ":" + ev).digest("hex");
await out("slack", await fetch(b + "/slack/events", { method: "POST", headers: { "content-type": "application/json",
  "x-slack-request-timestamp": ts, "x-slack-signature": sig }, body: ev }));
const p = { MessageSid: "SM" + "0".repeat(31) + "1", AccountSid: "AC" + "0".repeat(32), From: "+15550002222",
  To: "+15550001111", Body: "hi", NumMedia: "0" };
const data = "${HOOK}" + Object.keys(p).sort().map((k) => k + p[k]).join("");
const tsig = crypto.createHmac("sha1", "${TWILIO_TOKEN}").update(data).digest("base64");
const sms = () => fetch(b + "/webhooks/sms", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
  "x-twilio-signature": tsig }, body: new URLSearchParams(p).toString() });
await out("sms", await sms());
await out("sms-again", await sms());
await out("sms-badsig", await fetch(b + "/webhooks/sms", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
  "x-twilio-signature": "bad" }, body: new URLSearchParams(p).toString() }));
await out("discord", await fetch(b + "/discord/interactions", { method: "POST", body: "{}" }));
`;

const SCRIPT = `
mkdir -p /tmp/st /tmp/h; cp /cfg/openclaw.json /tmp/st/openclaw.json; cd /app
node openclaw.mjs gateway --allow-unconfigured --bind loopback --port 18789 > /tmp/gw.out 2>&1 &
for i in $(seq 1 120); do grep -q "http mode listening at /slack/events" /tmp/gw.out && grep -q "Registered SMS webhook route" /tmp/gw.out && break; sleep 1; done
node --input-type=module -e "$(cat /cfg/post.mjs)" 2>&1
echo "@@log"; grep -E "slack|sms|no channel plugin|no-channel-owner" /tmp/gw.out | cut -c1-240
`;

export default {
  name: "channel-plugins",
  source: "docs/14 Per channel, Notes 'Plugins'; worker/test/results/M7-live-access.md F2",
  rule: "Image ships /opt/oc-plugins/slack and /opt/oc-plugins/sms root-owned with their bundled deps. Offline with fake credentials: the gateway logs 'http mode listening at /slack/events' and 'Registered SMS webhook route /webhooks/sms', no 'no-channel-owner'; a signed Slack event gets 200; a signed SMS gets 200 + durable, a repeat 200 + durable, a bad signature 403; /discord/interactions stays 404.",
  timeoutMs: 400_000,
  async run(t) {
    const sh = (c) => dk(["run", "--rm", "--entrypoint", "sh", t.image, "-c", c]);
    const own = sh("stat -c '%U' /opt/oc-plugins/slack /opt/oc-plugins/sms").out;
    t.check(
      "plugin dirs root-owned",
      own.split("\n").every((x) => x === "root"),
      own,
    );
    t.check(
      "dependencies bundled",
      sh(
        "test -d /opt/oc-plugins/slack/node_modules/@slack/bolt && test -d /opt/oc-plugins/sms/node_modules/zod",
      ).code === 0,
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chp-"));
    fs.writeFileSync(path.join(dir, "openclaw.json"), JSON.stringify(CFG));
    fs.writeFileSync(path.join(dir, "post.mjs"), POST);
    const r = dk(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "1000",
        "-v",
        `${dir}:/cfg:ro`,
        "-e",
        "HOME=/tmp/h",
        "-e",
        "OPENCLAW_STATE_DIR=/tmp/st",
        "-e",
        "OPENCLAW_CONFIG_PATH=/tmp/st/openclaw.json",
        "-e",
        "OC_SLACK_BOT_TOKEN=xoxb-0000000000-fakefakefake",
        "-e",
        `OC_SLACK_SIGNING_SECRET=${SLACK_SECRET}`,
        "-e",
        `OC_TWILIO_AUTH_TOKEN=${TWILIO_TOKEN}`,
        "--entrypoint",
        "sh",
        t.image,
        "-c",
        SCRIPT,
      ],
      { timeoutMs: 350_000 },
    );
    fs.rmSync(dir, { recursive: true, force: true });
    const line = (k) => new RegExp(`^@@${k} (.*)$`, "m").exec(r.out)?.[1] ?? "";
    const log = /@@log\n([\s\S]*)$/.exec(r.out)?.[1] ?? "";
    t.measure(
      "answers",
      ["slack", "sms", "sms-again", "sms-badsig", "discord"].map((k) => `${k} ${line(k)}`),
    );
    t.check("Slack route mounted", /http mode listening at \/slack\/events/.test(log), log.slice(-600));
    t.check("SMS route mounted", /Registered SMS webhook route \/webhooks\/sms/.test(log), log.slice(-600));
    t.check("no channel without owner", !/no-channel-owner|no channel plugin/.test(log), log.slice(-600));
    t.check("signed Slack event → 200", /^200 /.test(line("slack")), line("slack"));
    t.check("signed SMS → 200 durable", line("sms") === "200 durable", line("sms"));
    t.check(
      "repeat SMS (same MessageSid) → 200 durable",
      line("sms-again") === "200 durable",
      line("sms-again"),
    );
    t.check("bad Twilio signature → 403", /^403 /.test(line("sms-badsig")), line("sms-badsig"));
    t.check("Discord interactions still 404 (no plugin)", /^404 /.test(line("discord")), line("discord"));
  },
};
