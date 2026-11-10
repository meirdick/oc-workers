// ownerPanel() (ctl/panel.ts): rows, colours, fix lines, one-minute probe cache, asleep = cached and never a wake,
// no secret value in the JSON. World = Control DO on node:sqlite with a fake clock and fake probes.
import { describe, expect, it } from "vitest";
import { alert } from "../../src/ctl/alerts";
import { configPropose } from "../../src/ctl/config";
import type { PanelDeps } from "../../src/ctl/panel";
import { PROBE_TTL_MS } from "../../src/ctl/panel";
import { handleOps } from "../../src/ops";
import { tg, world } from "./world";

const ORIGIN = "https://oc.example";
const BOT = "123456:AAbbccddeeffgghhiijjkkllmmnnoopp_qq";
const ALERT_URL = "https://ntfy.example/topic-9f3a";

const doc = (over: Record<string, unknown> = {}) => ({
  agents: { defaults: { model: { primary: "cfgw/@cf/deepseek-ai/deepseek-v4.1-flash-1017" } } },
  models: { providers: { cfgw: { baseUrl: "http://15.0.0.3/ai/v1", models: [] } } },
  channels: { telegram: { enabled: true, webhookUrl: `${ORIGIN}/telegram-webhook`, allowFrom: ["999"] } },
  tools: {
    web: { fetch: { provider: "firecrawl" }, search: { provider: "cloudflare-web-search" } },
    media: { models: [{}] },
  },
  browser: { enabled: true },
  tts: { providers: { openai: {} } },
  ...over,
});

interface Fakes {
  hops: string[];
  hop: { status: number; ms: number; error?: string };
  tg: { ok: boolean; result: Record<string, unknown> };
  tgCalls: string[];
}

async function setup(o: { state?: string; doc?: unknown; bot?: boolean } = {}) {
  const w = world({ settings: { publicOrigin: ORIGIN }, alertUrl: ALERT_URL });
  w.install();
  w.rt(1).state = (o.state ?? "running") as never;
  w.ctx.secrets.botToken = o.bot === false ? undefined : BOT;
  // The sink took an alert once (Z2.9: a sink that never did is a FAIL).
  w.ctx.db.setMeta("alertSinkOkAt", 1);
  const f: Fakes = {
    hops: [],
    hop: { status: 200, ms: 412 },
    tg: { ok: true, result: { url: `${ORIGIN}/telegram-webhook`, pending_update_count: 2 } },
    tgCalls: [],
  };
  w.ctx.fetch = (async (u: string) => {
    f.tgCalls.push(String(u));
    return Response.json(f.tg);
  }) as never;
  await configPropose(w.ctx, { source: "owner", doc: doc() });
  // Written straight to the table: configPropose refuses a webhook URL off this origin.
  if (o.doc) w.ctx.db.run("UPDATE config SET doc = ?", JSON.stringify(o.doc));
  const deps: Omit<PanelDeps, "status" | "view" | "caps" | "sink"> = {
    hop: async (m) => {
      f.hops.push(m);
      return f.hop;
    },
    sandbox: async () => ({ state: "asleep" }),
    env: { access: null, gateway: "default" },
  };
  w.core.panelProbes = deps;
  const panel = (x: { fresh?: boolean } = {}) => w.core.ownerPanel({ origin: ORIGIN, ...x });
  return { w, f, panel };
}

const by = (rows: { name: string }[], n: string) => rows.find((r) => r.name === n) as any;

describe("ownerPanel rows", () => {
  it("connected: model, search, browser, media, sandbox, channel, access, sink, install; checks match the doctor names", async () => {
    const { panel } = await setup();
    const p = await panel();
    expect(by(p.connected, "model")).toMatchObject({
      result: "PASS",
      detail: "cfgw, @cf/deepseek-ai/deepseek-v4.1-flash-1017, gateway default, last hop 412 ms",
    });
    expect(by(p.connected, "web search").detail).toMatch(/^on; 0 of 200 today$/);
    expect(by(p.connected, "browser and web fetch").detail).toBe("on; 0s of 3600s today; 0 of 2000 today");
    expect(by(p.connected, "media")).toMatchObject({ result: "WARN" }); // image off in this doc
    expect(by(p.connected, "media").detail).toBe("speech on, transcription on, image off");
    expect(by(p.connected, "media").fix).toMatch(/ochost init/);
    expect(by(p.connected, "sandbox")).toMatchObject({ result: "PASS", detail: "off (opt-in)" });
    expect(by(p.connected, "channel telegram")).toMatchObject({ result: "PASS" });
    expect(by(p.connected, "channel telegram").detail).toBe(
      "transport webhook, webhook set, last error none, blocks sleep no",
    );
    expect(by(p.connected, "access").detail).toBe("off");
    expect(by(p.connected, "alerts sink")).toMatchObject({
      result: "WARN",
      fix: expect.stringMatching(/alerts test/),
    });
    expect(by(p.connected, "install").detail).toMatch(/CLI unknown, image sha256:img1.*no upgrade check yet/);
    expect(p.checks.map((c) => c.name)).toEqual([
      "reach",
      "state",
      "webhook",
      "webhook (Telegram)",
      "model hop",
      "replica lag",
      "archive age",
      "alerts",
      "dead-man",
      "file storage",
    ]);
    expect(by(p.checks, "file storage")).toMatchObject({
      result: "WARN",
      detail: "off (no storage location r2)",
    });
    expect(p.files).toBeNull();
    expect(by(p.checks, "webhook (Telegram)").detail).toBe("set, 2 pending");
    expect(p.ok).toBe(true);
    expect(p.warns).toBeGreaterThan(0);
  });

  it("channel telegram: accepted messages without a reply after 5 min make the row WARN with the count", async () => {
    const { w, panel } = await setup();
    for (const k of [1, 2]) {
      await w.api.inboxPut({ body: tg(k, 700 + k, 700 + k), headers: { host: "oc.example.workers.dev" } });
      w.ctx.db.run(
        "UPDATE inbox SET state = 'accepted', accepted_at = ? WHERE platform_key = ?",
        w.clock.t,
        String(k),
      );
    }
    w.advance(6 * 60_000);
    const row = by((await panel({ fresh: true })).connected, "channel telegram");
    expect(row.result).toBe("WARN");
    expect(row.detail).toMatch(/blocks sleep no, 2 messages without a reply$/);
    expect(row.fix).toMatch(/gateway runs but did not answer/);
    // An asleep install is not judged: it has nothing to reply with.
    w.rt(1).state = "asleep" as never;
    const asleep = by((await panel({ fresh: true })).connected, "channel telegram");
    expect(asleep.detail).not.toMatch(/without a reply/);
  });

  it("file storage on: prefix and bytes for the Setup row; at 85 % WARN with caps set storage", async () => {
    const { w, panel } = await setup({
      doc: doc({ storage: { locations: { r2: { provider: "ochost-r2", settings: { prefix: "f/oc-x" } } } } }),
    });
    // 4.25 GB of the default 5 GB, counted by the ledger.
    (w.core as any).ledger.run("INSERT INTO files_obj (key, bytes, at) VALUES ('f/oc-x/a', 4250000000, 1)");
    const p = await panel({ fresh: true });
    expect(p.files).toEqual({ prefix: "f/oc-x/", used: 4.25e9, limit: 5e9 });
    expect(by(p.connected, "file storage")).toMatchObject({
      result: "WARN",
      fix: "ochost caps set storage 10",
    });
  });

  it("colours and fix lines: wrong webhook FAIL, hop 400 gateway FAIL, 429 WARN, high alert FAIL, replica WARN, old archive FAIL", async () => {
    const { w, f, panel } = await setup({
      doc: doc({ channels: { telegram: { enabled: true, webhookUrl: "https://evil.example/hook" } } }),
    });
    f.hop = { status: 400, ms: 90, error: "gateway not found: x" };
    f.tg = {
      ok: true,
      result: { url: "https://evil.example/hook", pending_update_count: 0, last_error_message: "boom" },
    };
    w.ctx.db.setMeta("seeding:1", 1);
    alert(w.ctx, "gate-down", "high", "gate unreachable");
    w.ctx.db.run(
      "INSERT INTO archives (id, key, kind, state, created_at, completed_at) VALUES ('a1', 'k', 'full', 'complete', ?, ?)",
      w.clock.t - 13 * 3_600_000,
      w.clock.t - 13 * 3_600_000,
    );
    const p = await panel();
    expect(by(p.checks, "webhook")).toMatchObject({
      result: "FAIL",
      fix: expect.stringMatching(/channels add telegram/),
    });
    expect(by(p.checks, "webhook (Telegram)")).toMatchObject({ result: "FAIL" });
    expect(by(p.checks, "model hop")).toMatchObject({
      result: "FAIL",
      fix: "the gateway does not exist: ochost ai-gateway setup --gateway default",
    });
    expect(by(p.checks, "alerts")).toMatchObject({ result: "FAIL", fix: "ochost alerts list; ochost logs" });
    expect(by(p.checks, "archive age")).toMatchObject({ result: "FAIL" });
    expect(by(p.checks, "replica lag")).toMatchObject({ result: "WARN" });
    expect(p.ok).toBe(false);
    expect(p.fails).toBeGreaterThanOrEqual(4);
    expect(by(p.connected, "channel telegram")).toMatchObject({ result: "FAIL" });
    expect(by(p.connected, "model").result).toBe("FAIL");
    expect(by(p.backups.rows, "archive").result).toBe("FAIL");
  });

  it("alerts: every open alert with severity, time, detail and fix; the Doctor tail shows while doctor-failed is open", async () => {
    const { w, panel } = await setup();
    alert(
      w.ctx,
      "doctor-failed",
      "high",
      "Doctor failed 3x on sha256:abc; booting without Doctor: line1\nline2 EACCES",
    );
    alert(w.ctx, "sbx-lost", "warn", "sandbox stopped before a backup");
    alert(w.ctx, "old-one", "info", "x");
    w.ctx.db.run("UPDATE alerts SET open = 0 WHERE class = 'old-one'");
    const p = await panel();
    expect(p.alerts.open.map((a) => [a.class, a.severity, a.result]).sort()).toEqual([
      ["doctor-failed", "high", "FAIL"],
      ["sbx-lost", "warn", "WARN"],
    ]);
    const d = p.alerts.open.find((a) => a.class === "doctor-failed");
    expect(d).toMatchObject({ at: w.clock.t, fix: "ochost logs --source rt; ochost restart" });
    expect(p.alerts.doctorTail).toBe("line1\nline2 EACCES");
    w.ctx.db.run("UPDATE alerts SET open = 0 WHERE class = 'doctor-failed'");
    expect((await panel()).alerts.doctorTail).toBeNull();
  });

  it("budgets: bars with used, limit, colour by percent; Raise target is double the limit (default when 0)", async () => {
    const { w, panel } = await setup();
    w.ledger.capsSet({ websearch: 100, browser: 0 });
    w.ledger.capAdd("websearch", 85);
    w.ledger.capAdd("requests", 2000);
    const p = await panel();
    const b = (v: string) => p.budgets.find((x) => x.verb === v) as any;
    expect(b("websearch")).toMatchObject({ used: 85, limit: 100, next: 200 });
    expect(b("websearch").row).toMatchObject({ result: "WARN", fix: "ochost caps set websearch 200" });
    expect(b("requests").row).toMatchObject({ result: "FAIL", fix: "ochost caps set requests 4000" });
    expect(b("browser")).toMatchObject({ limit: 0, next: 3600 });
    expect(b("neurons").row.result).toBe("PASS");
    expect(by(p.connected, "browser and web fetch").result).toBe("FAIL");
  });

  it("backups, channels and wake: archive age and verified, snapshots, replica, maintenance, wake list, pairing, held inbox", async () => {
    const { w, panel } = await setup();
    w.ctx.db.run(
      "INSERT INTO archives (id, key, kind, state, created_at, completed_at) VALUES ('a1', 'k', 'full', 'complete', ?, ?)",
      w.clock.t - 3_600_000,
      w.clock.t - 3_600_000,
    );
    w.ctx.db.run("UPDATE archives SET verified_at = ? WHERE id = 'a1'", w.clock.t - 3_000_000);
    w.api.inboxPut({ body: tg(5, 777, 777, "hello"), headers: { host: "oc.example" } });
    const p = await panel();
    expect(by(p.backups.rows, "archive").detail).toBe("newest 60m old; verified");
    expect(by(p.backups.rows, "snapshots").detail).toMatch(/^\d+ snapshots, chain \d+$/);
    expect(by(p.backups.rows, "replica lag").result).toBe("PASS");
    expect(by(p.backups.rows, "next maintenance").name).toBe("next maintenance");
    expect(p.channels.wake).toEqual({ userIds: [], groupChatIds: [] });
    expect(p.channels.pairing).toMatchObject([{ id: "777", count: 1 }]);
    expect(p.channels.pairing[0]?.code).toMatch(/^[a-z0-9]{6}$/);
    expect(JSON.stringify(p.channels)).not.toContain("hello"); // message text is not shown
    expect(p.channels.heldInbox).toBe(0);
  });

  it("cost and events: wakes, sleeps, restarts and archives newest first with durations; closed alerts apart", async () => {
    const { w, panel } = await setup();
    const t = w.clock.t;
    w.ctx.db.run("DELETE FROM wake_log");
    w.ctx.db.run("DELETE FROM archives");
    w.ctx.db.run(
      "INSERT INTO wake_log (gen, reason, wake_at, slept_at, awake_s, cpu_s, sleep_ms) VALUES (1, 'wake:cron', ?, ?, 3600, 30, 9000)",
      t - 3 * 3_600_000,
      t - 2 * 3_600_000,
    );
    w.ctx.db.run(
      "INSERT INTO wake_log (gen, reason, wake_at, startupz_ms) VALUES (2, 'ladder', ?, 52000)",
      t - 1_200_000,
    );
    w.ctx.db.run(
      "INSERT INTO wake_log (gen, reason, wake_at, startupz_ms) VALUES (3, 'webhook', ?, 41000)",
      t - 600_000,
    );
    w.ctx.db.run(
      "INSERT INTO archives (id, key, kind, state, size, created_at, completed_at) VALUES ('a1', 'k', 'owner', 'complete', 12500000, ?, ?)",
      t - 5_400_000,
      t - 5_280_000,
    );
    alert(w.ctx, "old-one", "info", "x");
    alert(w.ctx, "still-open", "warn", "y");
    w.ctx.db.run("UPDATE alerts SET open = 0, last_sent_at = ? WHERE class = 'old-one'", t - 1_800_000);
    const p = await panel();
    expect(p.events).toEqual([
      { at: t - 600_000, kind: "wake", text: "Woke on webhook", ms: 41000 },
      { at: t - 1_200_000, kind: "restart", text: "Restarted (ladder)", ms: 52000 },
      { at: t - 5_400_000, kind: "archive", text: "Archive (owner), complete, 13 MB", ms: 120_000 },
      { at: t - 2 * 3_600_000, kind: "sleep", text: "Slept after 60m awake", ms: 9000 },
      { at: t - 3 * 3_600_000, kind: "wake", text: "Woke on cron", ms: null },
    ]);
    expect(p.alerts.closed.map((a) => [a.class, a.at])).toEqual([["old-one", t - 1_800_000]]);
    expect(p.alerts.open.map((a) => a.class)).toContain("still-open");
    expect(p.cost.wakes24).toBe(3);
    expect(p.cost.monthUsd).toBeGreaterThan(0);
    expect(p.cost.monthUsd).toBeLessThan(p.cost.alwaysOnMonthUsd);
    expect(p.cost.holding).toBe(false);
  });
});

describe("ownerPanel probes", () => {
  it("hop and webhook info run at most once a minute", async () => {
    const { w, f, panel } = await setup();
    await panel();
    await panel();
    w.advance(PROBE_TTL_MS - 1);
    await panel();
    expect([f.hops.length, f.tgCalls.length]).toEqual([1, 1]);
    w.advance(2);
    const p = await panel();
    expect([f.hops.length, f.tgCalls.length]).toEqual([2, 2]);
    expect(p.probes.hopAt).toBe(w.clock.t);
  });

  it("asleep: cached values with a note, no probe, no wake; no cache → 'not checked yet'", async () => {
    const { w, f, panel } = await setup();
    await panel(); // awake: fills the cache
    w.rt(1).state = "asleep";
    w.advance(10 * 60_000);
    const p = await panel();
    expect(f.hops.length).toBe(1);
    expect(f.tgCalls.length).toBe(1);
    expect(by(p.checks, "model hop").detail).toMatch(/200 in 412 ms .* \(cached 10m ago, install asleep\)$/);
    expect(by(p.checks, "webhook (Telegram)").detail).toMatch(/cached 10m ago, install asleep/);
    expect(p.probes.asleep).toBe(true);
    expect(w.rt(1).wakes).toEqual([]);
    const cold = await setup({ state: "asleep" });
    const c = await cold.panel();
    expect(by(c.checks, "model hop")).toMatchObject({ result: "WARN", detail: "not checked yet" });
    expect(cold.f.hops).toEqual([]);
    expect(cold.w.rt(1).wakes).toEqual([]);
    // the owner asked (ochost doctor): probe now, still no wake
    const fresh = await cold.panel({ fresh: true });
    expect(by(fresh.checks, "model hop").result).toBe("PASS");
    expect(cold.w.rt(1).wakes).toEqual([]);
  });

  it("no secret value anywhere in the JSON: bot token, alert sink URL and token, webhook secret", async () => {
    const { f, panel } = await setup();
    f.tg = {
      ok: true,
      result: {
        url: `${ORIGIN}/_ochost/hook/telegram/SEGMENT-SECRET-123`,
        pending_update_count: 0,
        last_error_message: `Wrong response from ${ORIGIN}/_ochost/hook/telegram/SEGMENT-SECRET-123`,
      },
    };
    const text = JSON.stringify(await panel());
    for (const s of [BOT, ALERT_URL, "topic-9f3a", "wh-secret-1", "SEGMENT-SECRET-123", '"tk"'])
      expect(text).not.toContain(s);
  });

  it("no AI binding: model hop FAIL with the deploy fix; no bot token: no Telegram live row", async () => {
    const { w, panel } = await setup({ bot: false });
    w.core.panelProbes = undefined;
    const p = await panel();
    expect(by(p.checks, "model hop")).toMatchObject({
      result: "FAIL",
      fix: "ochost deploy updates the Worker",
    });
    expect(by(p.checks, "webhook (Telegram)")).toBeUndefined();
  });
});

describe("GET /ops/doctor", () => {
  const ENV = {
    CONTROL_TOKEN: "owner-tok",
    CI_TOKEN: "ci-tok",
    OC_TEST: "0",
    OC_SETTINGS: JSON.stringify({ publicOrigin: ORIGIN }),
  };
  const call = (
    w: Awaited<ReturnType<typeof setup>>["w"],
    method: string,
    path: string,
    tok: string | null,
    body?: unknown,
  ) =>
    handleOps(
      new Request(`${ORIGIN}/${path}`, {
        method,
        headers: tok ? { authorization: `Bearer ${tok}` } : {},
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      {
        ...ENV,
        OC_INST: "t1",
        CONTROL: { getByName: () => w.api },
        RUNTIME: { getByName: () => w.rt(1) },
      } as never,
      async () => 1,
    );

  it("owner bearer gets the ownerPanel JSON; ci and no bearer get 404", async () => {
    const { w, panel } = await setup();
    const r = await call(w, "GET", "ops/doctor", "owner-tok");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(JSON.parse(JSON.stringify(await panel())));
    expect((await call(w, "GET", "ops/doctor", "ci-tok")).status).toBe(404);
    expect((await call(w, "GET", "ops/doctor", null)).status).toBe(404);
    expect((await call(w, "POST", "ops/doctor", "owner-tok", {})).status).toBe(404);
  });

  it("the webhook is compared with this Worker's own origin, not one the caller sends", async () => {
    const { w } = await setup();
    const r = await call(w, "GET", "ops/doctor?origin=https://evil.example", "owner-tok");
    const j: any = await r.json();
    expect(by(j.checks, "webhook").result).toBe("PASS");
  });

  it("fresh=1 probes while asleep (the owner asked); upgrade-check is shown on the install row", async () => {
    const { w, f } = await setup({ state: "asleep" });
    expect(
      ((await (await call(w, "GET", "ops/doctor", "owner-tok")).json()) as any).checks.find(
        (c: any) => c.name === "model hop",
      ).detail,
    ).toBe("not checked yet");
    expect(f.hops).toEqual([]);
    const j: any = await (await call(w, "GET", "ops/doctor?fresh=1", "owner-tok")).json();
    expect(by(j.checks, "model hop").result).toBe("PASS");
    expect((await call(w, "POST", "ops/upgrade-check", "ci-tok", {})).status).toBe(404);
    const up = await call(w, "POST", "ops/upgrade-check", "owner-tok", {
      cliVersion: "0.9.1",
      pinned: { version: "2026.10.9", digest: "sha256:abc" },
      target: { version: "2026.11.2" },
      delta: "newer",
    });
    expect(up.status).toBe(200);
    const k: any = await (await call(w, "GET", "ops/doctor", "owner-tok")).json();
    expect(by(k.connected, "install")).toMatchObject({
      result: "WARN",
      fix: "ochost upgrade check, then ochost upgrade run",
    });
    expect(by(k.connected, "install").detail).toMatch(
      /CLI 0\.9\.1, image sha256:img1, OpenClaw 2026\.10\.9, upgrade available \(2026\.11\.2; checked 0s ago\)/,
    );
  });

  it("the CLI's render version against the document's: outdated warns with the fix; equal passes", async () => {
    const { w } = await setup();
    const doc = async () => (await (await call(w, "GET", "ops/doctor", "owner-tok")).json()) as any;
    let j = await doc();
    expect(j.render).toEqual({ docVersion: 0, cliVersion: null, outdated: false });
    expect(by(j.connected, "config render").detail).toBe("render 0, CLI version not reported yet");
    expect((await call(w, "POST", "ops/render-check", "ci-tok", { renderVersion: 1 })).status).toBe(404);
    expect((await call(w, "POST", "ops/render-check", "owner-tok", { renderVersion: "1" })).status).toBe(400);
    expect((await call(w, "POST", "ops/render-check", "owner-tok", { renderVersion: 1 })).status).toBe(200);
    j = await doc();
    expect(j.render).toEqual({ docVersion: 0, cliVersion: 1, outdated: true });
    expect(by(j.connected, "config render")).toMatchObject({
      result: "WARN",
      fix: "ochost config render, then ochost restart",
    });
    expect(by(j.connected, "config render").detail).toBe("outdated: config has render 0, CLI 1");
    w.ctx.db.run("UPDATE config SET doc = json_set(doc, '$.ochost', json('{\"renderVersion\":1}'))");
    j = await doc();
    expect(j.render).toEqual({ docVersion: 1, cliVersion: 1, outdated: false });
    expect(by(j.connected, "config render").result).toBe("PASS");
    // A newer version the container proposed (Doctor rewrote the file) has no ochost block: the render version
    // comes from the newest version that carries it, so the row stays PASS.
    w.ctx.db.run(
      "INSERT INTO config (ver, status, source, doc, created_at) SELECT MAX(ver) + 1, 'candidate', 'doctor', json_remove(doc, '$.ochost'), 1 FROM config",
    );
    j = await doc();
    expect(j.render).toEqual({ docVersion: 1, cliVersion: 1, outdated: false });
    expect(by(j.connected, "config render").result).toBe("PASS");
  });
});

describe("panel helpers", () => {
  it("raiseTo doubles, a zero limit takes the default, never past CAP_MAX", async () => {
    const { raiseTo, alertFix } = await import("../../src/ctl/panel-checks");
    const { CAP_MAX } = await import("../../src/gates/caps");
    expect(raiseTo(100, 200, CAP_MAX)).toBe(200);
    expect(raiseTo(0, 3600, CAP_MAX)).toBe(3600);
    expect(raiseTo(6e8, 1, CAP_MAX)).toBe(CAP_MAX);
    expect(raiseTo(CAP_MAX, 1, CAP_MAX)).toBe(CAP_MAX);
    expect(alertFix("restore-blocked:schema")).toBe("ochost backup list, then ochost backup restore <id>");
  });
});
