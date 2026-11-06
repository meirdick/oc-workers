// Telegram config for tests: webhook transport (sleep-ok class), fake Bot API at api.telegram.org
// (15.0.0.20, TLS with the test CA). Keys from OpenClaw extensions/telegram/src/config-schema.ts
// (main 44e6b1b8): botToken, webhookUrl, webhookSecret. guess: 2026.10.9 has the same keys.
export const TG_TOKEN = "7000000001:m1-fake-token";
export const tgDoc = (extra = {}) => ({
  channels: {
    telegram: {
      enabled: true,
      botToken: TG_TOKEN,
      webhookUrl: "https://m1.invalid/_ochost/tg/default",
      webhookSecret: "m1-webhook-secret-0123456789",
      ...extra,
    },
  },
});
