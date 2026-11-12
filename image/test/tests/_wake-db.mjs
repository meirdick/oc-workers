// Probe (not in `all`): where a wake from a real sleep op spends its boot (docs/13 "Wake database wait").
// Cycle: boot fresh, one Telegram turn, sleep op (check, prepare, stop-gateway, flush), snapshot, wake with the
// marker plan, one turn; repeat. Prints per wake: /startupz, the gateway's own `ready` line, the agent
// database lines (clean-close receipt, admission) and the first turn.
// Env: OCM1_RUNS (wakes, default 3), OCM1_CPUS, OCM1_MEM, OCM1_FILL_MB (random rows in the agent DB before
// the first sleep, default 0: the full-file check grows with the file), OCM1_LS_HOLD=0 (OCRT_LS_ADMIT_HOLD=0 in the box: no admission hold),
// OCM1_LS_STOP_HOLD=0 (no hold around the gateway stop of a sleep).
import { sleepOp, sleepSnapshot, waitL0 } from "../harness/flows.mjs";
import { probeCount, restoreRows, writeRows } from "../harness/sqlite.mjs";
import { tgDoc } from "../harness/telegram.mjs";

const SECRET = "m1-webhook-secret-0123456789";
const SEND = `
const body = (id) => JSON.stringify({ update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000),
  from: { id: 111, is_bot: false, first_name: "u" }, chat: { id: 111, type: "private" }, text: "hello " + id } });
(async () => {
  const id = Number(process.argv[1]);
  const t0 = Date.now();
  let r = null, tries = 0;
  for (; tries < 240; tries++) {
    try {
      r = await fetch("http://127.0.0.1:18789/telegram-webhook", { method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "${SECRET}" }, body: body(id) });
      if (r.status === 200) break;
    } catch {}
    await new Promise((x) => setTimeout(x, 250));
  }
  console.log(JSON.stringify({ t0, t200: Date.now(), tries, status: r?.status ?? 0 }));
})();`;
const AGENT_DB = "/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite";
const fill = (mb) =>
  `node -e 'const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync("${AGENT_DB}");c.exec("PRAGMA busy_timeout=30000;create table if not exists m1_big(b blob)");const s=c.prepare("insert into m1_big values(randomblob(1048576))");for(let k=0;k<${mb};k+=10){c.exec("begin immediate");for(let i=0;i<10;i++)s.run();c.exec("commit")}c.close();console.log("filled")'`;

const WANT =
  /clean-close receipt|has not completed startup inspection|recovered after background|remained busy|completed cleanly|\[gateway\] ready|fetch-timeout|page-cache warm|integrity|slow SQLite|http server listening/;
/** Gateway lines of interest as [ms since gateway-start, text]. */
function gwLines(box) {
  const evs = box.events();
  const g0 = Date.parse(evs.find((e) => e.ev === "gateway-start")?.ts ?? evs[0]?.ts ?? 0);
  return evs
    .filter((e) => /^ls-hold/.test(e.ev) || (e.ev === "gw" && WANT.test(e.line || "")))
    .map((e) => [Date.parse(e.ts) - g0, String(e.line ?? e.ev).replace(/^\S+T\S+ /, "").slice(0, 160)]);
}

async function turn(t, b, id, seq0) {
  const r = JSON.parse(b.sh(["node", "-e", SEND, String(id)], { timeoutMs: 180_000 }).out || "{}");
  const end = Date.now() + 120_000;
  let hit = null;
  while (!hit && Date.now() < end) {
    const recs = await t.records({ since: seq0, plane: "tg", route: "sendMessage" });
    hit = recs.find((x) => x.ts >= r.t0);
    if (!hit) await t.sleep(100);
  }
  return hit ? hit.ts - r.t200 : null;
}

export default {
  name: "_wake-db",
  source: "docs/13 wake database wait",
  rule: "probe: prints the boot split of each wake from a sleep op; fails only when a wake gets no /startupz or reply",
  needs: ["m1", "configRender", "ocsupctl"],
  timeoutMs: 2_400_000,
  async run(t) {
    const runs = Number(process.env.OCM1_RUNS || 3);
    const size = {
      ...(process.env.OCM1_CPUS ? { cpus: Number(process.env.OCM1_CPUS) } : {}),
      ...(process.env.OCM1_MEM ? { memory: process.env.OCM1_MEM } : {}),
    };
    const env = { OC_ANTHROPIC_KEY: "sk-ant-m1-cold-0000" };
    if (process.env.OCM1_LS_HOLD) env.OCRT_LS_ADMIT_HOLD = process.env.OCM1_LS_HOLD;
    if (process.env.OCM1_LS_STOP_HOLD) env.OCRT_LS_STOP_HOLD = process.env.OCM1_LS_STOP_HOLD;
    await t.ctl("/_ctl/config", {
      ver: 1,
      doc: {
        ...tgDoc({ dmPolicy: "open", allowFrom: ["*"] }),
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
        models: { providers: { anthropic: { apiKey: "$" + "{OC_ANTHROPIC_KEY}" } } },
      },
    });
    let b = t.box({ name: "w0", gen: 1, plan: { configVer: 1 }, env, ...size });
    let seq0 = (await t.records({})).at(-1)?.seq ?? 0;
    await b.start();
    if (!t.check("fresh /startupz", (await b.startupz()) !== null)) return;
    t.check("fresh turn", (await turn(t, b, 100, seq0)) !== null);
    const mb = Number(process.env.OCM1_FILL_MB || 0);
    if (mb) t.check("agent DB filled", /filled/.test(b.as1000(fill(mb), { timeoutMs: 600_000 }).out));
    const out = [];
    for (let i = 0; i < runs; i++) {
      await t.sleep(3000);
      const r = await sleepOp(t, b, { checkWaitMs: 300_000 });
      if (!t.check(`sleep ${i}: flush ok`, r.answers.flush?.ok, r.answers.flush)) return;
      const sleepLines = gwLines(b).filter(([, l]) => /receipt|remained busy|completed cleanly/.test(l));
      const stopMs = r.answers["stop-gateway"]?._ms ?? null;
      const { snap, marker, dbs } = sleepSnapshot(t, b, r.answers.flush);
      b.rm();
      seq0 = (await t.records({})).at(-1)?.seq ?? 0;
      const k = Date.now();
      const gen = b.o.gen + 1;
      const nb = t.box({
        name: `w${i + 1}`,
        image: snap,
        gen,
        restoreGens: [marker.gen],
        env: { OCRT_SNAPSHOT_ID: snap, ...env },
        plan: { rootfs: { kind: "snapshot", snapshotId: snap }, sqlite: marker, dbs, configVer: 1 },
        ...size,
      });
      await nb.start();
      const w = { box: nb, ms: await nb.startupz() };
      b = w.box;
      if (!t.check(`wake ${i}: /startupz`, w.ms !== null)) return;
      const first = await turn(t, b, 200 + i * 10, seq0);
      const second = await turn(t, b, 201 + i * 10, seq0);
      const gs = b.ev("gateway-start")[0];
      const sz = b.ev("startupz")[0];
      const row = {
        wake: i,
        sleepStopGatewayMs: stopMs,
        startToGatewayMs: gs ? Date.parse(gs.ts) - Date.parse(b.events()[0].ts) : null,
        gatewayToStartupzMs: gs && sz ? Date.parse(sz.ts) - Date.parse(gs.ts) : null,
        wallToStartupzMs: w.ms,
        firstTurnMs: first,
        secondTurnMs: second,
        totalToFirstReplyMs: first === null ? null : Date.now() - k,
        sleepLines,
        wakeLines: gwLines(b),
      };
      // Replication after the admission hold: rows written now must be in a restore of this gen.
      const wAt = Date.now();
      writeRows(b, 20, { tag: `w${i}` });
      await waitL0(t, gen, { after: wAt, timeoutMs: 60_000 });
      await t.sleep(4000);
      const rr = restoreRows(t.image, gen, {});
      row.restoredRows = probeCount(rr, `w${i}`);
      t.check(`wake ${i}: gen ${gen} restore has the 20 rows written after the hold`, row.restoredRows === 20, rr.probe);
      out.push(row);
      t.note(JSON.stringify(row));
      t.check(`wake ${i}: reply`, first !== null);
    }
    t.measure("wakes", out);
    b.rm();
  },
};
