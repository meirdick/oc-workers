// Calls the oc-host capability gate for the cf-capabilities plugin (docs/11 §11). No SDK import: index.js passes the
// SDK helpers in as `sdk`, so the offline unit test can run this file with fakes. No API key anywhere; the gate holds
// the Cloudflare bindings and enforces the daily budgets (429 {error: "budget"}).
export const PLUGIN_ID = "cf-capabilities";
/** Id of the plugin before it took the browser and fetch capabilities (still read, see baseUrlOf). */
export const LEGACY_PLUGIN_ID = "cf-web-search";
export const SEARCH_ID = "cloudflare-web-search";
export const FETCH_ID = "cloudflare-web-fetch";
export const DEFAULT_BASE_URL = "http://15.0.0.3";
/** ocsup's loopback forwarder to the gate (image/ocrt/lib/cap-proxy.mjs CAP_PROXY_PORT). */
export const DEFAULT_FETCH_URL = "http://127.0.0.1:18791";
const TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 10_000;
const FIELD_MAX = 4000;
const FETCH_MAX_CHARS = 50_000;

const entryOf = (cfg) => cfg?.plugins?.entries?.[PLUGIN_ID] ?? cfg?.plugins?.entries?.[LEGACY_PLUGIN_ID];
const clean = (v, dflt) => (typeof v === "string" && v.trim() ? v.trim() : dflt).replace(/\/+$/, "");

/** The gate: search and the browser status read. Key plugins.entries.cf-capabilities.config.webSearch.baseUrl. */
export const baseUrlOf = (cfg) => clean(entryOf(cfg)?.config?.webSearch?.baseUrl, DEFAULT_BASE_URL);
/** Web fetch goes through the loopback forwarder: plugins.entries.cf-capabilities.config.webFetch.baseUrl. */
export const fetchUrlOf = (cfg) => clean(entryOf(cfg)?.config?.webFetch?.baseUrl, DEFAULT_FETCH_URL);

const deadline = (signal, ms) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

/** The text of a gate 429 (budget). Same words for search and fetch. */
const budgetError = (what, body) =>
  new Error(
    `${what}: daily ${body.verb} budget spent (${body.used}/${body.limit}); resets in ${body.retryAfterS} s. The owner can raise it with \`ochost caps set ${body.verb} <n>\`.`,
  );

/** The gate answers {success, data: {web: [{url, title, description}]}}; errors are {success: false, error} or {error: "budget", ...}. */
export async function runSearch({ cfg, query, count, signal, fetchImpl = fetch, sdk }) {
  const wrap = (text) =>
    sdk.wrapWebContent(sdk.truncateSanitizedExternalContent(String(text ?? ""), FIELD_MAX).text, "web_search");
  const q = String(query ?? "").trim();
  if (!q) throw new Error("web_search needs a query");
  const start = Date.now();
  const res = await fetchImpl(`${baseUrlOf(cfg)}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: q, ...(count ? { limit: count } : {}) }),
    signal: deadline(signal, TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  if (res.status === 429 && body?.error === "budget") throw budgetError("Cloudflare Web Search", body);
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
    provider: SEARCH_ID,
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: { untrusted: true, source: "web_search", provider: SEARCH_ID, wrapped: true },
    results,
  };
}

/**
 * POST <fetch base>/v2/scrape {url, formats: ["markdown"]}: the Firecrawl wire shape the gate serves, from Browser Run.
 * Answer {success, data: {markdown, metadata: {title, sourceURL, url}}}. The result has the fields web_fetch reads.
 */
export async function runFetch({ cfg, url, extractMode, maxChars, signal, fetchImpl = fetch, sdk }) {
  const wrap = (text, max) => sdk.wrapExternalContent(sdk.truncateSanitizedExternalContent(String(text ?? ""), max).text, {
    source: "web_fetch",
    includeWarning: false,
  });
  let target;
  try {
    target = new URL(String(url));
  } catch {
    throw new Error("web_fetch needs a full http or https URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:")
    throw new Error(`Blocked non-HTTP(S) protocol in Cloudflare Web Fetch URL: ${target.protocol}`);
  if (sdk.isBlockedHostnameOrIp?.(target.hostname))
    throw new Error(`Blocked hostname or private/internal IP in Cloudflare Web Fetch URL: ${target.hostname}`);
  const res = await fetchImpl(`${fetchUrlOf(cfg)}/v2/scrape`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: target.href, formats: ["markdown"] }),
    signal: deadline(signal, TIMEOUT_MS * 2),
  });
  const body = await res.json().catch(() => null);
  if (res.status === 429 && body?.error === "budget") throw budgetError("Cloudflare Web Fetch", body);
  if (!res.ok || !body || body.success === false)
    throw new Error(
      `Cloudflare Web Fetch failed (${res.status}): ${wrap(body?.error ?? body?.detail ?? res.statusText, 500)}`,
    );
  const data = body.data ?? {};
  const markdown = typeof data.markdown === "string" ? data.markdown : "";
  if (!markdown) throw new Error("Cloudflare Web Fetch returned no content.");
  const cap = Math.floor(Math.min(Number(maxChars) > 0 ? Number(maxChars) : FETCH_MAX_CHARS, FETCH_MAX_CHARS));
  const bounded = sdk.truncateSanitizedExternalContent(markdown, cap);
  const text = sdk.wrapExternalContent(bounded.text, { source: "web_fetch", includeWarning: false });
  const meta = data.metadata ?? {};
  return {
    url: target.href,
    finalUrl: typeof meta.url === "string" && meta.url ? meta.url : (meta.sourceURL ?? target.href),
    ...(typeof meta.title === "string" && meta.title ? { title: wrap(meta.title, 500) } : {}),
    extractor: "cloudflare",
    extractMode: extractMode === "text" ? "text" : "markdown",
    externalContent: { untrusted: true, source: "web_fetch", wrapped: true },
    truncated: bounded.truncated,
    rawLength: markdown.length,
    length: text.length,
    text,
  };
}

/** GET <gate>/browser/status → {on, used, limit, ok, retryAfterS}. The gate does not charge for it. */
export async function browserStatus({ cfg, signal, fetchImpl = fetch }) {
  const res = await fetchImpl(`${baseUrlOf(cfg)}/browser/status`, { signal: deadline(signal, STATUS_TIMEOUT_MS) });
  const b = await res.json().catch(() => null);
  if (!res.ok || typeof b?.on !== "boolean") throw new Error(`browser status failed (${res.status})`);
  return b;
}

/** "Browser: on, 40 s of 3600 s today" */
export const browserLine = (s) =>
  `Browser: ${s.on ? "on" : "off"}, ${s.used} s of ${s.limit} s today${s.on && !s.ok ? " (budget spent)" : ""}`;

/**
 * The health check: one real search, one real fetch of https://example.com and one browser status read, through the
 * gate. Each part reports on its own; ok is true when all three work.
 */
export async function runTest({ cfg, signal, fetchImpl = fetch, sdk }) {
  const part = async (fn) => {
    const t = Date.now();
    try {
      return { ok: true, ...(await fn()), ms: Date.now() - t };
    } catch (e) {
      return { ok: false, ms: Date.now() - t, error: String(e?.message ?? e) };
    }
  };
  const [search, fetched, browser] = [
    await part(async () => {
      const r = await runSearch({ cfg, query: "cloudflare", count: 1, signal, fetchImpl, sdk });
      return { detail: `${r.count} result` };
    }),
    await part(async () => {
      const r = await runFetch({ cfg, url: "https://example.com", signal, fetchImpl, sdk });
      return { detail: `${r.rawLength} characters` };
    }),
    await part(async () => {
      const s = await browserStatus({ cfg, signal, fetchImpl });
      return { ok: s.on, detail: browserLine(s), status: s };
    }),
  ];
  const lines = [
    `Web search: ${search.ok ? `ok (${search.detail}, ${search.ms} ms)` : `failed: ${search.error}`}`,
    `Web fetch: ${fetched.ok ? `ok (${fetched.detail}, ${fetched.ms} ms)` : `failed: ${fetched.error}`}`,
    browser.detail ?? `Browser: failed: ${browser.error}`,
  ];
  return { ok: search.ok && fetched.ok && browser.ok, search, fetch: fetched, browser, lines };
}
