// Probe (not in `all`): the shape of OpenClaw's heartbeat automation job (docs/04 "Heartbeat in duty-cycle").
// Boots with agents.defaults.heartbeat {every, activeHours}, then prints the cron_jobs rows (job_json,
// state_json) and what ocio sleep-read makes of them. Env: OCM1_HB_EVERY (default 2m), OCM1_HB_WAIT_S (default
// 150: long enough to see one tick move nextRunAtMs).
import { tgDoc } from "../harness/telegram.mjs";

const DB = "/home/node/.openclaw/state/openclaw.sqlite";
const READ = `const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync("${DB}",{readOnly:true});
const rows=c.prepare("SELECT job_id, enabled, job_json, state_json FROM cron_jobs").all();
console.log(JSON.stringify(rows.map(r=>({id:r.job_id,enabled:r.enabled,job:JSON.parse(r.job_json),state:JSON.parse(r.state_json||"{}")}))));`;

export default {
  name: "_hb-shape",
  source: "docs/04 heartbeat in duty-cycle",
  rule: "probe: prints the heartbeat job rows and the sleep-read answer",
  needs: ["m1", "configRender", "ocsupctl"],
  timeoutMs: 900_000,
  async run(t) {
    const every = process.env.OCM1_HB_EVERY || "2m";
    const doc = {
      ...tgDoc({ dmPolicy: "open", allowFrom: ["*"] }),
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          heartbeat: { every, activeHours: { start: "08:00", end: "22:00", timezone: "UTC" } },
        },
      },
      models: { providers: { anthropic: { apiKey: "$" + "{OC_ANTHROPIC_KEY}" } } },
    };
    // OCM1_HB_OWNER=1: the config names a command owner (the first-owner rule), so the heartbeat has a route.
    if (process.env.OCM1_HB_OWNER === "1") doc.commands = { ownerAllowFrom: ["telegram:111"] };
    // OCM1_HB_MANAGED=1: the owner doc says "0m" (the old default); the plan's managed keys and wakeHours set
    // the cadence, as the Control DO does from sleep.proactive. The window is chosen to exclude the current hour.
    const managedRun = process.env.OCM1_HB_MANAGED === "1";
    const hNow = new Date().getUTCHours();
    const win = { from: (hNow + 2) % 24, to: (hNow + 4) % 24 || 24 };
    if (win.from >= win.to) Object.assign(win, { from: 0, to: Math.max(1, hNow) === hNow ? hNow : 1 });
    const pad = (h) => `${String(h).padStart(2, "0")}:00`;
    const plan = { configVer: 1 };
    if (managedRun) {
      doc.agents.defaults.heartbeat = { every: "0m" };
      plan.managed = [
        { path: "agents.defaults.heartbeat.every", value: "30m" },
        { path: "agents.defaults.heartbeat.activeHours", value: { start: pad(win.from), end: pad(win.to), timezone: "UTC" } },
      ];
      plan.wakeHours = { heartbeat: { ...win, tz: "UTC" } };
      t.note(`managed run: window ${JSON.stringify(win)} utc hour now ${hNow}`);
    }
    await t.ctl("/_ctl/config", { ver: 1, doc });
    const b = t.box({ name: "hb", gen: 1, plan, env: { OC_ANTHROPIC_KEY: "sk-ant-m1-hb-0000" } });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    const read = () => {
      const r = b.as1000(["node", "-e", READ], { timeoutMs: 30_000 });
      try {
        return JSON.parse(r.out);
      } catch {
        return { error: (r.out || r.err || "").slice(0, 300) };
      }
    };
    const sleepRead = (ignore) =>
      b.as1000(["node", "/opt/ocrt/ocio/sleep-read.mjs", DB, String(Date.now()), JSON.stringify(ignore)], {
        timeoutMs: 30_000,
      }).out;
    await t.sleep(8000);
    const first = read();
    t.note(`now ${Date.now()} rows ${JSON.stringify(first).slice(0, 3000)}`);
    t.note(`sleep-read ignore=[]: ${String(sleepRead([])).slice(0, 600)}`);
    t.note(`sleep-read ignore=[heartbeat]: ${String(sleepRead(["heartbeat"])).slice(0, 600)}`);
    if (managedRun) {
      const hb = (first || []).find?.((r) => r.job?.payload?.kind === "heartbeat");
      t.check("managed: heartbeat job enabled every 30 min", hb?.enabled === 1 && hb?.job?.schedule?.everyMs === 1_800_000, hb?.job?.schedule);
      const cfg = b.sh(["cat", "/home/node/.openclaw/openclaw.json"]).out || "";
      let hbCfg = null;
      try {
        hbCfg = JSON.parse(cfg).agents?.defaults?.heartbeat;
      } catch {}
      t.note(`rendered heartbeat config ${JSON.stringify(hbCfg)}`);
      t.check("managed: rendered config has the cadence and hours", hbCfg?.every === "30m" && hbCfg?.activeHours?.start === pad(win.from));
      const withHours = JSON.parse(
        b.as1000(
          ["node", "/opt/ocrt/ocio/sleep-read.mjs", DB, String(Date.now()), "[]", JSON.stringify(plan.wakeHours)],
          { timeoutMs: 30_000 },
        ).out || "{}",
      );
      t.note(`sleep-read with hours: next ${withHours.nextWakeAtMs} moved ${JSON.stringify(withHours.moved)}`);
      const h = new Date(withHours.nextWakeAtMs).getUTCHours();
      t.check("managed: the next wake is a heartbeat tick inside the window", (withHours.moved || []).length === 1 && h >= win.from && h < win.to, { h, win });
      const chk = b.ctl("sleep-check", { opId: `op-hb-${Date.now()}` });
      t.note(`sleep-check nextWakeAtMs ${chk.nextWakeAtMs} blockers ${JSON.stringify(chk.blockers)}`);
      t.check("managed: ocsup's sleep-check gives the same next wake", chk.nextWakeAtMs === withHours.nextWakeAtMs, chk.nextWakeAtMs);
      b.rm();
      return;
    }
    await t.sleep(Number(process.env.OCM1_HB_WAIT_S || 150) * 1000);
    const second = read();
    t.note(`now ${Date.now()} rows after wait ${JSON.stringify(second).slice(0, 3000)}`);
    const llm = await t.records({ plane: "llm" });
    t.note(`llm calls ${llm.filter((x) => x.route !== "models").length}`);
    const hb2 = (second || []).find?.((r) => r.job?.payload?.kind === "heartbeat");
    t.note(`heartbeat last: ${JSON.stringify({ status: hb2?.state?.lastRunStatus, error: hb2?.state?.lastError, delivery: hb2?.state?.lastDeliveryStatus })}`);
    if (process.env.OCM1_HB_OWNER === "1") {
      t.check("owner set: the heartbeat ran (not skipped for no-route)", hb2?.state?.lastRunStatus && !/no-route/.test(String(hb2?.state?.lastError ?? "")), hb2?.state);
      const tg = await t.records({ plane: "tg" });
      t.note(`telegram calls: ${JSON.stringify(tg.map((x) => x.route).filter((x) => /send/i.test(x)))}`);
    }
    t.measure("rows", { first, second });
    b.rm();
  },
};
