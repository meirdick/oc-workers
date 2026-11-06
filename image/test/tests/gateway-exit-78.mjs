// Amend §2 row 19: agent DB with user_version 0 -> gateway exit 78 (gateway.maintenance_required)
// -> ocsup exits 78 `doctor-required` in <= 15 s, no crash loop.
import { prepImage } from "../harness/box.mjs";
import { exitInfo } from "../harness/flows.mjs";

const FIXTURE = `node -e '
const {DatabaseSync}=require("node:sqlite");const fs=require("fs");const d="/home/node/.openclaw/agents/m1bad/agent";
fs.mkdirSync(d,{recursive:true});const c=new DatabaseSync(d+"/openclaw-agent.sqlite");
c.exec("PRAGMA journal_mode=WAL; CREATE TABLE junk(x); PRAGMA user_version=0");c.close();console.log("fixture ok")'`;

export default {
  name: "gateway-exit-78",
  source: "amend §2 row 19; contract §6",
  rule: "ocsup exit 78 reason doctor-required <= 15 s after the first gateway exit; gateway started once (no restart).",
  timeoutMs: 400_000,
  async run(t) {
    const img = prepImage(t.image, "exit78", FIXTURE);
    const b = t.box({ name: "a", image: img, gen: 1 });
    await b.start();
    const s = await b.waitExit(240_000);
    const ex = await exitInfo(t, b);
    t.measure("exit", ex);
    const gwExit = b.ev("gateway-exit")[0];
    const xEv = b.ev("exit").at(-1);
    const dt = gwExit && xEv ? xEv.t - gwExit.t : null;
    t.measure("gatewayExit", gwExit);
    t.measure("gatewayExitToOcsupExitMs", dt);
    t.check("ocsup exited", !!s, s);
    t.check("exit 78 doctor-required", ex.code === 78 && ex.reason === "doctor-required", ex);
    t.check("<= 15 s from first gateway exit", dt !== null && dt <= 15_000, dt);
    t.check(
      "gateway started once (no crash loop)",
      b.ev("gateway-start").length === 1,
      b.ev("gateway-start").length,
    );
  },
};
