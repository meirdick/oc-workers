// Header hygiene and security headers (plan §7, spec 08 §19.1, add §5.4).
import { stripCookie } from "./cookie";
import { GATEWAY_USER_HEADER, OWNER_IDENTITY } from "./gateway";

/** Client headers that never reach the Runtime DO or the gateway. */
const DROP = new Set(["forwarded", "x-real-ip", "x-openclaw-scopes", "authorization", "x-oc-rt"]);
const DROP_PREFIX = ["x-forwarded-", "cf-access-", "x-ochost-"];

export function dropHeader(name: string): boolean {
  const k = name.toLowerCase();
  return DROP.has(k) || DROP_PREFIX.some((p) => k.startsWith(p));
}

/**
 * Request to send to the Runtime DO for an owner-authenticated proxied path. Client forwarding and identity
 * headers are removed; the Worker sets its own. The gateway trusts them only from `trustedProxies`
 * (the getTcpPort source, 10.1.0.0/32 on CF, M0 T2 item 3).
 */
export function forwardRequest(req: Request): Request {
  const url = new URL(req.url);
  const h = new Headers();
  for (const [k, v] of req.headers) if (!dropHeader(k)) h.set(k, v);
  const cookie = stripCookie(req.headers.get("cookie"));
  if (cookie) h.set("cookie", cookie);
  else h.delete("cookie");
  const ip = req.headers.get("cf-connecting-ip");
  if (ip) h.set("x-forwarded-for", ip);
  h.set("x-forwarded-proto", "https");
  h.set("x-forwarded-host", url.host);
  h.set(GATEWAY_USER_HEADER, OWNER_IDENTITY);
  // Same method, URL and body stream; only the headers change.
  return new Request(req, { headers: h });
}

/** Headers on every page the Worker makes itself. `nonce` allows its one inline script and style. */
export function pageHeaders(nonce?: string): Record<string, string> {
  const src = nonce ? `'nonce-${nonce}'` : "'none'";
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; script-src ${src}; style-src ${src}; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    ...BASE_SECURITY,
  };
}

export const BASE_SECURITY: Record<string, string> = {
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
};

/** Security headers on a proxied answer; the gateway's own values win. A 101 is returned as is. */
export function withSecurity(res: Response): Response {
  if (res.status === 101 || (res as { webSocket?: unknown }).webSocket) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(BASE_SECURITY)) {
    if (k === "x-frame-options" && /frame-ancestors/i.test(out.headers.get("content-security-policy") ?? ""))
      continue;
    if (!out.headers.has(k)) out.headers.set(k, v);
  }
  return out;
}

/** Same-origin check (plan §7 Origin rule): WS upgrades and every non-GET/HEAD cookie request. */
export function originOk(req: Request): boolean {
  const ws = (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
  const unsafe = req.method !== "GET" && req.method !== "HEAD";
  if (!ws && !unsafe) return true;
  const o = req.headers.get("origin");
  if (o && o === new URL(req.url).origin) return true;
  // Firefox sends "Origin: null" on a same-origin form POST under Referrer-Policy: no-referrer (demo login,
  // 2026-11-05). Sec-Fetch-Site is set by every current browser and cannot be forged by a page.
  if ((!o || o === "null") && req.headers.get("sec-fetch-site") === "same-origin") return true;
  return false;
}

export function nonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
