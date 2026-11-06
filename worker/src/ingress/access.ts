// Cloudflare Access front door (opt-in, `ochost auth access`; docs/15-access.md). Active only when ACCESS_AUD is set.
// On the custom domain every request needs a valid Access JWT (header or CF_Authorization cookie, WS upgrades
// included) before the owner-cookie layer. On any other host (workers.dev) only the webhook routes, and by default
// /ops (bearer), are served; the rest redirects to the custom domain. Fail closed: no key, no pass.

export interface AccessEnv {
  /** App AUD tag. Unset = Access off, this module does nothing. */
  ACCESS_AUD?: string;
  /** Team domain, e.g. myteam.cloudflareaccess.com. */
  ACCESS_TEAM?: string;
  /** The custom domain the Access app protects. */
  ACCESS_DOMAIN?: string;
  /** "ops" (default): workers.dev serves webhooks and /ops. "webhooks": webhooks only. */
  ACCESS_WORKERS_DEV?: string;
}

export const ACCESS_COOKIE = "CF_Authorization";
const JWKS_TTL_MS = 3_600_000;
const REFETCH_MS = 30_000;
const SKEW_S = 30;

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}
let jwks: { team: string; keys: Map<string, CryptoKey>; at: number; tried: number } | null = null;

/** Test hook: a new isolate. */
export function resetAccessCache() {
  jwks = null;
}

const teamHost = (t: string) => t.replace(/^https?:\/\//, "").replace(/\/.*$/, "");

async function loadKeys(team: string, now: number): Promise<void> {
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const k of body.keys ?? []) {
    if (k.kty !== "RSA" || !k.kid || !k.n || !k.e) continue;
    keys.set(
      k.kid,
      await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  jwks = { team, keys, at: now, tried: now };
}

/** Key for `kid`: cache 1 h; an unknown kid refetches, at most once per 30 s (key rotation). */
async function keyFor(team: string, kid: string, now: number): Promise<CryptoKey | null> {
  const fresh = jwks && jwks.team === team && now - jwks.at < JWKS_TTL_MS;
  if (!fresh) await loadKeys(team, now);
  else if (!jwks?.keys.has(kid) && now - (jwks?.tried ?? 0) >= REFETCH_MS) {
    const prev = jwks as NonNullable<typeof jwks>;
    prev.tried = now;
    await loadKeys(team, now);
  }
  return jwks?.keys.get(kid) ?? null;
}

const b64 = (s: string): Uint8Array => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const jsonPart = (s: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(new TextDecoder().decode(b64(s)));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export interface AccessClaims {
  email?: string;
  common_name?: string;
  exp: number;
  [k: string]: unknown;
}

/** Verified claims, or null for anything wrong (bad shape, alg, signature, iss, aud, exp, nbf, no key). */
export async function verifyAccessJwt(
  token: string,
  env: AccessEnv,
  now = Date.now(),
): Promise<AccessClaims | null> {
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 8192) return null;
  const [h, p, s] = parts as [string, string, string];
  const head = jsonPart(h);
  const c = jsonPart(p);
  if (!head || !c || head.alg !== "RS256" || typeof head.kid !== "string") return null;
  const team = teamHost(env.ACCESS_TEAM);
  try {
    const key = await keyFor(team, head.kid, now);
    if (!key) return null;
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return null;
  } catch {
    return null;
  }
  const t = Math.floor(now / 1000);
  if (typeof c.exp !== "number" || c.exp + SKEW_S < t) return null;
  if (typeof c.nbf === "number" && c.nbf - SKEW_S > t) return null;
  if (c.iss !== `https://${team}`) return null;
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  return c as AccessClaims;
}

/** The Access JWT of a request: the header Access sets, else the CF_Authorization cookie. */
export function accessToken(req: Request): string | null {
  const h = req.headers.get("cf-access-jwt-assertion");
  if (h) return h;
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === ACCESS_COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

const refuse = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

/**
 * null = serve the request; else the answer to send. `open` = a webhook route (index.ts decides): served on
 * every host without a JWT, since Telegram and other platforms cannot pass Access. The route handler checks its
 * own secret.
 */
export async function accessGate(
  req: Request,
  env: AccessEnv,
  open: boolean,
  now = Date.now(),
): Promise<Response | null> {
  if (!env.ACCESS_AUD) return null;
  if (open) return null;
  const url = new URL(req.url);
  const domain = env.ACCESS_DOMAIN?.toLowerCase();
  if (domain && url.hostname.toLowerCase() !== domain) {
    const ops = url.pathname === "/ops" || url.pathname.startsWith("/ops/");
    if (ops && env.ACCESS_WORKERS_DEV !== "webhooks") return null;
    const get = req.method === "GET" || req.method === "HEAD";
    return new Response(null, {
      status: get ? 302 : 307,
      headers: { location: `https://${domain}${url.pathname}${url.search}`, "cache-control": "no-store" },
    });
  }
  const tok = accessToken(req);
  if (tok && (await verifyAccessJwt(tok, env, now))) return null;
  return refuse(403, "access required");
}
