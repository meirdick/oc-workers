// web_search provider "Cloudflare Web Search" (docs/11 §8). No API key: it calls the capability gate (POST <baseUrl>/search),
// which holds the Cloudflare token, bills the install's AI Gateway credits and enforces the daily `websearch` budget.
// Plain ESM, no build step; the SDK subpaths resolve in the host like the official firecrawl plugin's.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";
import { truncateSanitizedExternalContent, wrapWebContent } from "openclaw/plugin-sdk/security-runtime";

const ID = "cloudflare-web-search";
const PLUGIN_ID = "cf-web-search";
const DEFAULT_BASE_URL = "http://15.0.0.3";
const TIMEOUT_MS = 30_000;
const FIELD_MAX = 4000;

const baseUrlOf = (cfg) => {
  const v = cfg?.plugins?.entries?.[PLUGIN_ID]?.config?.webSearch?.baseUrl;
  return (typeof v === "string" && v.trim() ? v.trim() : DEFAULT_BASE_URL).replace(/\/+$/, "");
};
const wrap = (text) => wrapWebContent(truncateSanitizedExternalContent(String(text ?? ""), FIELD_MAX).text, "web_search");

/** The gate answers {success, data: {web: [{url, title, description}]}}; errors are {success: false, error} or {error: "budget", ...}. */
export async function runSearch({ cfg, query, count, signal, fetchImpl = fetch }) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("web_search needs a query");
  const start = Date.now();
  const res = await fetchImpl(`${baseUrlOf(cfg)}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: q, ...(count ? { limit: count } : {}) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  if (res.status === 429 && body?.error === "budget")
    throw new Error(
      `Cloudflare Web Search: daily ${body.verb} budget spent (${body.used}/${body.limit}); resets in ${body.retryAfterS} s. The owner can raise it with \`ochost caps set ${body.verb} <n>\`.`,
    );
  if (!res.ok || !body || body.success === false)
    throw new Error(`Cloudflare Web Search failed (${res.status}): ${wrap(body?.error ?? body?.detail ?? res.statusText)}`);
  const web = Array.isArray(body?.data?.web) ? body.data.web : [];
  const results = web.slice(0, count || 10).map((r) => {
    let siteName;
    try {
      siteName = new URL(r.url).hostname.replace(/^www\./, "");
    } catch {}
    return {
      title: r.title ? wrap(r.title) : "",
      url: r.url,
      description: r.description ? wrap(r.description) : "",
      ...(siteName ? { siteName } : {}),
    };
  });
  return {
    query: q,
    provider: ID,
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: { untrusted: true, source: "web_search", provider: ID, wrapped: true },
    results,
  };
}

export function createProvider() {
  return {
    id: ID,
    label: "Cloudflare Web Search",
    hint: "Cloudflare Web Search API through the capability gate. No API key; daily budget, see `ochost caps`.",
    onboardingScopes: ["text-inference"],
    requiresCredential: false,
    envVars: [],
    placeholder: "(no key needed)",
    signupUrl: "https://developers.cloudflare.com/web-search/",
    docsUrl: "https://developers.cloudflare.com/web-search/how-to-use/",
    credentialPath: "",
    ...createWebSearchProviderContractFields({
      credentialPath: "",
      searchCredential: { type: "scoped", scopeId: ID },
      selectionPluginId: PLUGIN_ID,
    }),
    createTool: (ctx) => ({
      description:
        "Search the web with the Cloudflare Web Search API. Returns titles, URLs and snippets. Read a result with web_fetch.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query string." },
          count: { type: "integer", description: "Number of results to return (1-10).", minimum: 1, maximum: 10 },
        },
        additionalProperties: false,
      },
      execute: async (args, executionContext) => {
        executionContext?.signal?.throwIfAborted();
        const count = Number.isInteger(args?.count) ? Math.min(Math.max(args.count, 1), 10) : undefined;
        return await runSearch({
          cfg: ctx.config,
          query: args?.query,
          count,
          ...(executionContext?.signal ? { signal: executionContext.signal } : {}),
        });
      },
    }),
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Cloudflare Web Search",
  description: "web_search through the Cloudflare Web Search API, via the oc-host capability gate.",
  register(api) {
    api.registerWebSearchProvider(createProvider());
  },
});
