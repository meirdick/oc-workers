// Worker routes (spec 08 §19): ops auth and CI limits, proxy auth, 421 retry, cron → ctl.ensure().
import { describe, expect, it } from "vitest";
import worker, { resetPointerCache } from "../../src/index";
import { resetSessionCache } from "../../src/ingress/session";
import { handleOps, roleOf } from "../../src/ops";
import { fakeAuthNs, ownerCookie } from "../ingress/fake-auth";

function env(o: { test?: boolean; rt421?: number } = {}) {
  const calls: { cls: string; name: string; m: string; a: unknown[] }[] = [];
  let n421 = o.rt421 ?? 0;
  const ns = (cls: string, impl: Record<string, (...a: unknown[]) => unknown>) => ({
    getByName: (name: string) =>
      new Proxy(
        {},
        {
          get:
            (_t, m: string) =>
            async (...a: unknown[]) => {
              calls.push({ cls, name, m, a });
              const f = impl[m];
              return f ? f(...a) : { ok: true };
            },
        },
      ),
  });
  const e = {
    OC_INST: "t1",
    OC_TEST: o.test ? "1" : "0",
    CONTROL_TOKEN: "owner-token",
    CI_TOKEN: "ci-token",
    TELEGRAM_WEBHOOK_SECRET: "wh",
    CONTROL: ns("ctl", {
      status: () => ({ epoch: { n: n421 > 0 ? 1 : 2 } }),
      ops: (r: unknown) => ({ status: 200, body: { served: (r as { action: string }).action } }),
      ensure: () => ({ ok: true }),
    }),
    RUNTIME: ns("rt", {
      fetch: () => {
        if (n421 > 0) {
          n421--;
          return new Response("retired", { status: 421 });
        }
        return new Response("gateway", { status: 200 });
      },
      fault: () => ({ ok: true }),
    }),
  };
  (e as Record<string, unknown>).AUTH = fakeAuthNs(() => e as Record<string, unknown>).ns;
  return { e: e as never, calls };
}
const req = (path: string, token?: string, init: RequestInit = {}) =>
  new Request(`https://oc.example.workers.dev${path}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;

describe("ops routes §19.2", () => {
  it("roles: owner, ci, none", async () => {
    const { e } = env();
    expect(await roleOf(req("/ops/status", "owner-token"), e)).toBe("owner");
    expect(await roleOf(req("/ops/status", "ci-token"), e)).toBe("ci");
    expect(await roleOf(req("/ops/status", "nope"), e)).toBeNull();
  });
  it("S30 CI token on each destructive route → 404; read routes 200", async () => {
    const { e } = env();
    for (const a of [
      "wake",
      "start",
      "stop",
      "restart",
      "sleep",
      "epoch/roll",
      "restore",
      "inbox",
      "events",
      "logs",
      "fault",
    ])
      expect([
        a,
        (await handleOps(req(`/ops/${a}`, "ci-token", { method: "POST" }), e, async () => 1)).status,
      ]).toEqual([a, 404]);
    for (const a of ["status", "idle", "images-in-use", "deploy-check"])
      expect([a, (await handleOps(req(`/ops/${a}`, "ci-token"), e, async () => 1)).status]).toEqual([a, 200]);
  });
  it("unknown /ops path and no token → 404; /ops/fault only with OC_TEST=1", async () => {
    const { e } = env();
    expect((await handleOps(req("/ops/nope", "owner-token"), e, async () => 1)).status).toBe(404);
    expect((await handleOps(req("/ops/status"), e, async () => 1)).status).toBe(404);
    const body = JSON.stringify({ name: "capacity" });
    expect(
      (await handleOps(req("/ops/fault", "owner-token", { method: "POST", body }), e, async () => 1)).status,
    ).toBe(404);
    const t = env({ test: true });
    const r = await handleOps(req("/ops/fault", "owner-token", { method: "POST", body }), t.e, async () => 1);
    expect(r.status).toBe(200);
    expect(t.calls.some((c) => c.cls === "rt" && c.m === "fault")).toBe(true);
  });
});

describe("worker fetch §19.1", () => {
  it("proxy without the owner cookie → 404 and no Runtime call (no wake)", async () => {
    resetPointerCache();
    const { e, calls } = env();
    const r = await worker.fetch(req("/chat"), e, ctx);
    expect(r.status).toBe(404);
    expect(calls.filter((c) => c.cls === "rt").length).toBe(0);
  });
  it("proxy with the owner cookie reaches rt:<inst>:e<N>; 421 → pointer refresh and one retry", async () => {
    resetPointerCache();
    resetSessionCache();
    const { e, calls } = env({ rt421: 1 });
    expect((await worker.fetch(req("/chat", "owner-token"), e, ctx)).status).toBe(404); // M3: bearer is not enough
    const cookie = await ownerCookie(e as Record<string, unknown>);
    const r = await worker.fetch(req("/chat", undefined, { headers: { cookie } }), e, ctx);
    expect(r.status).toBe(200);
    const rt = calls.filter((c) => c.cls === "rt" && c.m === "fetch");
    expect(rt.map((c) => c.name)).toEqual(["rt:t1:e1", "rt:t1:e2"]);
  });
  it("unknown /_ochost/* → 404 (M3 routes: test/ingress); /ops routes go to the Control DO", async () => {
    resetPointerCache();
    const { e } = env();
    expect((await worker.fetch(req("/_ochost/nope", "owner-token"), e, ctx)).status).toBe(404);
    const r = await worker.fetch(req("/ops/status", "owner-token"), e, ctx);
    expect(await r.json()).toEqual({ served: "status" });
  });
  it("cron → ctl.ensure()", async () => {
    const { e, calls } = env();
    const waits: Promise<unknown>[] = [];
    await worker.scheduled({} as never, e, { waitUntil: (p: Promise<unknown>) => waits.push(p) } as never);
    await Promise.all(waits);
    expect(calls.some((c) => c.cls === "ctl" && c.m === "ensure")).toBe(true);
  });
});
