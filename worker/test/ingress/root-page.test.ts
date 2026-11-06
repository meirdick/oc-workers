// `/` on both hosts: the owner status page (ui/pages.ts statusPage) for an owner session, the login form and
// nothing else for no session; the one state-driven button (POST /_ochost/power act=wake|sleep|start), and the
// older /_ochost/wake and /_ochost/sleep routes.
// Hosts: workers.dev with Access off, and the custom domain with Access on (valid Access JWT).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { resetPointerCache } from "../../src/index";
import { resetAccessCache } from "../../src/ingress/access";
import { resetSessionCache } from "../../src/ingress/session";
import { CONTROL_UI_PATH, DOCS_URL } from "../../src/ui/pages";
import { fakeAuthNs } from "./fake-auth";

const TEAM = "acme.cloudflareaccess.com";
const AUD = "aud-root-1";
const DOMAIN = "oc.example.com";
const DEV = "https://oc.example.workers.dev";
const NOW = Date.now();

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
let jwt = "";
let jwk: JsonWebKey & { kid?: string };

beforeEach(async () => {
  resetSessionCache();
  resetPointerCache();
  resetAccessCache();
  const kp = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey), kid: "k1" };
  const h = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
  const p = enc({ iss: `https://${TEAM}`, aud: [AUD], email: "me@example.com", exp: NOW / 1000 + 600 });
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    kp.privateKey,
    new TextEncoder().encode(`${h}.${p}`),
  );
  jwt = `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
  vi.stubGlobal("fetch", async (u: string) =>
    u === `https://${TEAM}/cdn-cgi/access/certs`
      ? Response.json({ keys: [jwk] })
      : new Response("no", { status: 404 }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const VIEW = (state: string, x: { ladderClass?: string; desired?: string } = {}) => ({
  ...x,
  inst: "oc-demo",
  state,
  stateAt: NOW - 12 * 60_000,
  lastActivityAt: NOW - 4 * 60_000,
  nextWakeAt: NOW + 2 * 3600_000,
  snapshots: 7,
  alerts: [
    { class: "doctor-failed", severity: "high", at: NOW - 3600_000, open: true },
    { class: "upgrade-regression", severity: "high", at: NOW - 7200_000, open: false },
  ],
  now: NOW,
});

function mkEnv(o: { access: boolean; state?: string; sleepOk?: boolean; ladderClass?: string }) {
  const calls: { cls: string; m: string; a: unknown[] }[] = [];
  const st = { state: o.state ?? "running" };
  const ns = (cls: string, impl: Record<string, (...a: unknown[]) => unknown>) => ({
    getByName: () =>
      new Proxy(
        {},
        {
          get: (_t, m: string) =>
            m === "then"
              ? undefined
              : async (...a: unknown[]) => {
                  calls.push({ cls, m, a });
                  const f = impl[m];
                  return f ? f(...a) : { ok: true };
                },
        },
      ),
  });
  const e: Record<string, unknown> = {
    OC_INST: "t1",
    OC_TEST: "0",
    CONTROL_TOKEN: "owner-token",
    ...(o.access ? { ACCESS_AUD: AUD, ACCESS_TEAM: TEAM, ACCESS_DOMAIN: DOMAIN } : {}),
    CONTROL: ns("ctl", {
      status: () => ({ epoch: { n: 2 } }),
      ownerView: () => VIEW(st.state, o.ladderClass ? { ladderClass: o.ladderClass } : {}),
    }),
    RUNTIME: ns("rt", {
      fetch: async () => new Response("gateway", { status: 200, headers: { "content-type": "text/plain" } }),
      status: () => ({ state: st.state }),
      requestWake: () => ({ state: "starting", action: "start" }),
      sleepNow: () => (o.sleepOk === false ? { ok: false, reason: "3:recent-activity" } : { ok: true }),
      ownerStart: () => ({ ok: true, state: "starting" }),
    }),
  };
  e.AUTH = fakeAuthNs(() => e).ns;
  return { e: e as never, calls };
}

const HOSTS = [
  { name: "workers.dev (Access off)", origin: DEV, access: false },
  { name: `custom domain ${DOMAIN} (Access on)`, origin: `https://${DOMAIN}`, access: true },
];
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as never;
const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe.each(HOSTS)("/ on $name", ({ origin, access }) => {
  const rq = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const h = new Headers(init.headers);
    const cookies = [init.cookie, access ? `CF_Authorization=${jwt}` : undefined].filter(Boolean);
    if (cookies.length) h.set("cookie", cookies.join("; "));
    h.set("cf-connecting-ip", "198.51.100.9");
    return new Request(`${origin}${path}`, { ...init, headers: h });
  };
  const go = (e: never, r: Request) => worker.fetch(r, e, ctx);
  const nav = { accept: "text/html,application/xhtml+xml" };
  async function cookieOf(e: never) {
    const r = await go(
      e,
      rq("/_ochost/login", {
        method: "POST",
        body: "token=owner-token",
        headers: { "content-type": "application/x-www-form-urlencoded", origin },
      }),
    );
    expect([r.status, r.headers.get("location")]).toEqual([303, "/"]);
    return (r.headers.get("set-cookie") ?? "").split(";")[0] as string;
  }

  it("no session: GET / → 200 login form and nothing else; no Control or Runtime call", async () => {
    const { e, calls } = mkEnv({ access, state: "asleep" });
    for (const headers of [nav, { accept: "*/*" }]) {
      const r = await go(e, rq("/", { headers }));
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      const csp = r.headers.get("content-security-policy") ?? "";
      const html = await r.text();
      expect(html).toContain('action="/_ochost/login"');
      expect(csp).toMatch(/default-src 'none'; script-src 'nonce-[0-9a-f]{32}'/);
      expect(html).not.toMatch(/oc-demo|asleep|running|starting|Snapshots|doctor-failed|Open Control UI/);
      expect(html).not.toMatch(/(src|href)=["']https?:/);
    }
    expect(calls.filter((c) => c.cls === "rt" || c.m === "ownerView")).toEqual([]);
  });

  it("no session: POST /, a WS upgrade on /, and the owner buttons → 404, no call", async () => {
    const { e, calls } = mkEnv({ access });
    expect((await go(e, rq("/", { method: "POST", headers: { origin } }))).status).toBe(404);
    expect((await go(e, rq("/", { headers: { upgrade: "websocket", origin } }))).status).toBe(404);
    for (const p of ["/_ochost/wake", "/_ochost/sleep", "/_ochost/power"])
      expect(
        (await go(e, rq(p, { method: "POST", headers: { origin, ...FORM }, body: "act=start" }))).status,
      ).toBe(404);
    expect(calls.filter((c) => c.cls === "rt" || c.m === "ownerView")).toEqual([]);
  });

  it("no session after a cross-site navigation: the login form reloads once by script (SameSite=Strict cookie)", async () => {
    const { e } = mkEnv({ access });
    const cross = await (
      await go(
        e,
        rq("/", { headers: { ...nav, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } }),
      )
    ).text();
    expect(cross).toContain("location.replace(location.href)");
    const same = await (
      await go(
        e,
        rq("/", { headers: { ...nav, "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" } }),
      )
    ).text();
    expect(same).not.toContain("location.replace");
    expect(same).toContain('action="/_ochost/login"');
  });

  it("owner: GET / → status page with install, state and elapsed, activity, next wake, snapshots, 2 alerts, buttons; no wake, no proxy", async () => {
    const { e, calls } = mkEnv({ access });
    const c = await cookieOf(e);
    const r = await go(e, rq("/", { cookie: c, headers: nav }));
    expect(r.status).toBe(200);
    const nonce = /'nonce-([0-9a-f]{32})'/.exec(r.headers.get("content-security-policy") ?? "")?.[1];
    const html = await r.text();
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).toContain("<h1>oc-demo</h1>");
    expect(html).toContain('Running</p><p class="since">for 12 min</p>');
    expect(html).toContain("4 min ago");
    expect(html).toMatch(/in 2 h \(\d{4}-\d\d-\d\d \d\d:\d\d UTC\)/);
    expect(html).toContain("<dd>7</dd>");
    expect(html).toContain("doctor-failed (high), 60 min ago, open");
    expect(html).toContain("upgrade-regression (high), 2 h ago");
    expect(html).toContain(`href="${CONTROL_UI_PATH}">Open Control UI`);
    // running: one form, Sleep now only
    expect([...html.matchAll(/action="\/_ochost\/power"/g)]).toHaveLength(1);
    expect(html).toContain('<button type="submit" name="act" value="sleep">Sleep now</button>');
    expect(html).not.toMatch(/Wake now|_ochost\/wake"|_ochost\/sleep"/);
    expect(html).toContain('action="/_ochost/logout"');
    expect(html.replace(DOCS_URL, "")).not.toMatch(/(src|href)=["']https?:/);
    expect(calls.filter((x) => x.cls === "rt").map((x) => x.m)).toEqual([]);
  });

  it("owner: asleep and starting states read as such; starting reloads", async () => {
    const asleep = mkEnv({ access, state: "asleep" });
    let html = await (await go(asleep.e, rq("/", { cookie: await cookieOf(asleep.e), headers: nav }))).text();
    expect(html).toContain('Asleep</p><p class="since">for 12 min</p>');
    expect(html).not.toContain("setTimeout");
    resetSessionCache();
    const starting = mkEnv({ access, state: "waiting-capacity" });
    html = await (await go(starting.e, rq("/", { cookie: await cookieOf(starting.e), headers: nav }))).text();
    expect(html).toContain('Waking</p><p class="since">for 12 min · waiting-capacity</p>');
    expect(html).toContain("setTimeout(");
  });

  it("owner: a WS upgrade or an API call on / still goes to the gateway; the UI path is proxied", async () => {
    const { e, calls } = mkEnv({ access });
    const c = await cookieOf(e);
    const ws = await go(e, rq("/", { cookie: c, headers: { upgrade: "websocket", origin } }));
    expect(ws.status).toBe(200);
    const api = await go(e, rq("/", { cookie: c, headers: { accept: "application/json" } }));
    expect(await api.text()).toBe("gateway");
    const ui = await go(e, rq(CONTROL_UI_PATH, { cookie: c, headers: nav }));
    expect(await ui.text()).toBe("gateway");
    expect(calls.filter((x) => x.cls === "rt" && x.m === "fetch")).toHaveLength(3);
  });

  it("owner: Wake now → requestWake(ui), 303 to /; Sleep now → sleepNow (no force); refusal names the rule", async () => {
    const { e, calls } = mkEnv({ access, state: "asleep" });
    const c = await cookieOf(e);
    const w = await go(e, rq("/_ochost/wake", { method: "POST", cookie: c, headers: { origin } }));
    expect([w.status, w.headers.get("location")]).toEqual([303, "/?n=wake"]);
    expect(calls.find((x) => x.m === "requestWake")?.a).toEqual(["ui"]);
    const s = await go(e, rq("/_ochost/sleep", { method: "POST", cookie: c, headers: { origin } }));
    expect([s.status, s.headers.get("location")]).toEqual([303, "/?n=sleep"]);
    expect(calls.find((x) => x.m === "sleepNow")?.a).toEqual([{ force: false }]);
    const page = await (await go(e, rq("/?n=wake", { cookie: c, headers: nav }))).text();
    expect(page).toContain("Wake requested");

    const refused = mkEnv({ access, sleepOk: false });
    resetSessionCache();
    const c2 = await cookieOf(refused.e);
    const r = await go(refused.e, rq("/_ochost/sleep", { method: "POST", cookie: c2, headers: { origin } }));
    expect(r.headers.get("location")).toBe("/?n=sleep-refused&why=3%3Arecent-activity");
    const html = await (
      await go(refused.e, rq("/?n=sleep-refused&why=<b>3:recent-activity</b>", { cookie: c2, headers: nav }))
    ).text();
    expect(html).toContain("Sleep refused: b3:recent-activityb.");
    expect(html).not.toContain("<b>");
  });

  const pageOf = async (state: string, extra: { ladderClass?: string; q?: string } = {}) => {
    resetSessionCache();
    const m = mkEnv({ access, state, ...(extra.ladderClass ? { ladderClass: extra.ladderClass } : {}) });
    const c = await cookieOf(m.e);
    return (await go(m.e, rq(`/${extra.q ?? ""}`, { cookie: c, headers: nav }))).text();
  };
  const act = (v: string, label: string) => `<button type="submit" name="act" value="${v}">${label}</button>`;

  it.each([
    ["asleep", act("wake", "Wake now")],
    ["asleep-unconfirmed", act("wake", "Wake now")],
    ["running", act("sleep", "Sleep now")],
    ["maintenance", act("sleep", "Sleep now")],
    ["starting", '<button type="button" disabled>Waking, 12 min</button>'],
    ["waiting-capacity", '<button type="button" disabled>Waking, 12 min</button>'],
    ["quiescing", '<button type="button" disabled>Going to sleep</button>'],
    ["draining", '<button type="button" disabled>Going to sleep</button>'],
    ["stopping", '<button type="button" disabled>Stopping</button>'],
    ["stopped", act("start", "Start")],
    ["backoff", act("start", "Retry now")],
  ])("owner: state %s → one button: %s", async (state, button) => {
    const html = await pageOf(state);
    expect(html).toContain(button);
    expect([...html.matchAll(/<button type="(submit|button)"( name="act"| disabled)/g)]).toHaveLength(1);
    expect(html).not.toContain("Cancel"); // the Runtime DO has no route that aborts a sleep op
    expect(html).toContain(`href="${CONTROL_UI_PATH}">Open Control UI`);
    expect(html).toContain('action="/_ochost/logout"');
  });

  it("owner: backoff and restore-blocked → Retry now with the open alert's fix line beside it", async () => {
    let html = await pageOf("backoff");
    expect(html).toContain(act("start", "Retry now"));
    expect(html).toContain(
      'Do this: <code class="mono">ochost logs --source rt; ochost restart</code> (alert doctor-failed)</p>',
    );
    html = await pageOf("asleep", { ladderClass: "restore-blocked:schema" });
    expect(html).toContain(act("start", "Retry now"));
    expect(html).not.toContain("Wake now");
  });

  it("owner: a sleep refusal shows the rule's reason beside Sleep now, not as a top notice", async () => {
    const html = await pageOf("running", { q: "?n=sleep-refused&why=3:recent-activity" });
    expect(html).toContain(
      `${act("sleep", "Sleep now")}</form><p class="err" role="alert">Sleep refused: 3:recent-activity.</p>`,
    );
    expect(html).not.toContain('role="status">Sleep refused');
  });

  it("owner: POST /_ochost/power: act=wake → requestWake(ui), act=sleep → sleepNow, act=start → ownerStart; bad act → /", async () => {
    const { e, calls } = mkEnv({ access, state: "stopped" });
    const c = await cookieOf(e);
    const p = (body: string) =>
      go(e, rq("/_ochost/power", { method: "POST", cookie: c, body, headers: { origin, ...FORM } }));
    expect((await p("act=wake")).headers.get("location")).toBe("/?n=wake");
    expect((await p("act=sleep")).headers.get("location")).toBe("/?n=sleep");
    expect((await p("act=start")).headers.get("location")).toBe("/?n=start");
    expect((await p("act=nuke")).headers.get("location")).toBe("/");
    expect(calls.filter((x) => x.cls === "rt" && x.m !== "status").map((x) => [x.m, x.a])).toEqual([
      ["requestWake", ["ui"]],
      ["sleepNow", [{ force: false }]],
      ["ownerStart", []],
    ]);
    const page = await (await go(e, rq("/?n=start", { cookie: c, headers: nav }))).text();
    expect(page).toContain("Start requested");
    expect(page).toContain("setTimeout(");
  });

  it("owner: Firefox's Origin: null form POST passes with Sec-Fetch-Site same-origin; cross-site does not", async () => {
    const { e, calls } = mkEnv({ access, state: "asleep" });
    const c = await cookieOf(e);
    const p = (site: string) =>
      go(
        e,
        rq("/_ochost/power", {
          method: "POST",
          cookie: c,
          body: "act=wake",
          headers: { origin: "null", "sec-fetch-site": site, ...FORM },
        }),
      );
    expect((await p("same-origin")).status).toBe(303);
    expect((await p("cross-site")).status).toBe(403);
    expect(calls.filter((x) => x.m === "requestWake")).toHaveLength(1);
  });

  it("owner buttons need the same origin (403) and POST (404)", async () => {
    const { e, calls } = mkEnv({ access });
    const c = await cookieOf(e);
    const x = await go(
      e,
      rq("/_ochost/wake", { method: "POST", cookie: c, headers: { origin: "https://evil.example" } }),
    );
    expect(x.status).toBe(403);
    expect((await go(e, rq("/_ochost/sleep", { cookie: c }))).status).toBe(404);
    expect(calls.filter((y) => y.m === "requestWake" || y.m === "sleepNow")).toEqual([]);
  });
});

describe("/ with Access on, on workers.dev", () => {
  it("redirects to the custom domain (the page lives there)", async () => {
    const { e } = mkEnv({ access: true });
    const r = await worker.fetch(new Request(`${DEV}/`), e, ctx);
    expect([r.status, r.headers.get("location")]).toEqual([302, `https://${DOMAIN}/`]);
  });
  it("custom domain without the Access JWT → 403, no page", async () => {
    const { e } = mkEnv({ access: true });
    const r = await worker.fetch(new Request(`https://${DOMAIN}/`), e, ctx);
    expect(r.status).toBe(403);
  });
});
