// Amend §3 row 'T7e row 19' (M1, pinned image): `openclaw channels status --json` output has lifecycle
// and restartPending per account (field check, recorded output).
import { tgDoc } from "../harness/telegram.mjs";

export default {
  name: "channels-status-fields",
  source: "amend §3 row 'T7e row 19' (field check on the pinned image)",
  rule: "With a Telegram account configured: `openclaw channels status --json` (uid 1000, 20 s cap) exits 0 and each account has lifecycle and restartPending; output saved to logs.",
  needs: ["m1", "configRender"],
  timeoutMs: 400_000,
  async run(t) {
    await t.ctl("/_ctl/config", { ver: 1, doc: tgDoc() });
    const b = t.box({ name: "a", gen: 1, plan: { configVer: 1 } });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    await t.sleep(10_000);
    const r = b.as1000("cd /home/node && timeout 20 node /app/openclaw.mjs channels status --json 2>&1", {
      // rendered config = trusted-proxy: a local client uses the password (ocsup sets it from the token)
      env: { OPENCLAW_GATEWAY_PASSWORD: "m1testtoken0123456789abcdef" },
      timeoutMs: 30_000,
    });
    t.save("channels-status.json", r.out);
    let j = null;
    try {
      j = JSON.parse(r.out.slice(r.out.indexOf("{")));
    } catch {}
    const accounts = [];
    const walk = (o) => {
      if (!o || typeof o !== "object") return;
      if ("accountId" in o || "lifecycle" in o) accounts.push(o);
      for (const v of Object.values(o)) walk(v);
    };
    walk(j);
    t.measure(
      "accounts",
      accounts.map((a) => ({
        id: a.accountId,
        lifecycle: a.lifecycle,
        restartPending: a.restartPending,
        running: a.running,
        mode: a.mode ?? a.transport,
      })),
    );
    t.check("exit 0 and JSON", r.code === 0 && !!j, r.out.slice(0, 200));
    t.check("at least one account", accounts.length > 0);
    t.check(
      "lifecycle present on each account",
      accounts.length > 0 && accounts.every((a) => "lifecycle" in a),
    );
    t.check(
      "restartPending present on each account",
      accounts.length > 0 && accounts.every((a) => "restartPending" in a),
    );
  },
};
