// M5b Worker routes for the ochost CLI (docs/10-cli-spec.md §1.3, M5-STATUS §7): W1 /ops/pairing, W2 secret hook
// path in config, W4 /ops/alerts/ack and sink formats, W5 /ops/snapshots, W8 /ops/telegram/webhook; F9 and W7
// checks. Routes go through ops.ts (auth, route list) into the Control DO world.
import { describe, expect, it } from "vitest";
import { sinkKind } from "../../src/ctl/alerts";
import { HOOK_PATH_RE, webhookViolation } from "../../src/ctl/config";
import { pairCode } from "../../src/ctl/owner-ops";
import { webhookTransport } from "../../src/gates/ledger";
import { hookPath, hookUrl } from "../../src/ingress/telegram";
import { handleOps } from "../../src/ops";
import { handleTelegramOps, MESSAGE_UPDATES } from "../../src/ops-telegram";
import { DEFAULT_RT_TIMERS } from "../../src/rt/rt-timers";
import { opId, type World, world } from "./world";

const ORIGIN = "https://oc.example";
const SECRET = "wh-secret-1"; // world() webhookSecret
const BOT = "123456:AAbbccddeeffgghhiijjkkllmmnnoopp_qq";
const ENV = { CONTROL_TOKEN: "owner-tok", CI_TOKEN: "ci-tok", OC_TEST: "0" };

function call(
  w: World,
  method: string,
  path: string,
  body?: unknown,
  e: Record<string, string> = ENV,
  tok = "owner-tok",
) {
  return handleOps(
    new Request(`${ORIGIN}/${path}`, {
      method,
      headers: { authorization: `Bearer ${tok}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    {
      ...e,
      OC_INST: "t1",
      CONTROL: { getByName: () => w.api },
      RUNTIME: { getByName: () => w.rt(1) },
    } as never,
    async () => 1,
  );
}

const tgDoc = (extra: Record<string, unknown> = {}) => ({
  channels: {
    telegram: {
      enabled: true,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: OpenClaw SecretRef
      botToken: "${OC_TELEGRAM_BOT_TOKEN}",
      dmPolicy: "allowlist",
      allowFrom: ["999"],
      webhookUrl: `${ORIGIN}/telegram-webhook`,
      webhookPath: "/telegram-webhook",
      ...extra,
    },
  },
});

function dm(updateId: number, fromId: number, text = "hi", first = "Meir", username = "meir") {
  return JSON.stringify({
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: fromId, is_bot: false, first_name: first, username },
      chat: { id: fromId, type: "private" },
      text,
    },
  });
}

describe("W5 GET /ops/snapshots", () => {
  it("lists the index newest first with kind, size, age, chain and TTL; expired hidden unless all=1", async () => {
    const w = world({ settings: { publicOrigin: ORIGIN } });
    w.install();
    const base = { digest: "sha256:img1", imageKey: "oc", gen: 1, epoch: 1 };
    await w.api.snapshotSaved({ ...base, id: "s1", size: 1000, kind: "sleep" });
    w.advance(60_000);
    await w.api.snapshotSaved({ ...base, id: "s2", size: 2000, kind: "sleep", parentId: "s1" });
    w.advance(60_000);
    await w.api.snapshotSaved({ ...base, id: "s3", size: 3000, kind: "checkpoint", parentId: "s2" });
    await w.api.snapshotSaved({ ...base, id: "old", size: 5, kind: "sleep" });
    w.db.run("UPDATE snapshots SET state = 'expired', created_at = created_at - 1 WHERE id = 'old'");
    const r = await call(w, "GET", "ops/snapshots");
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.snapshots.map((s: any) => s.id)).toEqual(["s3", "s2", "s1"]);
    expect(b.snapshots[0]).toMatchObject({
      kind: "checkpoint",
      state: "ok",
      size: 3000,
      parent: "s2",
      chainBase: "s1",
      chainLength: 3,
      ageMs: 0,
    });
    expect(b.snapshots[2]).toMatchObject({ chainLength: 1, ageMs: 120_000 });
    expect(b.snapshots[0].ttlLeftMs).toBe(w.ctx.timers.snapshotTtlMs);
    expect(b.live).toEqual({ count: 3, bytes: 6000 });
    expect(b.newest).toBe("s3");
    const all = (await (await call(w, "GET", "ops/snapshots?all=1&limit=2")).json()) as any;
    expect(all.snapshots).toHaveLength(2);
    expect((await call(w, "POST", "ops/snapshots", {})).status).toBe(404);
    expect((await call(w, "GET", "ops/snapshots", undefined, ENV, "ci-tok")).status).toBe(404);
  });
});

describe("W1 /ops/pairing (owner Telegram id capture from the inbox)", () => {
  async function setup(state: "running" | "asleep" = "running") {
    const w = world({ settings: { publicOrigin: ORIGIN } });
    w.install();
    const p = await call(w, "POST", "ops/config", { doc: tgDoc() });
    expect(p.status).toBe(200);
    w.rt(1).state = state;
    return w;
  }

  it("GET lists unknown senders once each, with a stable code; known ids and bots are left out", async () => {
    const w = await setup();
    await w.api.inboxPut({ body: dm(1, 4242, "hello there"), headers: {} });
    w.advance(1000);
    await w.api.inboxPut({ body: dm(2, 4242, "second"), headers: {} });
    await w.api.inboxPut({ body: dm(3, 999, "owner already allowed"), headers: {} });
    await w.api.inboxPut({
      body: JSON.stringify({
        update_id: 4,
        message: { from: { id: 77, is_bot: true }, chat: { id: 77 }, text: "x" },
      }),
      headers: {},
    });
    const r = await call(w, "GET", "ops/pairing?ch=telegram");
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]).toMatchObject({
      id: "4242",
      name: "Meir",
      username: "meir",
      chatType: "private",
      text: "second",
      count: 2,
      code: await pairCode("t1", "4242"),
    });
    expect(b.requests[0].code).toMatch(/^[2-9a-hjkmnp-z]{6}$/);
    expect((await call(w, "GET", "ops/pairing?ch=slack")).status).toBe(400);
    expect((await call(w, "GET", "ops/pairing", undefined, ENV, "ci-tok")).status).toBe(404);
  });

  it("approve by code: allowFrom + wake allowlist get the id, a new config version, restart when awake", async () => {
    const w = await setup("running");
    await w.api.inboxPut({ body: dm(1, 4242), headers: {} });
    const code = await pairCode("t1", "4242");
    const r = await call(w, "POST", "ops/pairing/approve", { ch: "telegram", code });
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b).toMatchObject({ ok: true, id: "4242", name: "Meir", configVer: 2, applied: "restart" });
    const doc = JSON.parse(w.db.one<{ doc: string }>("SELECT doc FROM config WHERE ver = 2")!.doc);
    expect(doc.channels.telegram.allowFrom).toEqual(["999", "4242"]);
    expect(doc.channels.telegram.dmPolicy).toBe("allowlist");
    const allow = w.db.one<{ user_ids: string }>("SELECT user_ids FROM wake_allow WHERE id = 1");
    expect(JSON.parse(allow!.user_ids)).toEqual(["999", "4242"]);
    expect(w.rt(1).state).toBe("starting"); // ownerStop then ownerStart
    // Now known: the list is empty.
    expect(((await (await call(w, "GET", "ops/pairing?ch=telegram")).json()) as any).requests).toEqual([]);
    expect(w.db.one<{ kind: string }>("SELECT kind FROM ring WHERE src = 'pairing'")?.kind).toBe("approve");
  });

  it("asleep: held updates of the approved sender go pending and the install wakes; others stay held", async () => {
    const w = await setup("asleep");
    // A fresh allowlist without 4242 → its DM is held while asleep (§12.2).
    w.core.putWakeAllow({ userIds: ["999"], groupChatIds: [] });
    w.core.noteRtState(1, "asleep");
    const put = await w.core.inboxPut({ body: dm(1, 4242), headers: {} });
    const other = await w.core.inboxPut({ body: dm(2, 5555, "spam", "X", "x"), headers: {} });
    expect(["held", "held"]).toEqual([(put as any).state, (other as any).state]);
    const r = await call(w, "POST", "ops/pairing/approve", { ch: "telegram", id: "4242" });
    const b = (await r.json()) as any;
    expect(b).toMatchObject({ ok: true, released: 1, applied: "wake" });
    expect(w.db.all("SELECT sender_id, state FROM inbox ORDER BY sender_id")).toEqual([
      { sender_id: "4242", state: "pending" },
      { sender_id: "5555", state: "held" },
    ]);
    expect(w.rt(1).wakes).toContain("cli");
  });

  it("refuses: unknown code 404, bad id 400, no Telegram channel 409", async () => {
    const w = await setup();
    expect((await call(w, "POST", "ops/pairing/approve", { code: "zzzzzz" })).status).toBe(404);
    expect((await call(w, "POST", "ops/pairing/approve", { id: "abc" })).status).toBe(400);
    expect((await call(w, "POST", "ops/pairing/approve", {})).status).toBe(400);
    const w2 = world();
    w2.install();
    await call(w2, "POST", "ops/config", { doc: {} });
    expect((await call(w2, "POST", "ops/pairing/approve", { id: "4242" })).status).toBe(409);
  });
});

describe("W2 secret hook path accepted as the managed webhook URL", () => {
  it("config: legacy and the current secret path pass; a wrong segment, other origin or http fail", async () => {
    const good = await hookUrl(ORIGIN, SECRET);
    const paths = [await hookPath(SECRET)];
    const doc = (u: string) => tgDoc({ webhookUrl: u });
    expect(webhookViolation(doc(good), ORIGIN, paths)).toBeNull();
    expect(webhookViolation(doc(`${ORIGIN}/telegram-webhook`), ORIGIN, paths)).toBeNull();
    expect(webhookViolation(doc(`${ORIGIN}/_ochost/hook/telegram/${"0".repeat(32)}`), ORIGIN, paths)).toBe(
      "channels.telegram.webhookUrl",
    );
    expect(webhookViolation(doc(good.replace(ORIGIN, "https://evil.example")), ORIGIN, paths)).not.toBeNull();
    expect(webhookViolation(doc(good.replace("https:", "http:")), ORIGIN, paths)).not.toBeNull();
    expect(webhookViolation(doc(`${good}?x=1`), ORIGIN, paths)).not.toBeNull();
    // No secret known → any well-formed hook path on the origin.
    expect(webhookViolation(doc(`${ORIGIN}/_ochost/hook/telegram/${"a".repeat(32)}`), ORIGIN)).toBeNull();
    expect(HOOK_PATH_RE.test(await hookPath("x"))).toBe(true);
  });

  it("POST /ops/config takes the secret hook URL (403 before W2); ocsup proposals too (ledger)", async () => {
    const w = world({ settings: { publicOrigin: ORIGIN } });
    const good = await hookUrl(ORIGIN, SECRET);
    expect((await call(w, "POST", "ops/config", { doc: tgDoc({ webhookUrl: good }) })).status).toBe(200);
    const bad = `${ORIGIN}/_ochost/hook/telegram/${"0".repeat(32)}`;
    const r = await call(w, "POST", "ops/config", { doc: tgDoc({ webhookUrl: bad }) });
    expect(r.status).toBe(403);
    expect(webhookTransport(tgDoc({ webhookUrl: good }))).toBeNull();
    expect(webhookTransport(tgDoc({ webhookUrl: `${ORIGIN}/other` }))).toMatch(/path \/other/);
  });
});

describe("W4 /ops/alerts test, ack and sink formats", () => {
  it("test alert carries the CLI code; ack with a wrong code 409, right code 200; GET shows the sink", async () => {
    const w = world({ alertUrl: "https://ntfy.sh/oc-host-t1-abcdef0123456789" });
    const t = await call(w, "POST", "ops/alerts/test", { code: "k7m2pq" });
    expect(t.status).toBe(200);
    expect(await t.json()).toMatchObject({ sent: 1, failed: 0, kind: "ntfy", code: "k7m2pq" });
    expect(w.sent[0]?.body).toContain("ochost alerts ack k7m2pq");
    expect(w.sent[0]?.headers).toMatchObject({
      title: "oc-host t1: alert-test",
      priority: "5",
      authorization: "Bearer tk",
    });
    expect((await call(w, "POST", "ops/alerts/ack", { code: "nope00" })).status).toBe(409);
    w.advance(5000);
    const a = await call(w, "POST", "ops/alerts/ack", { code: "K7M2PQ" });
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ ok: true, afterMs: 5000 });
    const g = (await (await call(w, "GET", "ops/alerts")).json()) as any;
    expect(g.sink).toMatchObject({ configured: true, kind: "ntfy", token: true, ackedAt: w.clock.t });
    expect(g.alerts.find((x: any) => x.class === "alert-test").open).toBe(0);
    expect((await call(w, "POST", "ops/alerts/test", { code: "bad code!" })).status).toBe(400);
  });

  it("W11: /ops calls hand the Worker env's sink to the Control DO (new ALERT_URL used at once)", async () => {
    const w = world({ alertUrl: "https://ntfy.sh/old-topic" });
    const e = { ...ENV, ALERT_URL: "https://hooks.slack.com/services/T0/B0/new" };
    const r = await call(w, "POST", "ops/alerts/test", { code: "abc234" }, e);
    expect(((await r.json()) as any).kind).toBe("slack");
    expect(w.sent.at(-1)?.url).toBe("https://hooks.slack.com/services/T0/B0/new");
    expect(w.ctx.secrets.alertToken).toBeUndefined();
    expect(w.db.one<{ kind: string }>("SELECT kind FROM ring WHERE kind = 'sink-env'")).toBeTruthy();
    // No ALERT_URL in the calling env → the DO keeps what it has.
    await call(w, "GET", "ops/status", undefined, ENV);
    expect(w.ctx.secrets.alertUrl).toBe("https://hooks.slack.com/services/T0/B0/new");
  });

  it("ack without a test → 409 no-test", async () => {
    const w = world();
    const r = await call(w, "POST", "ops/alerts/ack", { code: "abcdef" });
    expect([r.status, ((await r.json()) as any).error]).toEqual([409, "no-test"]);
  });

  it("Slack and Discord URLs get JSON; others keep the ntfy form", async () => {
    expect(sinkKind("https://hooks.slack.com/services/T0/B0/xyz")).toBe("slack");
    expect(sinkKind("https://discord.com/api/webhooks/1/abc")).toBe("discord");
    expect(sinkKind("https://ntfy.example.org/topic")).toBe("ntfy");
    expect(sinkKind("not a url")).toBe("ntfy");
    const w = world({ alertUrl: "https://hooks.slack.com/services/T0/B0/xyz" });
    const r = await call(w, "POST", "ops/alerts/test", { code: "abc234" });
    expect(((await r.json()) as any).kind).toBe("slack");
    expect(w.sent[0]?.headers["content-type"]).toBe("application/json");
    expect(w.sent[0]?.headers.authorization).toBeUndefined();
    expect(JSON.parse(w.sent[0]!.body).text).toMatch(
      /^\*oc-host t1: alert-test\*\nHIGH alert-test\n.*abc234/,
    );
  });

  it("429: the answer and Retry-After are kept; the retry waits; the next test is not held back", async () => {
    const w = world({ alertUrl: "https://ntfy.sh/topic" });
    let n = 0;
    w.ctx.fetch = (async () => {
      n++;
      return new Response('{"code":42901,"http":429,"error":"limit reached: too many requests"}', {
        status: 429,
        headers: { "retry-after": "120" },
      });
    }) as never;
    const r = await call(w, "POST", "ops/alerts/test", { code: "abc234" });
    expect(r.status).toBe(502);
    const b = (await r.json()) as any;
    expect(b.errors[0]).toMatchObject({ cls: "alert-test", status: 429, retryAfterS: 120 });
    expect(b.errors[0].error).toContain("42901");
    expect(n).toBe(1);
    // A flush inside the Retry-After window does not call the sink.
    expect(await w.api.flushAlerts()).toMatchObject({ sent: 0, failed: 0, deferred: 1 });
    expect(n).toBe(1);
    w.advance(121_000);
    await w.api.flushAlerts();
    expect(n).toBe(2);
    expect(
      w.db.one<{ detail: string }>("SELECT detail FROM ring WHERE kind = 'sink-failed'")?.detail,
    ).toContain('"status":429');
  });
});

describe("W8 /ops/telegram/webhook", () => {
  function tgFetch() {
    const calls: { method: string; body: any }[] = [];
    let hook: any = { url: "" };
    const f = (async (u: string, init: RequestInit) => {
      const method = String(u).split("/").pop() as string;
      expect(String(u)).toContain(`/bot${BOT}/`);
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, body });
      if (method === "setWebhook") {
        hook = { url: body.url, allowed_updates: body.allowed_updates, pending_update_count: 0 };
        return Response.json({ ok: true, result: true, description: "Webhook was set" });
      }
      return Response.json({ ok: true, result: hook });
    }) as never;
    return { f, calls };
  }
  const env = (over: Record<string, string> = {}) =>
    ({
      ...ENV,
      OC_INST: "t1",
      OC_SETTINGS: JSON.stringify({ publicOrigin: ORIGIN }),
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      OC_SECRET_OC_TELEGRAM_BOT_TOKEN: BOT,
      ...over,
    }) as never;
  const internal = (w: World) => (a: { sub: string[]; body: Record<string, unknown> }) =>
    w.api.ops({ action: "telegram-int", method: "POST", sub: a.sub, query: {}, body: a.body, role: "owner" });

  it("POST sets the secret-path URL with secret_token and message updates only; URL redacted; config follows", async () => {
    const w = world({ settings: { publicOrigin: ORIGIN } });
    await call(w, "POST", "ops/config", { doc: tgDoc() });
    const { f, calls } = tgFetch();
    const r = await handleTelegramOps(
      new Request(`${ORIGIN}/ops/telegram/webhook`, { method: "POST" }),
      env(),
      ["webhook"],
      {},
      internal(w),
      f,
    );
    expect(r.status).toBe(200);
    const managed = await hookUrl(ORIGIN, SECRET);
    expect(calls[0]).toEqual({
      method: "setWebhook",
      body: {
        url: managed,
        secret_token: SECRET,
        allowed_updates: MESSAGE_UPDATES,
        drop_pending_updates: false,
      },
    });
    expect(MESSAGE_UPDATES).toEqual(["message", "edited_message"]);
    expect(r.body).toMatchObject({
      ok: true,
      url: `${ORIGIN}/_ochost/hook/telegram/[redacted]`,
      path: "secret",
      allowedUpdates: MESSAGE_UPDATES,
      config: { changed: true, configVer: 2 },
    });
    expect(JSON.stringify(r.body)).not.toContain(managed.slice(-32));
    expect(JSON.stringify(r.body)).not.toContain(BOT);
    const doc = JSON.parse(w.db.one<{ doc: string }>("SELECT doc FROM config WHERE ver = 2")!.doc);
    expect(doc.channels.telegram.webhookUrl).toBe(managed);
    // Again: same URL → no new config version.
    const r2 = await handleTelegramOps(
      new Request(`${ORIGIN}/x`, { method: "POST" }),
      env(),
      ["webhook"],
      {},
      internal(w),
      f,
    );
    expect((r2.body as any).config).toMatchObject({ changed: false, configVer: 2 });
    const ring = w.db.all<{ kind: string; detail: string }>(
      "SELECT kind, detail FROM ring WHERE src = 'telegram'",
    );
    expect(ring.map((x) => x.kind)).toEqual(["webhook-set", "webhook-set"]);
    expect(ring[0]?.detail).toContain("[redacted]");
  });

  it("GET reads getWebhookInfo: secret / legacy / other; 409 without a bot token or secret", async () => {
    const w = world();
    const { f } = tgFetch();
    const get = (e = env()) =>
      handleTelegramOps(new Request(`${ORIGIN}/ops/telegram/webhook`), e, ["webhook"], {}, internal(w), f);
    expect((await get()).body).toMatchObject({ ok: true, path: "none", url: "" });
    await handleTelegramOps(
      new Request(`${ORIGIN}/x`, { method: "POST" }),
      env(),
      ["webhook"],
      { config: false },
      internal(w),
      f,
    );
    expect((await get()).body).toMatchObject({ path: "secret", allowedUpdates: MESSAGE_UPDATES });
    const g = await get(env({ TELEGRAM_WEBHOOK_SECRET: "rotated" }));
    expect((g.body as any).path).toBe("secret-other");
    const noTok = await get(env({ OC_SECRET_OC_TELEGRAM_BOT_TOKEN: "" }));
    expect([noTok.status, (noTok.body as any).error]).toEqual([409, "no-bot-token"]);
    const noSec = await get(env({ TELEGRAM_WEBHOOK_SECRET: "" }));
    expect([noSec.status, (noSec.body as any).error]).toEqual([409, "no-webhook-secret"]);
    const bad = await handleTelegramOps(
      new Request(`${ORIGIN}/x`, { method: "POST" }),
      env(),
      ["webhook"],
      { allowedUpdates: ["nope"] },
      internal(w),
      f,
    );
    expect(bad.status).toBe(400);
  });

  it("through /ops with OC_TEST=1: the Control DO fake answers; nothing leaves the Worker", async () => {
    const w = world({ settings: { publicOrigin: ORIGIN } });
    const e = {
      ...ENV,
      OC_TEST: "1",
      OC_SETTINGS: JSON.stringify({ publicOrigin: ORIGIN }),
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      OC_SECRET_OC_TELEGRAM_BOT_TOKEN: BOT,
    };
    const r = await call(w, "POST", "ops/telegram/webhook", {}, e);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, path: "secret", allowedUpdates: MESSAGE_UPDATES });
    const g = (await (await call(w, "GET", "ops/telegram/webhook", undefined, e)).json()) as any;
    expect(g).toMatchObject({ ok: true, path: "secret", pending: 0 });
    expect(w.db.metaJson<any>("tgFakeHook", null)).toMatchObject({ secret: true });
    expect((await call(w, "GET", "ops/telegram/other", undefined, e)).status).toBe(404);
    expect((await call(w, "GET", "ops/telegram/webhook", undefined, e, "ci-tok")).status).toBe(404);
    // The internal action is not routed from outside.
    expect((await call(w, "POST", "ops/telegram-int/fake", {}, e)).status).toBe(404);
  });
});

describe("F9 and W7 (already built; checked here)", () => {
  it("F9: a config version posted before the first start is the boot's configVer", async () => {
    const w = world();
    w.install();
    expect((await call(w, "POST", "ops/config", { doc: { agents: {} } })).status).toBe(200);
    const b = await w.api.beginBoot({ epoch: 1, mode: "prod", opId: opId("start"), reason: "user" });
    expect(b.plan.configVer).toBe(1);
  });

  it("W7: the cold-pull start budget is 300 s (warm 30 s); M3 pulls took 35-56 s", () => {
    expect(DEFAULT_RT_TIMERS.coldStartTimeoutMs).toBe(300_000);
  });
});
