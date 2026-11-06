// Auth Durable Object `auth:<inst>` (D4, add §5.4). Holds the cookie key, owner sessions, login codes and
// login rate limits. Separate from the Control DO: login traffic and session checks never load it, and the
// proxy keeps working while the Control DO is down (scope Z0.8).
import { DurableObject } from "cloudflare:workers";
import { ctlName, type Env } from "../core/types";
import {
  type AuthLimits,
  AuthStore,
  DEFAULT_LIMITS,
  type LoginOut,
  limitsFrom,
  type SessionRow,
} from "./store";

export const authName = (inst: string) => `auth:${inst}`;

export interface AuthRpc {
  key(): Promise<{ ver: number; key: string }>;
  login(a: { token: string; ip: string; ua: string }): Promise<LoginOut>;
  redeem(a: { code: string; ip: string; ua: string }): Promise<LoginOut>;
  mintCode(): Promise<{ code: string; expiresAt: number }>;
  check(sid: string): Promise<boolean>;
  logout(sid: string): Promise<boolean>;
  list(): Promise<SessionRow[]>;
  revoke(id: string): Promise<{ ok: boolean; ended: number }>;
  rotate(): Promise<{ ended: number; keyVer: number }>;
}

export class Auth extends DurableObject<Env> implements AuthRpc {
  private store: AuthStore;
  private lim: AuthLimits = DEFAULT_LIMITS;
  private limAt = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new AuthStore(
      ctx.storage.sql,
      () => Date.now(),
      () => this.env.CONTROL_TOKEN,
      () => this.lim,
    );
  }

  /** Settings `login.*` from the Control DO, at most every 10 s. Control DO down: the last limits stay. */
  private async load(): Promise<void> {
    if (Date.now() - this.limAt < 10_000) return;
    this.limAt = Date.now();
    try {
      const ctl = this.env.CONTROL.getByName(ctlName(this.env.OC_INST)) as unknown as {
        settingsView(): Promise<{ login: Parameters<typeof limitsFrom>[0] }>;
      };
      this.lim = limitsFrom((await ctl.settingsView()).login);
    } catch {
      // keep the last limits
    }
  }
  async key() {
    return this.store.key();
  }
  async login(a: { token: string; ip: string; ua: string }) {
    await this.load();
    return this.store.login(a.token, a.ip, a.ua);
  }
  async redeem(a: { code: string; ip: string; ua: string }) {
    await this.load();
    return this.store.redeem(a.code, a.ip, a.ua);
  }
  async mintCode() {
    await this.load();
    return this.store.mintCode();
  }
  async check(sid: string) {
    return this.store.check(sid);
  }
  async logout(sid: string) {
    return this.store.logout(sid);
  }
  async list() {
    return this.store.list();
  }
  async revoke(id: string) {
    return this.store.revoke(id);
  }
  async rotate() {
    return this.store.rotate();
  }
}
