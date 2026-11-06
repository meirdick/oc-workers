import { describe, expect, it } from "vitest";
import { addTelegram, type ChannelDeps, hookMatches, redactHookUrl, withTelegram } from "../src/channels.ts";
import { fakeFetch, fakeOps, type Handler } from "./fakes.ts";

const BOT = "123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr"; // fake, right shape
const ORIGIN = "https://oc-m5-x.example.workers.dev";
const SEG = "0123456789abcdef0123456789abcdef";
const TG = "https://api.telegram.org";

function fakeTelegram(state: { url: string; err?: number }) {
  const getMe: Handler = () => ({
    json: { ok: true, result: { id: 123456789, username: "oc_test_bot", is_bot: true } },
  });
  return fakeFetch([
    [`GET ${TG}/bot${BOT}/getMe`, getMe],
    [
      `GET ${TG}/bot${BOT}/getWebhookInfo`,
      () => ({
        json: {
          ok: true,
          result: {
            url: state.url,
            pending_update_count: 0,
            ...(state.err ? { last_error_date: state.err, last_error_message: "Wrong response" } : {}),
          },
        },
      }),
    ],
    [`GET ${TG}/bot`, () => ({ status: 401, json: { ok: false, description: "Unauthorized" } })],
  ]);
}

function mk(fetch: typeof globalThis.fetch, ops: ChannelDeps["ops"], over: Partial<ChannelDeps> = {}) {
  const lines: string[] = [];
  const put: [string, string][] = [];
  let t = 1_000_000;
  const d: ChannelDeps = {
    fetch,
    env: { TELEGRAM_BOT_TOKEN: BOT },
    ops,
    log: (l) => lines.push(l),
    registerSecret: () => {},
    putSecret: async (n, v) => {
      put.push([n, v]);
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ...over,
  };
  return { d, lines, put };
}

describe("channels add telegram", () => {
  it("W8 route: secret on the Worker, config, Worker sets the webhook, getWebhookInfo matches", async () => {
    const tg = { url: "" };
    const o = fakeOps({
      "POST /ops/telegram/webhook": () => {
        tg.url = `${ORIGIN}/_ochost/hook/telegram/${SEG}`;
        return { status: 200, body: { ok: true } };
      },
    });
    o.versions.push({ ver: 1, doc: { agents: {} } });
    const { d, lines, put } = mk(fakeTelegram(tg).fetch, o.ops);
    const r = await addTelegram({ origin: ORIGIN }, d);
    expect(r).toMatchObject({
      ok: true,
      bot: { username: "oc_test_bot" },
      configVer: 2,
      webhook: { via: "ops", path: "secret", url: `${ORIGIN}/_ochost/hook/telegram/<secret>` },
    });
    expect(put).toEqual([["OC_SECRET_OC_TELEGRAM_BOT_TOKEN", BOT]]);
    const doc = o.versions.at(-1)!.doc;
    expect(doc.channels.telegram).toMatchObject({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: OpenClaw SecretRef
      botToken: "${OC_TELEGRAM_BOT_TOKEN}",
      dmPolicy: "pairing",
      streaming: { mode: "partial" },
      webhookUrl: `${ORIGIN}/telegram-webhook`,
    });
    expect(doc.bindings).toEqual([{ agentId: "main", match: { channel: "telegram", accountId: "default" } }]);
    const out = lines.join("\n");
    expect(out).not.toContain(SEG);
    expect(out).not.toContain(BOT);
    // without --wait-pair (the --no-wait path) the hook URL is still printed, secret segment hidden
    expect(out).toContain(`Webhook URL: ${ORIGIN}/_ochost/hook/telegram/<secret>`);
    expect(out).toMatch(/ochost pairing approve telegram <code>/);
    expect(o.calls.some((c) => c.path === "/ops/restart")).toBe(false);
  });
  it("no W8 route → restart fallback; legacy path accepted", async () => {
    const tg = { url: "" };
    const o = fakeOps({
      "POST /ops/restart": () => {
        tg.url = `${ORIGIN}/telegram-webhook`;
        return { status: 200, body: {} };
      },
    });
    const { d } = mk(fakeTelegram(tg).fetch, o.ops);
    const r = await addTelegram({ origin: ORIGIN }, d);
    expect(r.webhook).toEqual({
      via: "restart",
      path: "legacy",
      pending: 0,
      url: `${ORIGIN}/telegram-webhook`,
    });
  });
  it("webhook never set → exit 4 after the budget, no secret in the text", async () => {
    const tg = { url: `https://other.example/_ochost/hook/telegram/${SEG}` };
    const o = fakeOps({ "POST /ops/telegram/webhook": () => ({ status: 200, body: { ok: true } }) });
    const { d } = mk(fakeTelegram(tg).fetch, o.ops);
    const e = await addTelegram({ origin: ORIGIN, webhookTimeoutMs: 20_000 }, d).catch((x) => x);
    expect(e.exit).toBe(4);
    expect(e.message).toBe(
      "Failed: Telegram webhook not set after 0 min (webhook points at https://other.example) — fix: ochost logs --source ocsup; ochost restart",
    );
  });
  it("bad token shape, getMe refusal, non-interactive with no token, second bot", async () => {
    const o = fakeOps();
    const tg = fakeTelegram({ url: "" });
    await expect(
      addTelegram({ origin: ORIGIN }, mk(tg.fetch, o.ops, { env: { TELEGRAM_BOT_TOKEN: "nope" } }).d),
    ).rejects.toThrow(/wrong shape/);
    const other = "987654321:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr";
    await expect(
      addTelegram({ origin: ORIGIN }, mk(tg.fetch, o.ops, { env: { TELEGRAM_BOT_TOKEN: other } }).d),
    ).rejects.toThrow(
      "Failed: Telegram rejected the token (getMe 401) — fix: copy the token from @BotFather again; rerun with --token-file",
    );
    const ni = await addTelegram(
      { origin: ORIGIN, nonInteractive: true },
      mk(tg.fetch, o.ops, { env: {} }).d,
    ).catch((x) => x);
    expect(ni.exit).toBe(3);
    const o2 = fakeOps();
    o2.versions.push({ ver: 1, doc: { channels: { telegram: { enabled: true } } } });
    await expect(addTelegram({ origin: ORIGIN, storedBotId: 42 }, mk(tg.fetch, o2.ops).d)).rejects.toThrow(
      /a second Telegram bot is not supported in v1/,
    );
  });
  it("--wait-pair: wakes, polls, asks y/N, approves", async () => {
    const tg = { url: `${ORIGIN}/_ochost/hook/telegram/${SEG}` };
    let polls = 0;
    const o = fakeOps({
      "POST /ops/telegram/webhook": () => ({ status: 200, body: { ok: true } }),
      "POST /ops/wake": () => ({ status: 200, body: {} }),
      "GET /ops/pairing": () => ({
        status: 200,
        body: { requests: ++polls < 3 ? [] : [{ code: "ABCD1234", id: "555", name: "Owner" }] },
      }),
      "POST /ops/pairing/approve": () => ({ status: 200, body: { ok: true } }),
    });
    const asked: string[] = [];
    const { d } = mk(fakeTelegram(tg).fetch, o.ops, {
      confirm: async (q) => {
        asked.push(q);
        return true;
      },
    });
    const r = await addTelegram({ origin: ORIGIN, waitPair: true }, d);
    expect(r.paired).toEqual({ id: "555", name: "Owner" });
    expect(asked).toEqual(["Pair Owner (id 555), code ABCD1234? [y/N] "]);
    expect(o.calls.find((c) => c.path === "/ops/pairing/approve")?.body).toEqual({
      ch: "telegram",
      code: "ABCD1234",
    });
    expect(o.calls.filter((c) => c.path === "/ops/wake")).toHaveLength(1);
  });
  it("--wait-pair timeout → exit 4; no pairing route → exit 1", async () => {
    const tg = { url: `${ORIGIN}/_ochost/hook/telegram/${SEG}` };
    const base = {
      "POST /ops/telegram/webhook": () => ({ status: 200, body: { ok: true } }),
      "POST /ops/wake": () => ({ status: 200, body: {} }),
    };
    const o = fakeOps({ ...base, "GET /ops/pairing": () => ({ status: 200, body: { requests: [] } }) });
    const e = await addTelegram(
      { origin: ORIGIN, waitPair: true, pairTimeoutMs: 60_000 },
      mk(fakeTelegram(tg).fetch, o.ops).d,
    ).catch((x) => x);
    expect(e.exit).toBe(4);
    expect(e.message).toMatch(/^Failed: no pairing request in 1 min/);
    const o2 = fakeOps(base);
    const e2 = await addTelegram(
      { origin: ORIGIN, waitPair: true },
      mk(fakeTelegram(tg).fetch, o2.ops).d,
    ).catch((x) => x);
    expect(e2.message).toMatch(/no pairing route/);
  });
});

it("hook helpers", () => {
  expect(hookMatches(`${ORIGIN}/_ochost/hook/telegram/${SEG}`, ORIGIN)).toBe("secret");
  expect(hookMatches(`${ORIGIN}/telegram-webhook`, `${ORIGIN}/`)).toBe("legacy");
  expect(hookMatches(`${ORIGIN}/_ochost/hook/telegram/short`, ORIGIN)).toBeNull();
  expect(redactHookUrl(`${ORIGIN}/_ochost/hook/telegram/${SEG}`)).toBe(
    `${ORIGIN}/_ochost/hook/telegram/[redacted]`,
  );
  const d = withTelegram({ bindings: [{ agentId: "main", match: { channel: "telegram" } }] }, "u");
  expect(d.bindings).toHaveLength(1);
});

describe("channels add telegram secret lag", () => {
  it("retries the webhook call while the Worker says the secret is not set", async () => {
    const tg = { url: "" };
    let n = 0;
    const o = fakeOps({
      "POST /ops/telegram/webhook": () => {
        if (++n < 3)
          return {
            status: 409,
            body: { description: "Worker secret X is not set (ochost channels add telegram)" },
          };
        tg.url = `${ORIGIN}/_ochost/hook/telegram/${SEG}`;
        return { status: 200, body: { ok: true } };
      },
    });
    o.versions.push({ ver: 1, doc: { agents: {} } });
    const { d } = mk(fakeTelegram(tg).fetch, o.ops);
    const r = await addTelegram({ origin: ORIGIN }, d);
    expect(n).toBe(3);
    expect(r.ok).toBe(true);
  });
});
