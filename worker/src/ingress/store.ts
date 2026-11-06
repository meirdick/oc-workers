// Auth store (D4, add §5.4) on DO SQLite: cookie key, owner sessions, one-time login codes, login rate
// limits. Pure logic over a SQL handle and a clock, so vitest runs it on node:sqlite.
import { sha256Hex } from "../core/ids";
import { cookieValue, randomToken, SESSION_TTL_MS } from "./cookie";

export interface SqlLike {
  exec(q: string, ...b: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** Limits (guess: values; no measurement). One window per key. */
export const LIMITS = {
  windowMs: 10 * 60_000,
  /** Failed logins per client IP per window. */
  ipFail: 5,
  /** Login attempts (any result) per client IP per window. */
  ipTry: 20,
  /** Failed logins, all IPs, per window. Past it every login gets 429; `ochost open` (bearer) still works. */
  allFail: 30,
  maxSessions: 20,
  codeTtlMs: 5 * 60_000,
  maxCodes: 10,
  /** lastSeen is written at most this often per session. */
  touchMs: 60_000,
} as const;

/** The limits the store applies; settings `login.*` (core/tunables.ts) change them per call. */
export interface AuthLimits {
  windowMs: number;
  ipFail: number;
  ipTry: number;
  allFail: number;
  maxSessions: number;
  codeTtlMs: number;
  maxCodes: number;
  sessionTtlMs: number;
}

export const DEFAULT_LIMITS: AuthLimits = Object.freeze({
  windowMs: LIMITS.windowMs,
  ipFail: LIMITS.ipFail,
  ipTry: LIMITS.ipTry,
  allFail: LIMITS.allFail,
  maxSessions: LIMITS.maxSessions,
  codeTtlMs: LIMITS.codeTtlMs,
  maxCodes: LIMITS.maxCodes,
  sessionTtlMs: SESSION_TTL_MS,
});

/** Settings `login` block → AuthLimits. */
export function limitsFrom(l: {
  sessionDays: number;
  maxSessions: number;
  codeMinutes: number;
  rateLimits: { windowMinutes: number; ipFail: number; ipTry: number; allFail: number; maxCodes: number };
}): AuthLimits {
  return {
    windowMs: l.rateLimits.windowMinutes * 60_000,
    ipFail: l.rateLimits.ipFail,
    ipTry: l.rateLimits.ipTry,
    allFail: l.rateLimits.allFail,
    maxSessions: l.maxSessions,
    codeTtlMs: l.codeMinutes * 60_000,
    maxCodes: l.rateLimits.maxCodes,
    sessionTtlMs: l.sessionDays * 86_400_000,
  };
}

export type LoginOut =
  | { ok: true; cookie: string; id: string; maxAgeS: number }
  | { ok: false; status: 401 | 429 | 404; retryAfterS?: number };

export interface SessionRow {
  id: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
  userAgent: string;
  ip: string;
  via: string;
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS auth_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS sessions (h TEXT PRIMARY KEY, pub TEXT NOT NULL, created_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL, ua TEXT NOT NULL, ip TEXT NOT NULL, via TEXT NOT NULL)`,
  "CREATE TABLE IF NOT EXISTS codes (h TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS rate (k TEXT PRIMARY KEY, win INTEGER NOT NULL, n INTEGER NOT NULL)",
];

async function sha(s: string): Promise<string> {
  return sha256Hex(s);
}

/** Constant-time compare of sha256(a) and sha256(b) (§19.2 pattern). */
export async function tokenEqual(a: string, b: string | undefined): Promise<boolean> {
  if (!b || !a) return false;
  const [x, y] = await Promise.all([sha(a), sha(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

export class AuthStore {
  constructor(
    private sql: SqlLike,
    private now: () => number,
    private controlToken: () => string | undefined,
    private limits: () => AuthLimits = () => DEFAULT_LIMITS,
  ) {
    for (const q of SCHEMA) sql.exec(q);
  }

  private meta(k: string): string | null {
    const r = this.sql.exec("SELECT v FROM auth_meta WHERE k = ?", k).toArray()[0];
    return r ? String(r.v) : null;
  }
  private setMeta(k: string, v: string) {
    this.sql.exec(
      "INSERT INTO auth_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k,
      v,
    );
  }

  /** Current cookie key; made on first use (no secret to set at init, D7). */
  key(): { ver: number; key: string } {
    let key = this.meta("key");
    let ver = Number(this.meta("keyVer") ?? "0");
    if (!key || !ver) {
      key = randomToken(32);
      ver = ver + 1;
      this.setMeta("key", key);
      this.setMeta("keyVer", String(ver));
    }
    return { ver, key };
  }

  // ---- rate limits ----
  private count(k: string): number {
    const now = this.now();
    const r = this.sql.exec("SELECT win, n FROM rate WHERE k = ?", k).toArray()[0];
    if (!r || Number(r.win) + this.limits().windowMs <= now) return 0;
    return Number(r.n);
  }
  private retryAfter(k: string): number {
    const r = this.sql.exec("SELECT win FROM rate WHERE k = ?", k).toArray()[0];
    if (!r) return 1;
    return Math.max(1, Math.ceil((Number(r.win) + this.limits().windowMs - this.now()) / 1000));
  }
  private bump(k: string) {
    const now = this.now();
    const r = this.sql.exec("SELECT win, n FROM rate WHERE k = ?", k).toArray()[0];
    if (!r || Number(r.win) + this.limits().windowMs <= now)
      this.sql.exec(
        "INSERT INTO rate (k, win, n) VALUES (?, ?, 1) ON CONFLICT(k) DO UPDATE SET win = excluded.win, n = 1",
        k,
        now,
      );
    else this.sql.exec("UPDATE rate SET n = n + 1 WHERE k = ?", k);
  }
  private prune() {
    const now = this.now();
    this.sql.exec("DELETE FROM rate WHERE win + ? <= ?", this.limits().windowMs, now);
    this.sql.exec("DELETE FROM codes WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
  }

  /** 429 answer when a limit for this IP or for all IPs is reached; else null. */
  private limited(ip: string): LoginOut | null {
    const keys: [string, number][] = [
      [`fail:${ip}`, this.limits().ipFail],
      [`try:${ip}`, this.limits().ipTry],
      ["fail:*", this.limits().allFail],
    ];
    for (const [k, max] of keys)
      if (this.count(k) >= max) return { ok: false, status: 429, retryAfterS: this.retryAfter(k) };
    return null;
  }
  private fail(ip: string) {
    this.bump(`fail:${ip}`);
    this.bump("fail:*");
  }

  // ---- sessions ----
  private async newSession(ua: string, ip: string, via: string): Promise<LoginOut> {
    const now = this.now();
    const sid = randomToken(32);
    const h = await sha(sid);
    this.sql.exec(
      `INSERT INTO sessions (h, pub, created_at, last_seen, expires_at, ua, ip, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      h,
      h.slice(0, 12),
      now,
      now,
      now + this.limits().sessionTtlMs,
      ua.slice(0, 200),
      ip.slice(0, 64),
      via,
    );
    // Cap: the oldest sessions end first.
    this.sql.exec(
      "DELETE FROM sessions WHERE h NOT IN (SELECT h FROM sessions ORDER BY created_at DESC LIMIT ?)",
      this.limits().maxSessions,
    );
    const { ver, key } = this.key();
    return {
      ok: true,
      cookie: await cookieValue(key, ver, sid),
      id: h.slice(0, 12),
      maxAgeS: Math.floor(this.limits().sessionTtlMs / 1000),
    };
  }

  /** POST /_ochost/login: the owner token once → a session. Rate-limited per IP and for all IPs. */
  async login(token: string, ip: string, ua: string): Promise<LoginOut> {
    this.prune();
    const lim = this.limited(ip);
    if (lim) return lim;
    this.bump(`try:${ip}`);
    if (!(await tokenEqual(token, this.controlToken()))) {
      this.fail(ip);
      return { ok: false, status: 401 };
    }
    return this.newSession(ua, ip, "token");
  }

  /** One-time login code for `ochost open` (owner bearer). Single use, 5 min. */
  async mintCode(): Promise<{ code: string; expiresAt: number }> {
    this.prune();
    const code = randomToken(24);
    const expiresAt = this.now() + this.limits().codeTtlMs;
    this.sql.exec("INSERT INTO codes (h, expires_at) VALUES (?, ?)", await sha(code), expiresAt);
    this.sql.exec(
      "DELETE FROM codes WHERE h NOT IN (SELECT h FROM codes ORDER BY expires_at DESC LIMIT ?)",
      this.limits().maxCodes,
    );
    return { code, expiresAt };
  }

  /** GET /_ochost/login/<code>: spend the code → a session. Unknown, spent or expired → 404. */
  async redeem(code: string, ip: string, ua: string): Promise<LoginOut> {
    this.prune();
    const lim = this.limited(ip);
    if (lim) return lim;
    this.bump(`try:${ip}`);
    const h = await sha(code);
    const r = this.sql.exec("SELECT h FROM codes WHERE h = ? AND expires_at > ?", h, this.now()).toArray()[0];
    if (!r) {
      this.fail(ip);
      return { ok: false, status: 404 };
    }
    this.sql.exec("DELETE FROM codes WHERE h = ?", h);
    return this.newSession(ua, ip, "code");
  }

  /** Session alive? Updates lastSeen at most once per LIMITS.touchMs. */
  async check(sid: string): Promise<boolean> {
    const now = this.now();
    const h = await sha(sid);
    const r = this.sql
      .exec("SELECT last_seen FROM sessions WHERE h = ? AND expires_at > ?", h, now)
      .toArray()[0];
    if (!r) return false;
    if (now - Number(r.last_seen) >= LIMITS.touchMs)
      this.sql.exec("UPDATE sessions SET last_seen = ? WHERE h = ?", now, h);
    return true;
  }

  async logout(sid: string): Promise<boolean> {
    const h = await sha(sid);
    const n = this.sql.exec("SELECT 1 FROM sessions WHERE h = ?", h).toArray().length;
    this.sql.exec("DELETE FROM sessions WHERE h = ?", h);
    return n > 0;
  }

  list(): SessionRow[] {
    this.prune();
    return this.sql
      .exec("SELECT pub, created_at, last_seen, expires_at, ua, ip, via FROM sessions ORDER BY created_at")
      .toArray()
      .map((r) => ({
        id: String(r.pub),
        createdAt: Number(r.created_at),
        lastSeen: Number(r.last_seen),
        expiresAt: Number(r.expires_at),
        userAgent: String(r.ua),
        ip: String(r.ip),
        via: String(r.via),
      }));
  }

  /** End one session by its public id (from list()). */
  revoke(id: string): { ok: boolean; ended: number } {
    if (!/^[0-9a-f]{12}$/.test(id)) return { ok: false, ended: 0 };
    const n = this.sql.exec("SELECT 1 FROM sessions WHERE pub = ?", id).toArray().length;
    this.sql.exec("DELETE FROM sessions WHERE pub = ?", id);
    return { ok: n > 0, ended: n };
  }

  /** New cookie key; every session and code ends. */
  rotate(): { ended: number; keyVer: number } {
    const ended = this.sql.exec("SELECT 1 FROM sessions").toArray().length;
    this.sql.exec("DELETE FROM sessions");
    this.sql.exec("DELETE FROM codes");
    const ver = Number(this.meta("keyVer") ?? "0") + 1;
    this.setMeta("key", randomToken(32));
    this.setMeta("keyVer", String(ver));
    return { ended, keyVer: ver };
  }
}
