// docs/11 §11: the cf-capabilities plugin (gate.mjs) against a fake gate. Offline: the SDK helpers are fakes, fetch is a stub.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  baseUrlOf,
  browserLine,
  browserStatus,
  fetchUrlOf,
  runFetch,
  runSearch,
  runTest,
} from "../../plugins/cf-capabilities/gate.mjs";

const sdk = {
  wrapWebContent: (t, src) => `<${src}>${t}</${src}>`,
  wrapExternalContent: (t) => `<ext>${t}</ext>`,
  truncateSanitizedExternalContent: (t, max) => ({ text: t.slice(0, max), truncated: t.length > max }),
  isBlockedHostnameOrIp: (h) => h === "localhost" || h.startsWith("10."),
};
const cfg = { plugins: { entries: { "cf-capabilities": { config: {} } } } };

/** A fake gate: records calls, answers by path. */
function gate(over = {}) {
  const calls = [];
  const routes = {
    "/search": () =>
      Response.json({
        success: true,
        data: { web: [{ url: "https://www.e.com/a", title: "A", description: "d" }] },
      }),
    "/v2/scrape": () =>
      Response.json({
        success: true,
        data: { markdown: "# Hi\n\nbody", metadata: { title: "T", sourceURL: "https://example.com/" } },
      }),
    "/browser/status": () => Response.json({ on: true, used: 40, limit: 3600, ok: true, retryAfterS: 9 }),
    ...over,
  };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({
      host: u.origin,
      path: u.pathname,
      method: init.method ?? "GET",
      body: init.body,
      headers: init.headers,
    });
    return (routes[u.pathname] ?? (() => new Response("{}", { status: 404 })))();
  };
  return { calls, fetchImpl };
}
const budget = (verb) =>
  Response.json({ error: "budget", verb, used: 200, limit: 200, retryAfterS: 77 }, { status: 429 });

describe("addresses", () => {
  it("search uses the gate, fetch the loopback relay; the old cf-web-search entry is still read", () => {
    assert.equal(baseUrlOf(cfg), "http://15.0.0.3");
    assert.equal(fetchUrlOf(cfg), "http://127.0.0.1:18791");
    const old = {
      plugins: { entries: { "cf-web-search": { config: { webSearch: { baseUrl: "http://x/" } } } } },
    };
    assert.equal(baseUrlOf(old), "http://x");
    const both = {
      plugins: {
        entries: {
          "cf-capabilities": { config: { webSearch: { baseUrl: "http://new" } } },
          ...old.plugins.entries,
        },
      },
    };
    assert.equal(baseUrlOf(both), "http://new");
  });
});

describe("web search", () => {
  it("posts {query, limit} to <gate>/search and wraps the result; no key, no authorization header", async () => {
    const g = gate();
    const r = await runSearch({ cfg, query: " cats ", count: 3, fetchImpl: g.fetchImpl, sdk });
    assert.deepEqual(
      g.calls.map((c) => [c.host, c.path, c.method]),
      [["http://15.0.0.3", "/search", "POST"]],
    );
    assert.deepEqual(JSON.parse(g.calls[0].body), { query: "cats", limit: 3 });
    assert.equal(JSON.stringify(g.calls[0].headers).match(/authorization|key/i), null);
    assert.equal(r.provider, "cloudflare-web-search");
    assert.equal(r.results[0].siteName, "e.com");
    assert.equal(r.results[0].title, "<web_search>A</web_search>");
  });
  it("429 budget names the verb and the owner command", async () => {
    const g = gate({ "/search": () => budget("websearch") });
    await assert.rejects(
      runSearch({ cfg, query: "q", fetchImpl: g.fetchImpl, sdk }),
      /daily websearch budget spent \(200\/200\); resets in 77 s.*ochost caps set websearch <n>/,
    );
  });
  it("an empty query is refused before any call", async () => {
    const g = gate();
    await assert.rejects(runSearch({ cfg, query: "  ", fetchImpl: g.fetchImpl, sdk }), /needs a query/);
    assert.equal(g.calls.length, 0);
  });
});

describe("web fetch", () => {
  it("posts the Firecrawl shape to <relay>/v2/scrape and returns what web_fetch reads", async () => {
    const g = gate();
    const r = await runFetch({ cfg, url: "https://example.com", fetchImpl: g.fetchImpl, sdk });
    assert.deepEqual(
      g.calls.map((c) => [c.host, c.path]),
      [["http://127.0.0.1:18791", "/v2/scrape"]],
    );
    assert.deepEqual(JSON.parse(g.calls[0].body), { url: "https://example.com/", formats: ["markdown"] });
    assert.equal(r.text, "<ext># Hi\n\nbody</ext>");
    assert.equal(r.title, "<ext>T</ext>");
    assert.equal(r.finalUrl, "https://example.com/");
    assert.equal(r.extractor, "cloudflare");
    assert.equal(r.truncated, false);
  });
  it("maxChars truncates and says so", async () => {
    const g = gate();
    const r = await runFetch({ cfg, url: "https://example.com", maxChars: 4, fetchImpl: g.fetchImpl, sdk });
    assert.equal(r.text, "<ext># Hi</ext>");
    assert.equal(r.truncated, true);
    assert.equal(r.rawLength, 10);
  });
  it("refuses a non-http scheme and a private host before any call", async () => {
    const g = gate();
    await assert.rejects(
      runFetch({ cfg, url: "file:///etc/passwd", fetchImpl: g.fetchImpl, sdk }),
      /non-HTTP/,
    );
    await assert.rejects(
      runFetch({ cfg, url: "http://10.0.0.1/", fetchImpl: g.fetchImpl, sdk }),
      /private\/internal/,
    );
    await assert.rejects(
      runFetch({ cfg, url: "nonsense", fetchImpl: g.fetchImpl, sdk }),
      /full http or https URL/,
    );
    assert.equal(g.calls.length, 0);
  });
  it("429 budget names the browser verb; empty markdown and gate errors are errors", async () => {
    await assert.rejects(
      runFetch({
        cfg,
        url: "https://e.com",
        fetchImpl: gate({ "/v2/scrape": () => budget("browser") }).fetchImpl,
        sdk,
      }),
      /Cloudflare Web Fetch: daily browser budget spent.*ochost caps set browser <n>/,
    );
    const empty = gate({ "/v2/scrape": () => Response.json({ success: true, data: { markdown: "" } }) });
    await assert.rejects(
      runFetch({ cfg, url: "https://e.com", fetchImpl: empty.fetchImpl, sdk }),
      /no content/,
    );
    const bad = gate({
      "/v2/scrape": () => Response.json({ success: false, error: "no content at x" }, { status: 502 }),
    });
    await assert.rejects(
      runFetch({ cfg, url: "https://e.com", fetchImpl: bad.fetchImpl, sdk }),
      /failed \(502\).*no content at x/,
    );
  });
});

describe("browser status and Test", () => {
  it("reads GET /browser/status; the line shows state and seconds", async () => {
    const g = gate();
    const s = await browserStatus({ cfg, fetchImpl: g.fetchImpl });
    assert.equal(g.calls[0].path, "/browser/status");
    assert.equal(g.calls[0].method, "GET");
    assert.equal(browserLine(s), "Browser: on, 40 s of 3600 s today");
    assert.equal(
      browserLine({ on: true, used: 3600, limit: 3600, ok: false }),
      "Browser: on, 3600 s of 3600 s today (budget spent)",
    );
    assert.equal(
      browserLine({ on: false, used: 0, limit: 3600, ok: true }),
      "Browser: off, 0 s of 3600 s today",
    );
  });
  it("Test runs one search, one fetch of https://example.com and one status read", async () => {
    const g = gate();
    const r = await runTest({ cfg, fetchImpl: g.fetchImpl, sdk });
    assert.equal(r.ok, true);
    assert.deepEqual(
      g.calls.map((c) => c.path),
      ["/search", "/v2/scrape", "/browser/status"],
    );
    assert.equal(JSON.parse(g.calls[1].body).url, "https://example.com/");
    assert.match(r.lines[0], /^Web search: ok/);
    assert.match(r.lines[1], /^Web fetch: ok/);
    assert.equal(r.lines[2], "Browser: on, 40 s of 3600 s today");
  });
  it("each part reports alone: a spent search budget fails search only; browser off fails the Test", async () => {
    const g = gate({ "/search": () => budget("websearch") });
    const r = await runTest({ cfg, fetchImpl: g.fetchImpl, sdk });
    assert.equal(r.ok, false);
    assert.match(r.lines[0], /^Web search: failed: .*websearch budget spent/);
    assert.match(r.lines[1], /^Web fetch: ok/);
    const off = gate({
      "/browser/status": () => Response.json({ on: false, used: 0, limit: 3600, ok: true }),
    });
    const r2 = await runTest({ cfg, fetchImpl: off.fetchImpl, sdk });
    assert.equal(r2.ok, false);
    assert.equal(r2.lines[2], "Browser: off, 0 s of 3600 s today");
  });
  it("an old gate without /browser/status makes the browser line fail, not the whole Test", async () => {
    const g = gate({ "/browser/status": () => new Response("{}", { status: 404 }) });
    const r = await runTest({ cfg, fetchImpl: g.fetchImpl, sdk });
    assert.match(r.lines[2], /^Browser: failed: browser status failed \(404\)/);
    assert.match(r.lines[0], /ok/);
  });
});
