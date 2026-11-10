import { describe, expect, it } from "vitest";
import { SHIPPED_CATALOG } from "../src/catalog.ts";
import { modelEntry, renderModelRoles, renderOpenclawDoc } from "../src/config.ts";
import {
  fetchCatalog,
  formatModels,
  listModels,
  modelRoles,
  setModel,
  toCatalog,
  withPrimary,
  withRole,
} from "../src/model.ts";
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
      "@cf/zai-org/glm-5.3", // shortlist, newest first
      "@cf/openai/gpt-oss-120b",
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

describe("model roles and effort", () => {
  it("modelEntry: effort enum and vision come from the catalogue facts", () => {
    const ds = modelEntry("@cf/deepseek-ai/deepseek-v4.1-flash-1017") as any;
    expect(ds).toMatchObject({ reasoning: true, input: ["text", "image"] });
    expect(ds.compat).toEqual({
      supportedReasoningEfforts: ["none", "low", "high", "max"],
      reasoningEffortMap: { off: "none" },
    });
    const glm = modelEntry("@cf/zai-org/glm-5.3") as any;
    expect(glm.input).toEqual(["text"]); // no vision
    expect(glm.compat).toEqual({ supportedReasoningEfforts: ["low", "high", "max"] }); // cannot switch off
    expect(modelEntry("@cf/openai/gpt-oss-120b")).toMatchObject({ reasoning: true, input: ["text"] }); // from the catalogue
    expect(modelEntry("anthropic/claude-x")).toMatchObject({ reasoning: false, input: ["text"] });
    expect(modelEntry("anthropic/claude-x")).not.toHaveProperty("compat");
  });
  it("render: thinkingDefault low for the main model, utility and compaction at off per model, both entries in the cfgw list", () => {
    const d = renderOpenclawDoc({ model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017" }) as any;
    const g = "cfgw/@cf/google/gemma-4-26b-a4b-it";
    expect(d.agents.defaults.utilityModel).toBe(g);
    expect(d.agents.defaults.compaction).toEqual({ model: g, thinkingLevel: "off" });
    // the main level is the global default (the Control UI's Thinking row), never a per-model override
    expect(d.agents.defaults.thinkingDefault).toBe("low");
    expect(d.agents.defaults.models["cfgw/@cf/deepseek-ai/deepseek-v4.1-flash-1017"]).toBeUndefined();
    // migration: an older render's per-model low on the main model goes; other params and an owner's level stay
    const main = "cfgw/@cf/deepseek-ai/deepseek-v4.1-flash-1017";
    const old = renderModelRoles({
      ...d,
      agents: {
        ...d.agents,
        defaults: {
          ...d.agents.defaults,
          thinkingDefault: "high",
          models: { ...d.agents.defaults.models, [main]: { params: { thinking: "low", temperature: 0.2 } } },
        },
      },
    }) as any;
    expect(old.agents.defaults.models[main]).toEqual({ params: { temperature: 0.2 } });
    expect(old.agents.defaults.thinkingDefault).toBe("high");
    const kept = renderModelRoles({
      ...d,
      agents: {
        ...d.agents,
        defaults: {
          ...d.agents.defaults,
          models: { ...d.agents.defaults.models, [main]: { params: { thinking: "high" } } },
        },
      },
    }) as any;
    expect(kept.agents.defaults.models[main].params.thinking).toBe("high"); // the owner chose it
    expect(d.agents.defaults.models[g].params.thinking).toBe("off");
    const ids = d.models.providers.cfgw.models.map((x: any) => x.id);
    expect(ids).toEqual(
      expect.arrayContaining(["@cf/deepseek-ai/deepseek-v4.1-flash-1017", "@cf/google/gemma-4-26b-a4b-it"]),
    );
    expect(ids).toHaveLength(SHIPPED_CATALOG.models.length);
  });
  it("render keeps an owner's role choice; a BYOK main model gets no thinking params", () => {
    const d = renderOpenclawDoc({ model: "anthropic/claude-x" }) as any;
    expect(d.agents.defaults.models["cfgw/anthropic/claude-x"]).toBeUndefined();
    const set = withRole(d, "utility", "@cf/zai-org/glm-4.7-flash") as any;
    expect(set.agents.defaults.utilityModel).toBe("cfgw/@cf/zai-org/glm-4.7-flash");
    expect(set.agents.defaults.compaction.model).toBe("cfgw/@cf/google/gemma-4-26b-a4b-it");
  });
  it("withRole compaction: GLM cannot switch off, so its level is low; modelRoles shows all three", () => {
    const d = withRole(
      renderOpenclawDoc({ model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017" }),
      "compaction",
      "@cf/zai-org/glm-5.3",
    );
    expect(modelRoles(d)).toEqual([
      { role: "main", model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", thinking: "low" },
      { role: "utility", model: "@cf/google/gemma-4-26b-a4b-it", thinking: "off" },
      { role: "compaction", model: "@cf/zai-org/glm-5.3", thinking: "low" },
    ]);
  });
  it("set --role utility writes only utilityModel; a deprecated model is refused with a token, warned without", async () => {
    const o = fakeOps();
    o.versions.push({
      ver: 1,
      doc: renderOpenclawDoc({ model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017" }),
    });
    const logs: string[] = [];
    await setModel({ id: "@cf/zai-org/glm-5.3", role: "utility" }, o.ops, {
      fetch: searchFetch().fetch,
      log: (l) => logs.push(l),
    });
    const doc = o.versions.at(-1)?.doc;
    expect(doc.agents.defaults.utilityModel).toBe("cfgw/@cf/zai-org/glm-5.3");
    expect(doc.agents.defaults.model.primary).toBe("cfgw/@cf/deepseek-ai/deepseek-v4.1-flash-1017");
    expect(logs.join()).toMatch(/deprecation date not checked/);
    const dep = [m("@cf/old/model", { function_calling: "true" })];
    (dep[0] as any).planned_deprecation_date = "2026-11-15";
    const ff = fakeFetch([
      [`GET https://api.cloudflare.com/client/v4/accounts/${ACCT}/ai/models/search`, () => cf(dep)],
    ]);
    await expect(
      setModel({ id: "@cf/old/model", role: "utility", token: TOKEN, acct: ACCT }, o.ops, {
        fetch: ff.fetch,
        log: () => {},
      }),
    ).rejects.toThrow(/deprecated \(planned 2026-11-15\)/);
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
      "@cf/google/gemma-4-26b-a4b-it", // the utility role keeps its entry
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

describe("toCatalog", () => {
  it("keeps function calling without a deprecation date; known ids keep their efforts", () => {
    const c = toCatalog(
      [
        m("@cf/openai/gpt-oss-120b", { context_window: "128000", function_calling: "true" }),
        { ...m("@cf/x/old", { function_calling: "true" }), planned_deprecation_date: "2026-12-01" },
        m("@cf/x/notools", { context_window: "1000" }),
      ],
      "2026-11-06",
    );
    expect(c.models.map((x) => x.id)).toEqual(["@cf/openai/gpt-oss-120b"]);
    expect(c.models[0]?.efforts).toEqual(["low", "medium", "high"]);
    expect(c.date).toBe("2026-11-06");
  });
});

describe("model list --refresh against the search endpoint's real shape", () => {
  // Shape of GET /ai/models/search (v4 page pagination): each item has id, source, name, description, task,
  // created_at, tags and `properties` with string values (price is an array); `result_info` is {count, page,
  // per_page, total_count}, with no total_pages. The server answers 2 items a page whatever per_page asks.
  const item = (name: string, properties: { property_id: string; value: unknown }[]) => ({
    id: `00000000-0000-4000-8000-${String(name.length).padStart(12, "0")}`,
    source: 1,
    name,
    description: "d",
    task: { id: "t", name: "Text Generation", description: "d" },
    created_at: "2026-10-17 12:00:00.000",
    tags: [],
    properties,
  });
  const p = (property_id: string, value: unknown) => ({ property_id, value });
  const price = p("price", [
    { unit: "per M input tokens", price: 0.5, currency: "USD" },
    { unit: "per M output tokens", price: 1.5, currency: "USD" },
  ]);
  const PAGES = [
    [
      item("@cf/meta/llama-3.2-1b-instruct", [p("context_window", "60000")]),
      item("@cf/x/new-tools", [p("context_window", "262144"), p("function_calling", "true"), price]),
    ],
    [
      item("@cf/x/going-away", [p("function_calling", "true"), p("planned_deprecation_date", "2026-12-01")]),
      item("@cf/x/beta-tools", [p("beta", "true"), p("function_calling", "true"), p("reasoning", "true")]),
    ],
    [item("@cf/x/last-tools", [p("function_calling", "true"), p("context_window", "8192")])],
  ];

  it("pages through by total_count, keeps function calling, drops a planned deprecation", async () => {
    const ff = fakeFetch([
      [
        `GET https://api.cloudflare.com/client/v4/accounts/${ACCT}/ai/models/search`,
        (c) => {
          const page = Number(new URL(c.url).searchParams.get("page"));
          return cf(PAGES[page - 1] ?? [], {
            result_info: { count: PAGES[page - 1]?.length ?? 0, page, per_page: 2, total_count: 5 },
          });
        },
      ],
    ]);
    const cat = await fetchCatalog({ acct: ACCT, token: TOKEN, date: "2026-11-06" }, { fetch: ff.fetch });
    expect(cat.models.map((x) => x.id)).toEqual(["@cf/x/beta-tools", "@cf/x/last-tools", "@cf/x/new-tools"]);
    expect(cat.models.find((x) => x.id === "@cf/x/new-tools")).toMatchObject({
      contextWindow: 262144,
      priceInPerM: 0.5,
      priceOutPerM: 1.5,
    });
    expect(cat.models.find((x) => x.id === "@cf/x/beta-tools")?.supportsReasoning).toBe(true);
    expect(ff.calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2", "3"]);
  });

  it("without result_info it stops at the first empty page", async () => {
    const ff = fakeFetch([
      [
        `GET https://api.cloudflare.com/client/v4/accounts/${ACCT}/ai/models/search`,
        (c) => cf(PAGES[Number(new URL(c.url).searchParams.get("page")) - 1] ?? []),
      ],
    ]);
    const cat = await fetchCatalog({ acct: ACCT, token: TOKEN, date: "2026-11-06" }, { fetch: ff.fetch });
    expect(cat.models).toHaveLength(3);
    expect(ff.calls).toHaveLength(4);
  });
});
