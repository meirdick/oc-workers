// M4 fix F9 (M3 e2e): with no config version ocsup rendered nothing, the gateway ran `--auth token`, and the
// Control UI through the proxy could not connect. Rule: a fresh install with zero posted config renders a
// default document (model + provider key ref + managed trusted-proxy auth); the gateway starts in
// trusted-proxy mode; ocsup's CLI reaches it with the local password; no secret value in openclaw.json.

import { GW_TOKEN } from "../harness/env.mjs";
import { gatewayPid } from "../harness/flows.mjs";

const KEY = "sk-ant-m4-f9-probe-7c1e4b2a";

export default {
  name: "fresh-default-config",
  source: "M3 e2e F9; plan §4.9; M3 ingress (trusted-proxy keys)",
  rule: "Plan with configVer null: openclaw.json has gateway.auth.mode trusted-proxy with trustedProxy.userHeader x-ochost-user, agents.defaults.model.primary, models.providers.anthropic.apiKey = a $-ref to OC_ANTHROPIC_KEY (a ref, not the value); the gateway argv has no --auth; `gateway call health` with OPENCLAW_GATEWAY_PASSWORD succeeds; the config step logs default:true.",
  needs: ["m1", "configRender"],
  timeoutMs: 400_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1, plan: { configVer: null }, env: { OC_ANTHROPIC_KEY: KEY } });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    const step = b.events().find((e) => e.ev === "config-render");
    t.measure("configRender", step ?? null);
    t.check("config step rendered the default doc", step?.default === true, step);
    const text = b.as1000("cat /home/node/.openclaw/openclaw.json").out;
    let doc = null;
    try {
      doc = JSON.parse(text);
    } catch {}
    t.measure("doc", doc);
    t.check("auth mode trusted-proxy", doc?.gateway?.auth?.mode === "trusted-proxy");
    t.check(
      "trustedProxy.userHeader x-ochost-user",
      doc?.gateway?.auth?.trustedProxy?.userHeader === "x-ochost-user",
    );
    t.check("model set", typeof doc?.agents?.defaults?.model?.primary === "string");
    t.check(
      "provider key is a ref",
      doc?.models?.providers?.anthropic?.apiKey === `\${OC_ANTHROPIC_KEY}`,
      doc?.models?.providers?.anthropic?.apiKey,
    );
    t.check("no secret value in openclaw.json", !text.includes(KEY) && !text.includes(GW_TOKEN));
    const gw = gatewayPid(b);
    const argv = b.sh(`tr '\\0' ' ' < /proc/${gw}/cmdline`).out;
    t.measure("gatewayArgv", argv.trim());
    t.check("gateway argv has no --auth", !/--auth\b/.test(argv), argv);
    const h = b.as1000(
      `OPENCLAW_GATEWAY_PASSWORD=${GW_TOKEN} timeout 60 node /app/openclaw.mjs gateway call health --json --timeout 20000`,
      { timeoutMs: 90_000 },
    );
    t.measure("healthCall", { code: h.code, out: (h.out || h.err).slice(-300) });
    t.check("local CLI with the password reaches the gateway", h.code === 0, (h.out || h.err).slice(-200));
  },
};
