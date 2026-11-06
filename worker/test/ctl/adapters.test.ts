// Inbox adapters (add §2.2, §3): Slack Events API, Discord interactions, Twilio SMS. Signature vectors are the
// worked examples in each platform's docs (fetched 2026-11-05); Discord's docs give code but no vector, so the
// fake platform signs with a fresh Ed25519 key. Then the whole path: request → Worker handler → Control DO inbox →
// replay driver → fake gateway.
import { describe, expect, it } from "vitest";
import { handleAdapter } from "../../src/ctl/adapter-webhook";
import { adapterByPath, platformSecrets } from "../../src/ctl/adapters";
import { discord } from "../../src/ctl/adapters/discord";
import { slack, slackSign } from "../../src/ctl/adapters/slack";
import { twilio, twilioSign } from "../../src/ctl/adapters/twilio";
import { driverBootStarted } from "../../src/ctl/driver";
import { webhookTransport } from "../../src/gates/ledger";
import { FakeDiscord, FakeGateway, FakeSlack, FakeTwilio } from "../harness/platforms";
import { type World, world } from "./world";

// ---- vectors from the platform docs
const SLACK_DOC = {
  secret: "8f742231b10e8888abcd99yyyzzz85a5",
  ts: "1531420618",
  body: "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c",
  sig: "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
};
const TWILIO_DOC = {
  token: "12345",
  url: "https://example.com/myapp.php?foo=1&bar=2",
  params: {
    CallSid: "CA1234567890ABCDE",
    Caller: "+14158675310",
    Digits: "1234",
    From: "+14158675310",
    To: "+18005551212",
  },
  sig: "L/OH5YylLD5NRKLltdqwSvS0BnU=",
};

describe("signature vectors", () => {
  it("Slack v0 doc example", async () => {
    expect(await slackSign(SLACK_DOC.secret, SLACK_DOC.ts, SLACK_DOC.body)).toBe(SLACK_DOC.sig);
  });
  it("Twilio doc example (query string stays in the signed URL, params sorted)", async () => {
    // Insert in reverse order: the signature must not depend on arrival order.
    const form = new URLSearchParams(Object.entries(TWILIO_DOC.params).reverse());
    expect(await twilioSign(TWILIO_DOC.token, TWILIO_DOC.url, form)).toBe(TWILIO_DOC.sig);
  });
});

const hdr = (r: Request) => r.headers;
const text = (r: Request) => r.clone().text();
const T = Date.parse("2026-11-05T12:00:00Z");

async function recv(a: typeof slack, r: Request, secrets: Record<string, string>, now = T) {
  return a.receive({ method: r.method, url: r.url, headers: hdr(r), body: await text(r), now }, secrets);
}

describe("Slack", () => {
  const p = new FakeSlack(() => T);
  const s = { OC_SLACK_SIGNING_SECRET: p.secret };

  it("answers url_verification with the challenge and stores nothing", async () => {
    const v = await recv(
      slack,
      p.send(JSON.stringify({ type: "url_verification", challenge: "3eZbrw1" })),
      s,
    );
    expect(v).toMatchObject({ kind: "respond", res: { status: 200 } });
    expect(v.kind === "respond" && JSON.parse(v.res.body ?? "")).toEqual({ challenge: "3eZbrw1" });
  });

  it("rejects a wrong secret, a missing secret, a body changed after signing", async () => {
    const body = p.event("Ev1");
    expect(await recv(slack, p.send(body, { secret: "other" }), s)).toMatchObject({ res: { status: 401 } });
    expect(await recv(slack, p.send(body), {})).toMatchObject({ res: { status: 401 } });
    const good = p.send(body);
    const tampered = new Request(good.url, { method: "POST", headers: good.headers, body: `${body} ` });
    expect(await recv(slack, tampered, s)).toMatchObject({ res: { status: 401 } });
  });

  it("timestamp window is ±300 s: 299 passes, 301 fails, in the past and in the future", async () => {
    const at = (d: number) => recv(slack, p.send(p.event("Ev1"), { ts: T / 1000 + d }), s);
    expect((await at(-299)).kind).toBe("store");
    expect((await at(299)).kind).toBe("store");
    expect(await at(-301)).toMatchObject({ kind: "respond", res: { status: 401 } });
    expect(await at(301)).toMatchObject({ kind: "respond", res: { status: 401 } });
  });

  it("event_callback → key event_id, sender and channel from the event", async () => {
    const v = await recv(slack, p.send(p.event("Ev0123", { user: "U9", channel: "C7" })), s);
    expect(v).toMatchObject({ kind: "store", platformKey: "Ev0123", senderId: "U9", chatId: "C7" });
  });

  it("slash command (form) → key trigger_id; interactivity payload → trigger_id from the payload", async () => {
    const cmd = await recv(
      slack,
      p.send(SLACK_DOC.body, { contentType: "application/x-www-form-urlencoded" }),
      s,
    );
    expect(cmd).toMatchObject({
      kind: "store",
      platformKey: "trigger:398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c",
      senderId: "U2CERLKJA",
      chatId: "G8PSS9T3V",
    });
    const payload = JSON.stringify({
      type: "block_actions",
      trigger_id: "T.1",
      user: { id: "U3" },
      channel: { id: "C3" },
    });
    const act = await recv(
      slack,
      p.send(`payload=${encodeURIComponent(payload)}`, { contentType: "application/x-www-form-urlencoded" }),
      s,
    );
    expect(act).toMatchObject({ kind: "store", platformKey: "trigger:T.1", senderId: "U3", chatId: "C3" });
  });

  it("app_rate_limited and unknown types are acked, not stored", async () => {
    const v = await recv(
      slack,
      p.send(JSON.stringify({ type: "app_rate_limited", minute_rate_limited: 1 })),
      s,
    );
    expect(v).toMatchObject({ kind: "respond", res: { status: 200 } });
  });

  it("replay headers carry a fresh timestamp and a valid signature over the original body", async () => {
    const body = p.event("Ev1");
    const h = await slack.replayHeaders(
      { headers: { "content-type": "application/json" }, body },
      s,
      T + 3_600_000,
    );
    expect(h["x-slack-request-timestamp"]).toBe(String((T + 3_600_000) / 1000));
    expect(h["x-slack-signature"]).toBe(
      await slackSign(p.secret, h["x-slack-request-timestamp"] as string, body),
    );
  });
});

describe("Discord", () => {
  const p = new FakeDiscord(() => T);
  const s = { OC_DISCORD_PUBLIC_KEY: p.publicKey };

  it("PING → PONG, not stored", async () => {
    const v = await recv(discord, p.send(JSON.stringify({ type: 1, id: "1", application_id: "100" })), s);
    expect(v).toMatchObject({ kind: "respond", res: { status: 200 } });
    expect(v.kind === "respond" && JSON.parse(v.res.body ?? "")).toEqual({ type: 1 });
  });

  it("bad signatures are 401: changed body, changed timestamp, signature over the body alone, wrong key", async () => {
    const body = p.command("i1");
    const good = p.send(body);
    const swap = (b: string, h: Record<string, string>) =>
      new Request(good.url, {
        method: "POST",
        body: b,
        headers: { ...Object.fromEntries(good.headers), ...h },
      });
    expect(await recv(discord, swap(`${body} `, {}), s)).toMatchObject({ res: { status: 401 } });
    expect(await recv(discord, swap(body, { "x-signature-timestamp": "1" }), s)).toMatchObject({
      res: { status: 401 },
    });
    expect(await recv(discord, p.send(body, { sigOver: body }), s)).toMatchObject({ res: { status: 401 } });
    expect(
      await recv(discord, good, { OC_DISCORD_PUBLIC_KEY: new FakeDiscord(() => T).publicKey }),
    ).toMatchObject({
      res: { status: 401 },
    });
    expect(await recv(discord, good, { OC_DISCORD_PUBLIC_KEY: "zz" })).toMatchObject({
      res: { status: 401 },
    });
    expect(await recv(discord, good, {})).toMatchObject({ res: { status: 401 } });
  });

  it("slash command → deferred ack type 5; component → type 6; autocomplete → empty choices, not stored", async () => {
    const cmd = await recv(discord, p.send(p.command("i1", { user: "u7", channel: "c5" })), s);
    expect(cmd).toMatchObject({ kind: "store", platformKey: "i1", senderId: "u7", chatId: "c5" });
    expect(cmd.kind === "store" && JSON.parse(cmd.ack.body ?? "")).toEqual({ type: 5 });
    const comp = await recv(
      discord,
      p.send(JSON.stringify({ id: "i2", type: 3, user: { id: "u8" }, channel_id: "c6" })),
      s,
    );
    expect(comp.kind === "store" && JSON.parse(comp.ack.body ?? "")).toEqual({ type: 6 });
    expect(comp).toMatchObject({ senderId: "u8" });
    const ac = await recv(discord, p.send(JSON.stringify({ id: "i3", type: 4 })), s);
    expect(ac.kind).toBe("respond");
  });

  it("replay keeps the signature headers byte for byte", async () => {
    const r = p.send(p.command("i1"));
    const v = await recv(discord, r, s);
    if (v.kind !== "store") throw new Error("not stored");
    const h = await discord.replayHeaders({ headers: v.headers, body: await text(r) }, s, T + 1);
    expect(h["x-signature-ed25519"]).toBe(r.headers.get("x-signature-ed25519"));
    expect(h["x-signature-timestamp"]).toBe(r.headers.get("x-signature-timestamp"));
  });
});

describe("Twilio", () => {
  const p = new FakeTwilio();
  const s = { OC_TWILIO_AUTH_TOKEN: p.authToken };

  it("valid signature → stored with MessageSid, empty TwiML 200", async () => {
    const v = await recv(twilio, p.send(p.sms("SM1")), s);
    expect(v).toMatchObject({ kind: "store", platformKey: "SM1", senderId: "+14158675310", hold: false });
    expect(v.kind === "store" && v.ack).toMatchObject({
      status: 200,
      headers: { "content-type": expect.stringContaining("text/xml") },
    });
    expect(v.kind === "store" && v.ack.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  });

  it("rejects a wrong token, a different URL (the signature covers it), and a changed param", async () => {
    expect(await recv(twilio, p.send(p.sms("SM1"), { token: "x" }), s)).toMatchObject({
      res: { status: 401 },
    });
    const r = p.send(p.sms("SM1"));
    const moved = new Request("https://other.example/_ochost/hook/twilio", {
      method: "POST",
      body: await text(r),
      headers: r.headers,
    });
    expect(await recv(twilio, moved, s)).toMatchObject({ res: { status: 401 } });
    const edited = new Request(r.url, {
      method: "POST",
      body: (await text(r)).replace("hello", "hellp"),
      headers: r.headers,
    });
    expect(await recv(twilio, edited, s)).toMatchObject({ res: { status: 401 } });
    expect(await recv(twilio, r, {})).toMatchObject({ res: { status: 401 } });
  });

  it("a delivery receipt of our own message is stored held, keyed apart from the inbound sid", async () => {
    const cb = {
      MessageSid: "SM9",
      MessageStatus: "delivered",
      AccountSid: "AC123",
      From: "+18005551212",
      To: "+14158675310",
    };
    const v = await recv(twilio, p.send(cb), s);
    expect(v).toMatchObject({ kind: "store", platformKey: "SM9:delivered", hold: true });
  });
});

// ---- the whole path
function setup(w: World, secrets: Record<string, string>) {
  const wakes: string[] = [];
  const handler = (r: Request, over: { wake?: () => Promise<unknown> } = {}) => {
    const url = new URL(r.url);
    const a = adapterByPath(url.pathname);
    if (!a) throw new Error("no adapter");
    const pending: Promise<unknown>[] = [];
    return handleAdapter(r, a, {
      secrets,
      now: () => w.clock.t,
      ctl: { inboxPut: async (x) => w.api.inboxPut(x), hookSeen: async (i, k) => w.api.hookSeen(i, k) },
      wake: over.wake ?? (async () => void wakes.push("wake")),
      waitUntil: (pr) => void pending.push(pr),
    }).then(async (res) => {
      await Promise.all(pending);
      return res;
    });
  };
  return { handler, wakes };
}

const rows = (w: World) =>
  w.db.all<{
    route: string;
    platform_key: string;
    state: string;
    dead_reason: string | null;
    attempts: number;
  }>("SELECT route, platform_key, state, dead_reason, attempts FROM inbox ORDER BY received_at, id");

async function boot(w: World) {
  w.install();
  w.api.noteRtState(1, "running");
  w.rt(1).state = "running";
  w.db.run(
    `INSERT INTO gens (gen, epoch, op_id, reason, mode, secret, restore_gens, plan, plan_kind, state, unplanned, issued_at)
     VALUES (1, 1, 'op-1', 'user', 'prod', 's', '[]', '{"sqlite":{"kind":"fresh"}}', 'fresh', 'booting', 0, 0)`,
  );
  await w.api.onStarted({
    epoch: 1,
    gen: 1,
    opId: "op-1",
    reason: "user",
    digest: "d",
    wakeAt: 0,
    aliveMs: 1,
    startupzMs: 1,
  });
  w.api.core.ingressReady(1);
}

describe("inbox path: ack, dedupe, replay", () => {
  const slackP = (w: World) => new FakeSlack(() => w.clock.t);

  it("ack does not wait for the wake: a wake that never settles still gets the 200", async () => {
    const w = world();
    w.install();
    w.api.noteRtState(1, "asleep");
    const p = slackP(w);
    const never = new Promise<never>(() => {});
    const pending: Promise<unknown>[] = [];
    const a = adapterByPath("/_ochost/hook/slack");
    if (!a) throw new Error("x");
    const res = await handleAdapter(p.send(p.event("Ev1")), a, {
      secrets: { OC_SLACK_SIGNING_SECRET: p.secret },
      now: () => w.clock.t,
      ctl: { inboxPut: async (x) => w.api.inboxPut(x), hookSeen: async (i, k) => w.api.hookSeen(i, k) },
      wake: () => never,
      waitUntil: (x) => void pending.push(x),
    });
    expect(res.status).toBe(200);
    expect(pending).toHaveLength(1); // the wake is queued behind the ack, not awaited
  });

  it("the CLI can see the platform call: challenge, PING and events show in /ops/inbox hooks; a bad signature does not", async () => {
    const w = world();
    w.install();
    const sp = slackP(w);
    const dp = new FakeDiscord(() => w.clock.t);
    const { handler } = setup(w, { OC_SLACK_SIGNING_SECRET: sp.secret, OC_DISCORD_PUBLIC_KEY: dp.publicKey });
    const hooks = async () =>
      (
        (await w.api.ops({ action: "inbox", method: "GET", sub: [], query: {}, body: {}, role: "owner" }))
          .body as {
          hooks: Record<string, { at: number; kind: string } | null>;
        }
      ).hooks;
    expect(await hooks()).toEqual({ slack: null, discord: null, twilio: null });
    await handler(sp.send(JSON.stringify({ type: "url_verification", challenge: "c" }), { secret: "bad" }));
    expect((await hooks()).slack).toBeNull();
    await handler(sp.send(JSON.stringify({ type: "url_verification", challenge: "c" })));
    expect((await hooks()).slack).toEqual({ at: w.clock.t, kind: "challenge" });
    await handler(dp.send(JSON.stringify({ type: 1, id: "1" })));
    expect((await hooks()).discord?.kind).toBe("ping");
    w.advance(1000);
    await handler(sp.send(sp.event("Ev1")));
    expect((await hooks()).slack).toEqual({ at: w.clock.t, kind: "event" });
  });

  it("Slack retries (same event_id, x-slack-retry-num) make one row and one wake", async () => {
    const w = world();
    w.install();
    w.api.noteRtState(1, "asleep");
    const p = slackP(w);
    const { handler, wakes } = setup(w, { OC_SLACK_SIGNING_SECRET: p.secret });
    const body = p.event("Ev77");
    expect((await handler(p.send(body))).status).toBe(200);
    w.advance(60_000);
    expect((await handler(p.send(body, { retry: 1 }))).status).toBe(200);
    w.advance(240_000);
    expect((await handler(p.send(body, { retry: 2 }))).status).toBe(200);
    expect(rows(w)).toHaveLength(1);
    expect(rows(w)[0]).toMatchObject({ route: "/slack/events", platform_key: "Ev77", state: "pending" });
    expect(wakes).toHaveLength(1);
  });

  it("url_verification and bad signatures never reach the inbox or the wake", async () => {
    const w = world();
    w.install();
    const p = slackP(w);
    const { handler, wakes } = setup(w, { OC_SLACK_SIGNING_SECRET: p.secret });
    const ch = await handler(p.send(JSON.stringify({ type: "url_verification", challenge: "abc" })));
    expect(await ch.json()).toEqual({ challenge: "abc" });
    expect((await handler(p.send(p.event("Ev1"), { secret: "bad" }))).status).toBe(401);
    expect(rows(w)).toHaveLength(0);
    expect(wakes).toHaveLength(0);
  });

  it("replay to the gateway: Slack row is re-signed, 2xx without the durable header is the accept, body unchanged", async () => {
    const w = world();
    await boot(w);
    const p = slackP(w);
    w.ctx.secrets.platform = { OC_SLACK_SIGNING_SECRET: p.secret };
    const { handler } = setup(w, { OC_SLACK_SIGNING_SECRET: p.secret });
    const gw = new FakeGateway(() => w.clock.t, { slackSecret: p.secret });
    w.rt(1).deliverFn = (r) => {
      const out = gw.handle(r);
      return r.okIsDurable && out.status === 200 ? { status: 200, durable: true } : out;
    };
    const body = p.event("Ev5", { text: "ünïcode ✓" });
    await handler(p.send(body));
    w.advance(10 * 60_000); // the original signature is now outside Slack's 5 min window
    await w.api.kickDriver();
    expect(gw.rejected).toEqual([]);
    expect(gw.accepted).toHaveLength(1);
    expect(gw.accepted[0]?.body).toBe(body);
    expect(gw.accepted[0]?.path).toBe("/slack/events");
    expect(rows(w)[0]?.state).toBe("accepted");
  });

  it("replay of Twilio keeps the original signature; the gateway verifies it against the Worker hook URL", async () => {
    const w = world();
    await boot(w);
    const p = new FakeTwilio();
    w.ctx.secrets.platform = { OC_TWILIO_AUTH_TOKEN: p.authToken };
    const { handler } = setup(w, { OC_TWILIO_AUTH_TOKEN: p.authToken });
    const gw = new FakeGateway(() => w.clock.t, { twilioToken: p.authToken, twilioUrl: p.url });
    w.rt(1).deliverFn = gw.handle;
    const res = await handler(p.send(p.sms("SM2", "+15551230000", "ça va?")));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Response/>");
    await w.api.kickDriver();
    expect(gw.rejected).toEqual([]);
    expect(gw.accepted[0]?.path).toBe("/webhooks/sms");
    expect(gw.accepted[0]?.headers["x-twilio-signature"]).toBe(
      p.signature(p.url, p.sms("SM2", "+15551230000", "ça va?")),
    );
    expect(rows(w)[0]?.state).toBe("accepted");
  });

  it("replay of Discord keeps the signed timestamp and body; the id is the dedupe key", async () => {
    const w = world();
    await boot(w);
    const p = new FakeDiscord(() => w.clock.t);
    w.ctx.secrets.platform = { OC_DISCORD_PUBLIC_KEY: p.publicKey };
    const { handler } = setup(w, { OC_DISCORD_PUBLIC_KEY: p.publicKey });
    const gw = new FakeGateway(() => w.clock.t, { discordKey: p.publicKey });
    w.rt(1).deliverFn = gw.handle;
    const res = await handler(p.send(p.command("1001")));
    expect(await res.json()).toEqual({ type: 5 });
    await handler(p.send(p.command("1001"))); // Discord does not retry, but a duplicate must not double-store
    await w.api.kickDriver();
    expect(rows(w)).toHaveLength(1);
    expect(gw.rejected).toEqual([]);
    expect(gw.accepted).toHaveLength(1);
  });

  it("serial order is arrival order for non-numeric keys (Slack Ev…, Twilio SM…)", async () => {
    const w = world();
    await boot(w);
    const p = slackP(w);
    w.ctx.secrets.platform = { OC_SLACK_SIGNING_SECRET: p.secret };
    const { handler } = setup(w, { OC_SLACK_SIGNING_SECRET: p.secret });
    // the gateway is not answering yet: all three wait, in arrival order
    w.rt(1).deliverFn = () => ({ status: 503, durable: false });
    for (const id of ["EvZ", "EvA", "EvM"]) {
      await handler(p.send(p.event(id)));
      w.advance(5);
    }
    const order: string[] = [];
    w.rt(1).deliverFn = (r) => {
      order.push(JSON.parse(r.body).event_id);
      return { status: 200, durable: !!r.okIsDurable };
    };
    for (let i = 0; i < 4; i++) {
      w.advance(w.ctx.timers.driverRetryCapMs);
      await w.api.kickDriver();
    }
    expect(order).toEqual(["EvZ", "EvA", "EvM"]);
  });

  it("a restart with no marker replays an accepted adapter row unchanged (no Telegram fresh-id rewrite)", async () => {
    const w = world();
    await boot(w);
    const p = slackP(w);
    w.ctx.secrets.platform = { OC_SLACK_SIGNING_SECRET: p.secret };
    const { handler } = setup(w, { OC_SLACK_SIGNING_SECRET: p.secret });
    const bodies: string[] = [];
    w.rt(1).deliverFn = (r) => {
      bodies.push(r.body);
      return { status: 200, durable: !!r.okIsDurable };
    };
    const body = p.event("Ev9");
    await handler(p.send(body));
    await w.api.kickDriver();
    w.advance(1000);
    expect(driverBootStarted(w.ctx, 2, 1, false)).toBe(1); // no clean marker: replay every unreplicated accepted row
    await w.api.kickDriver();
    expect(bodies).toEqual([body, body]); // delivered twice, byte for byte the same event
    expect(w.db.one<{ replays: number }>("SELECT replays FROM inbox")?.replays).toBe(0);
  });

  it("platform secrets reach the Control DO from the Worker env (OC_SECRET_ prefix)", () => {
    expect(
      platformSecrets({
        OC_SECRET_OC_SLACK_SIGNING_SECRET: "s",
        OC_SECRET_OC_TWILIO_AUTH_TOKEN: "",
        OC_SECRET_OC_SLACK_BOT_TOKEN: "ignored",
      }),
    ).toEqual({
      OC_SLACK_SIGNING_SECRET: "s",
      OC_DISCORD_PUBLIC_KEY: undefined,
      OC_TWILIO_AUTH_TOKEN: undefined,
    });
  });
});

describe("outage: 15 min then 23 h", () => {
  it("rows acked during a 15 min outage replay after it; rows still pending at 23 h are dead with an alert", async () => {
    const w = world({ real: true });
    w.install();
    w.api.noteRtState(1, "asleep");
    const sp = new FakeSlack(() => w.clock.t);
    const tp = new FakeTwilio();
    const { handler } = setup(w, { OC_SLACK_SIGNING_SECRET: sp.secret, OC_TWILIO_AUTH_TOKEN: tp.authToken });
    w.ctx.secrets.platform = { OC_SLACK_SIGNING_SECRET: sp.secret, OC_TWILIO_AUTH_TOKEN: tp.authToken };
    // gateway unreachable for 15 min: every event is acked at once, none is lost
    const gw = new FakeGateway(() => w.clock.t, {
      slackSecret: sp.secret,
      twilioToken: tp.authToken,
      twilioUrl: tp.url,
    });
    gw.down = true;
    w.rt(1).deliverFn = (r) => {
      const o = gw.handle(r);
      return r.okIsDurable && o.status === 200 ? { status: 200, durable: true } : o;
    };
    expect((await handler(sp.send(sp.event("EvOut1")))).status).toBe(200);
    expect((await handler(tp.send(tp.sms("SMout1")))).status).toBe(200);
    w.advance(15 * 60_000);
    expect(rows(w).map((r) => r.state)).toEqual(["pending", "pending"]);
    gw.down = false;
    w.api.noteRtState(1, "running");
    w.rt(1).state = "running";
    w.db.run(
      `INSERT INTO gens (gen, epoch, op_id, reason, mode, secret, restore_gens, plan, plan_kind, state, unplanned, issued_at)
       VALUES (1, 1, 'op-1', 'user', 'prod', 's', '[]', '{"sqlite":{"kind":"fresh"}}', 'fresh', 'booting', 0, 0)`,
    );
    await w.api.onStarted({
      epoch: 1,
      gen: 1,
      opId: "op-1",
      reason: "user",
      digest: "d",
      wakeAt: 0,
      aliveMs: 1,
      startupzMs: 1,
    });
    w.api.core.ingressReady(1);
    await w.api.kickDriver();
    expect(gw.rejected).toEqual([]);
    expect(rows(w).map((r) => r.state)).toEqual(["accepted", "accepted"]);

    // a second pair arrives and the gateway never comes back: dead at 23 h
    gw.down = true;
    await handler(sp.send(sp.event("EvOut2")));
    w.advance(w.ctx.timers.inboxDeadMs + 1);
    await w.api.tick();
    expect(rows(w).find((r) => r.platform_key === "EvOut2")).toMatchObject({
      state: "dead",
      dead_reason: "age",
    });
    expect(
      w.db.one<{ severity: string }>("SELECT severity FROM alerts WHERE class = 'inbox-dead'")?.severity,
    ).toBe("high");
  });
});

describe("config guard: webhook transports", () => {
  it("allows an adapter channel its own webhookPath, nothing else", () => {
    const doc = (channels: unknown) => ({ channels });
    expect(webhookTransport(doc({ slack: { mode: "http", webhookPath: "/slack/events" } }))).toBeNull();
    expect(
      webhookTransport(doc({ sms: { webhookPath: "/webhooks/sms", publicWebhookUrl: "https://x/y" } })),
    ).toBeNull();
    expect(webhookTransport(doc({ slack: { webhookPath: "/elsewhere" } }))).toBe(
      "channels.slack.webhookPath",
    );
    expect(webhookTransport(doc({ slack: { webhookUrl: "https://evil.example/x" } }))).toBe(
      "channels.slack.webhookUrl",
    );
    expect(webhookTransport(doc({ sms: { webhookPath: "/slack/events" } }))).toBe("channels.sms.webhookPath");
    expect(webhookTransport(doc({ whatsapp: { webhookPath: "/slack/events" } }))).toBe(
      "channels.whatsapp.webhookPath",
    );
  });
});
