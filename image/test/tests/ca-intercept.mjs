// Amend §2 row 20: local fake HTTPS intercept with its own CA -> gateway fetch ok, provider key present.
// The test CA is mounted at /etc/cloudflare/certs/cloudflare-containers-ca.crt (lib/gateway.mjs CF_CA).
import { gatewayPid } from "../harness/flows.mjs";
import { tgDoc } from "../harness/telegram.mjs";

export default {
  name: "ca-intercept",
  source: "amend §2 row 20 (M1: local fake HTTPS intercept with its own CA)",
  rule: "Gateway with a Telegram account: getMe/setWebhook reach the fake over TLS (test CA trusted by the gateway); gateway environ (root read) has NODE_EXTRA_CA_CERTS and the referenced OC_* SecretRef var; no OCRT_* var.",
  needs: ["m1", "configRender"],
  timeoutMs: 400_000,
  async run(t) {
    const doc = tgDoc({ botToken: { source: "env", provider: "default", id: "OC_TELEGRAM_TOKEN" } });
    await t.ctl("/_ctl/config", { ver: 1, doc });
    const b = t.box({
      name: "a",
      gen: 1,
      plan: { configVer: 1 },
      env: { OC_TELEGRAM_TOKEN: "7000000001:m1-fake-token" },
    });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    await t.sleep(15_000);
    const tg = await t.records({ plane: "tg" });
    t.measure(
      "tgCalls",
      tg.map((r) => `${r.route}${r.tls ? "/tls" : ""}`),
    );
    t.check(
      "Telegram API reached over TLS",
      tg.some((r) => r.tls),
      tg.length,
    );
    const pid = gatewayPid(b);
    const env = b.sh(`tr '\\0' '\\n' < /proc/${pid}/environ | cut -d= -f1 | sort`).out.split("\n");
    t.measure("gatewayEnvNames", env);
    t.check("NODE_EXTRA_CA_CERTS in gateway env", env.includes("NODE_EXTRA_CA_CERTS"));
    t.check("OC_TELEGRAM_TOKEN in gateway env", env.includes("OC_TELEGRAM_TOKEN"));
    t.check("no OCRT_* in gateway env", !env.some((n) => n.startsWith("OCRT_")));
  },
};
