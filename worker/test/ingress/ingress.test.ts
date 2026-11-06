// M3 ingress and auth (D4, add §2.4, §5.4, spec 08 §19): login, cookie, sessions, Origin, header hygiene,
// waking page, wake-status, WS 503, Telegram secret-path hook, /ops/auth, security headers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { resetPointerCache } from "../../src/index";
import { COOKIE_NAME, parseValue, readCookie, stripCookie } from "../../src/ingress/cookie";
import { GATEWAY_USER_HEADER, gatewayAuthManaged } from "../../src/ingress/gateway";
import { withSecurity } from "../../src/ingress/headers";
import { RT_WAKING_TEXT } from "../../src/ingress/routes";
import { resetSessionCache, SESSION_CACHE_MS } from "../../src/ingress/session";
import { LIMITS } from "../../src/ingress/store";
import { hookPath, hookUrl } from "../../src/ingress/telegram";
import { wakingResponse } from "../../src/rt/proxy";
import { fakeAuthNs } from "./fake-auth";

const ORIGIN = "https://oc.example.workers.dev";
const ctx = (waits: Promise<unknown>[] = []) =>
  ({ waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {}, props: {} }) as never;

interface Opts {
  state?: string;
  rtFetch?: (r: Request) => Response | Promise<Response>;
  prevOk?: boolean;
}
function mkEnv(o: Opts = {}) {
  const calls: { cls: string; m: string; a: unknown[] }[] = [];
  const seen: Request[] = [];
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
    CI_TOKEN: "ci-token",
    TELEGRAM_WEBHOOK_SECRET: "wh-secret",
    CONTROL: ns("ctl", {
      status: () => ({ epoch: { n: 3 } }),
      ops: (r: unknown) => ({ status: 200, body: { served: (r as { action: string }).action } }),
      inboxPut: () => ({ status: 200, state: "pending", wake: true }),
      webhookPrevOk: () => o.prevOk ?? false,
    }),
    RUNTIME: ns("rt", {
      fetch: async (r: unknown) => {
        seen.push(r as Request);
        if (o.rtFetch) return o.rtFetch(r as Request);
        if (st.state !== "running") return wakingResponse(r as Request);
        return new Response("gateway", { status: 200, headers: { "content-type": "text/plain" } });
      },
      status: () => ({ state: st.state }),
      requestWake: () => ({ ok: true }),
    }),
  };
  const auth = fakeAuthNs(() => e);
  e.AUTH = auth.ns;
  return { e: e as never, raw: e, calls, seen, st, auth };
}

const rq = (path: string, init: RequestInit & { cookie?: string; bearer?: string; ip?: string } = {}) => {
  const h = new Headers(init.headers);
  if (init.cookie) h.set("cookie", init.cookie);
  if (init.bearer) h.set("authorization", `Bearer ${init.bearer}`);
  h.set("cf-connecting-ip", init.ip ?? "198.51.100.7");
  return new Request(`${ORIGIN}${path}`, { ...init, headers: h });
};
const go = (e: never, r: Request, waits?: Promise<unknown>[]) => worker.fetch(r, e, ctx(waits));

async function login(e: never, token = "owner-token", ip = "198.51.100.7", origin = ORIGIN) {
  return go(
    e,
    rq("/_ochost/login", {
      method: "POST",
      body: new URLSearchParams({ token }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
      ip,
    }),
  );
}
async function cookieOf(e: never): Promise<string> {
  const r = await login(e);
  expect(r.status).toBe(303);
  const sc = r.headers.get("set-cookie") ?? "";
  return sc.split(";")[0] as string;
}

beforeEach(() => {
  resetSessionCache();
  resetPointerCache();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("login /_ochost/login", () => {
  it("GET → 200 form, no-store, CSP with nonce, security headers", async () => {
    const { e } = mkEnv();
    const r = await go(e, rq("/_ochost/login"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/style-src 'nonce-[0-9a-f]{32}'/);
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("strict-transport-security")).toMatch(/max-age=/);
    const html = await r.text();
    expect(html).toContain('action="/_ochost/login"');
    expect(html).toContain('name="token"');
  });
  it("POST good token → 303 / with __Host- cookie: HttpOnly, Secure, SameSite=Strict, Path=/, 30 d", async () => {
    const { e } = mkEnv();
    const r = await login(e);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/");
    const sc = r.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(new RegExp(`^${COOKIE_NAME}=v1\\.[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43};`));
    for (const a of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", `Max-Age=${30 * 86400}`])
      expect(sc).toContain(a);
    expect(sc).not.toMatch(/Domain=/i);
  });
  it("POST bad token → 401 page, no cookie; no Origin or a cross-site Origin → 403", async () => {
    const { e } = mkEnv();
    const bad = await login(e, "wrong");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
    expect(await bad.text()).toContain("Token rejected");
    expect((await login(e, "owner-token", "198.51.100.8", "")).status).toBe(403);
    expect((await login(e, "owner-token", "198.51.100.8", "https://evil.example")).status).toBe(403);
  });
  it("rate limit: 5 failures per IP → 429 with Retry-After, even for the right token; other IPs still log in", async () => {
    const { e } = mkEnv();
    for (let i = 0; i < LIMITS.ipFail; i++) expect((await login(e, `bad${i}`)).status).toBe(401);
    const r = await login(e);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await login(e, "owner-token", "203.0.113.50")).status).toBe(303);
  });
  it("rate limit: 30 failures from all IPs → 429 for a new IP; window end clears it", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 1), toFake: ["Date"] });
    const { e } = mkEnv();
    for (let i = 0; i < LIMITS.allFail; i++)
      expect((await login(e, "bad", `192.0.2.${Math.floor(i / 4)}`)).status).toBe(401);
    expect((await login(e, "owner-token", "203.0.113.99")).status).toBe(429);
    vi.setSystemTime(Date.now() + LIMITS.windowMs + 1);
    expect((await login(e, "owner-token", "203.0.113.99")).status).toBe(303);
  });
  it("20 attempts per IP per window, success or not", async () => {
    const { e } = mkEnv();
    for (let i = 0; i < LIMITS.ipTry; i++) expect((await login(e)).status).toBe(303);
    expect((await login(e)).status).toBe(429);
  });
});

describe("proxied paths need the owner cookie", () => {
  it("no cookie → 404, no Runtime call, no wake", async () => {
    const { e, calls } = mkEnv({ state: "asleep" });
    const r = await go(e, rq("/chat", { headers: { accept: "text/html" } }));
    expect(r.status).toBe(404);
    expect(calls.filter((c) => c.cls === "rt").length).toBe(0);
  });
  it("owner-cli bearer on a proxied path → 404 (scope M3 [Z2.10]); same bearer reaches destructive /ops", async () => {
    const { e, calls } = mkEnv();
    expect((await go(e, rq("/chat", { bearer: "owner-token" }))).status).toBe(404);
    expect(calls.filter((c) => c.cls === "rt").length).toBe(0);
    for (const a of ["restore", "stop", "restart", "epoch/roll"]) {
      const r = await go(e, rq(`/ops/${a}`, { method: "POST", bearer: "owner-token" }));
      expect([a, r.status]).toEqual([a, 200]);
      const ci = await go(e, rq(`/ops/${a}`, { method: "POST", bearer: "ci-token" }));
      expect([a, ci.status]).toEqual([a, 404]);
    }
  });
  it("ci bearer on a proxied path → 404", async () => {
    const { e } = mkEnv();
    expect((await go(e, rq("/chat", { bearer: "ci-token" }))).status).toBe(404);
  });
  it("valid cookie → proxied to rt:<inst>:e<N>; security headers added", async () => {
    const { e, seen } = mkEnv();
    const c = await cookieOf(e);
    const r = await go(e, rq("/chat", { cookie: c }));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("gateway");
    expect(seen.length).toBe(1);
    expect(seen[0]?.headers.get("x-oc-rt")).toBe("rt:t1:e3");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("strict-transport-security")).toMatch(/max-age/);
  });
  it("M4: the proxied request carries the session id (x-ochost-sid) for the bridge; a client value is replaced", async () => {
    const { e, seen } = mkEnv();
    const c = await cookieOf(e);
    const sid = parseValue(c.split("=")[1] as string)?.sid;
    expect(sid).toBeTruthy();
    await go(e, rq("/chat", { cookie: c, headers: { "x-ochost-sid": "forged" } }));
    expect(seen[0]?.headers.get("x-ochost-sid")).toBe(sid);
  });
  it("forged signature → 404 and no session lookup; tampered sid → 404", async () => {
    const { e, auth } = mkEnv();
    const c = await cookieOf(e);
    const p = parseValue(c.split("=")[1] as string)!;
    const forged = `${COOKIE_NAME}=v1.${"A".repeat(43)}.${p.sig}`;
    const before = auth.calls.filter((x) => x.m === "check").length;
    expect((await go(e, rq("/chat", { cookie: forged }))).status).toBe(404);
    expect(auth.calls.filter((x) => x.m === "check").length).toBe(before);
    expect((await go(e, rq("/chat", { cookie: `${COOKIE_NAME}=garbage` }))).status).toBe(404);
  });
  it("a forged high key version refetches the key at most once per 2 s per isolate", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 1), toFake: ["Date"] });
    const { e, auth } = mkEnv();
    await cookieOf(e);
    const forged = `${COOKIE_NAME}=v99.${"A".repeat(43)}.${"B".repeat(43)}`;
    for (let i = 0; i < 20; i++) expect((await go(e, rq("/chat", { cookie: forged }))).status).toBe(404);
    expect(auth.calls.filter((x) => x.m === "key").length).toBeLessThanOrEqual(2);
  });
});

describe("Origin checks (plan §7)", () => {
  it("non-GET with the cookie: no Origin or another origin → 403; same origin → proxied", async () => {
    const { e, seen } = mkEnv();
    const c = await cookieOf(e);
    expect((await go(e, rq("/api/x", { method: "POST", body: "{}", cookie: c }))).status).toBe(403);
    expect(
      (
        await go(
          e,
          rq("/api/x", {
            method: "POST",
            body: "{}",
            cookie: c,
            headers: { origin: "https://evil.example" },
          }),
        )
      ).status,
    ).toBe(403);
    expect(seen.length).toBe(0);
    const ok = await go(
      e,
      rq("/api/x", { method: "POST", body: '{"a":1}', cookie: c, headers: { origin: ORIGIN } }),
    );
    expect(ok.status).toBe(200);
    expect(seen[0]?.method).toBe("POST");
    expect(await seen[0]?.text()).toBe('{"a":1}');
  });
  it("WS upgrade: cookie required, Origin required", async () => {
    const { e, seen } = mkEnv();
    const ws = { upgrade: "websocket", connection: "Upgrade" };
    expect((await go(e, rq("/", { headers: { ...ws, origin: ORIGIN } }))).status).toBe(404);
    const c = await cookieOf(e);
    expect((await go(e, rq("/", { cookie: c, headers: ws }))).status).toBe(403);
    expect(
      (await go(e, rq("/", { cookie: c, headers: { ...ws, origin: "https://x.example" } }))).status,
    ).toBe(403);
    expect(seen.length).toBe(0);
    await go(e, rq("/", { cookie: c, headers: { ...ws, origin: ORIGIN } }));
    expect(seen.length).toBe(1);
  });
});

describe("header hygiene (spec 08 §19.1, trusted-proxy)", () => {
  it("client forwarding and identity headers are dropped; Worker sets XFF, proto, host, user; our cookie removed", async () => {
    const { e, seen } = mkEnv();
    const c = await cookieOf(e);
    await go(
      e,
      rq("/chat", {
        cookie: `theme=dark; ${c}; lang=en`,
        ip: "198.51.100.77",
        headers: {
          "x-forwarded-for": "127.0.0.1",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "http",
          "x-forwarded-user": "admin",
          [GATEWAY_USER_HEADER]: "admin",
          forwarded: "for=127.0.0.1",
          "x-real-ip": "127.0.0.1",
          "x-openclaw-scopes": "operator.admin",
          "cf-access-authenticated-user-email": "x@y",
          "x-oc-rt": "rt:t1:e99",
          authorization: "Bearer owner-token",
          "x-keep": "1",
        },
      }),
    );
    const h = seen[0]!.headers;
    expect(h.get("x-forwarded-for")).toBe("198.51.100.77");
    expect(h.get("x-forwarded-proto")).toBe("https");
    expect(h.get("x-forwarded-host")).toBe("oc.example.workers.dev");
    expect(h.get(GATEWAY_USER_HEADER)).toBe("owner");
    for (const k of ["x-forwarded-user", "forwarded", "x-real-ip", "x-openclaw-scopes", "authorization"])
      expect([k, h.get(k)]).toEqual([k, null]);
    expect(h.get("cf-access-authenticated-user-email")).toBeNull();
    expect(h.get("x-oc-rt")).toBe("rt:t1:e3");
    expect(h.get("cookie")).toBe("theme=dark; lang=en");
    expect(h.get("x-keep")).toBe("1");
  });
  it("stripCookie / readCookie", () => {
    expect(stripCookie(`${COOKIE_NAME}=a`)).toBeNull();
    expect(stripCookie(`a=1;${COOKIE_NAME}=x; b=2`)).toBe("a=1; b=2");
    expect(readCookie(`a=1; ${COOKIE_NAME}=x; ${COOKIE_NAME}=y`)).toEqual(["x", "y"]);
  });
  it("gateway managed keys match the headers the Worker sets; trustedProxies = measured getTcpPort source", () => {
    const m = Object.fromEntries(
      gatewayAuthManaged({ publicOrigin: `${ORIGIN}/` }).map((x) => [x.path, x.value]),
    );
    expect(m["gateway.auth.mode"]).toBe("trusted-proxy");
    expect(m["gateway.trustedProxies"]).toEqual(["10.1.0.0/32"]);
    expect(m["gateway.auth.trustedProxy.userHeader"]).toBe(GATEWAY_USER_HEADER);
    expect(m["gateway.auth.trustedProxy.allowUsers"]).toEqual(["owner"]);
    expect(m["gateway.auth.trustedProxy.allowLoopback"]).toBe(false);
    expect(m["gateway.publicOrigin"]).toBe(ORIGIN);
    expect(m["gateway.auth.trustedProxy.deviceAutoApprove"]).toEqual({ enabled: true });
    expect(m["gateway.auth.identityScopes"]).toEqual({ owner: ["operator.admin"] });
    // the Runtime DO proxy strips x-forwarded-*: the user header must not be one
    expect(GATEWAY_USER_HEADER.startsWith("x-forwarded-")).toBe(false);
  });
});

describe("waking (add §2.4)", () => {
  it("HTML GET while asleep → 200 waking page, no-store, polls wake-status; rt was asked (wake ui)", async () => {
    const { e, st, seen } = mkEnv();
    const c = await cookieOf(e);
    st.state = "asleep";
    const r = await go(e, rq("/chat", { cookie: c, headers: { accept: "text/html,application/xhtml+xml" } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const html = await r.text();
    expect(html).toContain("/_ochost/wake-status");
    expect(html).toContain("location.replace(");
    expect(html).toMatch(/ready[\s\S]*starting[\s\S]*restoring/);
    expect(html).not.toMatch(/(src|href)=["']https?:/);
    expect(seen.length).toBe(1);
  });
  it("the Runtime DO waking text is the one the Worker detects", async () => {
    const r = wakingResponse(new Request(`${ORIGIN}/`, { headers: { accept: "text/html" } }));
    expect(r.status).toBe(503);
    expect(await r.text()).toBe(RT_WAKING_TEXT);
  });
  it("WS while asleep → fast 503 (no hold, no page) so the UI retries", async () => {
    const { e, st } = mkEnv();
    const c = await cookieOf(e);
    st.state = "asleep";
    const t0 = Date.now();
    const r = await go(e, rq("/", { cookie: c, headers: { upgrade: "websocket", origin: ORIGIN } }));
    expect(r.status).toBe(503);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.headers.get("content-type")).not.toContain("text/html");
  });
  it("/healthz while asleep → 503 JSON waking (not the page)", async () => {
    const { e, st } = mkEnv();
    const c = await cookieOf(e);
    st.state = "asleep";
    const r = await go(e, rq("/healthz", { cookie: c, headers: { accept: "text/html" } }));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ ok: false, status: "waking" });
  });
  it("a gateway 503 on a navigation while running is passed through, not replaced", async () => {
    const { e } = mkEnv({
      rtFetch: () =>
        new Response("busy", { status: 503, headers: { "retry-after": "5", "content-type": "text/plain" } }),
    });
    const c = await cookieOf(e);
    const r = await go(e, rq("/chat", { cookie: c, headers: { accept: "text/html" } }));
    expect(r.status).toBe(503);
    expect(await r.text()).toBe("busy");
  });
  it("wake-status: no cookie → 404; asleep → started false + requestWake(ui); running → started true", async () => {
    const { e, st, calls } = mkEnv();
    expect((await go(e, rq("/_ochost/wake-status"))).status).toBe(404);
    const c = await cookieOf(e);
    st.state = "asleep";
    const waits: Promise<unknown>[] = [];
    const a = await go(e, rq("/_ochost/wake-status", { cookie: c }), waits);
    await Promise.all(waits);
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect(await a.json()).toEqual({ state: "asleep", started: false });
    expect(calls.some((x) => x.cls === "rt" && x.m === "requestWake" && x.a[0] === "ui")).toBe(true);
    st.state = "starting";
    expect(await (await go(e, rq("/_ochost/wake-status", { cookie: c }))).json()).toEqual({
      state: "starting",
      started: false,
    });
    st.state = "running";
    expect(await (await go(e, rq("/_ochost/wake-status", { cookie: c }))).json()).toEqual({
      state: "running",
      started: true,
    });
  });
  it("other /_ochost/* paths → 404", async () => {
    const { e } = mkEnv();
    const c = await cookieOf(e);
    for (const p of ["/_ochost/", "/_ochost/x", "/_ochost/hook/slack/abc"])
      expect([p, (await go(e, rq(p, { cookie: c }))).status]).toEqual([p, 404]);
  });
});

describe("1101 guard and anonymous no-wake (M6)", () => {
  const throwing = () => {
    throw new Error("container is not running");
  };
  it("a Runtime DO that throws on an HTML GET → the waking page, never an exception", async () => {
    const { e } = mkEnv({ rtFetch: throwing });
    const c = await cookieOf(e);
    const r = await go(e, rq("/automations", { cookie: c, headers: { accept: "text/html" } }));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("/_ochost/wake-status");
  });
  it("a Runtime DO that throws on a non-HTML request or a WS upgrade → 503 with Retry-After", async () => {
    const { e } = mkEnv({ rtFetch: throwing });
    const c = await cookieOf(e);
    const a = await go(e, rq("/api/x", { cookie: c, headers: { accept: "application/json" } }));
    expect([a.status, a.headers.get("retry-after")]).toEqual([503, "5"]);
    const w = await go(e, rq("/", { cookie: c, headers: { upgrade: "websocket", origin: ORIGIN } }));
    expect([w.status, w.headers.get("retry-after")]).toEqual([503, "5"]);
  });
  it("50 anonymous requests while asleep: no rt call, no wake, no state shown", async () => {
    const { e, calls } = mkEnv({ state: "asleep" });
    const bad = "oc_session=garbage.value";
    const reqs: Request[] = [];
    for (let i = 0; i < 5; i++) {
      for (const cookie of [undefined, bad]) {
        const o = cookie ? { cookie } : {};
        reqs.push(rq("/automations", { ...o, headers: { accept: "text/html" } }));
        reqs.push(rq("/", { ...o, headers: { accept: "text/html" } }));
        reqs.push(rq("/_ochost/wake-status", o));
        reqs.push(rq("/", { ...o, headers: { upgrade: "websocket", origin: ORIGIN } }));
        reqs.push(rq("/healthz", o));
      }
    }
    for (let i = 0; i < 5; i++) {
      reqs.push(rq("/_ochost/login"));
      reqs.push(
        rq("/_ochost/login", {
          method: "POST",
          body: "token=wrong",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
        }),
      );
    }
    expect(reqs.length).toBe(60);
    for (const r of reqs) {
      const p = new URL(r.url).pathname;
      const res = await go(e, r);
      const t = await res.text();
      // `/` GET: the login form (200), no state; a WS upgrade on `/`: 404.
      const ok = p === "/_ochost/login" ? [200, 401] : p === "/" ? [200, 404] : [404];
      expect([p, ok.includes(res.status)]).toEqual([p, true]);
      expect(t).not.toMatch(/asleep|waking|starting|started/);
    }
    expect(calls.filter((c) => c.cls === "rt")).toEqual([]);
  });
});

describe("sessions: /ops/auth (owner bearer only)", () => {
  it("list, revoke one, the revoked cookie stops working within the cache time", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 1), toFake: ["Date"] });
    const { e } = mkEnv();
    const c1 = await cookieOf(e);
    const c2 = await cookieOf(e);
    const l = await go(e, rq("/ops/auth/sessions", { bearer: "owner-token" }));
    const { sessions } = (await l.json()) as { sessions: { id: string; via: string; ip: string }[] };
    expect(sessions.length).toBe(2);
    expect(sessions[0]?.via).toBe("token");
    expect(JSON.stringify(sessions)).not.toContain((c1.split(".")[1] as string).slice(0, 20)); // no sid leak
    expect((await go(e, rq("/chat", { cookie: c1 }))).status).toBe(200);
    const rv = await go(
      e,
      rq("/ops/auth/revoke", {
        method: "POST",
        bearer: "owner-token",
        body: JSON.stringify({ id: sessions[0]?.id }),
      }),
    );
    expect(await rv.json()).toEqual({ ok: true, ended: 1 });
    vi.setSystemTime(Date.now() + SESSION_CACHE_MS + 1);
    expect((await go(e, rq("/chat", { cookie: c1 }))).status).toBe(404);
    expect((await go(e, rq("/chat", { cookie: c2 }))).status).toBe(200);
    const unknown = await go(
      e,
      rq("/ops/auth/revoke", {
        method: "POST",
        bearer: "owner-token",
        body: JSON.stringify({ id: "000000000000" }),
      }),
    );
    expect(unknown.status).toBe(404);
  });
  it("rotate: new key, every session ends; a new login works at once in the same isolate", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 1), toFake: ["Date"] });
    const { e } = mkEnv();
    const c1 = await cookieOf(e);
    expect((await go(e, rq("/chat", { cookie: c1 }))).status).toBe(200);
    const r = await go(e, rq("/ops/auth/rotate", { method: "POST", bearer: "owner-token" }));
    expect(await r.json()).toEqual({ ended: 1, keyVer: 2 });
    vi.setSystemTime(Date.now() + SESSION_CACHE_MS + 1);
    expect((await go(e, rq("/chat", { cookie: c1 }))).status).toBe(404);
    vi.setSystemTime(Date.now() + 2001);
    const c2 = await cookieOf(e);
    expect(c2.startsWith(`${COOKIE_NAME}=v2.`)).toBe(true);
    expect((await go(e, rq("/chat", { cookie: c2 }))).status).toBe(200);
  });
  it("ci and no token → 404 on every /ops/auth route; unknown sub → 404", async () => {
    const { e } = mkEnv();
    for (const [m, p] of [
      ["GET", "sessions"],
      ["POST", "rotate"],
      ["POST", "revoke"],
      ["POST", "code"],
    ] as const) {
      expect((await go(e, rq(`/ops/auth/${p}`, { method: m, bearer: "ci-token" }))).status).toBe(404);
      expect((await go(e, rq(`/ops/auth/${p}`, { method: m }))).status).toBe(404);
    }
    expect((await go(e, rq("/ops/auth/nope", { method: "POST", bearer: "owner-token" }))).status).toBe(404);
    expect((await go(e, rq("/ops/auth/rotate", { bearer: "owner-token" }))).status).toBe(404);
  });
  it("one-time code (ochost open): GET shows a button only (S1.5); same-origin POST sets the cookie; reuse → 404; expiry → 404", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 1), toFake: ["Date"] });
    const { e } = mkEnv();
    const m = await go(e, rq("/ops/auth/code", { method: "POST", bearer: "owner-token" }));
    const { url, code } = (await m.json()) as { url: string; code: string };
    expect(url).toBe(`${ORIGIN}/_ochost/login/${code}`);
    const post = (c: string, origin: string | null = ORIGIN, h = "") =>
      go(
        e,
        rq(`/_ochost/login/${c}`, {
          method: "POST",
          body: new URLSearchParams({ h }).toString(),
          headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
        }),
      );
    // A link preview bot: two plain GETs. No cookie; the link stays valid.
    for (let i = 0; i < 2; i++) {
      const g = await go(e, rq(`/_ochost/login/${code}`));
      expect(g.status).toBe(200);
      expect(g.headers.get("set-cookie")).toBeNull();
      expect(await g.text()).toContain('<form method="post">');
    }
    expect((await post(code, "https://evil.example")).status).toBe(403); // cross-site POST
    const r = await post(code, ORIGIN, "#k=v");
    expect(r.status).toBe(200);
    const sc = r.headers.get("set-cookie") ?? "";
    expect(sc).toContain("SameSite=Strict");
    expect(await r.text()).toContain(`location.replace('/' + "#k=v")`);
    expect((await go(e, rq("/chat", { cookie: sc.split(";")[0] }))).status).toBe(200);
    expect((await post(code)).status).toBe(404);
    const m2 = (await (
      await go(e, rq("/ops/auth/code", { method: "POST", bearer: "owner-token" }))
    ).json()) as {
      code: string;
    };
    vi.setSystemTime(Date.now() + LIMITS.codeTtlMs + 1);
    expect((await post(m2.code)).status).toBe(404);
    const sessions = (await (await go(e, rq("/ops/auth/sessions", { bearer: "owner-token" }))).json()) as {
      sessions: { via: string }[];
    };
    expect(sessions.sessions.map((s) => s.via)).toEqual(["code"]);
  });
  it("code guessing counts as failures: 5 bad codes from one IP → 429", async () => {
    const { e } = mkEnv();
    const post = (c: string) =>
      go(e, rq(`/_ochost/login/${c}`, { method: "POST", body: "", headers: { origin: ORIGIN } }));
    for (let i = 0; i < LIMITS.ipFail; i++) expect((await post(`${"x".repeat(31)}${i}`)).status).toBe(404);
    expect((await post("x".repeat(32))).status).toBe(429);
  });
  it("logout: Origin required; ends the session and clears the cookie", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 1), toFake: ["Date"] });
    const { e } = mkEnv();
    const c = await cookieOf(e);
    expect((await go(e, rq("/_ochost/logout", { method: "POST", cookie: c }))).status).toBe(403);
    const r = await go(e, rq("/_ochost/logout", { method: "POST", cookie: c, headers: { origin: ORIGIN } }));
    expect(r.status).toBe(303);
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await go(e, rq("/chat", { cookie: c }))).status).toBe(404);
  });
  it("no AUTH binding → login 404 and every proxied path 404 (fail closed)", async () => {
    const { e, raw } = mkEnv();
    const c = await cookieOf(e);
    delete raw.AUTH;
    resetSessionCache();
    expect((await go(e, rq("/_ochost/login"))).status).toBe(404);
    expect((await go(e, rq("/chat", { cookie: c }))).status).toBe(404);
  });
});

describe("Telegram secret-path hook /_ochost/hook/telegram/<seg>", () => {
  const upd = JSON.stringify({ update_id: 7, message: { from: { id: 1 }, chat: { id: 1 }, text: "hi" } });
  it("right path + secret header → 200 and inbox hand-off; wake through waitUntil", async () => {
    const { e, calls } = mkEnv();
    const p = await hookPath("wh-secret");
    expect(p).toMatch(/^\/_ochost\/hook\/telegram\/[0-9a-f]{32}$/);
    expect(await hookUrl(`${ORIGIN}/`, "wh-secret")).toBe(ORIGIN + p);
    const waits: Promise<unknown>[] = [];
    const r = await go(
      e,
      rq(p, { method: "POST", body: upd, headers: { "x-telegram-bot-api-secret-token": "wh-secret" } }),
      waits,
    );
    await Promise.all(waits);
    expect(r.status).toBe(200);
    const put = calls.find((c) => c.cls === "ctl" && c.m === "inboxPut");
    expect((put!.a[0] as { body: string }).body).toBe(upd);
    expect(calls.some((c) => c.cls === "rt" && c.m === "requestWake" && c.a[0] === "webhook")).toBe(true);
  });
  it("wrong path → 404 and no Control DO call; right path, wrong header → 401; query → 404; GET → 405", async () => {
    const { e, calls } = mkEnv();
    const p = await hookPath("wh-secret");
    const h = { "x-telegram-bot-api-secret-token": "wh-secret" };
    expect(
      (await go(e, rq(`/_ochost/hook/telegram/${"0".repeat(32)}`, { method: "POST", body: upd, headers: h })))
        .status,
    ).toBe(404);
    expect((await go(e, rq(`${p}?x=1`, { method: "POST", body: upd, headers: h }))).status).toBe(404);
    expect(
      (
        await go(
          e,
          rq(p.toUpperCase().replace("/_OCHOST/HOOK/TELEGRAM/", "/_ochost/hook/telegram/"), {
            method: "POST",
            body: upd,
            headers: h,
          }),
        )
      ).status,
    ).toBe(404);
    expect(calls.filter((c) => c.cls === "ctl").length).toBe(0);
    const bad = await go(
      e,
      rq(p, { method: "POST", body: upd, headers: { "x-telegram-bot-api-secret-token": "nope" } }),
    );
    expect(bad.status).toBe(401);
    expect(calls.filter((c) => c.m === "inboxPut").length).toBe(0);
    expect((await go(e, rq(p, { headers: h }))).status).toBe(405);
  });
  it("rotation: the previous secret's path + header work while the Control DO says prev is valid", async () => {
    const { e, raw } = mkEnv({ prevOk: true });
    raw.TELEGRAM_WEBHOOK_SECRET = "wh-new";
    raw.TELEGRAM_WEBHOOK_SECRET_PREV = "wh-secret";
    const p = await hookPath("wh-secret");
    const r = await go(
      e,
      rq(p, { method: "POST", body: upd, headers: { "x-telegram-bot-api-secret-token": "wh-secret" } }),
    );
    expect(r.status).toBe(200);
  });
  it("no cookie needed; a cookie does not open the hook", async () => {
    const { e } = mkEnv();
    const c = await cookieOf(e);
    expect(
      (await go(e, rq(`/_ochost/hook/telegram/${"0".repeat(32)}`, { method: "POST", body: upd, cookie: c })))
        .status,
    ).toBe(404);
  });
});

describe("security headers on proxied answers", () => {
  it("gateway values win; frame-ancestors in the gateway CSP skips X-Frame-Options; 101 untouched", () => {
    const r = withSecurity(
      new Response("x", {
        headers: { "referrer-policy": "same-origin", "content-security-policy": "frame-ancestors 'self'" },
      }),
    );
    expect(r.headers.get("referrer-policy")).toBe("same-origin");
    expect(r.headers.get("x-frame-options")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const ws = { status: 101, webSocket: {} } as unknown as Response;
    expect(withSecurity(ws)).toBe(ws);
  });
  it("404 for an unauthenticated path carries the base headers", async () => {
    const { e } = mkEnv();
    const r = await go(e, rq("/x"));
    expect(r.status).toBe(404);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("auth store", () => {
  it("sessions are capped at 20 (oldest end first); storage holds no raw session id", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 1), toFake: ["Date"] });
    const { e, auth } = mkEnv();
    const first = await cookieOf(e);
    for (let i = 0; i < LIMITS.maxSessions; i++) {
      vi.setSystemTime(Date.now() + 1000);
      await login(e, "owner-token", `192.0.2.${i}`);
    }
    const l = (await (await go(e, rq("/ops/auth/sessions", { bearer: "owner-token" }))).json()) as {
      sessions: unknown[];
    };
    expect(l.sessions.length).toBe(LIMITS.maxSessions);
    vi.setSystemTime(Date.now() + SESSION_CACHE_MS + 1);
    expect((await go(e, rq("/chat", { cookie: first }))).status).toBe(404);
    const sid = parseValue(first.split("=")[1] as string)!.sid;
    const dump = JSON.stringify(auth.storage.db.prepare("SELECT * FROM sessions").all());
    expect(dump).not.toContain(sid);
  });
  it("a session expires after 30 d", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 1), toFake: ["Date"] });
    const { e } = mkEnv();
    const c = await cookieOf(e);
    vi.setSystemTime(Date.now() + 30 * 86400_000 + 1);
    expect((await go(e, rq("/chat", { cookie: c }))).status).toBe(404);
  });
});
