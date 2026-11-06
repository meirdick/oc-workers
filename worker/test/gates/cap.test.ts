// CapGate (gates/cap.ts): fake BROWSER binding, fake fetch for the AI Gateway, the real ledger budgets.
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/core/types";
import { type CapDeps, handleCapGate } from "../../src/gates/cap";
import worker from "../../src/index";
import { handleOps } from "../../src/ops";
import { secretEnv } from "../../src/rt/runtime";
import { World } from "./harness";

interface AiCall {
  model: string;
  input: Record<string, unknown>;
  opts?: { gateway?: { id: string; skipCache?: boolean } };
}
const sse = (...chunks: unknown[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks)
        c.enqueue(new TextEncoder().encode(typeof ch === "string" ? ch : `data: ${JSON.stringify(ch)}\n\n`));
      c.close();
    },
  });
const readAll = async (r: Response) => await r.text();

class FakeWs {
  peer: FakeWs | null = null;
  closed: { code: number; reason: string } | null = null;
  sent: string[] = [];
  private l = new Map<string, ((e: unknown) => void)[]>();
  /** Reply hook for a socket that stands for the browser. */
  onSend?: (data: string) => void;
  addEventListener(t: string, fn: (e: unknown) => void) {
    this.l.set(t, [...(this.l.get(t) ?? []), fn]);
  }
  emit(t: string, e: unknown = {}) {
    for (const fn of this.l.get(t) ?? []) fn(e);
  }
  accept() {}
  send(data: string) {
    this.sent.push(data);
    if (this.onSend) this.onSend(data);
    else this.peer?.emit("message", { data });
  }
  close(code: number, reason: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.emit("close");
    if (this.peer && !this.peer.closed) this.peer.close(code, reason);
  }
}

/** Fake Workers Browser binding speaking the @cloudflare/puppeteer protocol, with a scripted page. */
function fakeBrowser(w: World, o: { value?: string; pageMs?: number; acquire?: number } = {}) {
  const calls: string[] = [];
  const ws = new FakeWs();
  const cdp: string[] = [];
  ws.onSend = (data) => {
    const m = JSON.parse(data) as {
      id: number;
      method: string;
      params: { expression?: string; url?: string };
    };
    cdp.push(m.method + (m.params.url ? ` ${m.params.url}` : ""));
    const reply = (result: unknown) => ws.emit("message", { data: JSON.stringify({ id: m.id, result }) });
    if (m.method === "Target.createTarget") reply({ targetId: "t1" });
    else if (m.method === "Target.attachToTarget") reply({ sessionId: "p1" });
    else if (m.method === "Page.navigate") {
      reply({});
      ws.emit("message", {
        data: JSON.stringify({ method: "Page.loadEventFired", sessionId: "p1", params: {} }),
      });
    } else if (m.method === "Runtime.evaluate") {
      w.clock.t += o.pageMs ?? 7000;
      cdp.push(`eval:${m.params.expression?.slice(0, 20)}`);
      reply({ result: { value: o.value ?? "<html>hi</html>" } });
    } else reply({});
  };
  const fetcher = {
    calls,
    cdp,
    ws,
    async fetch(url: string, init?: RequestInit) {
      const u = new URL(url);
      calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
      if (init?.method === "POST") {
        const acq = o.acquire ?? 200;
        return new Response(acq === 200 ? JSON.stringify({ sessionId: "s1" }) : "no capacity", {
          status: acq,
        });
      }
      if (init?.method === "DELETE") return new Response("");
      return { status: 101, webSocket: ws } as unknown as Response;
    },
  };
  return fetcher;
}

function setup(
  o: {
    browser?: ReturnType<typeof fakeBrowser> | null;
    /** Scripted page for the default browser, on the same clock as the ledger. */
    page?: { value?: string; pageMs?: number };
    ai?: boolean;
    gateway?: string;
    /** Search backend; null = no AI binding. Default: a binding that returns one item. */
    websearch?: CapDeps["websearch"] | null;
  } = {},
) {
  const w = new World();
  const aiCalls: AiCall[] = [];
  const dflt = (model: string): unknown => {
    if (model.includes("melotts")) return { audio: btoa("RIFFwav") };
    if (model.includes("aura")) return new Blob(["ID3mp3"]).stream();
    if (model.includes("whisper")) return { text: " hello world " };
    if (model.includes("flux")) return { image: btoa("jpeg") };
    if (model.includes("bge")) return { shape: [1, 3], data: [[0.1, 0.2, 0.3]] };
    return {
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, neurons: 7 },
    };
  };
  let aiReply: (model: string, input: Record<string, unknown>) => unknown = dflt;
  const pairs: { client: FakeWs; server: FakeWs }[] = [];
  const bg: Promise<unknown>[] = [];
  const browser = o.browser === null ? undefined : (o.browser ?? fakeBrowser(w, o.page));
  const deps: CapDeps = {
    ctl: w.ctlPort(),
    browser: browser as unknown as Fetcher | undefined,
    websearch:
      o.websearch === null
        ? undefined
        : (o.websearch ?? (async () => Response.json({ items: [{ url: "https://e.com/", title: "E" }] }))),
    ai:
      o.ai === false
        ? undefined
        : {
            run: async (model, input, opts) => {
              aiCalls.push({ model, input, opts });
              const r = aiReply(model, input);
              if (r instanceof Error) throw r;
              return r;
            },
          },
    gateway: o.gateway ?? "gw",
    now: w.now,
    ws: {
      pair: () => {
        const p = { client: new FakeWs(), server: new FakeWs() };
        p.client.peer = p.server;
        p.server.peer = p.client;
        pairs.push(p);
        return p as unknown as { client: WebSocket; server: WebSocket };
      },
      respond: (c) => ({ status: 101, webSocket: c }) as unknown as Response,
    },
    waitUntil: (p) => bg.push(p),
  };
  const call = (path: string, init?: RequestInit) =>
    handleCapGate(new Request(`http://15.0.0.3${path}`, init), deps);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const used = (verb: string) =>
    w.sql<{ used: number }>("SELECT used FROM cap_day WHERE verb = ?", verb)[0]?.used ?? 0;
  const alerts = () =>
    w.sql<{ class: string; severity: string }>("SELECT class, severity FROM alerts ORDER BY class");
  return {
    w,
    deps,
    call,
    post,
    browser,
    aiCalls,
    setAi: (f: (model: string, input: Record<string, unknown>) => unknown) => (aiReply = f),
    pairs,
    bg,
    used,
    alerts,
  };
}

describe("browser REST", () => {
  it("/browser/content returns the page HTML, charges browser seconds and ends the session", async () => {
    const t = setup();
    const r = await t.post("/browser/content", { url: "https://example.com/a" });
    expect(await r.json()).toEqual({ success: true, result: "<html>hi</html>" });
    expect(t.browser?.cdp).toContain("Page.navigate https://example.com/a");
    expect(t.used("browser")).toBe(7);
    expect(t.used("requests")).toBe(1);
    await Promise.all(t.bg);
    expect(t.browser?.calls).toEqual([
      "POST /v1/devtools/browser",
      "GET /v1/devtools/browser/s1",
      "DELETE /v1/devtools/browser/s1",
    ]);
  });

  it("/browser/markdown evaluates the converter and returns its text; /browser/v2/scrape uses the Firecrawl shape", async () => {
    const page = JSON.stringify({ title: "T", text: "# Hi\n\n[x](https://e.com/)", url: "https://e.com/" });
    const t = setup({ browser: fakeBrowser(new World(), { value: page }) });
    const md = await t.post("/browser/markdown", { url: "https://e.com/" });
    expect(await md.json()).toEqual({ success: true, result: "# Hi\n\n[x](https://e.com/)" });
    expect(t.browser?.cdp.find((c) => c.startsWith("eval:"))).toContain("(() =>");
    const fc = await t.post("/browser/v2/scrape", { url: "https://e.com/" });
    expect(await fc.json()).toEqual({
      success: true,
      data: {
        markdown: "# Hi\n\n[x](https://e.com/)",
        metadata: { title: "T", sourceURL: "https://e.com/", url: "https://e.com/" },
      },
    });
  });

  it("/v2/scrape takes the body OpenClaw's firecrawl plugin sends, answers in its shape and charges the budget", async () => {
    const page = JSON.stringify({
      title: "Example Domain",
      text: "# Example Domain",
      url: "http://example.com/",
    });
    const t = setup({ page: { value: page, pageMs: 3000 } });
    // Body as sent by extensions/firecrawl firecrawl-client runFirecrawlScrape (2026.10.9).
    const r = await t.post("/v2/scrape", {
      url: "http://example.com/",
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: 60000,
      maxAge: 172800000,
      proxy: "auto",
      storeInCache: true,
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      success: true,
      data: {
        markdown: "# Example Domain",
        metadata: { title: "Example Domain", sourceURL: "http://example.com/", url: "http://example.com/" },
      },
    });
    expect(t.browser?.cdp).toContain("Page.navigate http://example.com/");
    expect(t.used("requests")).toBe(1);
    expect(t.used("browser")).toBe(3);
    expect(t.browser?.calls.at(-1)).toMatch(/^DELETE /);
  });

  it("/v2/scrape refuses with 429 once browser seconds are spent; an empty page is a 502 error", async () => {
    const t = setup({ page: { value: JSON.stringify({ title: "", text: " ", url: "x" }) } });
    const e = await t.post("/v2/scrape", { url: "http://e.com/" });
    expect(e.status).toBe(502);
    expect(((await e.json()) as { success: boolean }).success).toBe(false);
    t.w.ledger.capsSet({ browser: 1 });
    const r = await t.post("/v2/scrape", { url: "http://e.com/" });
    expect(r.status).toBe(429);
    expect(((await r.json()) as { verb: string }).verb).toBe("browser");
  });

  it("/v2/search: binding result → Firecrawl search shape, one websearch unit and one request charged", async () => {
    const calls: unknown[] = [];
    const t = setup({
      websearch: async (o) => {
        calls.push(o);
        return Response.json({
          items: [
            { url: "https://a.example/", title: "A", description: "about a" },
            { title: "no url, dropped" },
            { url: "https://b.example/" },
          ],
          metadata: { query: o.query, requestId: "r", latencyMs: 5 },
        });
      },
    });
    const r = await t.post("/v2/search", {
      query: "cf web search",
      limit: 50,
      scrapeOptions: { formats: ["markdown"] },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      success: true,
      data: {
        web: [
          { url: "https://a.example/", title: "A", description: "about a" },
          { url: "https://b.example/", title: "https://b.example/", description: "" },
        ],
      },
    });
    expect(calls).toEqual([{ gatewayId: "gw", query: "cf web search", limit: 10 }]); // limit capped at 10
    expect(t.used("websearch")).toBe(1);
    expect(t.used("requests")).toBe(1);
    expect(t.browser?.calls).toEqual([]); // never touches Browser Run
  });

  it("/search unwraps {result}; no gateway → gateway id default; no binding → 503 and no token path", async () => {
    const calls: { gatewayId: string }[] = [];
    const t = setup({
      gateway: "",
      websearch: async (o) => {
        calls.push(o);
        return Response.json({ result: { items: [{ url: "https://c.example/", title: "C" }] } });
      },
    });
    const r = await t.post("/search", { query: "q" });
    expect(((await r.json()) as { data: { web: unknown[] } }).data.web).toHaveLength(1);
    expect(calls).toEqual([{ gatewayId: "default", query: "q", limit: 5 }]);
    const none = setup({ websearch: null });
    expect((await none.post("/search", { query: "q" })).status).toBe(503);
    expect(none.aiCalls).toEqual([]);
  });

  it("websearch budget: 429 at the limit with the verb, 80% and 100% alerts, nothing reaches the backend", async () => {
    let n = 0;
    const t = setup({
      websearch: async () => {
        n++;
        return Response.json({ items: [] });
      },
    });
    t.w.ledger.capsSet({ websearch: 5 });
    for (let i = 0; i < 5; i++) expect((await t.post("/v2/search", { query: "q" })).status).toBe(200);
    const r = await t.post("/v2/search", { query: "q" });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: "budget", verb: "websearch", used: 5, limit: 5 });
    expect(n).toBe(5);
    expect(t.alerts().map((a) => a.class)).toEqual(
      expect.arrayContaining(["cap-websearch-80", "cap-websearch-100"]),
    );
  });

  it("a failed search charges no websearch unit; bad queries are 400 and free; nothing configured is 503", async () => {
    const t = setup({ websearch: async () => new Response("provider down", { status: 500 }) });
    const e = await t.post("/v2/search", { query: "q" });
    expect(e.status).toBe(502);
    expect(t.used("websearch")).toBe(0);
    expect((await t.post("/v2/search", { query: "" })).status).toBe(400);
    expect((await t.post("/v2/search", { query: "x".repeat(1025) })).status).toBe(400);
    expect((await t.post("/v2/search", { nope: 1 })).status).toBe(400);
    expect(t.used("requests")).toBe(1);
    const none = setup({ websearch: null, ai: false });
    expect((await none.post("/v2/search", { query: "q" })).status).toBe(503);
  });

  it("a bad body or a non-http url is 400 and costs nothing; no binding is 503", async () => {
    const t = setup();
    expect((await t.post("/browser/content", { nope: 1 })).status).toBe(400);
    expect((await t.post("/browser/content", { url: "file:///etc/passwd" })).status).toBe(400);
    expect((await t.post("/browser/markdown", { url: "ftp://x/" })).status).toBe(400);
    expect(t.used("requests")).toBe(0);
    expect(t.browser?.calls).toEqual([]);
    const nb = setup({ browser: null });
    expect((await nb.post("/browser/content", { url: "https://e.com/" })).status).toBe(503);
  });

  it("a failed acquire is a 502 and the browser seconds charged are zero", async () => {
    const t = setup({ browser: fakeBrowser(new World(), { acquire: 429 }) });
    const r = await t.post("/browser/content", { url: "https://e.com/" });
    expect(r.status).toBe(502);
    expect(t.used("browser")).toBe(0);
  });
});

describe("budgets at the gate", () => {
  it("requests: the call after the limit gets 429 with retry-after and the verb; nothing reaches the browser", async () => {
    const t = setup();
    t.w.ledger.capsSet({ requests: 2 });
    expect((await t.post("/browser/content", { url: "https://e.com/" })).status).toBe(200);
    expect((await t.post("/browser/content", { url: "https://e.com/" })).status).toBe(200);
    const n = t.browser?.calls.length;
    const r = await t.post("/browser/content", { url: "https://e.com/" });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBe(86_400 - ((t.w.now() / 1000) % 86_400));
    expect(await r.json()).toMatchObject({ error: "budget", verb: "requests", limit: 2 });
    expect(t.browser?.calls.length).toBe(n);
  });

  it("browser seconds spent → 429 on browser routes (and the request is not counted), AI still works", async () => {
    const t = setup();
    t.w.ledger.capsSet({ browser: 10 });
    expect((await t.post("/browser/content", { url: "https://e.com/" })).status).toBe(200); // 7 s
    expect((await t.post("/browser/content", { url: "https://e.com/" })).status).toBe(200); // 14 s, over
    const before = t.used("requests");
    const r = await t.post("/browser/content", { url: "https://e.com/" });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ verb: "browser" });
    expect(t.used("requests")).toBe(before);
    expect((await t.post("/ai/v1/embeddings", { input: "a" })).status).toBe(200);
    expect(t.alerts().map((a) => a.class)).toContain("cap-browser-100");
  });

  it("the owner raises the limit and the same call works again", async () => {
    const t = setup();
    t.w.ledger.capsSet({ requests: 1 });
    await t.post("/browser/content", { url: "https://e.com/" });
    expect((await t.post("/browser/content", { url: "https://e.com/" })).status).toBe(429);
    t.w.ledger.capsSet({ requests: 5 });
    expect((await t.post("/browser/content", { url: "https://e.com/" })).status).toBe(200);
  });

  it("GET /caps shows used and limits", async () => {
    const t = setup();
    await t.post("/ai/v1/embeddings", { input: "a" });
    const j = (await (await t.call("/caps")).json()) as Record<string, { used: number; limit: number }>;
    expect(j.requests).toMatchObject({ used: 1, limit: 2000 });
    expect(j.neurons?.used).toBeGreaterThan(0);
  });
});

describe("/browser/devtools bridge", () => {
  it("needs a WebSocket upgrade", async () => {
    const t = setup();
    expect((await t.call("/browser/devtools")).status).toBe(426);
  });

  it("relays frames both ways, then charges the session time and ends it on close", async () => {
    const t = setup();
    // the fake browser echoes through its own hook for this test
    (t.browser as ReturnType<typeof fakeBrowser>).ws.onSend = undefined;
    const r = await t.call("/browser/devtools", { headers: { upgrade: "websocket" } });
    expect(r.status).toBe(101);
    const p = t.pairs[0] as { client: FakeWs; server: FakeWs };
    const got: unknown[] = [];
    p.client.addEventListener("message", (e) => got.push((e as { data: string }).data));
    p.client.send('{"id":1,"method":"Browser.getVersion"}'); // client → gate server side
    expect(t.browser?.ws.sent).toEqual(['{"id":1,"method":"Browser.getVersion"}']);
    t.browser?.ws.emit("message", { data: '{"id":1,"result":{}}' });
    expect(got).toEqual(['{"id":1,"result":{}}']);
    t.w.clock.t += 40_000;
    p.client.close(1000, "bye");
    await Promise.all(t.bg);
    expect(t.used("browser")).toBe(40);
    expect(t.browser?.calls.at(-1)).toBe("DELETE /v1/devtools/browser/s1");
    expect(t.browser?.ws.closed).not.toBeNull();
  });

  it("a spent browser budget closes an open bridge with 1013 on the next frame after a tick", async () => {
    const t = setup();
    t.w.ledger.capsSet({ browser: 30 });
    await t.call("/browser/devtools", { headers: { upgrade: "websocket" } });
    const p = t.pairs[0] as { client: FakeWs; server: FakeWs };
    t.w.clock.t += 31_000;
    t.browser?.ws.emit("message", { data: "{}" });
    await new Promise((r) => setTimeout(r, 0));
    expect(p.server.closed?.code).toBe(1013);
    expect(t.used("browser")).toBe(31);
  });

  it("two frames inside one tick charge the span once", async () => {
    const t = setup();
    await t.call("/browser/devtools", { headers: { upgrade: "websocket" } });
    t.w.clock.t += 20_000;
    t.browser?.ws.emit("message", { data: "{}" });
    t.browser?.ws.emit("message", { data: "{}" });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.used("browser")).toBe(20);
  });

  it("refused with 429 when browser seconds are already spent", async () => {
    const t = setup();
    t.w.ledger.capsSet({ browser: 0 });
    const r = await t.call("/browser/devtools", { headers: { upgrade: "websocket" } });
    expect(r.status).toBe(429);
    expect(t.browser?.calls).toEqual([]);
  });
});

describe("/ai/v1 through the Workers AI binding", () => {
  const chatBody = (extra: Record<string, unknown> = {}) => ({
    model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    messages: [{ role: "user", content: "ping" }],
    ...extra,
  });

  it("chat: OpenAI body in, gateway id and skipCache on the run, reply and neurons from usage", async () => {
    const t = setup();
    const r = await t.post(
      "/ai/v1/chat/completions",
      chatBody({ max_tokens: 64, junk: 1, stream_options: {} }),
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { object: string; choices: { message: { content: string } }[] };
    expect(j.object).toBe("chat.completion");
    expect(j.choices[0]?.message.content).toBe("pong");
    const c = t.aiCalls[0] as AiCall;
    expect(c.model).toBe("@cf/deepseek-ai/deepseek-v4.1-flash-1017");
    expect(c.opts).toEqual({ gateway: { id: "gw", skipCache: true } });
    expect(c.input).toEqual({ messages: [{ role: "user", content: "ping" }], max_tokens: 64 }); // allowlist
    expect(t.used("neurons")).toBe(7);
    expect(t.used("requests")).toBe(1);
  });

  it("chat without a gateway id runs the binding with no gateway option", async () => {
    const t = setup({ gateway: "" });
    await t.post("/ai/v1/chat/completions", chatBody());
    expect((t.aiCalls[0] as AiCall).opts).toBeUndefined();
  });

  it("chat: content null on a tool-call message becomes an empty string; tools and tool results pass", async () => {
    const t = setup();
    const tool = {
      type: "function",
      function: { name: "calc", description: "d", parameters: { type: "object" } },
    };
    const calls = [{ id: "c1", type: "function", function: { name: "calc", arguments: "{}" } }];
    await t.post(
      "/ai/v1/chat/completions",
      chatBody({
        tools: [tool],
        messages: [
          { role: "user", content: "2+2" },
          { role: "assistant", content: null, tool_calls: calls },
          { role: "tool", tool_call_id: "c1", content: "4" },
          { role: "assistant", tool_calls: calls },
        ],
      }),
    );
    const m = (t.aiCalls[0] as AiCall).input.messages as { role: string; content: unknown }[];
    expect(m.map((x) => x.content)).toEqual(["2+2", "", "4", ""]);
    expect((t.aiCalls[0] as AiCall).input.tools).toEqual([tool]);
  });

  it("chat: a legacy {response, tool_calls} reply becomes an OpenAI message; <ds_safety> is stripped", async () => {
    const t = setup();
    t.setAi(() => ({
      response: "hi <ds_safety>x</ds_safety>",
      tool_calls: [{ name: "calc", arguments: { a: 1 } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    }));
    const j = (await (await t.post("/ai/v1/chat/completions", chatBody())).json()) as {
      choices: {
        message: {
          content: string;
          tool_calls: { id: string; function: { name: string; arguments: string } }[];
        };
        finish_reason: string;
      }[];
    };
    const ch = j.choices[0] as (typeof j.choices)[0];
    expect(ch.message.content).toBe("hi");
    expect(ch.message.tool_calls[0]?.function).toEqual({ name: "calc", arguments: '{"a":1}' });
    expect(ch.finish_reason).toBe("tool_calls");
    expect(t.used("neurons")).toBe(Math.ceil(100 * 0.03 + 10 * 0.1)); // no neurons in usage → estimate
  });

  it("chat stream: OpenAI chunks pass through split across reads, [DONE] ends, neurons charged from the last usage", async () => {
    const t = setup();
    const a = { choices: [{ index: 0, delta: { role: "assistant", content: "po" } }] };
    const b = { choices: [{ index: 0, delta: { content: "ng" } }] };
    const u = { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, neurons: 3 } };
    const raw = `data: ${JSON.stringify(a)}\n\ndata: ${JSON.stringify(b)}\n\ndata: ${JSON.stringify(u)}\n\ndata: [DONE]\n\n`;
    t.setAi(() => sse(raw.slice(0, 20), raw.slice(20, 90), raw.slice(90)));
    const r = await t.post("/ai/v1/chat/completions", chatBody({ stream: true }));
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const text = await readAll(r);
    expect(text).toBe(raw);
    expect((t.aiCalls[0] as AiCall).input.stream).toBe(true);
    expect(t.used("neurons")).toBe(3);
  });

  it("chat stream: legacy {response} chunks become deltas, a tool call chunk carries index and JSON arguments", async () => {
    const t = setup();
    t.setAi(() =>
      sse(
        { response: "he" },
        { response: "llo" },
        { tool_calls: [{ name: "calc", arguments: { a: 1 } }] },
        "data: [DONE]\n\n",
      ),
    );
    const text = await readAll(await t.post("/ai/v1/chat/completions", chatBody({ stream: true })));
    const ev = text
      .split("\n\n")
      .filter((x) => x.startsWith("data: {"))
      .map((x) => JSON.parse(x.slice(6)) as { choices: { delta: Record<string, unknown> }[] });
    expect(ev.map((e) => e.choices[0]?.delta)).toEqual([
      { role: "assistant", content: "he" },
      { content: "llo" },
      {
        tool_calls: [
          {
            index: 0,
            id: expect.any(String),
            type: "function",
            function: { name: "calc", arguments: '{"a":1}' },
          },
        ],
      },
    ]);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(t.used("neurons")).toBeGreaterThan(0); // estimated from the text: no usage came
  });

  it("chat stream: a client that cancels is still charged", async () => {
    const t = setup();
    t.setAi(
      () =>
        new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: "x" })}\n\n`));
          },
        }),
    );
    const r = await t.post("/ai/v1/chat/completions", chatBody({ stream: true }));
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    expect(t.used("neurons")).toBeGreaterThan(0);
  });

  it("chat: reasoning_effort reaches env.AI; Gemma gets enable_thinking instead", async () => {
    const t = setup();
    await t.post("/ai/v1/chat/completions", chatBody({ reasoning_effort: "low" }));
    expect((t.aiCalls[0] as AiCall).input.reasoning_effort).toBe("low");
    const gemma = "@cf/google/gemma-4-26b-a4b-it";
    await t.post("/ai/v1/chat/completions", chatBody({ model: gemma, reasoning_effort: "none" }));
    await t.post("/ai/v1/chat/completions", chatBody({ model: gemma, reasoning_effort: "high" }));
    expect((t.aiCalls[1] as AiCall).input).toEqual({
      messages: [{ role: "user", content: "ping" }],
      chat_template_kwargs: { enable_thinking: false },
    });
    expect((t.aiCalls[2] as AiCall).input.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect((t.aiCalls[2] as AiCall).input.reasoning_effort).toBeUndefined();
  });

  it("chat: reasoning in a non-streamed answer keeps the OpenAI shape (thinking is renamed)", async () => {
    const t = setup();
    const msg = (extra: Record<string, unknown>) => ({
      choices: [
        { index: 0, message: { role: "assistant", content: "pong", ...extra }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, neurons: 1 },
    });
    type Out = { choices: { message: Record<string, unknown> }[] };
    const ask = async () =>
      ((await (await t.post("/ai/v1/chat/completions", chatBody())).json()) as Out).choices[0]?.message;
    t.setAi(() => msg({ reasoning_content: "rc" }));
    expect(await ask()).toEqual({ role: "assistant", content: "pong", reasoning_content: "rc" });
    t.setAi(() => msg({ reasoning: "r" }));
    expect(await ask()).toEqual({ role: "assistant", content: "pong", reasoning: "r" });
    t.setAi(() => msg({ thinking: "th" }));
    expect(await ask()).toEqual({ role: "assistant", content: "pong", reasoning_content: "th" });
    t.setAi(() => ({ response: "pong", thinking: "th2", usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    expect(await ask()).toEqual({ role: "assistant", content: "pong", reasoning_content: "th2" });
    t.setAi(() => ({ reasoning_content: "only", response: "" }));
    expect((await ask())?.reasoning_content).toBe("only");
  });

  it("chat stream: reasoning deltas pass through; thinking and legacy reasoning chunks become reasoning_content", async () => {
    const t = setup();
    const oai = (delta: Record<string, unknown>) => ({ choices: [{ index: 0, delta }] });
    t.setAi(() =>
      sse(
        oai({ role: "assistant", reasoning_content: "a" }),
        oai({ reasoning: "b" }),
        oai({ thinking: "c" }),
        { reasoning_content: "d" },
        { thinking: "e", response: "hi" },
        oai({ content: "!" }),
        "data: [DONE]\n\n",
      ),
    );
    const text = await readAll(await t.post("/ai/v1/chat/completions", chatBody({ stream: true })));
    const deltas = text
      .split("\n\n")
      .filter((x) => x.startsWith("data: {"))
      .map(
        (x) =>
          (JSON.parse(x.slice(6)) as { choices: { delta: Record<string, unknown> }[] }).choices[0]?.delta,
      );
    expect(deltas).toEqual([
      { role: "assistant", reasoning_content: "a" },
      { reasoning: "b" },
      { reasoning_content: "c" },
      { role: "assistant", reasoning_content: "d" },
      { reasoning_content: "e", content: "hi" },
      { content: "!" },
    ]);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("chat errors: capacity → 429 with retry-after, bad input → 400, other → 502; nothing charged", async () => {
    const t = setup();
    const cases: [string, number][] = [
      ["3040: Capacity temporarily exceeded", 429],
      ["AiError 5006: Bad input: Type mismatch of '/messages/2/content'", 400],
      ["boom", 502],
    ];
    for (const [msg, status] of cases) {
      t.setAi(() => new Error(msg));
      const r = await t.post("/ai/v1/chat/completions", chatBody());
      expect(r.status, msg).toBe(status);
      expect(((await r.json()) as { error: { message: string } }).error.message).toContain(msg.slice(0, 8));
    }
    expect(t.used("neurons")).toBe(0);
  });

  it("chat models: @cf and anthropic/<model> pass; anything else is 400 before a run", async () => {
    const t = setup();
    for (const model of ["gpt-4", "openai/gpt-4.1", "@cf/a/b/../c", "anthropic/../x", "", undefined])
      expect((await t.post("/ai/v1/chat/completions", chatBody({ model }))).status, String(model)).toBe(400);
    expect((await t.post("/ai/v1/chat/completions", { model: "@cf/a/b" })).status).toBe(400); // no messages
    expect(t.aiCalls).toEqual([]);
  });

  it("anthropic/<model> runs on the binding with the gateway, charges no neurons even when spent", async () => {
    const t = setup();
    t.w.ledger.capsSet({ neurons: 0 });
    const r = await t.post("/ai/v1/chat/completions", chatBody({ model: "anthropic/claude-sonnet-4-6" }));
    expect(r.status).toBe(200);
    expect((t.aiCalls[0] as AiCall).model).toBe("anthropic/claude-sonnet-4-6");
    expect((t.aiCalls[0] as AiCall).opts?.gateway?.id).toBe("gw");
    expect(t.used("neurons")).toBe(0);
    expect(t.used("requests")).toBe(1);
    // a Workers AI model is refused with the same budget
    expect((await t.post("/ai/v1/chat/completions", chatBody())).status).toBe(429);
  });

  it("embeddings: input becomes {text}, the reply is an OpenAI list with the gateway option, charged by size", async () => {
    const t = setup();
    const r = await t.post("/ai/v1/embeddings", { model: "@cf/baai/bge-m3", input: ["hello", "world"] });
    expect(await r.json()).toMatchObject({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
    });
    const c = t.aiCalls[0] as AiCall;
    expect(c.input).toEqual({ text: ["hello", "world"] });
    expect(c.opts).toEqual({ gateway: { id: "gw" } });
    expect(t.used("neurons")).toBe(Math.ceil(3 * ((0.012 / 1e6) * (1000 / 0.011)))); // 10 chars ≈ 3 tokens
    expect((await t.post("/ai/v1/embeddings", { input: 5 })).status).toBe(400);
  });

  it("neurons spent → 429 before the binding is called", async () => {
    const t = setup();
    t.w.ledger.capsSet({ neurons: 5 });
    await t.post("/ai/v1/images/generations", { prompt: "a cat" }); // 500 neurons estimated
    t.aiCalls.length = 0;
    const r = await t.post("/ai/v1/images/generations", { prompt: "a cat" });
    expect(r.status).toBe(429);
    expect(t.aiCalls).toEqual([]);
  });

  it("no ai binding → 503; bad JSON → 400; GET → 405; other paths 404", async () => {
    expect((await setup({ ai: false }).post("/ai/v1/embeddings", {})).status).toBe(503);
    const t = setup();
    const r = await t.call("/ai/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(r.status).toBe(400);
    expect((await t.call("/ai/v1/embeddings")).status).toBe(405);
    for (const p of ["models", "embeddings/x", "chat", ""])
      expect((await t.post(`/ai/v1/${p}`, {})).status, p).toBe(404);
    expect(t.aiCalls).toEqual([]);
  });

  it("no credential on the wire: the reply never carries a token, the client's auth header is never forwarded", async () => {
    const t = setup();
    const r = await t.post("/ai/v1/chat/completions", chatBody(), { authorization: "Bearer agent-made-up" });
    expect(JSON.stringify(t.aiCalls)).not.toContain("agent-made-up");
    expect(r.headers.get("authorization")).toBeNull();
  });

  it("transcriptions: multipart file runs on the binding as base64, reply is OpenAI json, charged by size", async () => {
    const t = setup();
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array(160_000)], "a.wav"), "a.wav"); // ~10 s at 16 kB/s
    fd.set("model", "@cf/openai/whisper-large-v3-turbo");
    const r = await t.call("/ai/v1/audio/transcriptions", { method: "POST", body: fd });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ text: "hello world" });
    const c = t.aiCalls[0] as AiCall;
    expect(c.model).toBe("@cf/openai/whisper-large-v3-turbo");
    expect(atob(c.input.audio as string).length).toBe(160_000);
    expect(c.opts).toBeUndefined();
    expect(t.used("neurons")).toBeCloseTo(10 * ((0.0005 / 60) * (1000 / 0.011)), 0);
    expect((await t.call("/ai/v1/audio/transcriptions", { method: "POST", body: "x" })).status).toBe(400);
  });

  it("speech: input goes as prompt, the reply is WAV bytes", async () => {
    const t = setup();
    const r = await t.post("/ai/v1/audio/speech", {
      model: "@cf/myshell-ai/melotts",
      input: "hi",
      voice: "alloy",
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/wav");
    expect(new TextDecoder().decode(await r.arrayBuffer())).toBe("RIFFwav");
    expect(t.aiCalls[0]).toMatchObject({ model: "@cf/myshell-ai/melotts", input: { prompt: "hi" } });
    expect((await t.post("/ai/v1/audio/speech", {})).status).toBe(400);
  });

  it("deepgram speech: input goes as text, the reply is the MP3 stream", async () => {
    const t = setup();
    const r = await t.post("/ai/v1/audio/speech", {
      model: "@cf/deepgram/aura-1",
      input: "hi",
      voice: "alloy",
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/mpeg");
    expect(new TextDecoder().decode(await r.arrayBuffer())).toBe("ID3mp3");
    expect(t.aiCalls[0]).toMatchObject({ model: "@cf/deepgram/aura-1", input: { text: "hi" } });
    expect(t.aiCalls[0]?.input).not.toHaveProperty("prompt");
    expect((await t.post("/ai/v1/audio/speech", { model: "@cf/deepgram/aura-1" })).status).toBe(400);
  });

  it("images: n runs, reply is b64_json data; n is capped", async () => {
    const t = setup();
    const r = await t.post("/ai/v1/images/generations", { prompt: "a cat", n: 2 });
    expect(await r.json()).toMatchObject({ data: [{ b64_json: btoa("jpeg") }, { b64_json: btoa("jpeg") }] });
    expect(t.aiCalls.length).toBe(2);
    expect(t.used("neurons")).toBe(1000);
    t.aiCalls.length = 0;
    await t.post("/ai/v1/images/generations", { prompt: "a cat", n: 99 });
    expect(t.aiCalls.length).toBe(4);
  });

  it("the model id is validated: only @cf/<org>/<name> passes on media and embeddings", async () => {
    const t = setup();
    for (const model of ["../../x", "@cf/a/b/../c", "gpt-4", "@cf/a/b?x=1"]) {
      expect((await t.post("/ai/v1/images/generations", { prompt: "p", model })).status, model).toBe(400);
      expect((await t.post("/ai/v1/embeddings", { input: "p", model })).status, model).toBe(400);
    }
    expect(t.aiCalls).toEqual([]);
  });

  it("a binding error on media passes as an error status and charges nothing", async () => {
    const t = setup();
    t.setAi(() => new Error("3040: capacity"));
    const r = await t.post("/ai/v1/audio/speech", { input: "hi" });
    expect(r.status).toBe(429);
    expect(t.used("neurons")).toBe(0);
  });
});

describe("/ops/caps", () => {
  const env = (seen: unknown[]) =>
    ({
      CONTROL_TOKEN: "owner-tok",
      CI_TOKEN: "ci-tok",
      OC_INST: "t1",
      CONTROL: {
        getByName: () => ({
          ops: async (r: unknown) => {
            seen.push(r);
            return { status: 200, body: { ok: 1 } };
          },
        }),
      },
    }) as never;
  const req = (tok: string, method = "GET", body?: unknown) =>
    new Request("https://w/ops/caps", {
      method,
      headers: { authorization: `Bearer ${tok}` },
      body: body ? JSON.stringify(body) : undefined,
    });

  it("owner reads and raises; the CI token and strangers get 404", async () => {
    const seen: { action: string; method: string; body: unknown }[] = [];
    const e = env(seen);
    expect((await handleOps(req("owner-tok"), e, async () => 1)).status).toBe(200);
    expect((await handleOps(req("owner-tok", "POST", { neurons: 50000 }), e, async () => 1)).status).toBe(
      200,
    );
    expect(seen.map((s) => [s.action, s.method])).toEqual([
      ["caps", "GET"],
      ["caps", "POST"],
    ]);
    expect(seen[1]?.body).toEqual({ neurons: 50000 });
    expect((await handleOps(req("ci-tok"), e, async () => 1)).status).toBe(404);
    expect((await handleOps(req("nope"), e, async () => 1)).status).toBe(404);
    expect(seen).toHaveLength(2);
  });
});

describe("the container never gets a Cloudflare AI credential", () => {
  it("secretEnv strips the pre-zero-token AI token and keeps the other OC_SECRET_ refs", () => {
    const env = {
      OC_SECRET_OC_CF_AI_TOKEN: "old-ai-token-value",
      OC_SECRET_OC_TELEGRAM_BOT_TOKEN: "bot",
      CONTROL_TOKEN: "ctl",
    } as unknown as Env;
    expect(secretEnv(env)).toEqual({ OC_TELEGRAM_BOT_TOKEN: "bot" });
  });
});

describe("/ops/gate (the CapGate over HTTP for the owner)", () => {
  const ai = { run: async () => ({ choices: [{ message: { role: "assistant", content: "pong" } }] }) };
  const mkEnv = () => {
    const calls: string[] = [];
    const env = {
      CONTROL_TOKEN: "owner-tok",
      CI_TOKEN: "ci-tok",
      OC_INST: "t1",
      OC_AI_GATEWAY: "gw",
      AI: ai,
      RUNTIME: { getByName: () => ({}) },
      CONTROL: {
        getByName: () => ({
          gateCall: async (m: string) => {
            calls.push(m);
            return m === "capTake" || m === "capCheck"
              ? { ok: true, used: 0, limit: 1, pct: 0, verb: "x" }
              : { verb: "neurons", used: 1, limit: 2, pct: 0.5 };
          },
        }),
      },
    } as unknown as Env;
    return { env, calls };
  };
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
  const post = (tok: string) =>
    new Request("https://w/ops/gate/ai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "@cf/a/b", messages: [{ role: "user", content: "ping" }] }),
    });

  it("the owner token runs a chat through the gate and the budget; ci and strangers get 404", async () => {
    const { env, calls } = mkEnv();
    const ok = await worker.fetch(post("owner-tok"), env, ctx);
    expect(ok.status).toBe(200);
    expect(
      ((await ok.json()) as { choices: { message: { content: string } }[] }).choices[0]?.message.content,
    ).toBe("pong");
    expect(calls).toContain("capTake");
    expect(calls).toContain("capAdd");
    expect((await worker.fetch(post("ci-tok"), env, ctx)).status).toBe(404);
    expect((await worker.fetch(post("nope"), env, ctx)).status).toBe(404);
  });
});
