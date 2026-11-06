// Owner cookie check in the Worker (D4, add §5.4). The signature is checked first with the key cached per
// isolate, so a forged cookie costs no session lookup. A good signature → Auth DO check, cached 5 s.
// Revoke and rotate take effect in every isolate within SESSION_CACHE_MS.
import type { Env } from "../core/types";
import { type AuthRpc, authName } from "./auth-do";
import { type CookieParts, parseValue, readCookie, verifyParts } from "./cookie";

export const SESSION_CACHE_MS = 5000;
/** Key refetch at most this often per isolate (a cookie with an unknown key version asks for it). */
const KEY_REFETCH_MS = 2000;
const KEY_TTL_MS = 60_000;
const MAX_CACHE = 64;

export type IngressEnv = Env & { AUTH?: DurableObjectNamespace };

let keyCache: { inst: string; ver: number; key: string; at: number } | null = null;
const okCache = new Map<string, number>();

/** Test hook: a new isolate. */
export function resetSessionCache() {
  keyCache = null;
  okCache.clear();
}

export function authOf(env: IngressEnv): AuthRpc | null {
  if (!env.AUTH) return null;
  return env.AUTH.getByName(authName(env.OC_INST)) as unknown as AuthRpc;
}

async function keyFor(env: IngressEnv, auth: AuthRpc, ver: number, now: number) {
  const fresh = keyCache && keyCache.inst === env.OC_INST && now - keyCache.at < KEY_TTL_MS;
  const stale = !fresh || (keyCache && ver > keyCache.ver && now - keyCache.at >= KEY_REFETCH_MS);
  if (stale) {
    const k = await auth.key();
    keyCache = { inst: env.OC_INST, ver: k.ver, key: k.key, at: now };
  }
  return keyCache as { ver: number; key: string };
}

export interface OwnerSession {
  sid: string;
}

/** The owner session of this request, or null. Never throws (an Auth DO error → null, fail closed). */
export async function ownerSession(
  req: Request,
  env: IngressEnv,
  now = Date.now(),
): Promise<OwnerSession | null> {
  const auth = authOf(env);
  if (!auth) return null;
  const values = readCookie(req.headers.get("cookie")).slice(0, 3);
  for (const v of values) {
    const p: CookieParts | null = parseValue(v);
    if (!p) continue;
    try {
      const k = await keyFor(env, auth, p.ver, now);
      if (p.ver !== k.ver || !(await verifyParts(k.key, p))) continue;
      const until = okCache.get(p.sid);
      if (until !== undefined && until > now) return { sid: p.sid };
      if (!(await auth.check(p.sid))) {
        okCache.delete(p.sid);
        continue;
      }
      if (okCache.size >= MAX_CACHE) okCache.clear();
      okCache.set(p.sid, now + SESSION_CACHE_MS);
      return { sid: p.sid };
    } catch {
      return null;
    }
  }
  return null;
}

/** Drop a sid from this isolate's cache (logout). */
export function forgetSession(sid: string) {
  okCache.delete(sid);
}
