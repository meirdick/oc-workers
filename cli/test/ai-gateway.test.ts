import { describe, expect, it } from "vitest";
import {
  type AigDeps,
  chooseGateway,
  cleanContent,
  gateEndpoint,
  gateSmoke,
  gatewayCreateBody,
  hop,
  resolveAiToken,
} from "../src/ai-gateway.ts";
import { cf, cfErr, fakeFetch, type Handler, TOKEN } from "./fakes.ts";

const ACCT = "0123456789abcdef0123456789abcdef";
const API = "https://api.cloudflare.com/client/v4";
const GW = "https://gateway.ai.cloudflare.com/v1";

const pong: Handler = () => ({
  json: { choices: [{ message: { content: "pong" } }], usage: { neurons: 3.3, prompt_tokens: 38 } },
});

function deps(fetch: typeof globalThis.fetch, over: Partial<AigDeps> = {}) {
  const lines: string[] = [];
  const secrets: string[] = [];
  const d: AigDeps = {
    fetch,
    env: {},
    log: (l) => lines.push(l),
    registerSecret: (v) => secrets.push(v),
    sleep: async () => {},
    ...over,
  };
  return { d, lines, secrets };
}

describe("resolveAiToken (the opt-in; there is no prompt)", () => {
  it("no file and no env → null, nothing asked, nothing registered", async () => {
    const { d, secrets } = deps(fakeFetch([]).fetch, { askHidden: async () => "x" });
    expect(await resolveAiToken({}, d)).toBeNull();
    expect(await resolveAiToken({ useEnv: true }, d)).toBeNull();
    expect(secrets).toEqual([]);
  });
  it("--ai-token-file: reads the token, registers it before use", async () => {
    const { d, secrets } = deps(fakeFetch([]).fetch, {
      readFile: async () => ({ text: `${TOKEN}\n`, mode: 0o600 }),
    });
    expect(await resolveAiToken({ tokenFile: "f" }, d)).toEqual({ token: TOKEN, source: "file" });
    expect(secrets).toEqual([TOKEN]);
  });
  it("file with group/other bits → WARN; bad shape → fail", async () => {
    const { d, lines } = deps(fakeFetch([]).fetch, {
      readFile: async () => ({ text: "short", mode: 0o644 }),
    });
    await expect(resolveAiToken({ tokenFile: "f" }, d)).rejects.toThrow(/wrong shape/);
    expect(lines[0]).toMatch(/^WARN: f is readable by others — fix: chmod 600 f/);
  });
  it("env OC_CF_AI_TOKEN counts only when the caller allows it (init does not)", async () => {
    const { d } = deps(fakeFetch([]).fetch, { env: { OC_CF_AI_TOKEN: TOKEN } });
    expect(await resolveAiToken({}, d)).toBeNull();
    expect((await resolveAiToken({ useEnv: true }, d))?.source).toBe("env");
  });
});

describe("chooseGateway without a token", () => {
  it("no --gateway → default, no API call; --gateway is taken as given; none warns about logs", async () => {
    const ff = fakeFetch([]);
    const { d, lines } = deps(ff.fetch);
    expect(await chooseGateway({ accountId: ACCT }, d)).toMatchObject({
      gateway: "default",
      gatewayAction: "default",
      model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    });
    expect(await chooseGateway({ accountId: ACCT, gateway: "mine" }, d)).toMatchObject({
      gateway: "mine",
      gatewayAction: "given",
    });
    const r = await chooseGateway({ accountId: ACCT, gateway: "none" }, d);
    expect(r.gatewayAction).toBe("none");
    expect(r.warnings[0]).toMatch(/^WARN: no AI Gateway: calls run without logs/);
    expect(lines.length).toBe(1);
    expect(ff.calls).toEqual([]);
  });
});

describe("gateSmoke and hop through the gate", () => {
  const ep = gateEndpoint("https://w.example.workers.dev/", "owner-token");
  const GATE = "https://w.example.workers.dev/ops/gate/ai/v1/chat/completions";
  it("posts the owner bearer to /ops/gate and nothing else; pass on 200 with content", async () => {
    const ff = fakeFetch([[`POST ${GATE}`, pong]]);
    const { d } = deps(ff.fetch);
    const r = await gateSmoke({ endpoint: ep, model: "@cf/m/x", gateway: "default" }, d);
    expect(r).toMatchObject({ ok: true, neurons: 3.3, content: "pong" });
    const c = ff.calls[0];
    expect(c?.headers.authorization).toBe("Bearer owner-token");
    expect(JSON.stringify(c?.headers)).not.toContain("cf-aig");
    expect(c?.body.model).toBe("@cf/m/x");
  });
  it("429 and 5xx are tried 3 times, then WARN and ok false", async () => {
    let n = 0;
    const ff = fakeFetch([
      [
        `POST ${GATE}`,
        () => {
          n++;
          return { status: 502, json: { error: { message: "upstream" } } };
        },
      ],
    ]);
    const { d, lines } = deps(ff.fetch);
    const r = await gateSmoke({ endpoint: ep, model: "@cf/m/x", gateway: "default" }, d);
    expect(n).toBe(3);
    expect(r.ok).toBe(false);
    expect(lines[0]).toMatch(/^WARN: model hop returned 502 after 3 tries/);
  });
  it("a missing gateway names the way out; a missing route says deploy; a bad model says model list", async () => {
    const gw = fakeFetch([
      [`POST ${GATE}`, () => ({ status: 400, json: { error: { message: "gateway not found: mine" } } })],
    ]);
    await expect(
      gateSmoke({ endpoint: ep, model: "@cf/m/x", gateway: "mine" }, deps(gw.fetch).d),
    ).rejects.toThrow(/gateway mine does not exist: rerun with --gateway default/);
    const nf = fakeFetch([[`POST ${GATE}`, () => ({ status: 404, text: "not found" })]]);
    await expect(
      gateSmoke({ endpoint: ep, model: "@cf/m/x", gateway: "default" }, deps(nf.fetch).d),
    ).rejects.toThrow(/lacks the AI gate — fix: ochost deploy|did not answer \(404\)/);
    const bm = fakeFetch([
      [`POST ${GATE}`, () => ({ status: 400, json: { error: { message: "no such model" } } })],
    ]);
    await expect(
      gateSmoke({ endpoint: ep, model: "@cf/m/x", gateway: "default" }, deps(bm.fetch).d),
    ).rejects.toThrow(/model @cf\/m\/x failed through the gate \(400 no such model\).*ochost model list/);
  });
  it("hop without an endpoint still sends the token to the gateway (the direct opt-in)", async () => {
    const ff = fakeFetch([[`POST ${GW}/${ACCT}/gw/workers-ai/v1/chat/completions`, pong]]);
    const r = await hop(deps(ff.fetch).d, {
      acct: ACCT,
      gateway: "gw",
      token: TOKEN,
      model: "@cf/m/x",
      messages: [{ role: "user", content: "hi" }],
      skipCache: true,
    });
    expect(r.status).toBe(200);
    expect(ff.calls[0]?.headers["cf-aig-authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(ff.calls[0]?.headers["cf-aig-skip-cache"]).toBe("true");
  });
});

describe("chooseGateway with the opt-in token", () => {
  const verify = [`GET ${API}/accounts/${ACCT}/tokens/verify`, () => cf({ id: "x", status: "active" })] as [
    string,
    Handler,
  ];
  const list403 = [`GET ${API}/accounts/${ACCT}/ai-gateway/gateways`, () => cfErr(10000)] as [
    string,
    Handler,
  ];
  const withToken = (fetch: typeof globalThis.fetch) => deps(fetch, { env: { OC_CF_AI_TOKEN: TOKEN } });

  it("user token, oc-host missing → creates it with the required fields; the token is not returned", async () => {
    const ff = fakeFetch([
      [`GET ${API}/accounts/${ACCT}/tokens/verify`, () => cfErr(1000, 401)],
      [`GET ${API}/user/tokens/verify`, () => cf({ id: "x", status: "active" })],
      [
        `GET ${API}/accounts/${ACCT}/ai-gateway/gateways`,
        () => cf([{ id: "default", authentication: true }]),
      ],
      [`POST ${API}/accounts/${ACCT}/ai-gateway/gateways`, (c) => cf({ id: c.body.id })],
    ]);
    const r = await chooseGateway({ accountId: ACCT, useEnv: true }, withToken(ff.fetch).d);
    expect(r).toMatchObject({ gateway: "oc-host", gatewayAction: "created", tokenKind: "user" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    const create = ff.calls.find((c) => c.method === "POST" && c.url.includes("/ai-gateway/gateways"));
    expect(create?.body).toEqual(gatewayCreateBody("oc-host"));
  });
  it("OAuth first: when the wrangler login can list gateways, it selects with it", async () => {
    const ff = fakeFetch([
      verify,
      [
        `GET ${API}/accounts/${ACCT}/ai-gateway/gateways`,
        (c) =>
          c.headers.authorization === "Bearer oauth"
            ? cf([{ id: "oc-host", authentication: true }])
            : cfErr(10000),
      ],
    ]);
    const { d, lines } = withToken(ff.fetch);
    const r = await chooseGateway({ accountId: ACCT, useEnv: true, oauthToken: "oauth" }, d);
    expect(r.gatewayAction).toBe("selected");
    expect(lines).toContain("AI Gateway: oc-host (selected with the wrangler login)");
  });
  it("Run-only token + --gateway → WARN, the name is taken as given", async () => {
    const ff = fakeFetch([
      [`GET ${API}/accounts/${ACCT}/tokens/verify`, () => cfErr(1000, 401)],
      [`GET ${API}/user/tokens/verify`, () => cf({ id: "x", status: "active" })],
      list403,
    ]);
    const r = await chooseGateway(
      { accountId: ACCT, useEnv: true, gateway: "openclaw-cf" },
      withToken(ff.fetch).d,
    );
    expect(r).toMatchObject({ gateway: "openclaw-cf", gatewayAction: "assumed" });
    expect(r.warnings[0]).toMatch(/^WARN: the token cannot list AI gateways \(10000\)/);
  });
  it("Run-only token without --gateway and nothing answers → cannot read AI Gateway", async () => {
    const ff = fakeFetch([
      verify,
      list403,
      [`POST ${GW}/`, () => ({ status: 404, json: { error: "gateway not found" } })],
    ]);
    await expect(chooseGateway({ accountId: ACCT, useEnv: true }, withToken(ff.fetch).d)).rejects.toThrow(
      "Failed: the token cannot read AI Gateway (10000) and no gateway answered — fix: add AI Gateway: Read and AI Gateway: Edit to the token, or rerun with --gateway <existing gateway id>",
    );
  });
  it("Run-only token without --gateway: finds oc-host by request, else default", async () => {
    const a = fakeFetch([verify, list403, [`POST ${GW}/${ACCT}/oc-host/`, pong]]);
    const ra = await chooseGateway({ accountId: ACCT, useEnv: true }, withToken(a.fetch).d);
    expect(ra).toMatchObject({ gateway: "oc-host", gatewayAction: "assumed" });
    const b = fakeFetch([
      verify,
      list403,
      [`POST ${GW}/${ACCT}/oc-host/`, () => ({ status: 404, json: { error: "gateway not found" } })],
      [`POST ${GW}/${ACCT}/default/`, pong],
    ]);
    const rb = await chooseGateway({ accountId: ACCT, useEnv: true }, withToken(b.fetch).d);
    expect(rb.gateway).toBe("default");
  });
  it("Run-only token, probe 401 → names the missing permission", async () => {
    const ff = fakeFetch([
      verify,
      list403,
      [`POST ${GW}/`, () => ({ status: 401, json: { error: "2009" } })],
    ]);
    await expect(chooseGateway({ accountId: ACCT, useEnv: true }, withToken(ff.fetch).d)).rejects.toThrow(
      /gateway hop returned 401 — fix: the token lacks AI Gateway: Run/,
    );
  });
  it("inactive token → fail; auth off → WARN", async () => {
    const inactive = fakeFetch([
      [`GET ${API}/accounts/${ACCT}/tokens/verify`, () => cf({ id: "x", status: "disabled" })],
    ]);
    await expect(
      chooseGateway({ accountId: ACCT, useEnv: true }, withToken(inactive.fetch).d),
    ).rejects.toThrow(/the AI token is not active/);
    const off = fakeFetch([
      verify,
      [
        `GET ${API}/accounts/${ACCT}/ai-gateway/gateways`,
        () => cf([{ id: "oc-host", authentication: false }]),
      ],
    ]);
    const x = withToken(off.fetch);
    await chooseGateway({ accountId: ACCT, useEnv: true }, x.d);
    expect(x.lines.some((l) => /^WARN: gateway oc-host has authentication off/.test(l))).toBe(true);
  });
});

it("cleanContent strips the ds_safety tag", () => {
  expect(cleanContent("pong<ds_safety>")).toBe("pong");
  expect(cleanContent("  hi </ds_safety> ")).toBe("hi");
});
