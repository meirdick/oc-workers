// Cloudflare Access front door (ingress/access.ts): JWT verification against a generated key pair and JWKS
// fixture, and the custom-domain vs workers.dev rules in the Worker entry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { accessGate, accessToken, resetAccessCache, verifyAccessJwt } from "../../src/ingress/access";
import { stripCookie } from "../../src/ingress/cookie";

const TEAM = "acme.cloudflareaccess.com";
const AUD = "aud-tag-123";
const DOMAIN = "oc.example.com";
const env = { ACCESS_AUD: AUD, ACCESS_TEAM: TEAM, ACCESS_DOMAIN: DOMAIN };
const NOW = 1_800_000_000_000;

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
async function keypair(kid: string) {
  const kp = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey & { kid?: string };
  jwk.kid = kid;
  return { priv: kp.privateKey, jwk };
}
async function sign(
  priv: CryptoKey,
  kid: string,
  claims: Record<string, unknown>,
  head: Record<string, unknown> = {},
) {
  const h = enc({ alg: "RS256", kid, typ: "JWT", ...head });
  const p = enc(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
}
const good = (over: Record<string, unknown> = {}) => ({
  iss: `https://${TEAM}`,
  aud: [AUD],
  email: "me@example.com",
  exp: NOW / 1000 + 600,
  iat: NOW / 1000,
  ...over,
});

let k1: Awaited<ReturnType<typeof keypair>>;
let k2: Awaited<ReturnType<typeof keypair>>;
let published: unknown[];
let fetches: number;

beforeEach(async () => {
  resetAccessCache();
  k1 = await keypair("k1");
  k2 = await keypair("k2");
  published = [k1.jwk];
  fetches = 0;
  vi.stubGlobal("fetch", async (u: string) => {
    fetches++;
    if (u !== `https://${TEAM}/cdn-cgi/access/certs`) return new Response("no", { status: 404 });
    return Response.json({ keys: published });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("verifyAccessJwt", () => {
  it("accepts a good token and returns the claims", async () => {
    const c = await verifyAccessJwt(await sign(k1.priv, "k1", good()), env, NOW);
    expect(c?.email).toBe("me@example.com");
  });
  it("accepts aud as a plain string", async () => {
    expect(await verifyAccessJwt(await sign(k1.priv, "k1", good({ aud: AUD })), env, NOW)).not.toBeNull();
  });
  it.each([
    ["wrong aud", { aud: ["other"] }],
    ["wrong iss", { iss: "https://evil.cloudflareaccess.com" }],
    ["expired", { exp: NOW / 1000 - 120 }],
    ["not yet valid", { nbf: NOW / 1000 + 300 }],
    ["no exp", { exp: undefined }],
  ])("rejects %s", async (_n, over) => {
    expect(await verifyAccessJwt(await sign(k1.priv, "k1", good(over)), env, NOW)).toBeNull();
  });
  it("rejects a token signed by another key under a known kid", async () => {
    expect(await verifyAccessJwt(await sign(k2.priv, "k1", good()), env, NOW)).toBeNull();
  });
  it("rejects alg none / HS256 and garbage", async () => {
    const h = enc({ alg: "none", kid: "k1" });
    expect(await verifyAccessJwt(`${h}.${enc(good())}.`, env, NOW)).toBeNull();
    const t = await sign(k1.priv, "k1", good(), { alg: "HS256" });
    expect(await verifyAccessJwt(t, env, NOW)).toBeNull();
    expect(await verifyAccessJwt("a.b", env, NOW)).toBeNull();
    expect(await verifyAccessJwt("a.b.c", env, NOW)).toBeNull();
  });
  it("is off without ACCESS_AUD or ACCESS_TEAM (fail closed)", async () => {
    const t = await sign(k1.priv, "k1", good());
    expect(await verifyAccessJwt(t, { ACCESS_TEAM: TEAM }, NOW)).toBeNull();
    expect(await verifyAccessJwt(t, { ACCESS_AUD: AUD }, NOW)).toBeNull();
  });
  it("fails closed when the JWKS cannot be fetched", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    expect(await verifyAccessJwt(await sign(k1.priv, "k1", good()), env, NOW)).toBeNull();
  });
  it("caches the JWKS for 1 h", async () => {
    const t = await sign(k1.priv, "k1", good({ exp: NOW / 1000 + 7200 }));
    await verifyAccessJwt(t, env, NOW);
    await verifyAccessJwt(t, env, NOW + 3_000_000);
    expect(fetches).toBe(1);
    await verifyAccessJwt(t, env, NOW + 3_700_000);
    expect(fetches).toBe(2);
  });
  it("refetches on an unknown kid, at most once per 30 s", async () => {
    await verifyAccessJwt(await sign(k1.priv, "k1", good()), env, NOW);
    expect(fetches).toBe(1);
    const t2 = await sign(k2.priv, "k2", good());
    // rotation: k2 is not published yet; a forged-kid flood must not refetch more than once per 30 s
    expect(await verifyAccessJwt(t2, env, NOW + 1000)).toBeNull();
    expect(fetches).toBe(1);
    published = [k1.jwk, k2.jwk];
    expect(await verifyAccessJwt(t2, env, NOW + 31_000)).not.toBeNull();
    expect(fetches).toBe(2);
  });
});

describe("accessToken", () => {
  it("prefers the header, else the CF_Authorization cookie", () => {
    const r = (h: Record<string, string>) => new Request(`https://${DOMAIN}/`, { headers: h });
    expect(accessToken(r({ "cf-access-jwt-assertion": "H", cookie: "CF_Authorization=C" }))).toBe("H");
    expect(accessToken(r({ cookie: "a=1; CF_Authorization=C; b=2" }))).toBe("C");
    expect(accessToken(r({ cookie: "xCF_Authorization=C" }))).toBeNull();
    expect(accessToken(r({}))).toBeNull();
  });
  it("the cookie is stripped before the gateway sees the cookie header", () => {
    expect(stripCookie("a=1; CF_Authorization=C; b=2")).toBe("a=1; b=2");
    expect(stripCookie("CF_Authorization=C")).toBeNull();
  });
});

describe("accessGate rules", () => {
  const at = (host: string, path = "/", init: RequestInit = {}) =>
    new Request(`https://${host}${path}`, init);
  it("is a no-op when ACCESS_AUD is unset", async () => {
    expect(await accessGate(at("x.workers.dev"), {}, false, NOW)).toBeNull();
    expect(await accessGate(at(DOMAIN), {}, false, NOW)).toBeNull();
  });
  it("custom domain without a JWT → 403; with header or cookie JWT → pass", async () => {
    expect((await accessGate(at(DOMAIN), env, false, NOW))?.status).toBe(403);
    const t = await sign(k1.priv, "k1", good());
    expect(
      await accessGate(at(DOMAIN, "/", { headers: { "cf-access-jwt-assertion": t } }), env, false, NOW),
    ).toBeNull();
    expect(
      await accessGate(at(DOMAIN, "/", { headers: { cookie: `CF_Authorization=${t}` } }), env, false, NOW),
    ).toBeNull();
    const bad = await sign(k2.priv, "k1", good());
    expect(
      (await accessGate(at(DOMAIN, "/", { headers: { cookie: `CF_Authorization=${bad}` } }), env, false, NOW))
        ?.status,
    ).toBe(403);
  });
  it("a WebSocket upgrade on the custom domain is checked by the cookie", async () => {
    const t = await sign(k1.priv, "k1", good());
    const ws = (c?: string) =>
      at(DOMAIN, "/", {
        headers: { upgrade: "websocket", ...(c ? { cookie: `CF_Authorization=${c}` } : {}) },
      });
    expect((await accessGate(ws(), env, false, NOW))?.status).toBe(403);
    expect(await accessGate(ws(t), env, false, NOW)).toBeNull();
  });
  it("host match ignores case", async () => {
    expect((await accessGate(at("OC.Example.com"), env, false, NOW))?.status).toBe(403);
  });
  it("workers.dev: pages redirect to the custom domain, path and query kept", async () => {
    const r = await accessGate(at("x.workers.dev", "/chat?a=1"), env, false, NOW);
    expect(r?.status).toBe(302);
    expect(r?.headers.get("location")).toBe(`https://${DOMAIN}/chat?a=1`);
    const p = await accessGate(at("x.workers.dev", "/x", { method: "POST" }), env, false, NOW);
    expect(p?.status).toBe(307);
  });
  it("workers.dev: /ops passes by default (bearer auth), redirects in webhooks-only mode", async () => {
    expect(await accessGate(at("x.workers.dev", "/ops/status"), env, false, NOW)).toBeNull();
    expect(await accessGate(at("x.workers.dev", "/opsx"), env, false, NOW)).not.toBeNull();
    const strict = { ...env, ACCESS_WORKERS_DEV: "webhooks" };
    expect((await accessGate(at("x.workers.dev", "/ops/status"), strict, false, NOW))?.status).toBe(302);
  });
  it("custom domain /ops still needs the JWT", async () => {
    expect((await accessGate(at(DOMAIN, "/ops/status"), env, false, NOW))?.status).toBe(403);
  });
  it("webhook routes pass on every host without a JWT", async () => {
    expect(
      await accessGate(at("x.workers.dev", "/telegram-webhook", { method: "POST" }), env, true, NOW),
    ).toBeNull();
    expect(await accessGate(at(DOMAIN, "/telegram-webhook", { method: "POST" }), env, true, NOW)).toBeNull();
  });
  it("no ACCESS_DOMAIN set: every host needs the JWT, no redirect", async () => {
    const e = { ACCESS_AUD: AUD, ACCESS_TEAM: TEAM };
    expect((await accessGate(at("x.workers.dev"), e, false, NOW))?.status).toBe(403);
  });
});

describe("Worker entry", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as never;
  const e = (extra: Record<string, unknown> = {}) =>
    ({ OC_INST: "t1", OC_TEST: "0", ...env, ...extra }) as never;
  it("workers.dev page → 302; custom domain page without JWT → 403, with JWT → the owner-cookie layer (404)", async () => {
    const t = await sign(k1.priv, "k1", good({ exp: Date.now() / 1000 + 600 }));
    const a = await worker.fetch(new Request("https://x.workers.dev/chat"), e(), ctx);
    expect(a.status).toBe(302);
    const b = await worker.fetch(new Request(`https://${DOMAIN}/chat`), e(), ctx);
    expect(b.status).toBe(403);
    const c = await worker.fetch(
      new Request(`https://${DOMAIN}/chat`, { headers: { "cf-access-jwt-assertion": t } }),
      e(),
      ctx,
    );
    expect(c.status).toBe(404);
  });
  it("the Telegram secret-path hook is not behind Access on either host (wrong path → its own 404)", async () => {
    for (const host of ["x.workers.dev", DOMAIN]) {
      const r = await worker.fetch(
        new Request(`https://${host}/_ochost/hook/telegram/nope`, { method: "POST" }),
        e(),
        ctx,
      );
      expect(r.status).toBe(404);
    }
  });
  it("Slack, Discord and Twilio hooks are not behind Access on either host", async () => {
    for (const host of ["x.workers.dev", DOMAIN])
      for (const ch of ["slack", "discord", "twilio"]) {
        const r = await worker.fetch(
          new Request(`https://${host}/_ochost/hook/${ch}`, { method: "POST", body: "{}" }),
          e({ CONTROL: { getByName: () => ({ hookSeen: async () => undefined }) } }),
          ctx,
        );
        expect([302, 307, 403]).not.toContain(r.status);
      }
  });
  it("Access off: workers.dev behaves as before", async () => {
    const r = await worker.fetch(new Request("https://x.workers.dev/chat"), { OC_INST: "t1" } as never, ctx);
    expect(r.status).toBe(404);
  });
});
