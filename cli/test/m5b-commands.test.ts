// M5b: the commands added to the dispatch table (channels, pairing, model, ai-gateway, config, secrets, upgrade,
// advanced), run through runOps() against the fake /ops server. Cloudflare and Telegram calls go to a fake fetch.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPath, parseValue, secretName, setPath } from "../src/config-commands.ts";
import { COMMANDS } from "../src/index.ts";
import { OPS_COMMANDS, opsHelp } from "../src/ops-commands.ts";
import { nextCommand, selfCommand } from "../src/self.ts";
import { FakeOps, fakeRunner, installDir, type Req, run, statusBody } from "./ops-fake.ts";

const ACCT = "0".repeat(32);
const AI = "t".repeat(53);
const BOT = "123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr"; // fake, right shape

let f: FakeOps;
let dir: string;
/** Config versions in the fake Control DO. */
let vers: { ver: number; doc: Record<string, any> }[];

function configRoutes(r: Req) {
  const p = r.path.split("?")[0] as string;
  if (r.method === "GET" && p === "/ops/config")
    return {
      status: 200,
      body: {
        versions: [...vers]
          .reverse()
          .map((v) => ({ ver: v.ver, status: "good", source: "owner", sha: String(v.ver), created_at: 0 })),
      },
    };
  const m = /^\/ops\/config\/(\d+)$/.exec(p);
  if (r.method === "GET" && m) {
    const v = vers.find((x) => x.ver === Number(m[1]));
    return v
      ? { status: 200, body: { ver: v.ver, doc: v.doc } }
      : { status: 404, body: { error: "no-version" } };
  }
  if (r.method === "POST" && p === "/ops/config") {
    const last = vers[vers.length - 1];
    if (last && JSON.stringify(last.doc) === JSON.stringify(r.body.doc))
      return { status: 200, body: { ok: true, ver: last.ver, same: true } };
    const ver = (last?.ver ?? 0) + 1;
    vers.push({ ver, doc: r.body.doc });
    return { status: 200, body: { ok: true, ver } };
  }
  if (r.method === "POST" && p === "/ops/restart")
    return { status: 200, body: { stop: {}, start: { ok: true } } };
  return undefined;
}

/** Real fetch for the fake /ops server; fakes for api.cloudflare.com, the gateway and Telegram. */
function fetchWith(extra: (url: string, init?: RequestInit) => Response | undefined): typeof fetch {
  return (async (i: string | URL | Request, init?: RequestInit) => {
    const url = String(i);
    const x = extra(url, init);
    if (x) return x;
    return globalThis.fetch(i, init);
  }) as typeof fetch;
}
/** Fake POST /ops/inbox/drop: records the body, drops one row. */
const dropOk = (drops: unknown[], body: unknown) => {
  drops.push(body);
  return { status: 200, body: { ok: true, dropped: 1 } };
};
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  f = await new FakeOps().start();
  vers = [{ ver: 1, doc: { agents: { defaults: { model: { primary: "cfgw/@cf/a/b" } } } } }];
  f.routes.push(configRoutes);
  dir = installDir(f.url, {
    hostConfig: `{\n  "baseVersion": 1,\n  "name": "oc-m5-test",\n  "llm": { "gateway": "oc-host", "primary": "@cf/a/b" }\n}\n`,
  });
});
afterEach(() => f.stop());

describe("dispatch", () => {
  it("every spec §1.2 command has an entry; advanced is hidden from the list", () => {
    const all = { ...COMMANDS, ...OPS_COMMANDS };
    for (const c of [
      "init",
      "deploy",
      "status",
      "logs",
      "open",
      "sleep",
      "wake",
      "restart",
      "channels",
      "pairing",
      "model",
      "ai-gateway",
      "backup",
      "snapshot",
      "config",
      "secrets",
      "auth",
      "alerts",
      "doctor",
      "upgrade",
      "ci",
      "destroy",
      "advanced",
    ])
      expect(all[c], c).toBeDefined();
    expect(opsHelp()).not.toMatch(/^\s+advanced/m);
    expect(opsHelp("advanced")).toContain("advanced prune --plan | --apply");
  });

  it("-h on each new command exits 0 with its usage", async () => {
    for (const c of [
      "channels",
      "pairing",
      "model",
      "ai-gateway",
      "config",
      "secrets",
      "upgrade",
      "advanced",
    ]) {
      const r = await run(c, ["-h"]);
      expect(r.code, c).toBe(0);
      expect(r.out).toContain(`ochost ${c}`);
    }
  });

  it("Next line: ochost on PATH, else node <bin>; --dir when not cwd", () => {
    expect(selfCommand({ path: "", argv1: "/x/cli/bin/ochost.js" })).toBe("node /x/cli/bin/ochost.js");
    expect(selfCommand({ path: "", argv1: "/usr/bin/vitest" })).toBe("ochost");
    expect(nextCommand("/a", "/a", "ochost")).toBe("ochost channels add telegram");
    expect(nextCommand("/a b", "/c", "ochost")).toBe('ochost channels add telegram --dir "/a b"');
  });
});

describe("config", () => {
  it("path helpers", () => {
    const d = setPath({ a: { b: 1 } }, "a.c[0].d", "x");
    expect(d).toEqual({ a: { b: 1, c: [{ d: "x" }] } });
    expect(getPath(d, "a.c.0.d")).toBe("x");
    expect(setPath(d, "a.b", undefined)).toEqual({ a: { c: [{ d: "x" }] } });
    expect(parseValue("true")).toBe(true);
    expect(parseValue("cfgw/@cf/x/y")).toBe("cfgw/@cf/x/y");
    expect(() => parseValue("{bad")).toThrow(/not valid JSON/);
    expect(() => setPath({}, "__proto__.x", 1)).toThrow(/bad config path/);
  });

  it("get: whole doc, one path, --json", async () => {
    let r = await run("config", ["get", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(vers[0]?.doc);
    r = await run("config", ["get", "agents.defaults.model.primary", "--dir", dir]);
    expect(r.out.trim()).toBe("cfgw/@cf/a/b");
    r = await run("config", ["get", "nope.x", "--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/nope\.x is not set in config version 1/);
    r = await run("config", ["get", "--ver", "9", "--dir", dir]);
    expect(r.err).toMatch(/no config version 9/);
  });

  it("set: new version on the base, baseVersion moves, asleep → applies at the next wake", async () => {
    const r = await run("config", [
      "set",
      "channels.telegram.dmPolicy",
      "allowlist",
      "--dir",
      dir,
      "--restart",
    ]);
    expect(r.code).toBe(0);
    expect(vers).toHaveLength(2);
    expect(vers[1]?.doc.channels.telegram.dmPolicy).toBe("allowlist");
    expect(f.calls("POST", "/ops/config")[0]?.body.baseVer).toBe(1);
    expect(f.calls("POST", "/ops/restart")).toHaveLength(0); // fake status is asleep
    expect(r.err).toContain("applies at the next wake");
    expect(readFileSync(join(dir, "oc-host.jsonc"), "utf8")).toContain('"baseVersion": 2');
  });

  it("set --restart on a running install restarts; --unset removes", async () => {
    f.status = statusBody({ state: "running" });
    const r = await run("config", [
      "set",
      "agents.defaults.model.primary",
      "--unset",
      "--restart",
      "--dir",
      dir,
    ]);
    expect(r.code).toBe(0);
    expect(vers[1]?.doc.agents.defaults.model).toEqual({});
    expect(f.calls("POST", "/ops/restart")).toHaveLength(1);
  });

  it("set refuses when the config changed elsewhere", async () => {
    vers.push({ ver: 2, doc: {} });
    const r = await run("config", ["set", "a", "1", "--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(
      /^Failed: config changed elsewhere \(base 1, current 2\) — fix: run ochost config pull/,
    );
    expect(f.calls("POST", "/ops/config")).toHaveLength(0);
  });

  it("pull writes openclaw.jsonc and baseVersion; list shows versions", async () => {
    vers.push({ ver: 2, doc: { x: 1 } });
    let r = await run("config", ["pull", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "openclaw.jsonc"), "utf8")).toContain('"x": 1');
    expect(readFileSync(join(dir, "oc-host.jsonc"), "utf8")).toContain('"baseVersion": 2');
    r = await run("config", ["set", "y", "2", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "openclaw.jsonc"), "utf8")).toContain('"y": 2');
    r = await run("config", ["list", "--dir", dir]);
    expect(r.out).toMatch(/^VER\s+STATUS/m);
  });
});

describe("secrets", () => {
  it("names: OC_SECRET_ prefix, channel and managed names refused", () => {
    expect(secretName("MY_KEY")).toBe("OC_SECRET_MY_KEY");
    expect(secretName("OC_SECRET_MY_KEY")).toBe("OC_SECRET_MY_KEY");
    expect(() => secretName("TELEGRAM_BOT_TOKEN")).toThrow(
      /TELEGRAM_BOT_TOKEN is a channel secret — fix: use ochost channels add telegram/,
    );
    expect(() => secretName("OC_CF_AI_TOKEN")).toThrow(/AI binding, no token/);
    expect(() => secretName("lower")).toThrow(/bad secret name/);
  });

  it("set --from-file: wrangler secret put by stdin, manifest without the value, restart when running", async () => {
    f.status = statusBody({ state: "running" });
    const file = join(dir, "v.txt");
    writeFileSync(file, "s3cr3t-value-123\n", { mode: 0o600 });
    const fr = fakeRunner();
    const r = await run("secrets", ["set", "MY_KEY", "--from-file", file, "--dir", dir], { run: fr.run });
    expect(r.code).toBe(0);
    const put = fr.calls.find((c) => c.args.includes("put"));
    expect(put?.args.slice(-5)).toEqual(["secret", "put", "OC_SECRET_MY_KEY", "--name", "oc-m5-test"]);
    expect(put?.input).toBe("s3cr3t-value-123");
    const man = readFileSync(join(dir, ".oc-host", "secrets.json"), "utf8");
    expect(man).toContain("OC_SECRET_MY_KEY");
    expect(man).not.toContain("s3cr3t-value-123");
    expect(f.calls("POST", "/ops/restart")).toHaveLength(1);
    expect(r.out + r.err).not.toContain("s3cr3t-value-123");
  });

  it("set: non-interactive without a file → exit 3; --no-restart skips the restart", async () => {
    let r = await run("secrets", ["set", "MY_KEY", "--dir", dir]);
    expect(r.code).toBe(3);
    f.status = statusBody({ state: "running" });
    r = await run("secrets", ["set", "MY_KEY", "--no-restart", "--dir", dir], {
      nonInteractive: false,
      prompts: { ask: async () => "", askHidden: async () => "typed-value-1234" },
    });
    expect(r.code).toBe(0);
    expect(f.calls("POST", "/ops/restart")).toHaveLength(0);
  });

  it("list: manifest + wrangler secret list; a manifest name missing on the Worker shows MISSING", async () => {
    writeFileSync(
      join(dir, ".oc-host", "secrets.json"),
      JSON.stringify([{ name: "OC_SECRET_A", sha256: "x", setAt: "2026-11-01T00:00:00.000Z" }]),
    );
    const fr = fakeRunner(() => ({
      stdout: JSON.stringify([{ name: "CONTROL_TOKEN", type: "secret_text" }]),
    }));
    const r = await run("secrets", ["list", "--dir", dir], { run: fr.run });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/CONTROL_TOKEN\s+-\s+-\s+yes/);
    expect(r.out).toMatch(/OC_SECRET_A\s+2026-11-01 00:00:00\s+yes\s+MISSING/);
  });
});

describe("upgrade and advanced", () => {
  it("advanced: inbox, events, creds history, prune plan/apply hit the right routes", async () => {
    f.routes.push((q) =>
      /^\/ops\/(inbox|events|creds|gc)/.test(q.path) ? { status: 200, body: { ok: 1 } } : undefined,
    );
    for (const a of [
      ["inbox"],
      ["events", "--lines", "5"],
      ["creds", "history", "--path", "a/b"],
      ["prune", "--plan"],
      ["prune", "--apply"],
    ])
      expect((await run("advanced", [...a, "--dir", dir])).code, a.join(" ")).toBe(0);
    expect(f.reqs.map((q) => `${q.method} ${q.path}`)).toEqual([
      "GET /ops/inbox",
      "GET /ops/events?limit=5",
      "GET /ops/creds/history?path=a%2Fb",
      "GET /ops/gc",
      "POST /ops/gc",
    ]);
    expect((await run("advanced", ["prune", "--dir", dir])).code).toBe(2);
  });
});

describe("pairing", () => {
  it("list and approve through W1 routes", async () => {
    f.routes.push((q) =>
      q.path.startsWith("/ops/pairing?")
        ? { status: 200, body: { requests: [{ code: "ABCD1234", id: "42", name: "Meir" }] } }
        : q.path === "/ops/pairing/approve"
          ? { status: 200, body: { ok: true } }
          : undefined,
    );
    let r = await run("pairing", ["list", "--dir", dir]);
    expect(r.out).toMatch(/ABCD1234\s+42\s+Meir/);
    r = await run("pairing", ["approve", "telegram", "ABCD1234", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(f.calls("POST", "/ops/pairing/approve")[0]?.body).toEqual({ ch: "telegram", code: "ABCD1234" });
  });

  it("Worker without W1 → one Failed line with the Control UI fix", async () => {
    const r = await run("pairing", ["list", "--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no pairing route .* fix: approve the DM in the Control UI \(ochost open\)/);
  });
});

describe("channels", () => {
  const tg = (state: { url: string }) =>
    fetchWith((url) => {
      if (!url.startsWith("https://api.telegram.org/")) return undefined;
      if (url.endsWith("/getMe"))
        return json({ ok: true, result: { id: 123456789, username: "oc_test_bot" } });
      if (url.endsWith("/getWebhookInfo"))
        return json({ ok: true, result: { url: state.url, pending_update_count: 0 } });
      return json({ ok: false }, 404);
    });

  it("add telegram: secret put, config version with channel + binding, webhook via W8, bot id saved", async () => {
    f.routes.push((q) =>
      q.path === "/ops/telegram/webhook" ? { status: 200, body: { ok: true } } : undefined,
    );
    const fr = fakeRunner();
    const r = await run("channels", ["add", "telegram", "--dir", dir], {
      env: { TELEGRAM_BOT_TOKEN: BOT },
      run: fr.run,
      fetch: tg({ url: `${f.url}/telegram-webhook` }),
    });
    expect(r.err).not.toContain(BOT);
    expect(r.code).toBe(0);
    expect(fr.calls.find((c) => c.args.includes("put"))?.args).toContain("OC_SECRET_OC_TELEGRAM_BOT_TOKEN");
    expect(vers[1]?.doc.channels.telegram).toMatchObject({ enabled: true, dmPolicy: "pairing" });
    expect(vers[1]?.doc.bindings).toEqual([
      { agentId: "main", match: { channel: "telegram", accountId: "default" } },
    ]);
    const st = JSON.parse(readFileSync(join(dir, ".oc-host", "state.json"), "utf8"));
    expect(st.telegramBotId).toBe(123456789);
    expect(r.out).toContain("Telegram bot @oc_test_bot on (config version 2)");
  });

  it("add slack: Worker secrets by wrangler, HTTP-mode config + binding, URL printed, verified by the platform's call, applied", async () => {
    let calls = 0;
    f.routes.push((q) => {
      if (q.path === "/ops/inbox")
        return {
          status: 200,
          body: {
            counts: {},
            rows: [],
            hooks: { slack: ++calls > 1 ? { at: Date.now() + 1000, kind: "challenge" } : null },
          },
        };
      return undefined;
    });
    f.status = statusBody({ state: "running" });
    const fr = fakeRunner();
    const botToken = "xoxb-fake-token-for-tests-only";
    const signing = "8f742231b10e8888abcd99yyyzzz85a5";
    const r = await run("channels", ["add", "slack", "--verify-timeout", "1m", "--dir", dir], {
      env: { SLACK_BOT_TOKEN: botToken, SLACK_SIGNING_SECRET: signing },
      run: fr.run,
      // the Worker's hook route answers GET with 405 (POST only); the fake /ops server has no such route
      fetch: fetchWith((url) =>
        url.endsWith("/_ochost/hook/slack") ? new Response(null, { status: 405 }) : undefined,
      ),
    });
    expect(r.code, r.err).toBe(0);
    const puts = fr.calls.filter((c) => c.args.includes("put"));
    expect(puts.map((c) => [c.args[c.args.indexOf("put") + 1], c.input])).toEqual([
      ["OC_SECRET_OC_SLACK_BOT_TOKEN", botToken],
      ["OC_SECRET_OC_SLACK_SIGNING_SECRET", signing],
    ]);
    expect(r.out + r.err).not.toContain(botToken);
    expect(r.out + r.err).not.toContain(signing);
    expect(vers[1]?.doc.channels.slack).toMatchObject({
      enabled: true,
      mode: "http",
      webhookPath: "/slack/events",
    });
    expect(vers[1]?.doc.bindings).toEqual([
      { agentId: "main", match: { channel: "slack", accountId: "default" } },
    ]);
    expect(r.err).toContain(`Slack webhook URL: ${f.url}/_ochost/hook/slack`);
    expect(r.err).toContain("Slack called the webhook (challenge): verified");
    expect(f.calls("POST", "/ops/restart")).toHaveLength(1); // secrets and config apply at the next gateway start
    const m = JSON.parse(readFileSync(join(dir, ".oc-host", "secrets.json"), "utf8")) as { name: string }[];
    expect(m.map((e) => e.name)).toEqual([
      "OC_SECRET_OC_SLACK_BOT_TOKEN",
      "OC_SECRET_OC_SLACK_SIGNING_SECRET",
    ]);
    expect(JSON.stringify(m)).not.toContain(signing);
  });

  it("add slack non-interactive with no env exits 3; secrets set refuses the owned names", async () => {
    const r = await run("channels", ["add", "slack", "--dir", dir], { env: {} });
    expect(r.code).toBe(3);
    expect(r.err).toMatch(
      /^Failed: no Slack bot token .*fix: rerun with SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET set/,
    );
    for (const n of ["SLACK_SIGNING_SECRET", "DISCORD_PUBLIC_KEY", "TWILIO_AUTH_TOKEN"])
      expect(() => secretName(n)).toThrow(
        /is a channel secret — fix: use ochost channels add (slack|discord|twilio)/,
      );
  });

  it("remove twilio: waits for its own inbox rows only; --force removes the sms channel and its binding", async () => {
    vers.push({
      ver: 2,
      doc: {
        channels: { sms: { enabled: true, authToken: "x" }, telegram: { enabled: true } },
        bindings: [{ match: { channel: "sms" } }, { match: { channel: "telegram" } }],
      },
    });
    writeFileSync(join(dir, "oc-host.jsonc"), `{ "baseVersion": 2, "name": "oc-m5-test" }\n`);
    const drops: unknown[] = [];
    f.routes.push((q) =>
      q.path === "/ops/inbox"
        ? {
            status: 200,
            body: {
              counts: { pending: 2, held: 0 },
              rows: [
                { route: "/webhooks/sms", state: "pending" },
                { route: "/telegram-webhook", state: "pending" },
              ],
            },
          }
        : q.path === "/ops/inbox/drop"
          ? dropOk(drops, q.body)
          : undefined,
    );
    f.status = statusBody({ state: "running" });
    let r = await run("channels", ["remove", "twilio", "--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/inbox has 1 Twilio SMS update/);
    r = await run("channels", ["remove", "twilio", "--force", "--dir", dir]);
    expect(r.code, r.err).toBe(0);
    expect(vers.at(-1)?.doc).toEqual({
      channels: { telegram: { enabled: true } },
      bindings: [{ match: { channel: "telegram" } }],
    });
    expect(r.err).toContain("secrets OC_SECRET_OC_TWILIO_AUTH_TOKEN stay on the Worker");
    expect(drops).toEqual([{ all: true, channel: "sms" }]); // M7: its rows go dead, the Telegram row stays
  });

  it("D5: no bot token with --non-interactive exits 3, like the README says", async () => {
    const r = await run("channels", ["add", "telegram", "--dir", dir], { env: {} });
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/^Failed: no Telegram bot token — fix: rerun with --token-file/);
  });

  it("test install (init --fake-telegram): no token, no call to api.telegram.org, webhook read from the Worker", async () => {
    const stPath = join(dir, ".oc-host", "state.json");
    writeFileSync(
      stPath,
      JSON.stringify({ ...JSON.parse(readFileSync(stPath, "utf8")), fakeTelegram: true }),
    );
    let hook = "";
    f.routes.push((q) => {
      if (q.path === "/ops/telegram/webhook" && q.method === "POST") {
        hook = "secret";
        return { status: 200, body: { ok: true } };
      }
      if (q.path === "/ops/telegram/webhook")
        return { status: 200, body: { ok: true, path: hook || "none", pending: 0 } };
      return undefined;
    });
    const fr = fakeRunner();
    const seen: string[] = [];
    const r = await run("channels", ["add", "telegram", "--dir", dir], {
      env: { TELEGRAM_BOT_TOKEN: BOT }, // a real token in the env is not used
      run: fr.run,
      fetch: fetchWith((url) => {
        if (url.startsWith("https://api.telegram.org/")) seen.push(url);
        return undefined;
      }),
    });
    expect(r.err).toContain("Telegram bot: @oc_host_test_bot (fake, test install)");
    expect(r.err).not.toContain(BOT);
    expect(r.code).toBe(0);
    expect(seen).toEqual([]);
    const put = fr.calls.find((c) => c.args.includes("put"));
    expect(put?.input).toMatch(/^7000000001:[A-Za-z0-9_-]{35}$/);
    expect(put?.input).not.toBe(BOT);
    expect(r.out).toContain("Telegram bot @oc_host_test_bot on (config version 2)");
    expect(vers[1]?.doc.channels.telegram).toMatchObject({ enabled: true });
    const st = JSON.parse(readFileSync(stPath, "utf8"));
    expect(st).toMatchObject({ telegramBotId: 7000000001, telegramBot: "oc_host_test_bot" });
  });

  it("list shows the channel; remove refuses with inbox work, --force removes and restarts", async () => {
    vers.push({
      ver: 2,
      doc: {
        channels: { telegram: { enabled: true, dmPolicy: "pairing", webhookUrl: "x" } },
        bindings: [{ match: { channel: "telegram" } }],
      },
    });
    writeFileSync(join(dir, "oc-host.jsonc"), `{ "baseVersion": 2, "name": "oc-m5-test" }\n`);
    const drops: unknown[] = [];
    f.routes.push((q) =>
      q.path === "/ops/inbox"
        ? { status: 200, body: { counts: { pending: 1, held: 0 } } }
        : q.path === "/ops/inbox/drop"
          ? dropOk(drops, q.body)
          : undefined,
    );
    let r = await run("channels", ["list", "--dir", dir]);
    expect(r.out).toMatch(/telegram\s+yes\s+pairing\s+managed/);
    r = await run("channels", ["remove", "telegram", "--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/inbox has 1 Telegram update/);
    f.status = statusBody({ state: "running" });
    r = await run("channels", ["remove", "telegram", "--force", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(vers[2]?.doc).toEqual({});
    expect(f.calls("POST", "/ops/restart")).toHaveLength(1);
    expect(drops).toEqual([{ all: true, channel: "telegram" }]); // add §2.2: --force marks the rest dead
    expect(r.err).toContain("dead-lettered 1 Telegram update(s)");
  });

  it("unknown channel → usage exit 2", async () => {
    expect((await run("channels", ["add", "whatsapp", "--dir", dir])).code).toBe(2);
  });
});

describe("model and ai-gateway", () => {
  const models = [
    { name: "@cf/a/b", created_at: "2026", properties: [{ property_id: "function_calling", value: "true" }] },
    { name: "@cf/c/d", created_at: "2026", properties: [{ property_id: "function_calling", value: "true" }] },
  ];
  /** What the fake Worker's gate answers; the model it was asked for is kept. */
  let gate: { status: number; body: unknown };
  let gated: { model: string; auth: string }[];
  beforeEach(() => {
    gate = { status: 200, body: { choices: [{ message: { content: "pong" } }], usage: { neurons: 3 } } };
    gated = [];
    f.routes.push((q) => {
      if (q.path !== "/ops/gate/ai/v1/chat/completions") return undefined;
      gated.push({ model: q.body.model, auth: q.auth });
      return gate;
    });
  });
  const cfFetch = () =>
    fetchWith((url, init) => {
      if (url.includes("/ai/models/search")) {
        cfAuth.push(String((init?.headers as Record<string, string>)?.authorization));
        return json({ success: true, result: models, result_info: { total_pages: 1 } });
      }
      if (url.includes("gateway.ai.cloudflare.com") || url.includes("/ai-gateway/"))
        return json({ error: "no direct gateway calls without a token" }, 500);
      return undefined;
    });
  let cfAuth: string[];
  beforeEach(() => {
    cfAuth = [];
  });
  const login = (token: string | null) =>
    fakeRunner((c) =>
      c.args.includes("auth") && c.args.includes("token")
        ? token
          ? { stdout: JSON.stringify({ type: "oauth", token }) }
          : { code: 1, stderr: "not logged in" }
        : undefined,
    );

  it("model list: the wrangler login reads the catalogue; --ai-token-file or env wins; no login → exit 3", async () => {
    let r = await run("model", ["list", "--dir", dir], {
      fetch: cfFetch(),
      run: login("oauth-bearer-xyz-123").run,
    });
    expect(r.code).toBe(0);
    expect(cfAuth[0]).toBe("Bearer oauth-bearer-xyz-123");
    expect(r.out).toMatch(/^\*\s+@cf\/a\/b/m);
    r = await run("model", ["list", "--dir", dir], {
      env: { OC_CF_AI_TOKEN: AI },
      fetch: cfFetch(),
      run: login("oauth-bearer-xyz-123").run,
    });
    expect(cfAuth[1]).toBe(`Bearer ${AI}`);
    expect(r.out).not.toContain(AI);
    r = await run("model", ["list", "--dir", dir], { fetch: cfFetch(), run: login(null).run });
    expect(r.code).toBe(3);
    expect(r.err).toMatch(
      /no wrangler login on this machine .* fix: run npx wrangler login, or pass --ai-token-file/,
    );
  });

  it("model set: one call through the gate first (owner bearer), then the config; a model the gate refuses changes nothing", async () => {
    const r = await run("model", ["set", "@cf/c/d", "--dir", dir], { fetch: cfFetch() });
    expect(r.code).toBe(0);
    expect(gated).toEqual([{ model: "@cf/c/d", auth: `Bearer ${"a".repeat(64)}` }]);
    expect(vers[1]?.doc.agents.defaults.model.primary).toBe("cfgw/@cf/c/d");
    expect(readFileSync(join(dir, "oc-host.jsonc"), "utf8")).toContain('"primary": "@cf/c/d"');
    gate = { status: 400, body: { error: { message: "no such model" } } };
    const bad = await run("model", ["set", "@cf/x/y", "--dir", dir], { fetch: cfFetch() });
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/@cf\/x\/y did not answer through the gate \(400 no such model\)/);
    expect(vers).toHaveLength(2);
  });

  it("model set anthropic/<model>: nothing stored in the container; the gate decides; no key in the gateway → the dashboard step", async () => {
    const ok = await run("model", ["set", "anthropic/claude-sonnet-4-6", "--dir", dir], { fetch: cfFetch() });
    expect(ok.code).toBe(0);
    const doc = vers[1]?.doc;
    expect(doc?.agents.defaults.model.primary).toBe("cfgw/anthropic/claude-sonnet-4-6");
    expect(JSON.stringify(doc)).not.toMatch(/sk-ant|apiKey/);
    gate = { status: 502, body: { error: { message: "no provider key for anthropic" } } };
    const no = await run("model", ["set", "anthropic/claude-opus-4-1", "--dir", dir], { fetch: cfFetch() });
    expect(no.code).toBe(1);
    expect(no.err).toMatch(/Provider Keys, alias default/);
    expect(vers).toHaveLength(2);
    expect((await run("model", ["set", "openai/gpt-4.1", "--dir", dir], { fetch: cfFetch() })).err).toMatch(
      /bad model id openai\/gpt-4.1/,
    );
  });

  it("ai-gateway setup, no token: gateway from --gateway into oc-host.jsonc with a deploy hint, provider on the gate, hop through the gate, no secret", async () => {
    const fr = fakeRunner();
    const r = await run("ai-gateway", ["setup", "--gateway", "openclaw-cf", "--dir", dir], {
      fetch: cfFetch(),
      run: fr.run,
    });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/gateway is now openclaw-cf; the Worker still uses oc-host — fix: ochost deploy/);
    expect(gated).toHaveLength(1);
    expect(fr.calls).toHaveLength(0);
    const p = vers[1]?.doc.models.providers.cfgw;
    expect(p.baseUrl).toBe("http://15.0.0.3/ai/v1");
    expect(p.headers).toBeUndefined();
    expect(readFileSync(join(dir, "oc-host.jsonc"), "utf8")).toContain('"gateway": "openclaw-cf"');
    expect(r.out + r.err).not.toContain(AI);
  });

  it("ai-gateway setup replaces a token-era provider block (gateway URL, cf-aig header) with the gate one", async () => {
    vers[0] = {
      ver: 1,
      doc: {
        agents: { defaults: { model: { primary: "cfgw/@cf/a/b" } } },
        models: {
          providers: {
            cfgw: {
              baseUrl: `https://gateway.ai.cloudflare.com/v1/${ACCT}/oc-host/workers-ai/v1`,
              // biome-ignore lint/suspicious/noTemplateCurlyInString: OpenClaw SecretRef text
              apiKey: "${OC_CF_AI_TOKEN}",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: OpenClaw SecretRef text
              headers: { "cf-aig-authorization": "Bearer ${OC_CF_AI_TOKEN}" },
              models: [{ id: "@cf/a/b", name: "old" }],
            },
          },
        },
      },
    };
    const r = await run("ai-gateway", ["setup", "--dir", dir], { fetch: cfFetch() });
    expect(r.code).toBe(0);
    const p = vers[vers.length - 1]?.doc.models.providers.cfgw;
    expect(p.baseUrl).toBe("http://15.0.0.3/ai/v1");
    expect(JSON.stringify(p)).not.toMatch(/cf-aig|OC_CF_AI_TOKEN/);
  });

  it("ai-gateway setup keeps the live primary from the config doc over oc-host.jsonc; config set mirrors it", async () => {
    let r = await run("config", ["set", "agents.defaults.model.primary", "cfgw/@cf/c/d", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "oc-host.jsonc"), "utf8")).toContain('"primary": "@cf/c/d"');
    writeFileSync(
      join(dir, "oc-host.jsonc"),
      `{ "baseVersion": 2, "name": "oc-m5-test", "llm": { "primary": "@cf/a/b" } }\n`,
    );
    r = await run("ai-gateway", ["setup", "--gateway", "openclaw-cf", "--dir", dir], {
      fetch: cfFetch(),
      run: fakeRunner().run,
    });
    expect(r.code).toBe(0);
    expect(vers[vers.length - 1]?.doc.agents.defaults.model.primary).toBe("cfgw/@cf/c/d");
  });

  it("ai-gateway setup, the gate answers 400 → exit 1 and the fix", async () => {
    gate = { status: 400, body: { error: { message: "gateway not found: oc-host" } } };
    const r = await run("ai-gateway", ["setup", "--dir", dir], { fetch: cfFetch() });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/gateway oc-host does not exist: rerun with --gateway default/);
  });
});
