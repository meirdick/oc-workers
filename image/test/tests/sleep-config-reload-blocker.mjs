// Amend §3 row 'T7e row 19': config hot reload, sleep at +3 s -> blocked by (b) config-recent, then by
// (a) channel-unsettled while the Telegram account restarts, then done <= 60 s after the account is
// ready; never a forced destroy.
import { sleepOp } from "../harness/flows.mjs";
import { tgDoc } from "../harness/telegram.mjs";

export default {
  name: "sleep-config-reload-blocker",
  source: "amend §3 row 'T7e row 19'",
  rule: "Edit openclaw.json (Telegram key) at k; sleep-check at k+3 s has blocker config-recent; checks every 2 s record the blocker kinds; the first clean check comes <= 120 s after k; a full sleep op then flushes ok.",
  needs: ["ocsupctl", "configRender"],
  timeoutMs: 900_000,
  async run(t) {
    await t.ctl("/_ctl/config", { ver: 1, doc: tgDoc() });
    const b = t.box({ name: "a", gen: 1, plan: { configVer: 1 } });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    await t.sleep(70_000);
    const k = Date.now();
    b.as1000(
      `node -e 'const f="/home/node/.openclaw/openclaw.json";const j=JSON.parse(require("fs").readFileSync(f));j.channels.telegram.webhookSecret="m1-rotated-secret-0123456789";require("fs").writeFileSync(f+".t",JSON.stringify(j,null,2));require("fs").renameSync(f+".t",f)'`,
    );
    await t.sleep(3000);
    const seq = [];
    let clean = null;
    while (Date.now() - k < 150_000) {
      const c = b.ctl("sleep-check", { opId: `op-rl-${Date.now()}` });
      const kinds = (c.blockers || []).map((x) => x.kind);
      seq.push({ s: Math.round((Date.now() - k) / 1000), kinds });
      if (c.ok && !kinds.length) {
        clean = Date.now() - k;
        break;
      }
      await t.sleep(2000);
    }
    t.measure(
      "blockerSeq",
      seq.filter((x, i) => i === 0 || JSON.stringify(x.kinds) !== JSON.stringify(seq[i - 1].kinds)),
    );
    t.measure("cleanMs", clean);
    t.check("config-recent at +3 s", seq[0]?.kinds.includes("config-recent"), seq[0]);
    t.check("clean check <= 120 s", clean !== null && clean <= 120_000, clean);
    const r = await sleepOp(t, b);
    t.check("full sleep op flushes ok", r.answers.flush?.ok === true, r.answers.flush);
  },
};
