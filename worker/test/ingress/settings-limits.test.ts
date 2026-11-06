// login.* settings reach the Auth DO: session lifetime, session cap, code lifetime and the rate limits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Auth } from "../../src/ingress/auth-do";
import { FakeStorage } from "../harness/storage";

type Login = {
  sessionDays: number;
  maxSessions: number;
  codeMinutes: number;
  rateLimits: { windowMinutes: number; ipFail: number; ipTry: number; allFail: number; maxCodes: number };
};
const DEFAULT: Login = {
  sessionDays: 30,
  maxSessions: 20,
  codeMinutes: 5,
  rateLimits: { windowMinutes: 10, ipFail: 5, ipTry: 20, allFail: 30, maxCodes: 10 },
};

let login: Login;
let auth: Auth;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-05T12:00:00Z"));
  login = structuredClone(DEFAULT);
  const env = {
    OC_INST: "t1",
    CONTROL_TOKEN: "owner-token",
    CONTROL: { getByName: () => ({ settingsView: async () => ({ login: structuredClone(login) }) }) },
  };
  auth = new Auth({ storage: new FakeStorage() } as unknown as DurableObjectState, env as never);
});
afterEach(() => vi.useRealTimers());

const ok = (token = "owner-token", ip = "1.1.1.1") => auth.login({ token, ip, ua: "t" });

describe("login settings", () => {
  it("sessionDays sets the cookie Max-Age; a changed value applies after the 10 s cache", async () => {
    const a = await ok();
    expect(a).toMatchObject({ ok: true, maxAgeS: 30 * 86_400 });
    login.sessionDays = 2;
    expect(await ok()).toMatchObject({ maxAgeS: 30 * 86_400 }); // cached
    vi.setSystemTime(Date.now() + 11_000);
    expect(await ok()).toMatchObject({ maxAgeS: 2 * 86_400 });
  });

  it("maxSessions caps the sessions, oldest first", async () => {
    login.maxSessions = 2;
    for (let i = 0; i < 4; i++) {
      await ok();
      vi.setSystemTime(Date.now() + 1000);
    }
    expect((await auth.list()).length).toBe(2);
  });

  it("rateLimits.ipFail and windowMinutes: 429 after N failures, free again after the window", async () => {
    login.rateLimits.ipFail = 2;
    login.rateLimits.windowMinutes = 1;
    expect((await ok("bad")).ok).toBe(false);
    expect(await ok("bad")).toMatchObject({ status: 401 });
    expect(await ok("owner-token")).toMatchObject({ ok: false, status: 429 });
    vi.setSystemTime(Date.now() + 61_000);
    expect((await ok("owner-token")).ok).toBe(true);
  });

  it("codeMinutes sets the login code lifetime", async () => {
    login.codeMinutes = 1;
    const { code, expiresAt } = await auth.mintCode();
    expect(expiresAt - Date.now()).toBe(60_000);
    vi.setSystemTime(Date.now() + 61_000);
    expect(await auth.redeem({ code, ip: "2.2.2.2", ua: "t" })).toMatchObject({ ok: false, status: 404 });
  });

  it("the Control DO not answering keeps the defaults", async () => {
    const env = {
      OC_INST: "t1",
      CONTROL_TOKEN: "owner-token",
      CONTROL: {
        getByName: () => ({
          settingsView: async () => {
            throw new Error("down");
          },
        }),
      },
    };
    const a = new Auth({ storage: new FakeStorage() } as unknown as DurableObjectState, env as never);
    expect(await a.login({ token: "owner-token", ip: "3.3.3.3", ua: "t" })).toMatchObject({
      ok: true,
      maxAgeS: 30 * 86_400,
    });
  });
});
