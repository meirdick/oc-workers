// "Cloudflare capabilities" (docs/11 §11): web search, web fetch and the browser on Cloudflare through the oc-host
// capability gate; no API key. Plain ESM, no build step; bundled like the other image plugins (/app/dist/extensions).
//  - web search provider `cloudflare-web-search` (the former cf-web-search plugin, id kept so configs keep working)
//  - web fetch provider `cloudflare-web-fetch` (replaces the firecrawl plugin for web_fetch)
//  - the browser: OpenClaw has no plugin API for its built-in browser tool (its CDP endpoint is config:
//    browser.profiles.cf.cdpUrl). The plugin only reads the gate's browser status, for the status method and the Test.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { enablePluginInConfig } from "openclaw/plugin-sdk/provider-web-fetch-contract";
import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";
import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
  wrapWebContent,
} from "openclaw/plugin-sdk/security-runtime";
import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";
import { browserLine, browserStatus, FETCH_ID, PLUGIN_ID, runFetch, runSearch, runTest, SEARCH_ID } from "./gate.mjs";

const sdk = { wrapWebContent, wrapExternalContent, truncateSanitizedExternalContent, isBlockedHostnameOrIp };

export function createSearchProvider() {
  return {
    id: SEARCH_ID,
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
      searchCredential: { type: "scoped", scopeId: SEARCH_ID },
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
          sdk,
          ...(executionContext?.signal ? { signal: executionContext.signal } : {}),
        });
      },
    }),
  };
}

export function createFetchProvider() {
  return {
    id: FETCH_ID,
    label: "Cloudflare Web Fetch",
    hint: "Fetch pages with Cloudflare Browser Run through the capability gate. No API key; daily browser budget, see `ochost caps`.",
    requiresCredential: false,
    envVars: [],
    placeholder: "(no key needed)",
    signupUrl: "https://developers.cloudflare.com/browser-run/",
    docsUrl: "https://developers.cloudflare.com/browser-run/",
    credentialPath: "",
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    applySelectionConfig: (config) => enablePluginInConfig(config, PLUGIN_ID).config,
    createTool: ({ config }) => ({
      description: "Fetch a page with Cloudflare Browser Run.",
      parameters: {},
      execute: async (args, executionContext) => {
        executionContext?.signal?.throwIfAborted();
        return await runFetch({
          cfg: config,
          url: typeof args.url === "string" ? args.url : "",
          extractMode: args.extractMode === "text" ? "text" : "markdown",
          maxChars: Number.isFinite(args.maxChars) ? args.maxChars : undefined,
          sdk,
          ...(executionContext?.signal ? { signal: executionContext.signal } : {}),
        });
      },
    }),
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Cloudflare capabilities",
  description: "Web search, web fetch and the browser on Cloudflare through the oc-workers gate; no API key.",
  register(api) {
    api.registerWebSearchProvider(createSearchProvider());
    api.registerWebFetchProvider(createFetchProvider());
    // The Control UI has no plugin-level Test button and no status line for a capability. These two methods and the
    // CLI command give the owner (and `ochost doctor`) the same three checks.
    const reply = (respond, work) =>
      work().then(
        (result) => respond(true, result, undefined),
        (e) => respond(false, undefined, { code: "UNAVAILABLE", message: String(e?.message ?? e) }),
      );
    api.registerGatewayMethod(
      "cfCapabilities.status",
      ({ respond }) =>
        reply(respond, async () => {
          const s = await browserStatus({ cfg: api.config });
          return { browser: s, line: browserLine(s) };
        }),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "cfCapabilities.test",
      ({ respond }) => reply(respond, () => runTest({ cfg: api.config, sdk })),
      { scope: "operator.write" },
    );
    api.registerCli(
      ({ program, config }) => {
        const cmd = program.command("cf-capabilities").description("Cloudflare capabilities through the oc-host gate");
        cmd
          .command("status")
          .description("Browser state and the daily seconds used")
          .action(async () => {
            console.log(browserLine(await browserStatus({ cfg: config })));
          });
        cmd
          .command("test")
          .description("One real search, one real fetch of https://example.com and one browser status read")
          .action(async () => {
            const r = await runTest({ cfg: config, sdk });
            for (const l of r.lines) console.log(l);
            if (!r.ok) process.exitCode = 1;
          });
      },
      {
        descriptors: [
          { name: "cf-capabilities", description: "Cloudflare capabilities through the oc-host gate", hasSubcommands: true },
        ],
      },
    );
  },
});
