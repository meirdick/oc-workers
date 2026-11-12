// Ingress routes (D4, add §2.4, §5.4, spec 08 §19): `/` (owner status page or the login form), /_ochost/* pages
// and owner wake/sleep, /ops/auth/*, the cookie-gated proxy, and the Telegram secret-path hook. index.ts calls
// these; the Runtime DO and Control DO stay behind deps.
import type { OwnerView } from "../core/types";
import type { Panel } from "../ctl/panel";
import { codeConfirmPage, codeFailedPage, codePage, loginPage, statusPage, wakingPage } from "../ui/pages";
import { clearCookie, setCookie } from "./cookie";
import { BASE_SECURITY, forwardRequest, nonce, originOk, pageHeaders, withSecurity } from "./headers";
import { PANEL_ACTS, type PanelAct, type PanelOps, panelAct } from "./panel-actions";
import { authOf, forgetSession, type IngressEnv, ownerSession } from "./session";

export interface RtView {
  status(): Promise<{ state?: string } | null>;
  requestWake(reason: "ui"): Promise<unknown>;
  /** Sleep gate now, no force (spec §10.1); the owner's "Sleep now". */
  sleepNow(o: { force: boolean }): Promise<{ ok: boolean; reason?: string }>;
  /** Owner start (§10.6): from stopped, new or asleep; in backoff it moves the next start to now. */
  ownerStart(): Promise<{ ok: boolean; state?: string }>;
}
export interface IngressDeps {
  /** Send an owner-authenticated request to the active Runtime DO (index.ts proxy: pointer, 421 retry). */
  proxy(req: Request): Promise<Response>;
  /** Active Runtime DO, or null when no epoch exists. */
  rt(): Promise<RtView | null>;
  /** Control DO ownerView(): the status page fields. */
  view(): Promise<OwnerView | null>;
  /** Control DO ownerPanel(): the owner panel facts. Absent or null → the plain status page. */
  panel?(): Promise<Panel | null>;
  /** The owner's /ops actions, for the panel buttons. */
  ops?: PanelOps;
  waitUntil(p: Promise<unknown>): void;
}

/** Body of the Runtime DO's waking answer to an HTML GET (rt/proxy.ts wakingResponse). */
export const RT_WAKING_TEXT = "OpenClaw is waking up. Reload in a few seconds.";
const MAX_FORM = 4096;

const notFound = () => new Response("not found", { status: 404, headers: { ...BASE_SECURITY } });
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...BASE_SECURITY, ...extra } });

function page(html: (n: string) => string, status = 200, extra: Record<string, string> = {}): Response {
  const n = nonce();
  return new Response(html(n), { status, headers: { ...pageHeaders(n), ...extra } });
}

const ipOf = (req: Request) => req.headers.get("cf-connecting-ip") ?? "unknown";
const uaOf = (req: Request) => (req.headers.get("user-agent") ?? "").slice(0, 200);
const isWs = (req: Request) => (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
const isNav = (req: Request) =>
  req.method === "GET" && !isWs(req) && (req.headers.get("accept") ?? "").includes("text/html");

function limited(retryAfterS = 60): Response {
  return new Response("too many sign-in attempts; try later", {
    status: 429,
    headers: { "retry-after": String(retryAfterS), "cache-control": "no-store", ...BASE_SECURITY },
  });
}

// ---------------------------------------------------------------- /_ochost/*
export async function handleOchost(req: Request, env: IngressEnv, deps: IngressDeps): Promise<Response> {
  const path = new URL(req.url).pathname;
  const auth = authOf(env);
  if (path === "/_ochost/login") {
    if (!auth) return notFound();
    if (req.method === "GET" || req.method === "HEAD") return page((n) => loginPage(n));
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
    if (!originOk(req)) return new Response("bad origin", { status: 403, headers: { ...BASE_SECURITY } });
    if (Number(req.headers.get("content-length") ?? "0") > MAX_FORM)
      return new Response(null, { status: 413 });
    const text = (await req.text()).slice(0, MAX_FORM);
    const token = new URLSearchParams(text).get("token")?.trim() ?? "";
    const r = await auth.login({ token, ip: ipOf(req), ua: uaOf(req) });
    if (r.ok)
      return new Response(null, {
        status: 303,
        headers: {
          location: "/",
          "set-cookie": setCookie(r.cookie, r.maxAgeS),
          "cache-control": "no-store",
          ...BASE_SECURITY,
        },
      });
    if (r.status === 429) return limited(r.retryAfterS);
    return page((n) => loginPage(n, "Token rejected."), 401);
  }
  if (path.startsWith("/_ochost/login/")) {
    if (!auth || (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST")) return notFound();
    const code = path.slice("/_ochost/login/".length);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) return page((n) => codeFailedPage(n), 404);
    // S1.5: a GET (link preview, mail scanner, prefetch) never uses the code; only the page's same-origin POST.
    if (req.method !== "POST") return page((n) => codeConfirmPage(n));
    if (!originOk(req)) return new Response("bad origin", { status: 403, headers: { ...BASE_SECURITY } });
    if (Number(req.headers.get("content-length") ?? "0") > MAX_FORM)
      return new Response(null, { status: 413 });
    const form = new URLSearchParams((await req.text()).slice(0, MAX_FORM));
    const r = await auth.redeem({ code, ip: ipOf(req), ua: uaOf(req) });
    if (r.ok)
      return page((n) => codePage(n, form.get("h") ?? ""), 200, {
        "set-cookie": setCookie(r.cookie, r.maxAgeS),
      });
    if (r.status === 429) return limited(r.retryAfterS);
    return page((n) => codeFailedPage(n), 404);
  }
  if (path === "/_ochost/logout") {
    if (req.method !== "POST") return notFound();
    const s = await ownerSession(req, env);
    if (!s || !auth) return notFound();
    if (!originOk(req)) return new Response("bad origin", { status: 403, headers: { ...BASE_SECURITY } });
    await auth.logout(s.sid);
    forgetSession(s.sid);
    return new Response(null, {
      status: 303,
      headers: { location: "/_ochost/login", "set-cookie": clearCookie(), ...BASE_SECURITY },
    });
  }
  if (path === "/_ochost/power" || path === "/_ochost/wake" || path === "/_ochost/sleep") {
    // The one state-driven button on `/` (POST /_ochost/power, act=wake|sleep|start; ui/pages.ts powerButton).
    // /_ochost/wake and /_ochost/sleep stay for old tabs. Cookie + same origin, else 404 / 403. Never anonymous.
    if (req.method !== "POST") return notFound();
    if (!(await ownerSession(req, env))) return notFound();
    if (!originOk(req)) return new Response("bad origin", { status: 403, headers: { ...BASE_SECURITY } });
    let act = path.slice("/_ochost/".length);
    if (act === "power") {
      if (Number(req.headers.get("content-length") ?? "0") > MAX_FORM)
        return new Response(null, { status: 413 });
      act = new URLSearchParams((await req.text()).slice(0, MAX_FORM)).get("act") ?? "";
      if (act !== "wake" && act !== "sleep" && act !== "start") return seeOther("/");
    }
    const rt = await deps.rt().catch(() => null);
    if (!rt) return seeOther("/?n=no-install");
    if (act === "wake") {
      await rt.requestWake("ui").catch(() => undefined);
      return seeOther("/?n=wake");
    }
    if (act === "start") {
      const r = await rt.ownerStart().catch(() => ({ ok: false, state: "error" }));
      if (r.ok) return seeOther("/?n=start");
      return seeOther(`/?n=start-failed&why=${encodeURIComponent(String(r.state ?? "").slice(0, 60))}`);
    }
    // The owner pressed Sleep now: skip the idle, min-awake and next-wake rules (3, 4, 7), as `ochost sleep
    // --force` does. Blockers (open archive, import, inbox) and an open WS still refuse it.
    const r = await rt.sleepNow({ force: true }).catch((e: unknown) => ({
      ok: false,
      reason: e instanceof Error ? e.message : "error",
    }));
    if (r.ok) return seeOther("/?n=sleep");
    return seeOther(`/?n=sleep-refused&why=${encodeURIComponent(String(r.reason ?? "").slice(0, 60))}`);
  }
  if (path.startsWith("/_ochost/panel/")) {
    // Panel buttons: cookie + same origin, else 404 / 403. Never for an anonymous caller.
    const act = path.slice("/_ochost/panel/".length) as PanelAct;
    if (req.method !== "POST" || !PANEL_ACTS.includes(act)) return notFound();
    if (!(await ownerSession(req, env))) return notFound();
    if (!originOk(req)) return new Response("bad origin", { status: 403, headers: { ...BASE_SECURITY } });
    if (Number(req.headers.get("content-length") ?? "0") > MAX_FORM)
      return new Response(null, { status: 413 });
    const form = new URLSearchParams((await req.text()).slice(0, MAX_FORM));
    const r = deps.ops ? await panelAct(act, form, deps.ops) : { code: "panel-failed", why: "no ops" };
    // Back to the tab the button sits on: Close on Alerts and log, the rest on Setup.
    const tab = act === "ack" || act === "close" ? "log" : "setup";
    return seeOther(`/?n=${r.code}${r.why ? `&why=${encodeURIComponent(r.why)}` : ""}&tab=${tab}`);
  }
  if (path === "/_ochost/wake-status") {
    if (req.method !== "GET") return notFound();
    if (!(await ownerSession(req, env))) return notFound();
    const rt = await deps.rt().catch(() => null);
    if (!rt) return json({ state: "not-installed", started: false });
    const s = await rt.status().catch(() => null);
    const state = s?.state ?? "unknown";
    // A poll while asleep asks again (a dropped wake must not leave the page waiting forever).
    if (state === "asleep" || state === "asleep-unconfirmed")
      deps.waitUntil(rt.requestWake("ui").catch(() => undefined));
    return json({ state, started: state === "running" });
  }
  return notFound();
}

const seeOther = (location: string) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...BASE_SECURITY } });

// ---------------------------------------------------------------- `/`
/** A navigation from another site: Access login redirect, a link in a mail or chat. */
const crossSite = (req: Request) => {
  const s = req.headers.get("sec-fetch-site");
  return s === "cross-site" || s === "same-site";
};

/**
 * `/` on every host. Owner session + HTML GET → the status page (no wake). Owner WS upgrade or API call → the
 * proxy, as before. No session: GET → the login form and nothing else (no state, no Runtime call); else 404.
 */
export async function handleRoot(req: Request, env: IngressEnv, deps: IngressDeps): Promise<Response> {
  const s = await ownerSession(req, env);
  if (!s) {
    const get = (req.method === "GET" || req.method === "HEAD") && !isWs(req);
    if (!get || !authOf(env)) return notFound();
    return page((n) => loginPage(n, undefined, isNav(req) && crossSite(req)));
  }
  if (!isNav(req)) return handleProxied(req, env, deps);
  const [v, panel] = await Promise.all([
    deps.view().catch(() => null),
    deps.panel ? deps.panel().catch(() => null) : null,
  ]);
  const q = new URL(req.url).searchParams;
  const code = q.get("n") ?? "";
  const why = (q.get("why") ?? "").replace(/[^A-Za-z0-9 :._-]/g, "").slice(0, 60);
  return page((n) => {
    const notice = code ? { code, why: why || undefined } : undefined;
    // Deferred DO code (≤ 300 s after a deploy) can answer with an older panel shape; never 1101 on it.
    try {
      return statusPage(n, v, notice, panel, { tab: q.get("tab"), kind: q.get("kind") });
    } catch {
      return statusPage(n, v, notice, null);
    }
  });
}

// ---------------------------------------------------------------- proxied paths
/**
 * Any other path: the owner cookie, else 404 and no wake (add §5.4 layer 1). A bearer token is not enough
 * (scope M3 [Z2.10]: owner-cli gets 404 here). WS upgrades and non-GET need a same-origin `Origin`.
 */
export async function handleProxied(req: Request, env: IngressEnv, deps: IngressDeps): Promise<Response> {
  const s = await ownerSession(req, env);
  if (!s) return notFound();
  if (!originOk(req)) return new Response("bad origin", { status: 403, headers: { ...BASE_SECURITY } });
  const nav = isNav(req);
  // M4: the Runtime DO ties a WS bridge to this session (close on revoke/expiry, idle latch); it strips the header.
  const fwd = forwardRequest(req);
  const h = new Headers(fwd.headers);
  h.set("x-ochost-sid", s.sid);
  let res: Response;
  try {
    res = await deps.proxy(new Request(fwd, { headers: h }));
  } catch (e) {
    // A Runtime DO that throws (container gone between the gate and the fetch, a failed wake) must not become
    // Error 1101: answer as for a waking install, so a navigation gets the waking page and the rest a 503.
    console.error(`proxy failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    res = new Response(RT_WAKING_TEXT, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "5" },
    });
  }
  if (nav && (await isWakingAnswer(res))) return page((n) => wakingPage(n));
  return withSecurity(res);
}

/** The Runtime DO's 503 for a navigation while not running, or the Worker's own "epoch moved" 503. */
async function isWakingAnswer(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  const ra = res.headers.get("retry-after");
  if (ra !== "5" && ra !== "2") return false;
  if (!(res.headers.get("content-type") ?? "text/plain").startsWith("text/plain")) return false;
  const t = await res.clone().text();
  return t === RT_WAKING_TEXT || t === "epoch moved";
}

// ---------------------------------------------------------------- /ops/auth/*
/**
 * Owner bearer only (ci and none → 404, §19.2 rule): GET sessions, POST revoke {id}, POST rotate (new
 * cookie key, every session ends), POST code (one-time login link for `ochost open`).
 */
export async function handleOpsAuth(
  req: Request,
  env: IngressEnv,
  role: "owner" | "ci" | null,
): Promise<Response> {
  const nf = () => Response.json({ error: "not found" }, { status: 404 });
  if (role !== "owner") return nf();
  const auth = authOf(env);
  if (!auth) return nf();
  const url = new URL(req.url);
  const sub = url.pathname.split("/").filter(Boolean).slice(2).join("/");
  if (sub === "sessions" && req.method === "GET") return json({ sessions: await auth.list() });
  if (req.method !== "POST") return nf();
  if (sub === "rotate") return json(await auth.rotate());
  if (sub === "code") {
    const c = await auth.mintCode();
    return json({ ...c, url: `${url.origin}/_ochost/login/${c.code}` });
  }
  if (sub === "revoke") {
    let id = "";
    try {
      id = String(((await req.json()) as { id?: unknown }).id ?? "");
    } catch {
      return json({ error: "bad json" }, 400);
    }
    const r = await auth.revoke(id);
    return json(r, r.ok ? 200 : 404);
  }
  return nf();
}
