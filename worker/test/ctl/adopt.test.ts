// Channel adoption from the OpenClaw UI (ctl/adopt.ts, docs/20 section 2): a UI config with a credential in clear
// is held; POST /ops/channels/adopt moves it to the creds store and rewrites the channel to webhook mode.
import { describe, expect, it } from "vitest";
import { adoptDoc, adoptSpecOf, heldReason } from "../../src/ctl/adopt-spec";
import { configPropose } from "../../src/ctl/config";
import { adoptRows } from "../../src/ctl/panel-adopt";
import { hookUrl } from "../../src/ingress/telegram";
import { handleOps } from "../../src/ops";
import { type World, world } from "./world";

const ORIGIN = "https://oc.example";
const TOKEN = "123456:AAbbccddeeffgghhiijjkkllmmnnoopp_qq";
const ENV = { CONTROL_TOKEN: "owner-tok", CI_TOKEN: "ci-tok", OC_TEST: "0" };

function call(w: World, path: string, body?: unknown, tok = "owner-tok") {
  return handleOps(
    new Request(`${ORIGIN}/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}` },
      body: JSON.stringify(body ?? {}),
    }),
    {
      ...ENV,
      OC_INST: "t1",
      CONTROL: { getByName: () => w.api },
      RUNTIME: { getByName: () => w.rt(1) },
    } as never,
    async () => 1,
  );
}

function setup(tgOk = true) {
  const w = world({ settings: { publicOrigin: ORIGIN } });
  w.install();
  const calls: { url: string; body: any }[] = [];
  w.ctx.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body ?? "{}")) });
    return Response.json(tgOk ? { ok: true, result: true } : { ok: false, description: "Unauthorized" });
  }) as never;
  return { w, calls };
}

const good = { channels: { telegram: { enabled: false } } };
const uiTg = (extra: object = {}) => ({
  channels: { telegram: { enabled: true, botToken: TOKEN, ...extra } },
});
const status = (w: World) => w.db.all<{ status: string }>("SELECT ver, status FROM config ORDER BY ver");

describe("held candidate", () => {
  it("a UI config with a clear token is held; the same sha is not stored twice; a SecretRef is not held", async () => {
    const { w } = setup();
    expect(w.ledger.configPropose(1, { source: "ui", sha: "a", doc: good }).ok).toBe(true);
    const r = w.ledger.configPropose(1, { source: "ui", sha: "b", doc: uiTg() });
    expect(r).toMatchObject({ ok: true, held: true });
    expect(status(w).map((x) => x.status)).toEqual(["candidate", "held"]);
    // a boot never picks the held row
    expect(w.core.c.db.one<{ ver: number }>("SELECT ver FROM config WHERE status = 'candidate'")?.ver).toBe(
      1,
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: SecretRef
    const ref = { channels: { telegram: { botToken: "${OC_TELEGRAM_BOT_TOKEN}" } } };
    expect(heldReason(ref)).toBeNull();
    expect(heldReason(uiTg())).toMatch(/polling keeps the install awake/);
  });
});

describe("POST /ops/channels/adopt", () => {
  it("Telegram: setWebhook on the managed route, token to the creds store, config rewritten, held row closed", async () => {
    const { w, calls } = setup();
    w.ledger.configPropose(1, { source: "ui", sha: "a", doc: good });
    w.ledger.configPropose(1, { source: "ui", sha: "b", doc: uiTg({ dmPolicy: "allowlist" }) });
    const r = await call(w, "ops/channels/adopt", { channel: "telegram" });
    const b = (await r.json()) as any;
    expect(r.status).toBe(200);
    expect(JSON.stringify(b)).not.toContain(TOKEN);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/setWebhook`);
    expect(calls[0]?.body.url).toBe(await hookUrl(ORIGIN, "wh-secret-1"));
    const newest = w.db.one<{ doc: string; source: string; status: string }>(
      "SELECT doc, source, status FROM config WHERE source = 'owner' ORDER BY ver DESC",
    );
    const tg = JSON.parse(newest?.doc ?? "{}").channels.telegram;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: SecretRef
    expect(tg).toMatchObject({
      botToken: "$" + "{OC_TELEGRAM_BOT_TOKEN}",
      dmPolicy: "allowlist",
      webhookPath: "/telegram-webhook",
    });
    expect(tg.webhookUrl).toBe(await hookUrl(ORIGIN, "wh-secret-1"));
    expect(JSON.stringify(newest)).not.toContain(TOKEN);
    expect(status(w).some((x) => x.status === "held")).toBe(false);
    // the token is in the store, not in the container manifest, and rides the next boot
    const boot = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s1", reason: "user" });
    expect(boot.adoptedEnv).toEqual({ OC_TELEGRAM_BOT_TOKEN: TOKEN });
    expect(w.api.ledger.credsManifest().files).toEqual([]);
    expect(w.api.ledger.credsGet("adopted/OC_TELEGRAM_BOT_TOKEN")).toBeNull();
    expect(w.ctx.secrets.botToken).toBe(TOKEN);
  });

  it("a wrong token: Telegram refuses, nothing is stored, the candidate stays held", async () => {
    const { w } = setup(false);
    w.ledger.configPropose(1, { source: "ui", sha: "b", doc: uiTg() });
    const r = await call(w, "ops/channels/adopt", { channel: "telegram" });
    expect(r.status).toBe(502);
    expect(status(w).map((x) => x.status)).toEqual(["held"]);
    expect(
      (await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s2", reason: "user" })).adoptedEnv,
    ).toBeUndefined();
  });

  it("nothing held, bad channel, CI role: 404, 400, 404", async () => {
    const { w } = setup();
    expect((await call(w, "ops/channels/adopt", { channel: "telegram" })).status).toBe(404);
    expect((await call(w, "ops/channels/adopt", { channel: "irc" })).status).toBe(400);
    expect((await call(w, "ops/channels/adopt", { channel: "telegram" }, "ci-tok")).status).toBe(404);
  });

  it("Slack: both secrets move, mode http; Discord needs the public key and application id", async () => {
    const { w } = setup();
    const slack = {
      channels: {
        slack: { botToken: "xoxb-1234567890-abc", signingSecret: "abcdef0123456789abcd", appToken: "xapp-1" },
      },
    };
    w.ledger.configPropose(1, { source: "ui", sha: "s", doc: slack });
    const r = await call(w, "ops/channels/adopt", { channel: "slack" });
    expect(r.status).toBe(200);
    const doc = JSON.parse(
      w.db.one<{ doc: string }>("SELECT doc FROM config WHERE source = 'owner'")?.doc ?? "{}",
    );
    expect(doc.channels.slack).toMatchObject({ mode: "http", webhookPath: "/slack/events" });
    expect(doc.channels.slack.appToken).toBeUndefined();
    expect(doc.plugins.load.paths).toContain("/opt/oc-plugins/slack");
    const boot = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: "s3", reason: "user" });
    expect(Object.keys(boot.adoptedEnv ?? {}).sort()).toEqual([
      "OC_SLACK_BOT_TOKEN",
      "OC_SLACK_SIGNING_SECRET",
    ]);
    expect(w.ctx.secrets.platform?.OC_SLACK_SIGNING_SECRET).toBe("abcdef0123456789abcd");

    const dc = adoptDoc(
      { channels: { discord: { token: "x.y.z" } } },
      adoptSpecOf("discord") as never,
      "https://h",
    );
    expect(dc?.missing).toEqual(["publicKey", "applicationId"]);
    const ok = adoptDoc(
      { channels: { discord: { token: "x.y.z" } } },
      adoptSpecOf("discord") as never,
      "https://h",
      {
        publicKey: "ab".repeat(32),
        applicationId: "123456789012345",
      },
    );
    expect(ok?.missing).toEqual([]);
    expect(ok?.secrets).toEqual({ OC_DISCORD_BOT_TOKEN: "x.y.z", OC_DISCORD_PUBLIC_KEY: "ab".repeat(32) });
  });

  it("an owner config with a token is not held (the CLI path)", async () => {
    const { w } = setup();
    const r = await configPropose(w.ctx, { source: "owner", doc: uiTg() });
    expect(r.body.held).toBeUndefined();
  });
});

describe("console row", () => {
  it("held: Adopt button and the waiting text; adopted: the adopted text, no button", () => {
    const post = (a: string, f: Record<string, string>, l: string) => `[${a}:${f.channel}:${l}]`;
    const p = (adopt: unknown) => ({ channels: { adopt } }) as never;
    expect(adoptRows(p({ held: [{ id: "telegram", label: "Telegram" }], adopted: [] }), post)).toMatchObject([
      {
        name: "Telegram",
        state: "Token in the UI config, waiting for adoption",
        button: "[adopt:telegram:Adopt]",
        todo: true,
      },
    ]);
    expect(
      adoptRows(p({ held: [], adopted: [{ id: "telegram", label: "Telegram", at: 1 }] }), post),
    ).toMatchObject([{ state: "Telegram: adopted from the UI", result: "PASS", todo: false }]);
  });
});
