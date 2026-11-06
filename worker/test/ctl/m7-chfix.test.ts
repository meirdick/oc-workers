// M7 live B findings (worker/test/results/M7-live-access.md): F1 stale adapter secrets in the Control DO, F2
// attempts not counted before the first accept, F3 `inbox-blocked` only when ready, and the owner drop of stuck
// rows (`/ops/inbox/drop`, `channels remove --force`, `sleep now --force`).
import { describe, expect, it } from "vitest";
import { handleAdapter } from "../../src/ctl/adapter-webhook";
import { adapterByPath } from "../../src/ctl/adapters";
import { BLOCKED_AFTER_MISSES, countsAsAttempt, driverState } from "../../src/ctl/driver";
import { routeOfChannel } from "../../src/ctl/inbox";
import { handleOps } from "../../src/ops";
import { FakeGateway, FakeSlack, FakeTwilio } from "../harness/platforms";
import { type World, world } from "./world";

/** Running, driver started (`/startupz`), not ingress-ready: the state of every live boot today. */
async function bootNotReady(w: World) {
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
}

/** Worker hook → Control DO, as index.ts wires it; `fresh` is what the Worker isolate's env hands over. */
function hook(w: World, secrets: Record<string, string>, fresh?: Record<string, string>) {
  return (r: Request) => {
    const a = adapterByPath(new URL(r.url).pathname);
    if (!a) throw new Error("no adapter");
    return handleAdapter(r, a, {
      secrets,
      now: () => w.clock.t,
      ctl: {
        inboxPut: async (x) => w.api.inboxPut(x, fresh ? { platform: fresh } : undefined),
        hookSeen: async (i, k) => w.api.hookSeen(i, k),
      },
      wake: async () => undefined,
      waitUntil: () => undefined,
    });
  };
}

const rows = (w: World) =>
  w.db.all<{ id: string; route: string; state: string; attempts: number; dead_reason: string | null }>(
    "SELECT id, route, state, attempts, dead_reason FROM inbox ORDER BY received_at, id",
  );
const alertRow = (w: World, cls: string) =>
  w.db.one<{ last_detail: string; count: number }>(
    "SELECT last_detail, count FROM alerts WHERE class = ?",
    cls,
  );

async function drive(w: World, n: number) {
  for (let i = 0; i < n; i++) {
    w.advance(w.ctx.timers.driverRetryCapMs);
    await w.api.kickDriver();
  }
}

describe("F1: a secret put after the Control DO was built reaches the replay driver", () => {
  it("hook path: the Worker's env hands the new signing secret over; the replay is signed with it", async () => {
    const w = world();
    await bootNotReady(w);
    expect(w.ctx.secrets.platform).toBeUndefined(); // built before `channels add slack`
    const p = new FakeSlack(() => w.clock.t);
    const gw = new FakeGateway(() => w.clock.t, { slackSecret: p.secret });
    w.rt(1).deliverFn = (r) => {
      const out = gw.handle(r);
      return r.okIsDurable && out.status === 200 ? { status: 200, durable: true } : out;
    };
    // The Worker isolate of the new version has the secret; the DO does not.
    await hook(
      w,
      { OC_SLACK_SIGNING_SECRET: p.secret },
      { OC_SLACK_SIGNING_SECRET: p.secret },
    )(p.send(p.event("Ev1")));
    await w.api.kickDriver();
    expect(gw.rejected).toEqual([]);
    expect(rows(w)[0]?.state).toBe("accepted");
  });

  it("without the hand-over the driver cannot sign (the live bug); POST /ops/secrets-changed fixes it", async () => {
    const w = world();
    await bootNotReady(w);
    const p = new FakeSlack(() => w.clock.t);
    const gw = new FakeGateway(() => w.clock.t, { slackSecret: p.secret });
    w.rt(1).deliverFn = (r) => {
      const out = gw.handle(r);
      return r.okIsDurable && out.status === 200 ? { status: 200, durable: true } : out;
    };
    await hook(w, { OC_SLACK_SIGNING_SECRET: p.secret })(p.send(p.event("Ev2")));
    await w.api.kickDriver();
    expect(rows(w)[0]?.state).toBe("pending");
    expect(gw.accepted).toHaveLength(0);
    const r = await w.api.ops({
      action: "secrets-changed",
      method: "POST",
      sub: [],
      query: {},
      body: {},
      role: "owner",
      fresh: { platform: { OC_SLACK_SIGNING_SECRET: p.secret, OC_TWILIO_AUTH_TOKEN: undefined } },
    });
    expect(r.body).toMatchObject({
      ok: true,
      took: ["OC_SLACK_SIGNING_SECRET"],
      have: ["OC_SLACK_SIGNING_SECRET"],
    });
    await drive(w, 1);
    expect(gw.accepted).toHaveLength(1);
    expect(rows(w)[0]?.state).toBe("accepted");
  });

  it("an older isolate without the value does not clear a newer one", () => {
    const w = world();
    w.core.freshSecrets({ platform: { OC_TWILIO_AUTH_TOKEN: "new" } });
    expect(w.core.freshSecrets({ platform: { OC_TWILIO_AUTH_TOKEN: undefined } })).toEqual([]);
    expect(w.ctx.secrets.platform?.OC_TWILIO_AUTH_TOKEN).toBe("new");
  });

  it("ops.ts hands the Worker env to every /ops call; secrets-changed is owner only", async () => {
    const w = world();
    const handed: Record<string, string>[] = [];
    (
      w.rt(1) as unknown as { freshSecretEnv: (m: Record<string, string>) => Promise<number> }
    ).freshSecretEnv = async (m) => {
      handed.push(m);
      return Object.keys(m).length;
    };
    const env = {
      CONTROL_TOKEN: "owner-tok",
      CI_TOKEN: "ci-tok",
      OC_TEST: "0",
      OC_INST: "t1",
      OC_SECRET_OC_SLACK_SIGNING_SECRET: "s1",
      OC_SECRET_OC_SLACK_BOT_TOKEN: "xoxb-1",
      OC_SECRET_OC_CF_AI_TOKEN: "stays-on-the-worker",
      CONTROL: { getByName: () => w.api },
      RUNTIME: { getByName: () => w.rt(1) },
    } as never;
    const call = (tok: string) =>
      handleOps(
        new Request("https://oc.example/ops/secrets-changed", {
          method: "POST",
          headers: { authorization: `Bearer ${tok}` },
        }),
        env,
        async () => 1,
      );
    expect((await call("ci-tok")).status).toBe(404);
    const r = await call("owner-tok");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ have: ["OC_SLACK_SIGNING_SECRET"] });
    expect(w.ctx.secrets.platform?.OC_SLACK_SIGNING_SECRET).toBe("s1");
    // The Runtime DO gets the container's secret env too (the gateway verifies the replay with it).
    expect(handed).toEqual([{ OC_SLACK_SIGNING_SECRET: "s1", OC_SLACK_BOT_TOKEN: "xoxb-1" }]);
  });
});

describe("F2/F3: attempts and inbox-blocked before the first accept", () => {
  it("counts an attempt for any gateway answer but the not-up family", () => {
    expect(countsAsAttempt(404, false)).toBe(true);
    expect(countsAsAttempt(401, false)).toBe(true);
    expect(countsAsAttempt(501, false)).toBe(true);
    for (const s of [0, 500, 502, 503, 504]) expect(countsAsAttempt(s, false)).toBe(false);
    expect(countsAsAttempt(503, true)).toBe(true);
  });

  it("404 from a route with no plugin: attempts count, inbox-blocked after N with route and status, not ready", async () => {
    const w = world();
    await bootNotReady(w);
    const p = new FakeTwilio();
    w.ctx.secrets.platform = { OC_TWILIO_AUTH_TOKEN: p.authToken };
    w.rt(1).deliverFn = () => ({ status: 404, durable: false });
    await hook(w, { OC_TWILIO_AUTH_TOKEN: p.authToken })(p.send(p.sms("SM1", "+15551230000", "hi")));
    await w.api.kickDriver();
    await drive(w, BLOCKED_AFTER_MISSES - 2);
    expect(alertRow(w, "inbox-blocked")).toBeNull();
    await drive(w, 1);
    expect(driverState(w.ctx).ready).toBe(false);
    expect(rows(w)[0]).toMatchObject({ state: "pending", attempts: BLOCKED_AFTER_MISSES });
    const a = alertRow(w, "inbox-blocked");
    expect(a?.last_detail).toContain("404 on /webhooks/sms");
    expect(a?.last_detail).toContain("ochost inbox drop --all --channel sms");
    // Not ready: the queue keeps trying (a route can mount late) and does not raise again each time.
    await drive(w, 2);
    expect(driverState(w.ctx).queues["/webhooks/sms|default"]?.stopped).toBeUndefined();
    expect(alertRow(w, "inbox-blocked")?.count).toBe(1);
    // The plugin mounts: the next try is accepted.
    w.rt(1).deliverFn = () => ({ status: 200, durable: true });
    await drive(w, 1);
    expect(rows(w)[0]?.state).toBe("accepted");
  });

  it("501 counts the same way; a 503 between misses resets the run", async () => {
    const w = world();
    await bootNotReady(w);
    const p = new FakeSlack(() => w.clock.t);
    w.ctx.secrets.platform = { OC_SLACK_SIGNING_SECRET: p.secret };
    const seq = [501, 503, 501, 501, 501];
    w.rt(1).deliverFn = () => ({ status: seq.shift() ?? 501, durable: false });
    await hook(w, { OC_SLACK_SIGNING_SECRET: p.secret })(p.send(p.event("Ev9")));
    const until = async (n: number) => {
      for (let i = 0; i < 20 && w.rt(1).delivered.length < n; i++) await drive(w, 1);
    };
    await until(4); // 501, 503, 501, 501
    expect(alertRow(w, "inbox-blocked")).toBeNull();
    expect(rows(w)[0]?.attempts).toBe(3); // the 503 is not an attempt
    await until(5);
    expect(alertRow(w, "inbox-blocked")?.last_detail).toContain("501 on /slack/events");
  });
});

describe("stuck rows: POST /ops/inbox/drop", () => {
  async function three(w: World) {
    await bootNotReady(w);
    w.rt(1).deliverFn = () => ({ status: 404, durable: false });
    const sp = new FakeSlack(() => w.clock.t);
    const tp = new FakeTwilio();
    w.ctx.secrets.platform = { OC_SLACK_SIGNING_SECRET: sp.secret, OC_TWILIO_AUTH_TOKEN: tp.authToken };
    const h = hook(w, { OC_SLACK_SIGNING_SECRET: sp.secret, OC_TWILIO_AUTH_TOKEN: tp.authToken });
    await h(sp.send(sp.event("EvA")));
    await h(sp.send(sp.event("EvB")));
    await h(tp.send(tp.sms("SM7", "+15551230000", "hi")));
  }
  const drop = (w: World, body: Record<string, unknown>) =>
    w.api.ops({ action: "inbox", method: "POST", sub: ["drop"], query: {}, body, role: "owner" });

  it("drops one row by id, a channel's rows (sms alias), and refuses bad input", async () => {
    const w = world();
    await three(w);
    expect(w.core.inboxCounts().pending).toBe(3);
    const id = rows(w).find((r) => r.route === "/slack/events")?.id as string;
    expect((await drop(w, { id })).body).toMatchObject({ ok: true, dropped: 1 });
    expect((await drop(w, { id })).status).toBe(409); // already dead
    expect((await drop(w, { id: "nope" })).status).toBe(404);
    expect((await drop(w, {})).status).toBe(400);
    expect((await drop(w, { all: true, channel: "irc" })).status).toBe(400);
    expect((await drop(w, { all: true, channel: "sms" })).body).toMatchObject({
      dropped: 1,
      route: "/webhooks/sms",
    });
    expect(w.core.inboxCounts().pending).toBe(1);
    expect(w.core.sleepInputs().inboxBusy).toBe(1);
    expect((await drop(w, { all: true })).body).toMatchObject({ dropped: 1 });
    expect(w.core.sleepInputs().inboxBusy).toBe(0); // rule 5 clear
    expect(rows(w).every((r) => r.state === "dead" && r.dead_reason === "dropped")).toBe(true);
    // A dropped row is gone from the driver: nothing is due.
    w.rt(1).delivered.length = 0;
    await drive(w, 2);
    expect(w.rt(1).delivered).toHaveLength(0);
  });

  it("channel names map to inbox routes (twilio and sms are one)", () => {
    expect(routeOfChannel("telegram")).toBe("/telegram-webhook");
    expect(routeOfChannel("slack")).toBe("/slack/events");
    expect(routeOfChannel("discord")).toBe("/discord/interactions");
    expect(routeOfChannel("sms")).toBe("/webhooks/sms");
    expect(routeOfChannel("twilio")).toBe("/webhooks/sms");
    expect(routeOfChannel("irc")).toBeNull();
  });
});
