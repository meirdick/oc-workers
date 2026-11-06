// docs/11 §7: web_fetch through the CapGate. The cf-capabilities plugin (search, fetch, browser status) is a bundled extension of the image
// (/app/dist/extensions, no load path; docs/13), so with no network at all: config validates, Doctor does not try npm, and an agent turn
// (mock model) calls web_fetch / web_search and the mock gate gets POST /v2/scrape and /search. Runs as uid 1000 with --network none.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dk } from "../harness/docker.mjs";
import { TEST_DIR } from "../harness/env.mjs";

const CFG = {
  models: {
    providers: {
      mock: {
        baseUrl: "http://127.0.0.1:9101/v1",
        api: "openai-completions",
        apiKey: "x",
        models: [{ id: "mock", name: "mock", input: ["text"] }],
      },
    },
  },
  agents: { defaults: { model: { primary: "mock/mock" } } },
  // toolSearch off: the model sees web_fetch directly (default mode hides it behind tool_search).
  tools: {
    toolSearch: false,
    web: { fetch: { provider: "cloudflare-web-fetch" }, search: { provider: "cloudflare-web-search" } },
  },
  plugins: {
    // Production: firecrawl baseUrl is ocsup's loopback forwarder (127.0.0.1:18791 -> 15.0.0.3:80, cli FETCH_URL), since
    // OpenClaw refuses the public-looking 15.0.0.3. Here the real forwarder (lib/cap-proxy.mjs) fronts the mock gate.
    entries: {
      "cf-capabilities": {
        enabled: true,
        config: {
          webFetch: { baseUrl: "http://127.0.0.1:18791" },
          webSearch: { baseUrl: "http://127.0.0.1:9101" },
        },
      },
    },
  },
};

const SCRIPT = `
mkdir -p /tmp/st /tmp/h; cp /cfg/openclaw.json /tmp/st/openclaw.json; cd /app
node /t/fakes/webfetch-mock.mjs > /tmp/mock.out 2>&1 & M=$!
node --input-type=module -e 'import {startCapProxy} from "/opt/ocrt/lib/cap-proxy.mjs"; startCapProxy({target:{host:"127.0.0.1",port:9101}}); setInterval(()=>{},1e6)' > /tmp/proxy.out 2>&1 & P=$!
sleep 1
echo "@@validate"; node openclaw.mjs config validate 2>&1
echo "@@list"; node openclaw.mjs plugins list --json 2>&1 | grep -A16 '"id": "cf-capabilities"'
echo "@@providers"; node openclaw.mjs infer web providers --json 2>&1
echo "@@health"; node openclaw.mjs infer web search --provider cloudflare-web-search --query "health probe" --json 2>&1
echo "@@status"; node openclaw.mjs cf-capabilities status 2>&1
echo "@@doctor"; timeout 200 node openclaw.mjs doctor --fix --non-interactive 2>&1
echo "@@agent"; timeout 200 node openclaw.mjs agent --local --message "fetch http://example.com" --session-id t1 --json 2>&1
echo "@@agent2"; timeout 200 node openclaw.mjs agent --local --message "search for cloudflare web search" --session-id t2 --json 2>&1
kill -TERM $M $P; sleep 1
echo "@@mock"; cat /tmp/mock.out
`;

export default {
  name: "webfetch-plugin",
  source: "docs/11 §7 (web_fetch through the CapGate); M6 capgate live F2",
  rule: "Image ships cf-capabilities (and firecrawl, deprecated) as root-owned bundled extensions (no load path); offline: config validate has no 'plugin not installed', Doctor never mentions npm or EAI_AGAIN, plugins list shows cf-capabilities enabled, and a mock-model turn runs web_fetch http://example.com so the mock gate gets POST /v2/scrape through ocsup's loopback forwarder (baseUrl http://127.0.0.1:18791) and the model sees its text; another runs web_search and the gate gets POST /search (plugin cf-capabilities, shown as a provider); `openclaw cf-capabilities status` reads GET /browser/status.",
  timeoutMs: 600_000,
  async run(t) {
    const sh = (c) => dk(["run", "--rm", "--entrypoint", "sh", t.image, "-c", c]);
    const own = sh(
      "stat -c '%U' /app/dist/extensions/firecrawl /app/dist/extensions/firecrawl/dist/index.js /app/dist/extensions/cf-capabilities /app/dist/extensions/cf-capabilities/index.js",
    ).out;
    t.check(
      "plugin dir root-owned",
      own.split("\n").every((x) => x === "root"),
      own,
    );
    t.check("typebox bundled", sh("test -d /app/dist/extensions/firecrawl/node_modules/typebox").code === 0);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-"));
    fs.writeFileSync(path.join(dir, "openclaw.json"), JSON.stringify(CFG));
    const r = dk(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "1000",
        "-v",
        `${dir}:/cfg:ro`,
        "-v",
        `${TEST_DIR}:/t:ro`,
        "-e",
        "HOME=/tmp/h",
        "-e",
        "OPENCLAW_STATE_DIR=/tmp/st",
        "-e",
        "OPENCLAW_CONFIG_PATH=/tmp/st/openclaw.json",
        "--entrypoint",
        "sh",
        t.image,
        "-c",
        SCRIPT,
      ],
      { timeoutMs: 550_000 },
    );
    fs.rmSync(dir, { recursive: true, force: true });
    const part = (k) => {
      const m = new RegExp(`@@${k}\\n([\\s\\S]*?)(?=\\n@@|$)`).exec(r.out);
      return m ? m[1] : "";
    };
    t.check("config valid", /Config valid/.test(part("validate")), part("validate").slice(-300));
    t.check("no 'plugin not installed'", !/not installed/.test(part("validate")));
    t.check("plugin listed and enabled", /"enabled": true/.test(part("list")), part("list"));
    t.check(
      "cloudflare-web-search is a listed, configured provider",
      /"configured": true,\s*"selected": true,\s*"id": "cloudflare-web-search"/.test(part("providers")),
      part("providers").slice(0, 600),
    );
    t.check(
      "provider health: a search through the gate answers",
      /GATE-SEARCH-MARKER/.test(part("health")),
      part("health").slice(0, 600),
    );
    t.check(
      "browser status read through the gate",
      /Browser: on, 40 s of 3600 s today/.test(part("status")),
      part("status").slice(0, 300),
    );
    const doc = part("doctor");
    t.check(
      "Doctor never tried npm",
      !/EAI_AGAIN|npm (error|view)|openclaw plugins install/.test(doc),
      doc.slice(-400),
    );
    const log = JSON.parse((/^LOG (.*)$/m.exec(part("mock")) || [, "[]"])[1]);
    const gate = log.find((x) => x.gate === "/v2/scrape");
    t.check("agent called web_fetch → gate got POST /v2/scrape", gate?.gate === "/v2/scrape", log);
    t.check(
      "gate body carries the url",
      String(JSON.parse(gate?.body || "{}").url ?? "").replace(/\/$/, "") === "http://example.com", // the provider normalizes the URL
      gate?.body,
    );
    t.check("model saw the gate's text", /done: SAW-MARKER/.test(part("agent")), part("agent").slice(-300));
    const sg = log.find((x) => x.gate === "/search" && /cloudflare web search/.test(x.body));
    t.check("agent called web_search → gate got POST /search", !!sg, log);
    t.check(
      "model saw the gate's search result",
      /done: SAW-MARKER/.test(part("agent2")),
      part("agent2").slice(-300),
    );
  },
};
