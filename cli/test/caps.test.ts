// D14 CapGate on the CLI side: rendered OpenClaw config, rendered wrangler.jsonc, `ochost caps`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CAP_URL,
  defaultConfigText,
  FETCH_URL,
  RENDER_VERSION,
  renderCapabilities,
  renderOpenclawDoc,
  validateConfig,
} from "../src/config.ts";
import { renderWranglerJsonc, tokenEraConfig, warnTokenEra } from "../src/deploy.ts";
import { FakeOps, installDir, run } from "./ops-fake.ts";

const ACCT = "a".repeat(32);

/** Every URL string in a doc. */
function urls(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string" && /^(https?|wss?):\/\//.test(v)) out.push(v);
  else if (v && typeof v === "object") for (const x of Object.values(v)) urls(x, out);
  return out;
}

describe("renderCapabilities", () => {
  const doc = renderCapabilities();

  it("browser profile cf attaches at the gate over ws", () => {
    expect(doc.browser.defaultProfile).toBe("cf");
    expect(doc.browser.profiles.cf.cdpUrl).toBe("ws://15.0.0.3/browser/devtools");
  });

  it("web_fetch, memory, tts, stt and image all point at the gate; only the docs MCP leaves it", () => {
    expect(doc.plugins.entries.firecrawl.config.webFetch.baseUrl).toBe(FETCH_URL);
    expect(doc.tools.web.search.provider).toBe("cloudflare-web-search");
    expect(doc.plugins.entries["cf-web-search"]).toEqual({
      enabled: true,
      config: { webSearch: { baseUrl: CAP_URL } },
    });
    expect(doc.plugins.load).toBeUndefined(); // both plugins are bundled extensions (docs/13)
    expect(doc.memory.search.remote.baseUrl).toBe(`${CAP_URL}/ai/v1`);
    expect(doc.tts.providers.openai.baseUrl).toBe(`${CAP_URL}/ai/v1`);
    expect(doc.tools.media.models[0].baseUrl).toBe(`${CAP_URL}/ai/v1`);
    expect(doc.models.providers.openai.baseUrl).toBe(`${CAP_URL}/ai/v1`);
    const outside = urls(doc).filter((u) => !/^(http|ws):\/\/15\.0\.0\.3(?:\/|$)/.test(u) && u !== FETCH_URL);
    expect(outside).toEqual(["https://docs.mcp.cloudflare.com/mcp"]);
  });

  it("holds no credential: the only keys are the placeholder, and no Cloudflare token appears", () => {
    const s = JSON.stringify(doc);
    expect(s).not.toMatch(/OC_CF_AI_TOKEN|cf-aig-authorization|Bearer/);
    expect(s.match(/"apiKey":"([^"]*)"/g)?.every((k) => k === '"apiKey":"capgate"')).toBe(true);
  });
});

describe("renderOpenclawDoc", () => {
  it("with a model: the cfgw provider points at the gate with a dummy key and no header; nothing leaves the container", () => {
    const d = renderOpenclawDoc({ model: "@cf/a/b" }) as any;
    expect(d.agents.defaults.model.primary).toBe("cfgw/@cf/a/b");
    expect(d.agents.defaults.mediaModels.image.primary).toMatch(/^openai\/@cf\//);
    expect(Object.keys(d.models.providers).sort()).toEqual(["cfgw", "openai"]);
    const p = d.models.providers.cfgw;
    expect(p.baseUrl).toBe("http://15.0.0.3/ai/v1");
    expect(p.apiKey).toBe("capgate");
    expect(p.headers).toBeUndefined();
    expect(p.models.map((m: { id: string }) => m.id)).toEqual(["@cf/a/b", "@cf/google/gemma-4-26b-a4b-it"]);
    expect(d.browser.profiles.cf).toBeDefined();
    const s = JSON.stringify(d);
    expect(s).not.toMatch(/OC_CF_AI_TOKEN|cf-aig-authorization|gateway\.ai\.cloudflare\.com|\$\{/);
    const outside = urls(d).filter((u) => !/^(http|ws):\/\/15\.0\.0\.3(\/|$)/.test(u) && u !== FETCH_URL); // FETCH_URL: ocsup's loopback relay to the gate
    expect(outside).toEqual(["https://docs.mcp.cloudflare.com/mcp"]);
  });

  it("an anthropic model renders a provider entry with a 200k window and the gateway-key label", () => {
    const p = (renderOpenclawDoc({ model: "anthropic/claude-sonnet-4-6" }) as any).models.providers.cfgw;
    expect(p.models[0]).toMatchObject({ id: "anthropic/claude-sonnet-4-6", contextWindow: 200000 });
    expect(p.models[0].name).toContain("Anthropic");
  });

  it("without a model (--skip-ai): the gate keys, no model provider, no primary", () => {
    const d = renderOpenclawDoc(null) as any;
    expect(d).toEqual({ ...renderCapabilities(), ochost: { renderVersion: RENDER_VERSION } });
    expect(d.agents.defaults.model).toBeUndefined();
    expect(d.models.providers.cfgw).toBeUndefined();
  });
});

describe("renderWranglerJsonc", () => {
  const render = (gateway: string) => {
    const c = validateConfig(
      JSON.parse(
        defaultConfigText({ name: "w", inst: "abc123", accountId: ACCT, gateway, timezone: "UTC" })
          .replace(/\/\/.*$/gm, "")
          .replace(/,(\s*[}\]])/g, "$1"),
      ),
    );
    const text = renderWranglerJsonc(c, { accountId: ACCT, url: "https://w.s.workers.dev", source: "/src" });
    return { text, w: JSON.parse(text.replace(/^\/\/.*\n/, "")) };
  };

  it("binds BROWSER and the Workers AI binding, and names the gateway; no token anywhere", () => {
    const { w, text } = render("gw");
    expect(w.browser).toEqual({ binding: "BROWSER" });
    expect(w.ai).toEqual({ binding: "AI" });
    expect(w.vars.OC_AI_GATEWAY).toBe("gw");
    expect(w.vars.OC_AI_BASE).toBeUndefined();
    expect(text).not.toMatch(/OC_CF_AI_TOKEN/);
  });

  it("llm.gateway none renders an empty gateway: the binding runs without one", () => {
    expect(render("none").w.vars.OC_AI_GATEWAY).toBe("");
  });
});

describe("deploy: token-era config warning", () => {
  const oldDoc = {
    models: {
      providers: {
        cfgw: {
          baseUrl: "https://gateway.ai.cloudflare.com/v1/a/gw/workers-ai/v1",
          headers: { "cf-aig-authorization": `Bearer \${OC_CF_AI_TOKEN}` },
        },
      },
    },
  };
  const ctxWith = (doc: unknown) => {
    const warns: string[] = [];
    const calls: string[] = [];
    const ctx = {
      ui: { warn: (l: string) => warns.push(l) },
      fetch: async (u: string, init: RequestInit) => {
        calls.push(`${u} ${new Headers(init.headers).get("authorization")}`);
        return u.endsWith("/ops/config")
          ? Response.json({ versions: [{ ver: 1 }, { ver: 3 }] })
          : Response.json({ doc });
      },
    } as any;
    return { ctx, warns, calls };
  };

  it("a config that calls the gateway with the old token warns with the fix; a gate config does not", async () => {
    expect(tokenEraConfig(oldDoc)).toBe(true);
    expect(tokenEraConfig(renderOpenclawDoc({ model: "@cf/a/b" }))).toBe(false);
    const a = ctxWith(oldDoc);
    expect(await warnTokenEra(a.ctx, "https://w", "tok")).toBe(true);
    expect(a.warns[0]).toMatch(/ochost ai-gateway setup/);
    expect(a.calls).toEqual(["https://w/ops/config Bearer tok", "https://w/ops/config/3 Bearer tok"]);
    const b = ctxWith(renderOpenclawDoc({ model: "@cf/a/b" }));
    expect(await warnTokenEra(b.ctx, "https://w", "tok")).toBe(false);
    expect(b.warns).toEqual([]);
  });

  it("a read failure is silent", async () => {
    const ctx = {
      ui: { warn: () => {} },
      fetch: async () => {
        throw new Error("down");
      },
    } as any;
    expect(await warnTokenEra(ctx, "https://w", "tok")).toBe(false);
  });
});

describe("ochost caps", () => {
  let f: FakeOps;
  let dir: string;
  let limits: Record<string, number>;
  const view = () => ({
    day: "2026-11-02",
    resetsInS: 3600,
    verbs: Object.fromEntries(
      Object.entries(limits).map(([k, limit]) => [k, { used: limit / 2, limit, pct: 0.5 }]),
    ),
  });
  beforeEach(async () => {
    f = await new FakeOps().start();
    limits = { browser: 3600, neurons: 10000, requests: 2000, websearch: 200 };
    f.routes.push((r) => {
      if (r.path !== "/ops/caps") return undefined;
      if (r.method === "POST") Object.assign(limits, r.body);
      return { status: 200, body: view() };
    });
    dir = installDir(f.url);
  });
  afterEach(() => f.stop());

  it("shows used, limit and percent per verb", async () => {
    const r = await run("caps", ["--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/browser\s+1800s\s+3600s\s+50/);
    expect(r.out).toMatch(/neurons\s+5000\s+10000\s+50/);
  });

  it("shows the file storage cap when the Worker reports it (docs/11 §8)", async () => {
    f.routes.unshift((r) =>
      r.path === "/ops/caps"
        ? {
            status: 200,
            body: { ...view(), files: { used: 4.1e9, limit: 5e9, objects: 12, objectMax: 100e6, pct: 0.82 } },
          }
        : undefined,
    );
    const r = await run("caps", ["--dir", dir]);
    expect(r.out).toMatch(
      /files\s+4\.10GB of 5\.00GB \(82%\), 12 object\(s\), max 100MB each; ochost caps set storage <n>/,
    );
  });

  it("set raises one verb and posts only that verb", async () => {
    const r = await run("caps", ["set", "neurons", "50000", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(f.calls("POST", "/ops/caps")[0]?.body).toEqual({ neurons: 50000 });
    expect(r.out).toMatch(/neurons\s+25000\s+50000/);
  });

  it("set storage writes the setting files.capGb, not a daily budget", async () => {
    f.routes.unshift((r) =>
      r.method === "PUT" && r.path === "/ops/settings"
        ? { status: 200, body: { ver: 4, changed: true } }
        : undefined,
    );
    const r = await run("caps", ["set", "storage", "20", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(f.calls("PUT", "/ops/settings")[0]?.body).toEqual({ set: { "files.capGb": 20 }, source: "cli" });
    expect(f.calls("POST", "/ops/caps")).toHaveLength(0);
    expect((await run("caps", ["set", "storage", "2.5", "--dir", dir])).code).not.toBe(0);
  });

  it("set rejects an unknown verb or a bad number before any request", async () => {
    expect((await run("caps", ["set", "money", "5", "--dir", dir])).code).not.toBe(0);
    expect((await run("caps", ["set", "browser", "-5", "--dir", dir])).code).not.toBe(0);
    expect(f.calls("POST", "/ops/caps")).toHaveLength(0);
  });
});
