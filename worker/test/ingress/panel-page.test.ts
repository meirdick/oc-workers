// The owner console at `/` (ui/pages.ts panelPage: state card and six tabs) and its five POST buttons (/_ochost/panel/*, ingress/panel-actions.ts):
// anonymous visitors get the login form only; every POST needs the owner cookie and the same origin; one test per button.
import { beforeEach, describe, expect, it } from "vitest";
import type { Panel } from "../../src/ctl/panel";
import worker, { resetPointerCache } from "../../src/index";
import { resetSessionCache } from "../../src/ingress/session";
import { DOCS_URL } from "../../src/ui/pages";
import { fakeAuthNs } from "./fake-auth";

const ORIGIN = "https://oc.example.workers.dev";
const NOW = Date.now();
const SECRET = "SECRET-VALUE-9f3a";

const PANEL: Panel = {
  inst: "oc-demo",
  render: { docVersion: 1, cliVersion: 1, outdated: false },
  now: NOW,
  view: {
    inst: "oc-demo",
    state: "running",
    stateAt: NOW - 12 * 60_000,
    lastActivityAt: NOW - 4 * 60_000,
    nextWakeAt: null,
    snapshots: 7,
    alerts: [],
    now: NOW,
  },
  probes: { asleep: false, hopAt: NOW, webhookAt: NOW },
  ok: false,
  fails: 1,
  warns: 2,
  checks: [{ name: "reach", result: "PASS", detail: "Control DO answered" }],
  connected: [
    { name: "model", result: "PASS", detail: "cfgw, @cf/x/y, gateway default, last hop 412 ms" },
    {
      name: "web search",
      result: "WARN",
      detail: "on; 85 of 100 today",
      fix: "ochost caps set websearch 200",
    },
    {
      name: "file storage",
      result: "PASS",
      detail: "on, location r2, put+get+delete 38 ms; 1.2 GB of 5.0 GB used",
    },
    { name: "alerts sink", result: "FAIL", detail: "not configured", fix: "ochost alerts setup" },
  ],
  alerts: {
    open: [
      {
        class: "doctor-failed",
        severity: "high",
        result: "FAIL",
        at: NOW - 3_600_000,
        count: 2,
        detail: "<script>alert(1)</script> Doctor failed",
        fix: "ochost logs --source rt; ochost restart",
      },
    ],
    closed: [
      {
        class: "sleep-thrash",
        severity: "warn",
        result: "WARN",
        at: NOW - 20 * 3_600_000,
        count: 1,
        detail: "cost guard <i>held</i>",
        fix: "ochost sleep status",
      },
    ],
    doctorTail: "EACCES: permission denied",
  },
  budgets: [
    {
      verb: "websearch",
      used: 85,
      limit: 100,
      pct: 0.85,
      unit: "",
      next: 200,
      row: {
        name: "websearch",
        result: "WARN",
        detail: "85 of 100 (85%)",
        fix: "ochost caps set websearch 200",
      },
    },
  ],
  backups: {
    rows: [
      { name: "archive", result: "PASS", detail: "newest 60m old; verified" },
      { name: "snapshots", result: "PASS", detail: "7 snapshots, chain 3" },
    ],
    nextMaintenanceAt: NOW + 3_600_000,
  },
  files: { prefix: "f/oc-demo/", used: 1.2e9, limit: 5e9 },
  channels: {
    wake: { userIds: ["999"], groupChatIds: [] },
    pairing: [{ code: "abc234", id: "777", name: "Zed <b>", count: 2, held: 1 }],
    heldInbox: 1,
  },
  cost: {
    spend24Usd: 0.0412,
    monthUsd: 1.236,
    alwaysOnMonthUsd: 31.5,
    savedPct: 96,
    wakes24: 3,
    holding: true,
  },
  chat: {
    days: [0, 2, 5, 1, 0, 3, 2].map((received, i) => ({
      day: new Date(NOW - (6 - i) * 86_400_000).toISOString().slice(0, 10),
      received,
      replied: i === 2 ? 4 : received,
    })),
    lastInAt: NOW - 7_200_000,
    lastInRoute: "/telegram-webhook",
    lastOutAt: NOW - 7_100_000,
  },
  events: [
    { at: NOW - 12 * 60_000, kind: "wake", text: "Woke on webhook", ms: 41_000 },
    { at: NOW - 3_600_000, kind: "archive", text: "Archive (owner), complete, 12 MB", ms: 120_000 },
    { at: NOW - 2 * 3_600_000, kind: "sleep", text: "Slept after 20m awake", ms: 9_000 },
    { at: NOW - 5 * 3_600_000, kind: "restart", text: "Restarted (ladder)", ms: null },
  ],
};

interface Call {
  m: string;
  a: any[];
}

function mkEnv(over: { panel?: unknown; ops?: (r: any) => unknown } = {}) {
  const calls: Call[] = [];
  const ns = (impl: Record<string, (...a: any[]) => unknown>) => ({
    getByName: () =>
      new Proxy(
        {},
        {
          get: (_t, m: string) =>
            m === "then"
              ? undefined
              : async (...a: any[]) => {
                  calls.push({ m, a });
                  return impl[m] ? impl[m]!(...a) : { ok: true };
                },
        },
      ),
  });
  const e: Record<string, unknown> = {
    OC_INST: "t1",
    OC_TEST: "0",
    CONTROL_TOKEN: "owner-token",
    CONTROL: ns({
      status: () => ({ epoch: { n: 2 } }),
      ownerView: () => PANEL.view,
      ownerPanel: () => ("panel" in over ? over.panel : PANEL),
      ops: (r) => (over.ops ? over.ops(r) : { status: 200, body: { ok: true } }),
    }),
    RUNTIME: ns({ status: () => ({ state: "running" }) }),
  };
  e.AUTH = fakeAuthNs(() => e).ns;
  return { e: e as never, calls };
}

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as never;
const go = (e: never, path: string, init: RequestInit & { cookie?: string } = {}) => {
  const h = new Headers(init.headers);
  if (init.cookie) h.set("cookie", init.cookie);
  h.set("cf-connecting-ip", "198.51.100.9");
  return worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers: h }), e, ctx);
};
const nav = { accept: "text/html" };
async function login(e: never) {
  const r = await go(e, "/_ochost/login", {
    method: "POST",
    body: "token=owner-token",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
  });
  return (r.headers.get("set-cookie") ?? "").split(";")[0] as string;
}
beforeEach(() => {
  resetSessionCache();
  resetPointerCache();
});

const ACTS = ["ack", "raise", "archive", "drill", "approve"];
const opsCalls = (calls: Call[]) => calls.filter((c) => c.m === "ops").map((c) => c.a[0]);

describe("owner panel page", () => {
  it("anonymous: the login form and nothing else; no panel call; every button and /ops/doctor answer 404", async () => {
    const { e, calls } = mkEnv();
    const html = await (await go(e, "/", { headers: nav })).text();
    expect(html).toContain('action="/_ochost/login"');
    expect(html).not.toMatch(
      /oc-demo|Connected|Budgets|Backups|Acknowledge|Approve|Doctor|Actions|Projected month/,
    );
    for (const a of ACTS) {
      const r = await go(e, `/_ochost/panel/${a}`, {
        method: "POST",
        headers: { origin: ORIGIN },
        body: "class=x&verb=websearch&code=abc234",
      });
      expect(r.status).toBe(404);
    }
    expect((await go(e, "/ops/doctor")).status).toBe(404);
    expect(calls.filter((c) => c.m === "ops" || c.m === "ownerPanel")).toEqual([]);
  });

  it("owner: state card, then six tabs as links; each tab is its own page; one script, the refresh to the same tab", async () => {
    const { e } = mkEnv();
    const c = await login(e);
    const get = async (q: string) => {
      const r = await go(e, `/${q}`, { cookie: c, headers: nav });
      const nonce = /'nonce-([0-9a-f]{32})'/.exec(r.headers.get("content-security-policy") ?? "")?.[1];
      return { html: await r.text(), nonce };
    };
    const tabs: Record<string, string> = {};
    for (const t of ["overview", "log", "setup"]) {
      const { html, nonce } = await get(`?tab=${t}`);
      tabs[t] = html;
      // The state card on every tab: one state button, elapsed time, month cost.
      for (const s of [
        'href="/chat">Open Control UI',
        '<form method="post" action="/_ochost/power"><button type="submit" name="act" value="sleep">Sleep now</button></form>',
        'action="/_ochost/logout"',
        'Running</p><p class="since">for 12 min</p>',
        "<dt>Projected month</dt><dd>$1.24<small>always-on $31.50</small>",
      ])
        expect(html).toContain(s);
      // The tab row: plain links, the current one marked; counts on Setup and Alerts.
      expect(html).toContain('<nav class="tabs" aria-label="Sections">');
      expect([...html.matchAll(/aria-current="page">([A-Za-z ]+)/g)].map((m) => m[1])[0]).toBe(
        { overview: "Overview", log: "Alerts and log", setup: "Setup" }[t],
      );
      expect(html).toMatch(
        /<a href="\/\?tab=log"( aria-current="page")?>Alerts and log<span class="n hot">1<span class="vh"> open<\/span>/,
      );
      // CSP: one script, with the nonce: the refresh, back to this tab.
      expect([...html.matchAll(/<script/g)]).toHaveLength(1);
      expect(html).toContain(
        `<script nonce="${nonce}">setTimeout(function(){location.replace(${JSON.stringify(t === "overview" ? "/" : `/?tab=${t}`)})},30000);</script>`,
      );
      expect(html).not.toMatch(/ style=/);
      expect(html.replace(DOCS_URL, "")).not.toMatch(/(src|href)=["']https?:/);
      expect(html).toContain(
        `<a class="ghost btn" href="${DOCS_URL}" rel="noopener">Docs</a><a class="btn" href="/chat">`,
      );
      expect(html).not.toContain(SECRET);
      expect(html).not.toContain("<script>alert(1)");
      expect(html).not.toContain("<i>held</i>");
      expect(html).not.toContain("Zed <b>");
    }
    // No tab or an unknown one: Overview.
    expect((await get("")).html).toContain('<a href="/" aria-current="page">Overview</a>');
    expect((await get("?tab=nope")).html).toContain('<a href="/" aria-current="page">Overview</a>');

    // Buttons (panel forms) only in Setup and Alerts.
    const forms = (h: string) => [...h.matchAll(/action="\/_ochost\/panel\/(\w+)"/g)].map((m) => m[1]);
    expect(forms(tabs.setup ?? "")).toEqual(["approve", "raise", "archive", "drill"]);
    expect(forms(tabs.log ?? "")).toEqual(["ack"]);
    expect(forms(tabs.overview ?? "")).toEqual([]);
    // Old tab names still land on their content.
    for (const [o, n] of [
      ["health", "Overview"],
      ["cost", "Overview"],
      ["activity", "Alerts and log"],
      ["alerts", "Alerts and log"],
    ])
      expect((await get(`?tab=${o}`)).html).toContain(`aria-current="page">${n}`);
    // One item, one tab.
    const only = (needle: string, tab: string) => {
      for (const [t, h] of Object.entries(tabs)) expect([t, h.includes(needle)]).toEqual([t, t === tab]);
    };
    only('aria-label="Filter by kind"', "log");
    only("sleep-thrash", "log");
    only("held inbox", "overview");
    only("<code>ochost alerts setup</code>", "setup");
    only("<pre>EACCES: permission denied</pre>", "log");
    only("Projected month</span>", "overview");

    // Overview: the alerts box, then cost and health; no log, no action, no fix text from the state card.
    const ov = tabs.overview ?? "";
    expect(ov).toContain('<p class="sw2">1 open alert, 1 high</p>');
    expect(ov).toContain('<a class="go" href="/?tab=log">Open alerts');
    expect(ov).not.toContain("Do this:");
    expect(ov).not.toContain("Woke on webhook");

    // Setup: state with a dot, then one button or the command.
    const su = tabs.setup ?? "";
    expect(su).toContain("<code>ochost channels add telegram</code>");
    expect(su).toMatch(
      /<td class="nm">Alert channel<\/td><td class="w"><span class="st"><span class="dot bad"/,
    );
    expect(su).toContain("<code>ochost alerts setup</code>");
    expect(su).toContain("Zed &lt;b&gt; (777), 2 messages, 1 held");
    expect(su).toContain('name="code" value="abc234"');
    expect(su).toContain('name="verb" value="websearch"');
    expect(su).toContain('name="from" value="100"');
    expect(su).toMatch(
      /<td class="nm">File storage<\/td><td class="w"><span class="st"><span class="dot ok"[\s\S]*?On, prefix f\/oc-demo\/, 1\.2 GB of 5\.0 GB used<\/span><\/span><\/td><td class="cm">.*?<code>ochost caps set storage &lt;n&gt;<\/code>/,
    );

    // Overview, health: status as a dot and a word, fix lines; Setup's rows are not repeated. Cost: the strip, the
    // guard (holding: a warning dot and the fix line), the daily budgets as meters (bars as classes).
    expect(ov).toMatch(
      /<td class="nm">web search<\/td><td class="tm"><span class="st"><span class="dot warn" aria-hidden="true"><\/span><span>Warning<\/span>.*Fix: <code>ochost caps set websearch 200<\/code>/,
    );
    expect(ov).not.toContain(">alerts sink<");
    expect(ov).toContain("on, location r2, put+get+delete 38 ms; 1.2 GB of 5.0 GB used");
    expect(ov).toContain('<i class="w17"></i>');
    expect(ov).toContain("Cost guard is holding the install awake");
    expect(ov).toContain("Fix: <code>ochost sleep status</code>");
    expect(ov).toContain('<span class="big">96%</span>');

    // Alerts and log: open with border, badge, fix line, Doctor tail and Acknowledge; the activity table newest
    // first with the kind filter as links; then the closed alerts. Untrusted text escaped.
    const al = tabs.log ?? "";
    expect(al).toContain(
      '<div class="ex hi" id="a-doctor-failed"><div class="exh"><span class="bdg">High</span>',
    );
    expect(al).toContain('<p class="fixl">Do this: <code>ochost logs --source rt; ochost restart</code></p>');
    expect(al).toContain('name="class" value="doctor-failed"');
    expect(al).toContain("&lt;script&gt;alert(1)");
    expect(al.indexOf("doctor-failed")).toBeLessThan(al.indexOf("Woke on webhook"));
    expect(al.indexOf("Woke on webhook")).toBeLessThan(al.indexOf("Archive (owner)"));
    expect(al.indexOf("Archive (owner)")).toBeLessThan(al.indexOf("Slept after 20m"));
    expect(al.indexOf("Slept after 20m")).toBeLessThan(al.indexOf("sleep-thrash"));
    expect(al).toContain("cost guard &lt;i&gt;held&lt;/i&gt;");
    expect(al).toContain('<a href="/?tab=log&kind=archive">Archives <span class="n">1</span></a>');
    const arch = (await get("?tab=log&kind=archive")).html;
    expect(arch).toContain("Archive (owner), complete, 12 MB");
    expect(arch).not.toContain("Woke on webhook");
    expect(arch).toContain('location.replace("/?tab=log&kind=archive")');
  });

  it("owner: ownerPanel unavailable → the plain status page, not an error", async () => {
    const { e } = mkEnv({ panel: { ok: true } });
    const c = await login(e);
    const html = await (await go(e, "/", { cookie: c, headers: nav })).text();
    expect(html).toContain("<h1>oc-demo</h1>");
    expect(html).not.toContain("Budgets");
  });
});

describe("panel buttons: owner cookie, same origin, one /ops action each", () => {
  const post = (
    e: never,
    cookie: string | undefined,
    act: string,
    body: string,
    origin: string | null = ORIGIN,
  ) =>
    go(e, `/_ochost/panel/${act}`, {
      method: "POST",
      cookie,
      body,
      headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
    });

  it("a foreign origin is 403, a GET is 404, an unknown button is 404; no /ops call", async () => {
    const { e, calls } = mkEnv();
    const c = await login(e);
    for (const a of ACTS) expect((await post(e, c, a, "class=x", "https://evil.example")).status).toBe(403);
    expect((await go(e, "/_ochost/panel/ack", { cookie: c })).status).toBe(404);
    expect((await post(e, c, "nuke", "")).status).toBe(404);
    expect(opsCalls(calls)).toEqual([]);
  });

  it("Acknowledge: POST alerts/resolve {class}; a bad class is refused before any call", async () => {
    const { e, calls } = mkEnv();
    const c = await login(e);
    const r = await post(e, c, "ack", "class=doctor-failed");
    expect([r.status, r.headers.get("location")]).toEqual([303, "/?n=acked&tab=log"]);
    expect(opsCalls(calls)).toMatchObject([
      { action: "alerts", method: "POST", sub: ["resolve"], body: { class: "doctor-failed" }, role: "owner" },
    ]);
    const bad = await post(e, c, "ack", "class=a%20b%3Cx");
    expect(bad.headers.get("location")).toMatch(/^\/\?n=panel-failed/);
    expect(opsCalls(calls)).toHaveLength(1);
  });

  it("Raise: reads the limit, doubles it, POST caps {verb: 2x}; a zero limit goes to the default", async () => {
    const lim = { websearch: 100, browser: 0 } as Record<string, number>;
    const { e, calls } = mkEnv({
      ops: (r) =>
        r.method === "GET"
          ? {
              status: 200,
              body: { verbs: Object.fromEntries(Object.entries(lim).map(([k, v]) => [k, { limit: v }])) },
            }
          : { status: 200, body: {} },
    });
    const c = await login(e);
    const r = await post(e, c, "raise", "verb=websearch");
    expect(r.headers.get("location")).toBe("/?n=raised&why=websearch%20is%20now%20200&tab=setup");
    await post(e, c, "raise", "verb=browser");
    const posts = opsCalls(calls).filter((x) => x.method === "POST");
    expect(posts.map((x) => x.body)).toEqual([{ websearch: 200 }, { browser: 3600 }]);
    const bad = await post(e, c, "raise", "verb=everything");
    expect(bad.headers.get("location")).toMatch(/panel-failed/);
    expect(opsCalls(calls).filter((x) => x.method === "POST")).toHaveLength(2);
  });

  it("Raise: a second click (from= no longer the limit) does not double again; never past CAP_MAX", async () => {
    const lim = { websearch: 200, neurons: 6e8, requests: 1e9 } as Record<string, number>;
    const { e, calls } = mkEnv({
      ops: (r) =>
        r.method === "GET"
          ? {
              status: 200,
              body: { verbs: Object.fromEntries(Object.entries(lim).map(([k, v]) => [k, { limit: v }])) },
            }
          : { status: 200, body: {} },
    });
    const c = await login(e);
    const stale = await post(e, c, "raise", "verb=websearch&from=100");
    expect(stale.headers.get("location")).toBe(
      "/?n=panel-failed&why=websearch%20is%20already%20200%3A%20reload&tab=setup",
    );
    expect((await post(e, c, "raise", "verb=neurons&from=600000000")).headers.get("location")).toMatch(
      /^\/\?n=raised/,
    );
    const top = await post(e, c, "raise", "verb=requests&from=1000000000");
    expect(top.headers.get("location")).toMatch(/panel-failed.*highest/);
    expect(
      opsCalls(calls)
        .filter((x) => x.method === "POST")
        .map((x) => x.body),
    ).toEqual([{ neurons: 1e9 }]);
  });

  it("Archive now: POST archive {reason: owner}", async () => {
    const { e, calls } = mkEnv({ ops: () => ({ status: 202, body: { ok: true } }) });
    const r = await post(e, await login(e), "archive", "");
    expect(r.headers.get("location")).toBe("/?n=archive&tab=setup");
    expect(opsCalls(calls)).toMatchObject([
      { action: "archive", method: "POST", sub: [], body: { reason: "owner" } },
    ]);
  });

  it("Restore drill: POST archive/drill; a failed drill shows its reason", async () => {
    const { e, calls } = mkEnv({ ops: () => ({ status: 200, body: { ok: true } }) });
    const c = await login(e);
    expect((await post(e, c, "drill", "")).headers.get("location")).toBe("/?n=drill-ok&tab=setup");
    expect(opsCalls(calls)).toMatchObject([{ action: "archive", method: "POST", sub: ["drill"] }]);
    const f = mkEnv({ ops: () => ({ status: 409, body: { ok: false, error: "no archive" } }) });
    resetSessionCache();
    const r = await post(f.e, await login(f.e), "drill", "");
    expect(r.headers.get("location")).toBe("/?n=drill-failed&why=no%20archive&tab=setup");
  });

  it("Approve: POST pairing/approve {ch: telegram, code}, as ochost pairing approve does; a bad code is refused", async () => {
    const { e, calls } = mkEnv();
    const c = await login(e);
    const r = await post(e, c, "approve", "code=abc234");
    expect(r.headers.get("location")).toBe("/?n=approved&tab=setup");
    expect(opsCalls(calls)).toMatchObject([
      { action: "pairing", method: "POST", sub: ["approve"], body: { ch: "telegram", code: "abc234" } },
    ]);
    const bad = await post(e, c, "approve", "code=..%2F..");
    expect(bad.headers.get("location")).toMatch(/panel-failed/);
    expect(opsCalls(calls)).toHaveLength(1);
  });

  it("a button result shows as a notice on the next page", async () => {
    const { e } = mkEnv();
    const c = await login(e);
    const html = await (await go(e, "/?n=acked&tab=log", { cookie: c, headers: nav })).text();
    expect(html).toContain("Alert acknowledged.");
    expect(html).toContain('aria-current="page">Alerts and log');
  });
});
