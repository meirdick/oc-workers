// CapGate at 15.0.0.3:80 (docs/11 §4; D14). The one gate uid 1000 can reach: nft allows uid 1000 to this
// address only (image/ocrt/lib/netfilter.mjs). The agent holds no Cloudflare credential. The Worker holds the
// BROWSER and AI bindings (no token: the binding authenticates as the account); this gate spends them within the
// per-verb daily budgets in the Control DO (gates/caps.ts). No bearer: the address exists only inside this install's container. The budget
// bounds what a steered agent can spend.
//   GET  /caps                      budgets used today
//   GET  /browser/devtools          WebSocket CDP bridge to env.BROWSER (cdpUrl ws://15.0.0.3/browser/devtools)
//   GET  /browser/devtools/json/version   discovery document for CDP clients
//   POST /browser/content           {url} → {success, result: html}        (Browser Run REST shape)
//   POST /browser/markdown          {url} → {success, result: markdown}
//   POST /v2/scrape                 {url, formats?} → {success, data: {markdown, html?, metadata}}  (Firecrawl shape,
//                                   what OpenClaw's firecrawl plugin calls for web_fetch; it keeps only the host of
//                                   baseUrl, so the route is at the root. /browser/v2/scrape is an alias)
//   POST /v2/search                 {query, limit?} → {success, data: {web: [{url, title, description}]}}  (Firecrawl shape,
//                                   what the same plugin calls for web_search) backed by env.AI.websearch() (Web Search
//                                   API), charged to the `websearch` budget. /search is an alias.
//   POST /ai/v1/chat/completions    OpenAI chat, streaming too → env.AI.run (Workers AI, or anthropic/<model> by BYOK)
//   POST /ai/v1/{embeddings,audio/speech,audio/transcriptions,images/generations}   → env.AI.run; see ai()
import { type AiBinding, type AiCtx, b64, CF_MODEL_RE, chat, embeddings, runMedia, unb64 } from "./ai";
import { type CapVerb, estimateNeurons } from "./caps";
import { Cdp, closeBrowser, evalPage, MARKDOWN_JS, openBrowser } from "./cdp";
import type { GatePort } from "./ledger";

export const CAP_ADDR = "15.0.0.3:80";

/** Ledger calls the gate makes. */
export type CapPort = Pick<GatePort, "capCheck" | "capTake" | "capAdd" | "ring">;

export interface CapDeps {
  ctl: CapPort;
  /** Workers Browser binding (wrangler `browser`). Absent → 503 on browser routes. */
  browser?: Fetcher;
  /** Workers AI binding's websearch() (Web Search API). Absent → 503 on /v2/search. */
  websearch?: (o: { gatewayId: string; query: string; limit: number }) => Promise<Response>;
  /** Workers AI binding (wrangler `ai`). Absent → 503 on /ai/v1. */
  ai?: AiBinding;
  /** AI Gateway id the binding routes through (OC_AI_GATEWAY). Empty → no gateway. */
  gateway?: string;
  now: () => number;
  /** WebSocket seam: the Workers runtime has WebSocketPair and `new Response(null, {status: 101, webSocket})`. */
  ws: { pair(): { client: WebSocket; server: WebSocket }; respond(client: WebSocket): Response };
  waitUntil?: (p: Promise<unknown>) => void;
}

/** How often an open CDP socket is charged and re-checked. */
export const BROWSER_TICK_MS = 15_000;
const MAX_BODY = 25 * 1024 * 1024;
const AI_ROUTES = [
  "chat/completions",
  "embeddings",
  "audio/speech",
  "audio/transcriptions",
  "images/generations",
];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });
const refuse = (verb: CapVerb, retryAfterS: number, used: number, limit: number) =>
  json({ error: "budget", verb, used: Math.round(used), limit, retryAfterS }, 429, {
    "retry-after": String(retryAfterS),
  });

/** Refuse when `extra` is spent; else count one request (a refusal there is the 429 to return). */
async function admit(d: CapDeps, extra?: CapVerb): Promise<Response | null> {
  if (extra) {
    const c = await d.ctl.capCheck(extra);
    if (!c.ok) return refuse(extra, c.retryAfterS, c.used, c.limit);
  }
  const r = await d.ctl.capTake("requests", 1);
  return r.ok ? null : refuse("requests", r.retryAfterS, r.used, r.limit);
}

/** Whole seconds, rounded up; no time passed charges nothing. */
const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

export async function handleCapGate(req: Request, d: CapDeps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (path === "/caps" && req.method === "GET") {
      const out: Record<string, unknown> = {};
      for (const v of ["browser", "neurons", "requests", "websearch"] as const)
        out[v] = await d.ctl.capCheck(v);
      return json(out);
    }
    if (path === "/browser/devtools/json/version" && req.method === "GET")
      return json({
        Browser: "oc-host/CapGate",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://${req.headers.get("host") ?? "15.0.0.3"}/browser/devtools`,
      });
    if (path === "/browser/devtools") return await devtools(req, d);
    if (req.method === "POST" && (path === "/browser/content" || path === "/browser/markdown"))
      return await scrape(req, d, path === "/browser/markdown" ? "markdown" : "content");
    if (req.method === "POST" && (path === "/v2/scrape" || path === "/browser/v2/scrape"))
      return await scrape(req, d, "firecrawl");
    if (req.method === "POST" && (path === "/v2/search" || path === "/search")) return await search(req, d);
    if (path.startsWith("/ai/v1/")) return await ai(req, d, path.slice("/ai/v1/".length));
    return json({ error: "not found" }, 404);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void d.ctl.ring("cap", "error", { path, msg: msg.slice(0, 300) }).catch(() => undefined);
    return json({ error: "gate", detail: msg.slice(0, 200) }, 502);
  }
}

// ---------------------------------------------------------------- /browser/devtools

async function devtools(req: Request, d: CapDeps): Promise<Response> {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return json({ error: "websocket only" }, 426);
  if (!d.browser) return json({ error: "no browser binding" }, 503);
  const no = await admit(d, "browser");
  if (no) return no;
  const start = d.now();
  const up = await openBrowser(d.browser);
  const { client, server } = d.ws.pair();
  server.accept();
  let charged = start;
  let done = false;
  const charge = async (): Promise<boolean> => {
    // Move the mark before the await: a frame that arrives while capAdd runs must not charge the same span again.
    const t = d.now();
    const span = seconds(t - charged);
    charged = t;
    const u = await d.ctl.capAdd("browser", span);
    return u.pct < 1;
  };
  const end = (code: number, reason: string) => {
    if (done) return;
    done = true;
    for (const w of [server, up.ws]) {
      try {
        w.close(code, reason);
      } catch {
        // already closed
      }
    }
    const fin = charge()
      .then(() => closeBrowser(d.browser as Fetcher, up.id))
      .catch(() => undefined);
    d.waitUntil?.(fin);
  };
  // Charge every tick while frames flow; a spent budget closes the bridge (1013 try again later).
  const tick = async () => {
    if (done || d.now() - charged < BROWSER_TICK_MS) return;
    if (!(await charge())) end(1013, "browser budget spent");
  };
  server.addEventListener("message", (e: MessageEvent) => {
    if (!done) up.ws.send(e.data);
    void tick();
  });
  up.ws.addEventListener("message", (e: MessageEvent) => {
    if (!done) server.send(e.data);
    void tick();
  });
  server.addEventListener("close", () => end(1000, "client closed"));
  up.ws.addEventListener("close", () => end(1000, "browser closed"));
  server.addEventListener("error", () => end(1011, "client error"));
  up.ws.addEventListener("error", () => end(1011, "browser error"));
  return d.ws.respond(client);
}

// ---------------------------------------------------------------- /browser/content, /markdown

type Kind = "content" | "markdown" | "firecrawl";

async function scrape(req: Request, d: CapDeps, kind: Kind): Promise<Response> {
  if (!d.browser) return json({ error: "no browser binding" }, 503);
  let target: URL;
  try {
    const b = (await req.json()) as { url?: unknown };
    target = new URL(String(b.url));
  } catch {
    return json({ success: false, error: "body must be JSON with a url" }, 400);
  }
  if (target.protocol !== "https:" && target.protocol !== "http:")
    return json({ success: false, error: "http or https url only" }, 400);
  const no = await admit(d, "browser");
  if (no) return no;
  const start = d.now();
  const up = await openBrowser(d.browser);
  const cdp = new Cdp(up.ws);
  try {
    const expr = kind === "content" ? "document.documentElement.outerHTML" : MARKDOWN_JS;
    const raw = await evalPage(cdp, target.href, expr);
    if (kind === "content") return json({ success: true, result: raw });
    const page = JSON.parse(raw) as { title: string; text: string; url: string };
    if (kind === "markdown") return json({ success: true, result: page.text });
    // The plugin turns an empty markdown into an error; say so here, with the page URL.
    if (!page.text.trim()) return json({ success: false, error: `no content at ${target.href}` }, 502);
    return json({
      success: true,
      data: { markdown: page.text, metadata: { title: page.title, sourceURL: target.href, url: page.url } },
    });
  } finally {
    try {
      up.ws.close(1000, "done");
    } catch {
      // already closed
    }
    await d.ctl.capAdd("browser", seconds(d.now() - start));
    d.waitUntil?.(closeBrowser(d.browser, up.id));
  }
}

// ---------------------------------------------------------------- /v2/search

const SEARCH_MAX_QUERY = 1024;
const SEARCH_MAX_LIMIT = 10;

/**
 * Web Search API (developers.cloudflare.com/web-search/how-to-use) through env.AI.websearch(), as the account: no token.
 * Items {url, title, description} come back in the Firecrawl search shape. One `websearch` unit per answered search.
 * The API needs a gateway id; with OC_AI_GATEWAY empty it uses `default`.
 */
async function search(req: Request, d: CapDeps): Promise<Response> {
  let query: string;
  let limit: number;
  try {
    const b = (await req.json()) as { query?: unknown; limit?: unknown };
    query = String(b.query ?? "").trim();
    limit = Math.min(Math.max(Math.floor(Number(b.limit ?? 5)) || 5, 1), SEARCH_MAX_LIMIT);
  } catch {
    return json({ success: false, error: "body must be JSON with a query" }, 400);
  }
  if (!query || query.length > SEARCH_MAX_QUERY)
    return json({ success: false, error: `query must be 1 to ${SEARCH_MAX_QUERY} characters` }, 400);
  if (!d.websearch) return json({ success: false, error: "web search not configured" }, 503);
  const gatewayId = d.gateway || "default";
  const no = await admit(d, "websearch");
  if (no) return no;
  const up = await d.websearch({ gatewayId, query, limit });
  if (!up.ok) {
    const detail = (await up.text().catch(() => "")).slice(0, 200);
    return json({ success: false, error: `web search failed (${up.status}) ${detail}`.trim() }, 502);
  }
  // The binding returns the bare body; a {result: …} wrapper is accepted too.
  const raw = (await up.json().catch(() => null)) as { items?: unknown; result?: { items?: unknown } } | null;
  const items = raw?.items ?? raw?.result?.items;
  if (!Array.isArray(items)) return json({ success: false, error: "web search: no items in reply" }, 502);
  await d.ctl.capAdd("websearch", 1);
  const web = (items as { url?: string; title?: string; description?: string }[])
    .filter((i) => typeof i?.url === "string")
    .slice(0, limit)
    .map((i) => ({ url: i.url, title: i.title || i.url, description: i.description ?? "" }));
  return json({ success: true, data: { web } });
}

// ---------------------------------------------------------------- /ai/v1/*

const DEFAULT_MODEL: Record<string, string> = {
  embeddings: "@cf/baai/bge-m3",
  "audio/speech": "@cf/deepgram/aura-2-en", // melotts stops 2026-11-15
  "audio/transcriptions": "@cf/openai/whisper-large-v3-turbo",
  "images/generations": "@cf/black-forest-labs/flux-1-schnell",
};
const IMAGES_MAX = 4;

/**
 * Every model call goes through env.AI (gates/ai.ts); the container holds no token and the Worker needs none.
 *   chat, embeddings → env.AI.run with the gateway option (logs, spend limit)
 *   speech, transcriptions, images → env.AI.run without it (binding shapes: {audio}, {text}, {image}; the
 *     gateway's workers-ai routes answered 401 for these with a token, 2026-11-03)
 * Neurons: the model's own count when it reports one, else an estimate (caps.ts). anthropic/<model> costs
 * requests only; the provider bills the key in the gateway BYOK store.
 */
async function ai(req: Request, d: CapDeps, route: string): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!AI_ROUTES.includes(route)) return json({ error: "not found" }, 404);
  if (!d.ai) return json({ error: "no ai binding" }, 503);
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) return json({ error: "body too large" }, 413);
  const c: AiCtx = {
    ai: d.ai,
    gateway: d.gateway || undefined,
    now: d.now,
    charge: (n) => d.ctl.capAdd("neurons", n),
  };
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > MAX_BODY) return json({ error: "body too large" }, 413);
  const ct = req.headers.get("content-type") ?? "application/json";
  let reqJson: Record<string, unknown> | null = null;
  if (ct.includes("json")) {
    try {
      const j = JSON.parse(new TextDecoder().decode(body)) as unknown;
      if (j && typeof j === "object" && !Array.isArray(j)) reqJson = j as Record<string, unknown>;
    } catch {
      return json({ error: "bad json" }, 400);
    }
  }
  const pick = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
  if (route === "chat/completions") {
    if (!reqJson) return json({ error: "json body required" }, 400);
    // A provider model spends the owner's key, not neurons; it still counts as a request.
    const no = await admit(d, String(reqJson.model ?? "").startsWith("anthropic/") ? undefined : "neurons");
    return no ?? chat(reqJson, c);
  }
  if (route === "embeddings") {
    if (!reqJson) return json({ error: "json body required" }, 400);
    const no = await admit(d, "neurons");
    return no ?? embeddings(reqJson, c, DEFAULT_MODEL.embeddings as string);
  }
  const no = await admit(d, "neurons");
  if (no) return no;
  let out: Response;
  let bytes = body.byteLength;
  if (route === "audio/speech") {
    if (!reqJson) return json({ error: "json body required" }, 400);
    const model = pick(reqJson.model) ?? (DEFAULT_MODEL["audio/speech"] as string);
    if (!CF_MODEL_RE.test(model)) return json({ error: "bad model" }, 400);
    const input = pick(reqJson.input);
    if (!input) return json({ error: "input required" }, 400);
    // Deepgram Aura models take `text` (M7 live: aura-1 answered 5006 "required properties are 'text'" for `prompt`)
    // and return the audio itself (MP3 stream), not {audio: base64}. MeloTTS takes `prompt` and returns WAV.
    const deepgram = model.startsWith("@cf/deepgram/");
    const r = await runMedia(
      c,
      model,
      deepgram ? { text: input } : { prompt: input, ...(pick(reqJson.lang) ? { lang: reqJson.lang } : {}) },
    );
    if (!r.ok) return r.res;
    if (deepgram) {
      const v: unknown = r.value;
      const raw =
        v instanceof Response
          ? v.body
          : v instanceof ReadableStream || v instanceof ArrayBuffer || ArrayBuffer.isView(v)
            ? (v as BodyInit)
            : typeof r.value.audio === "string"
              ? unb64(r.value.audio)
              : null;
      if (!raw) return json({ error: "no audio in reply" }, 502);
      out = new Response(raw, { headers: { "content-type": "audio/mpeg" } });
    } else {
      if (typeof r.value.audio !== "string") return json({ error: "no audio in reply" }, 502);
      // MeloTTS returns WAV; response_format is not honoured.
      out = new Response(unb64(r.value.audio), { headers: { "content-type": "audio/wav" } });
    }
  } else if (route === "audio/transcriptions") {
    let form: FormData;
    try {
      form = await new Response(body, { headers: { "content-type": ct } }).formData();
    } catch {
      return json({ error: "multipart form required" }, 400);
    }
    const file = form.get("file");
    if (!file || typeof file === "string") return json({ error: "file required" }, 400);
    const model = pick(form.get("model")) ?? (DEFAULT_MODEL["audio/transcriptions"] as string);
    if (!CF_MODEL_RE.test(model)) return json({ error: "bad model" }, 400);
    const audio = new Uint8Array(await file.arrayBuffer());
    bytes = audio.byteLength;
    const lang = pick(form.get("language"));
    const r = await runMedia(c, model, { audio: b64(audio), ...(lang ? { language: lang } : {}) });
    if (!r.ok) return r.res;
    if (typeof r.value.text !== "string") return json({ error: "no text in reply" }, 502);
    out = json({ text: r.value.text.trim() });
  } else {
    if (!reqJson) return json({ error: "json body required" }, 400);
    const model = pick(reqJson.model) ?? (DEFAULT_MODEL["images/generations"] as string);
    if (!CF_MODEL_RE.test(model)) return json({ error: "bad model" }, 400);
    const prompt = pick(reqJson.prompt);
    if (!prompt) return json({ error: "prompt required" }, 400);
    const n = Math.min(Math.max(Math.floor(Number(reqJson.n ?? 1)) || 1, 1), IMAGES_MAX);
    const rs = await Promise.all(Array.from({ length: n }, () => runMedia(c, model, { prompt, steps: 4 })));
    const bad = rs.find((r) => !r.ok);
    if (bad && !bad.ok) return bad.res;
    const images = rs.map((r) => (r.ok ? r.value.image : undefined));
    if (images.some((i) => typeof i !== "string")) return json({ error: "no image in reply" }, 502);
    out = json({ created: Math.floor(d.now() / 1000), data: images.map((b64_json) => ({ b64_json })) });
    reqJson = { ...reqJson, n };
  }
  await d.ctl.capAdd("neurons", estimateNeurons(route, { bytes, json: reqJson }, null));
  return out;
}
