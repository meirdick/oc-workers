// Setup for the M4 loss drills: config with fake Telegram (open DM policy, so every update can use its own chat
// and replies map 1:1 to updates), first wake, link the fake second channel (fakewa creds identity), one test DM.
// usage: node setup.mjs   env: U, T, WH, GW. Result: $RAW/setup.json
import {
  dm,
  LINK,
  node1000,
  now,
  ops,
  raw,
  result,
  ringSince,
  running,
  sends,
  sleep,
  U,
  WH,
  waitFor,
} from "../loss-lib.mjs";

const t0 = now();
const doc = {
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-sonnet-4-6" },
      ...(process.env.HB ? { heartbeat: { every: process.env.HB } } : {}), // M4b: heartbeat on, wake filter must hold
    },
  },
  models: { providers: { anthropic: { apiKey: `\${OC_ANTHROPIC_KEY}` } } },
  channels: {
    telegram: {
      enabled: true,
      botToken: "7000000001:AAm4lossFakeTokenForTheInterceptOnly00",
      dmPolicy: "open",
      allowFrom: ["*"],
      webhookUrl: `${U}/telegram-webhook`,
      webhookSecret: WH,
      webhookPath: "/telegram-webhook",
    },
  },
  bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "default" } }],
};
const cfg = await ops("POST", "/ops/config", { doc });
raw("setup", { step: "config", status: cfg.status, body: cfg.json });
const w = await ops("POST", "/ops/wake?wait=1", {});
raw("setup", { step: "wake", status: w.status, body: w.json });
const up = await running(900_000);
await sleep(10_000);
const link = await node1000(LINK);
raw("setup", { step: "link", link });
const chat = 72000000;
const u = await dm(chat, "m4 loss setup hello");
const rep = await waitFor(async () => ((await sends(chat, u.t0)).length ? true : null), 240_000, 2000);
await sleep(3000);
const s = await sends(chat, u.t0);
const ev = await ringSince(t0);
const setWebhook = ev.find((e) => e.src === "telegram" && e.kind === "setWebhook");
result("setup", {
  config: { status: cfg.status, ver: cfg.json?.ver ?? null, err: cfg.json?.error ?? null },
  wake: { status: w.status, ms: w.ms },
  runningMs: up.ms,
  link,
  setWebhook: setWebhook ? setWebhook.at : null,
  dm: {
    ack: u.status,
    replyMs: s[0] ? s[0].at - u.t0 : null,
    replies: s.length,
    text: s.map((e) => e.detail).slice(0, 2),
  },
  checks: {
    configAccepted: cfg.status === 200 || cfg.status === 201,
    running: !!up.v,
    linked: !!link.identity,
    replyOnce: !!rep.v && s.length === 1,
  },
});
process.exit(0);
