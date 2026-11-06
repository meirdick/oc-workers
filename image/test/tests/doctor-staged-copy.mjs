// Scope §4 M1 row 12 (part 1); plan §4.9: Doctor on a staged copy with a retired key -> a migrate
// (or doctor) candidate. Retired key used: channels.telegram.timeoutSeconds (2026.10.9
// extensions/telegram/src/doctor-contract.ts RETIRED_TUNING_KEYS: Doctor strips it). Measured in M1:
// 2026.10.9 does not migrate channels.telegram.allowPrivateNetwork (Doctor: "must not have additional
// properties", no fix written, exit 1), so that key would test a Doctor failure, not a migration.
const DOC = { channels: { telegram: { enabled: false, timeoutSeconds: 30 } } };

export default {
  name: "doctor-staged-copy",
  source: "scope §4 M1 'Doctor on a staged copy with a retired key -> a migrate candidate'; plan §4.9",
  rule: "Config v1 with the retired key, runDoctor: a PUT /v1/config/proposal (source migrate or doctor) whose doc has no channels.telegram.timeoutSeconds and keeps channels.telegram.enabled false; Doctor ran on a staged path (not $STATE/openclaw.json); /startupz.",
  needs: ["m1", "guardBoot"],
  timeoutMs: 600_000,
  async run(t) {
    await t.ctl("/_ctl/config", { ver: 1, doc: DOC });
    const b = t.box({ name: "a", gen: 1, plan: { runDoctor: true, configVer: 1 } });
    await b.start();
    const ms = await b.startupz(400_000);
    t.check("/startupz", ms !== null, { ms });
    const st = await t.gateState();
    const props = st.config.proposals || [];
    t.measure(
      "proposals",
      props.map((p) => ({ source: p.source, tg: p.doc?.channels?.telegram })),
    );
    const p = props.find((x) => ["migrate", "doctor"].includes(x.source));
    t.check(
      "proposal sent (migrate|doctor)",
      !!p,
      props.map((x) => x.source),
    );
    const tg = p?.doc?.channels?.telegram || {};
    t.check("retired key removed", p && !("timeoutSeconds" in tg), tg);
    t.check("other keys kept", tg.enabled === false, tg);
    const doc = b.ev("doctor").at(-1);
    t.measure("doctor", doc && { code: doc.code, ms: doc.ms });
    const staged = b.events().some((e) => /OPENCLAW_CONFIG_PATH|staged/.test(JSON.stringify(e)));
    t.check("Doctor ran on a staged copy", staged);
  },
};
