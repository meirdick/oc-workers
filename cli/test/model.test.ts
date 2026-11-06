import { describe, expect, it } from "vitest";
import { formatModels, listModels, setModel, withPrimary } from "../src/model.ts";
import { cf, fakeFetch, fakeOps, TOKEN } from "./fakes.ts";

const ACCT = "0123456789abcdef0123456789abcdef";
const m = (name: string, props: Record<string, string>, created = "2026-01-01") => ({
  name,
  created_at: created,
  properties: Object.entries(props).map(([property_id, value]) => ({ property_id, value })),
});
const MODELS = [
  m("@cf/meta/llama-3.2-1b-instruct", { context_window: "60000" }),
  m("@cf/openai/gpt-oss-120b", { context_window: "128000", function_calling: "true" }, "2025-08-01"),
  m("@cf/zai-org/glm-5.3", { context_window: "1048576", function_calling: "true" }, "2026-10-01"),
  m(
    "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    { context_window: "1048576", function_calling: "true", reasoning: "true" },
    "2026-10-17",
  ),
];
const searchFetch = () =>
  fakeFetch([
    [`GET https://api.cloudflare.com/client/v4/accounts/${ACCT}/ai/models/search`, () => cf(MODELS)],
  ]);

describe("model list", () => {
  it("keeps tool-capable models; primary first, then shortlist, then newest", async () => {
    const ff = searchFetch();
    const ms = await listModels({ acct: ACCT, token: TOKEN }, { fetch: ff.fetch });
    expect(ms.map((x) => x.name)).toEqual([
      "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
      "@cf/openai/gpt-oss-120b",
      "@cf/zai-org/glm-5.3",
    ]);
    expect(ff.calls[0]?.url).toMatch(/task=Text%20Generation/);
    const t = formatModels(ms);
    expect(t.split("\n")[0]).toMatch(
      /^\*s {2}@cf\/deepseek-ai\/deepseek-v4\.1-flash-1017 {2}1024k {2}tools {2}reasoning$/,
    );
  });
  it("--all keeps models without tools", async () => {
    expect(
      await listModels({ acct: ACCT, token: TOKEN, all: true }, { fetch: searchFetch().fetch }),
    ).toHaveLength(4);
  });
});

describe("model set through the gate", () => {
  const d = { fetch: searchFetch().fetch, log: () => {} };
  it("anthropic/<model> is a cfgw model with a provider entry; the hop runs first", async () => {
    const o = fakeOps();
    const asked: string[] = [];
    const r = await setModel(
      {
        id: "anthropic/claude-sonnet-4-6",
        hop: async (m) => {
          asked.push(m);
          return { status: 200 };
        },
      },
      o.ops,
      d,
    );
    expect(asked).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(r.primary).toBe("anthropic/claude-sonnet-4-6");
    expect(o.versions.at(-1)?.doc.agents.defaults.model.primary).toBe("cfgw/anthropic/claude-sonnet-4-6");
  });
  it("a refusal stops before any config post; 429 and no answer only warn", async () => {
    const o = fakeOps();
    await expect(
      setModel({ id: "anthropic/x", hop: async () => ({ status: 502, error: "no provider key" }) }, o.ops, d),
    ).rejects.toThrow(/did not answer through the gate \(502 no provider key\).*Provider Keys/);
    expect(o.calls.filter((c) => c.method === "POST")).toEqual([]);
    const logs: string[] = [];
    await setModel({ id: "@cf/a/b", hop: async () => ({ status: 429 }) }, o.ops, {
      fetch: d.fetch,
      log: (l) => logs.push(l),
    });
    expect(logs[0]).toMatch(/^WARN: @cf\/a\/b not checked \(429\)/);
  });
});

describe("model set", () => {
  const base = {
    agents: { defaults: { model: { primary: "cfgw/@cf/deepseek-ai/deepseek-v4.1-flash-1017" } } },
    models: {
      providers: {
        cfgw: { baseUrl: "x", models: [{ id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", name: "DS" }] },
      },
    },
    channels: { telegram: { enabled: true } },
  };
  it("withPrimary sets primary/fallbacks, adds provider models, keeps other keys", () => {
    const d = withPrimary(base, "@cf/openai/gpt-oss-120b", ["@cf/deepseek-ai/deepseek-v4.1-flash-1017"]);
    expect(d.agents.defaults.model).toEqual({
      primary: "cfgw/@cf/openai/gpt-oss-120b",
      fallbacks: ["cfgw/@cf/deepseek-ai/deepseek-v4.1-flash-1017"],
    });
    expect(d.models.providers.cfgw.models.map((x: any) => x.id)).toEqual([
      "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
      "@cf/openai/gpt-oss-120b",
    ]);
    expect(d.channels).toEqual(base.channels);
    expect(base.agents.defaults.model.primary).toBe("cfgw/@cf/deepseek-ai/deepseek-v4.1-flash-1017");
  });
  it("posts a new version on the current base; checks the id on Workers AI", async () => {
    const o = fakeOps();
    o.versions.push({ ver: 3, doc: base });
    const r = await setModel({ id: "@cf/openai/gpt-oss-120b", token: TOKEN, acct: ACCT }, o.ops, {
      fetch: searchFetch().fetch,
      log: () => {},
    });
    expect(r).toMatchObject({ ver: 4, primary: "@cf/openai/gpt-oss-120b" });
    expect(o.calls.at(-1)?.body.baseVer).toBe(3);
    expect(o.versions.at(-1)?.doc.agents.defaults.model.primary).toBe("cfgw/@cf/openai/gpt-oss-120b");
  });
  it("unknown model, bad id, unrouted provider, base mismatch", async () => {
    const o = fakeOps();
    const d = { fetch: searchFetch().fetch, log: () => {} };
    await expect(setModel({ id: "@cf/x/nope", token: TOKEN, acct: ACCT }, o.ops, d)).rejects.toThrow(
      "Failed: model @cf/x/nope not found on Workers AI — fix: run ochost model list, then ochost model set <id>",
    );
    await expect(setModel({ id: "bad id" }, o.ops, d)).rejects.toThrow(/bad model id/);
    await expect(setModel({ id: "openai/gpt-4.1" }, o.ops, d)).rejects.toThrow(
      /bad model id openai\/gpt-4.1/,
    );
    const conflict = fakeOps({ "POST /ops/config": () => ({ status: 409, body: { ver: 7 } }) });
    conflict.versions.push({ ver: 6, doc: {} });
    await expect(setModel({ id: "@cf/openai/gpt-oss-120b" }, conflict.ops, d)).rejects.toThrow(
      "Failed: config changed elsewhere (base 6, current 7) — fix: run ochost config pull, then set again",
    );
  });
});
