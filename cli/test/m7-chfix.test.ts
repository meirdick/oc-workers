// M7 live B findings (worker/test/results/M7-live-access.md) on the CLI side: secrets-changed after a channel
// secret put (F1), the baked Slack and SMS plugins in the channel config (F2), `inbox list|drop`, `channels remove
// --force` and `sleep now --force` dead-lettering stuck rows, and `sms` as a name for twilio (F4).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AddHookDeps,
  addHookChannel,
  hookChannelOf,
  SECRETS_WAIT_MS,
  SLACK_PLUGIN_DIR,
  SMS_PLUGIN_DIR,
  SPECS,
  signalSecrets,
  withHookChannel,
  withoutChannel,
} from "../src/hook-channels.ts";
import { fakeFetch, fakeOps } from "./fakes.ts";
import { FakeOps, installDir, type Req, run, statusBody } from "./ops-fake.ts";

const ORIGIN = "https://oc-x.example.workers.dev";
const ENV = {
  SLACK_BOT_TOKEN: "xoxb-fake-token-for-tests-only",
  SLACK_SIGNING_SECRET: "8f742231b10e8888abcd99yyyzzz85a5",
};

function deps(secretsChanged: (n: number) => { status: number; body: unknown }) {
  let t = 1_000_000;
  let n = 0;
  const lines: string[] = [];
  const o = fakeOps({
    "POST /ops/secrets-changed": () => secretsChanged(++n),
    "GET /ops/inbox": () => ({ status: 200, body: { counts: {}, rows: [], hooks: {} } }),
  });
  o.versions.push({ ver: 1, doc: {} });
  const d: AddHookDeps = {
    fetch: fakeFetch([["GET https://", () => ({ status: 405 })]]).fetch,
    env: ENV,
    ops: o.ops,
    log: (l) => lines.push(l),
    registerSecret: () => {},
    putSecret: async () => {},
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  return { d, o, lines, polls: () => n };
}
const known = ["OC_SLACK_SIGNING_SECRET", "OC_DISCORD_PUBLIC_KEY", "OC_TWILIO_AUTH_TOKEN"];

describe("F1: channels add tells the Worker its secrets changed", () => {
  it("POSTs /ops/secrets-changed after the secret put and retries until the new version serves it", async () => {
    const m = deps((n) => ({
      status: 200,
      body: { ok: true, known, have: n >= 3 ? ["OC_SLACK_SIGNING_SECRET"] : [] },
    }));
    await addHookChannel("slack", { origin: ORIGIN, verifyTimeoutMs: 0 }, m.d);
    expect(m.polls()).toBe(3);
    const posts = m.o.calls.filter((c) => c.path === "/ops/secrets-changed");
    // The bot token is the gateway's; only the signing secret is one the replay driver reads.
    expect(posts[0]?.body).toEqual({ names: ["OC_SLACK_BOT_TOKEN", "OC_SLACK_SIGNING_SECRET"] });
    // before the config change, so the restart that follows starts the container with the new env
    const idx = (p: string) => m.o.calls.findIndex((c) => c.path === p);
    expect(idx("/ops/secrets-changed")).toBeLessThan(idx("/ops/config"));
    expect(m.lines.join("\n")).not.toContain("WARN");
  });

  it("an older Worker (404) or a version that never serves the secret → one WARN line, add goes on", async () => {
    const old = deps(() => ({ status: 404, body: { error: "not found" } }));
    await addHookChannel("slack", { origin: ORIGIN, verifyTimeoutMs: 0 }, old.d);
    expect(old.lines.join("\n")).toContain("WARN: this Worker has no /ops/secrets-changed");
    const slow = deps(() => ({ status: 200, body: { ok: true, known, have: [] } }));
    expect(await signalSecrets(slow.d, ["OC_SECRET_OC_SLACK_SIGNING_SECRET"])).toBe(false);
    expect(slow.polls()).toBe(SECRETS_WAIT_MS / 3_000 + 1);
    expect(slow.lines.join("\n")).toContain("WARN: the Worker does not serve OC_SLACK_SIGNING_SECRET yet");
  });
});

describe("F2: the baked channel plugins are in the channel config", () => {
  const a = {
    botToken: "x",
    signingSecret: "x",
    accountSid: `AC${"1".repeat(32)}`,
    authToken: "x",
    sender: "+15551234567",
  };
  it("slack and twilio add their plugin load path and entry; the user's paths stay; discord adds none", () => {
    const base = {
      plugins: {
        load: { paths: ["/srv/mine", "/srv/other"] },
        entries: { firecrawl: { enabled: true } },
      },
    };
    let doc = withHookChannel(base, SPECS.slack, a, `${ORIGIN}/x`);
    doc = withHookChannel(doc, SPECS.twilio, a, `${ORIGIN}/x`);
    doc = withHookChannel(doc, SPECS.slack, a, `${ORIGIN}/x`); // again: no second path
    expect(doc.plugins.load.paths).toEqual(["/srv/mine", "/srv/other", SLACK_PLUGIN_DIR, SMS_PLUGIN_DIR]);
    expect(doc.plugins.entries).toEqual({
      firecrawl: { enabled: true },
      slack: { enabled: true },
      sms: { enabled: true },
    });
    expect(
      withHookChannel({}, SPECS.discord, { ...a, applicationId: "1".repeat(18) }, ORIGIN).plugins,
    ).toBeUndefined();
    const back = withoutChannel(withoutChannel(doc, "slack", SLACK_PLUGIN_DIR), "sms", SMS_PLUGIN_DIR);
    expect(back.plugins).toEqual(base.plugins);
    expect(withoutChannel(withHookChannel({}, SPECS.slack, a, ORIGIN), "slack", SLACK_PLUGIN_DIR)).toEqual(
      {},
    );
  });

  it("sms is a name for twilio", () => {
    expect(hookChannelOf("sms")).toBe("twilio");
    expect(hookChannelOf("twilio")).toBe("twilio");
    expect(hookChannelOf("telegram")).toBeUndefined();
  });
});

describe("stuck rows: inbox list|drop, channels remove --force, sleep now --force", () => {
  let f: FakeOps;
  let dir: string;
  let drops: Record<string, unknown>[];
  let vers: { ver: number; doc: Record<string, any> }[];
  const rows = [
    {
      id: "01A",
      route: "/webhooks/sms",
      platform_key: "SM1",
      state: "pending",
      attempts: 21,
      received_at: 0,
    },
    { id: "01B", route: "/slack/events", platform_key: "Ev1", state: "pending", attempts: 3, received_at: 0 },
  ];
  beforeEach(async () => {
    f = await new FakeOps().start();
    dir = installDir(f.url);
    drops = [];
    vers = [
      {
        ver: 1,
        doc: {
          channels: { sms: { enabled: true }, telegram: { enabled: true } },
          plugins: { load: { paths: [SMS_PLUGIN_DIR] }, entries: { sms: { enabled: true } } },
          bindings: [{ match: { channel: "sms" } }, { match: { channel: "telegram" } }],
        },
      },
    ];
    writeFileSync(join(dir, "oc-host.jsonc"), `{ "baseVersion": 1, "name": "oc-m7-test" }\n`);
    f.status = statusBody({ state: "running" });
    f.routes.push((q: Req) => {
      const p = q.path.split("?")[0];
      if (p === "/ops/inbox" && q.method === "GET")
        return { status: 200, body: { counts: { pending: 2, held: 0, dead: 0 }, rows } };
      if (p === "/ops/inbox/drop") {
        drops.push(q.body);
        if (q.body.id === "nope") return { status: 404, body: { error: "no such row" } };
        return { status: 200, body: { ok: true, dropped: q.body.id ? 1 : q.body.channel ? 1 : 2 } };
      }
      if (p === "/ops/config" && q.method === "GET")
        return { status: 200, body: { versions: [...vers].reverse().map((v) => ({ ver: v.ver })) } };
      const m = /^\/ops\/config\/(\d+)$/.exec(p ?? "");
      if (m) return { status: 200, body: vers.find((v) => v.ver === Number(m[1])) };
      if (p === "/ops/config" && q.method === "POST") {
        vers.push({ ver: vers.length + 1, doc: q.body.doc });
        return { status: 200, body: { ok: true, ver: vers.length } };
      }
      if (p === "/ops/restart") return { status: 200, body: {} };
      return undefined;
    });
  });
  afterEach(() => f.stop());

  it("inbox list shows channel, state and attempts; drop takes an id or --all --channel (sms → sms)", async () => {
    let r = await run("inbox", ["list", "--dir", dir]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("pending 2, held 0");
    expect(r.out).toMatch(/01A\s+sms\s+SM1\s+pending\s+21/);
    expect(r.out).toMatch(/01B\s+slack\s+Ev1\s+pending\s+3/);
    r = await run("inbox", ["list", "--channel", "twilio", "--dir", dir]);
    expect(r.out).not.toContain("01B");
    r = await run("inbox", ["drop", "01A", "--dir", dir]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("dead-lettered 1 inbox row(s)");
    r = await run("inbox", ["drop", "--all", "--channel", "twilio", "--dir", dir]);
    expect(r.code, r.err).toBe(0);
    expect(drops).toEqual([{ id: "01A" }, { all: true, channel: "sms" }]);
    expect((await run("inbox", ["drop", "--dir", dir])).code).toBe(2);
    expect((await run("inbox", ["drop", "01A", "--all", "--dir", dir])).code).toBe(2);
    r = await run("inbox", ["drop", "nope", "--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no inbox row nope");
  });

  it("channels remove sms --force: the sms alias works, its rows are dead-lettered, the plugin path goes", async () => {
    let r = await run("channels", ["remove", "sms", "--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/inbox has 1 Twilio SMS update/);
    r = await run("channels", ["remove", "sms", "--force", "--dir", dir]);
    expect(r.code, r.err).toBe(0);
    expect(drops).toEqual([{ all: true, channel: "sms" }]);
    expect(r.err).toContain("dead-lettered 1 Twilio SMS update(s)");
    expect(vers.at(-1)?.doc).toEqual({
      channels: { telegram: { enabled: true } },
      bindings: [{ match: { channel: "telegram" } }],
    });
  });

  it("sleep now --force: a 5:inbox refusal dead-letters the pending rows with a warning, then sleeps", async () => {
    let sleeps = 0;
    f.routes.unshift((q: Req) =>
      q.path.startsWith("/ops/sleep")
        ? ++sleeps === 1
          ? { status: 409, body: { ok: false, reason: "5:inbox" } }
          : { status: 200, body: { ok: true, opId: "op-1" } }
        : undefined,
    );
    const r = await run("sleep", ["now", "--force", "--no-wait", "--dir", dir]);
    expect(r.code, r.err).toBe(0);
    expect(drops).toEqual([{ all: true, state: "pending" }]);
    expect(r.err).toContain("dead-lettered 2 pending inbox row(s) to pass rule 5");
    expect(f.calls("POST", "/ops/sleep?force=1")).toHaveLength(2);
  });

  it("sleep now without --force never drops rows", async () => {
    f.routes.unshift((q: Req) =>
      q.path.startsWith("/ops/sleep") ? { status: 409, body: { ok: false, reason: "5:inbox" } } : undefined,
    );
    const r = await run("sleep", ["now", "--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("dead-letters pending inbox rows (rule 5)");
    expect(drops).toEqual([]);
  });
});
