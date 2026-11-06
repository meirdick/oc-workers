// Scope §4 M1 row 12 (parts 2, 3); plan §4.9: the overlay is applied after Doctor; no proposal is sent
// while an overlay is active.
const DOC = {
  cron: { enabled: true },
  channels: { telegram: { enabled: false, timeoutSeconds: 30 } }, // retired in 2026.10.9 (see doctor-staged-copy)
};

export default {
  name: "overlay-after-doctor",
  source:
    "scope §4 M1 'The overlay is applied after Doctor. No proposal is sent while an overlay is active'; plan §4.9",
  rule: "Plan overlay cron.enabled=false + runDoctor + a config Doctor changes: rendered openclaw.json has cron.enabled false (overlay wins over Doctor); /run/ocrt/overlay.json lists the path; no PUT /v1/config/proposal in 60 s; a UI-style edit of openclaw.json in that boot also sends no proposal.",
  needs: ["m1", "guardBoot"],
  timeoutMs: 600_000,
  async run(t) {
    await t.ctl("/_ctl/config", { ver: 1, doc: DOC });
    const b = t.box({
      name: "a",
      gen: 1,
      plan: { runDoctor: true, configVer: 1, overlay: [{ path: "cron.enabled", value: false }] },
    });
    await b.start();
    if (!t.check("/startupz", (await b.startupz(400_000)) !== null)) return;
    let cfg = null;
    try {
      cfg = JSON.parse(b.as1000("cat /home/node/.openclaw/openclaw.json").out);
    } catch {}
    t.check("openclaw.json cron.enabled = false (overlay)", cfg?.cron?.enabled === false, cfg?.cron);
    const ov = b.sh("cat /run/ocrt/overlay.json 2>/dev/null").out;
    t.check("overlay.json lists cron.enabled", /cron\.enabled/.test(ov), ov.slice(0, 200));
    b.as1000(
      `node -e 'const f="/home/node/.openclaw/openclaw.json";const j=JSON.parse(require("fs").readFileSync(f));j.m1UiEdit=true;require("fs").writeFileSync(f+".tmp",JSON.stringify(j,null,2));require("fs").renameSync(f+".tmp",f)'`,
    );
    await t.sleep(60_000);
    const props = (await t.records({ plane: "control", route: "/v1/config/proposal" })).length;
    t.check("no proposal while the overlay is active", props === 0, props);
  },
};
