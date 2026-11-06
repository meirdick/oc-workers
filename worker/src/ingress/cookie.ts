// Owner cookie (D4, add §5.4): `__Host-ochost=v<ver>.<sid>.<sig>`. sig = HMAC-SHA256(key of ver, sid),
// base64url. HttpOnly, Secure, SameSite=Strict, Path=/, 30 d. The Auth DO holds the key and the sessions.

export const COOKIE_NAME = "__Host-ochost";
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

const enc = new TextEncoder();

export function b64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hmacKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function sign(key: string, msg: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(key), enc.encode(msg))));
}

export interface CookieParts {
  ver: number;
  sid: string;
  sig: string;
}

const PART = /^v(\d{1,6})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;

export function parseValue(v: string): CookieParts | null {
  const m = PART.exec(v);
  if (!m) return null;
  return { ver: Number(m[1]), sid: m[2] as string, sig: m[3] as string };
}

export async function cookieValue(key: string, ver: number, sid: string): Promise<string> {
  return `v${ver}.${sid}.${await sign(key, `s${ver}.${sid}`)}`;
}

/** Constant-time check of the signature part. */
export async function verifyParts(key: string, p: CookieParts): Promise<boolean> {
  const want = await sign(key, `s${p.ver}.${p.sid}`);
  if (want.length !== p.sig.length) return false;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ p.sig.charCodeAt(i);
  return d === 0;
}

/** Values of our cookie in a Cookie header (a client can send several). */
export function readCookie(header: string | null): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE_NAME) out.push(part.slice(i + 1).trim());
  }
  return out;
}

/** Cookie header without our cookie and the Access cookie (the gateway never sees them). null = nothing left. */
export function stripCookie(header: string | null): string | null {
  if (!header) return null;
  const rest = header
    .split(";")
    .map((p) => p.trim())
    .filter((p) => {
      const name = p.slice(0, p.indexOf("=") < 0 ? p.length : p.indexOf("=")).trim();
      // CF_Authorization is the Access JWT: the gateway and agent code never need it.
      return p && name !== COOKIE_NAME && name !== "CF_Authorization";
    });
  return rest.length ? rest.join("; ") : null;
}

export function setCookie(value: string, maxAgeS = Math.floor(SESSION_TTL_MS / 1000)): string {
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAgeS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
