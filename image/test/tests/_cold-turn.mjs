// Probe (not in `all`): time from /startupz to the first and second Telegram reply on a fresh boot.
// Webhook update goes in at /startupz like the Control DO driver, retried until the gateway answers 200.
// Env: OCM1_FROM_SNAP=1 (wake from the previous run's rootfs), OCM1_RUNS (default 3), OCM1_WARM (0|1 -> OCRT_WARMUP in the box), OCM1_WARM_MODE (OCRT_WARMUP_MODE).
// OCM1_DOC=<file.json>: the OpenClaw doc that init renders (cli renderOpenclawDoc), with provider cfgw pointed at the mock LLM:
// the real plugin, browser, memory and mcp config instead of the bare anthropic one (docs/13 "Regression").
// Reply = sendMessage seen by the fake Telegram. Mock LLM answers at once, so this is gateway overhead.
import fs from "node:fs";
import { IP } from "../harness/env.mjs";
import { tgDoc } from "../harness/telegram.mjs";

const SECRET = "m1-webhook-secret-0123456789";
const SEND = `
const body = (id) => JSON.stringify({ update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000),
  from: { id: 111, is_bot: false, first_name: "u" }, chat: { id: 111, type: "private" }, text: "hello " + id } });
(async () => {
  const id = Number(process.argv[1]);
  const t0 = Date.now();
  let r = null, tries = 0;
  for (; tries < 120; tries++) {
    try {
      r = await fetch("http://127.0.0.1:18789/telegram-webhook", { method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "${SECRET}" }, body: body(id) });
      if (r.status === 200) break;
    } catch {}
    await new Promise((x) => setTimeout(x, 250));
  }
  console.log(JSON.stringify({ t0, t200: Date.now(), tries, status: r?.status ?? 0, accepted: r?.headers.get("x-openclaw-delivery-accepted") }));
})();`;

/** First occurrence of each ocsup event as [name, ms since the first event]: where a boot spends its time. */
function phasesOf(evs) {
  const t0 = Date.parse(evs[0]?.ts ?? 0);
  const seen = new Set();
  const out = [];
  for (const e of evs) {
    if (!e.ts || seen.has(e.ev)) continue;
    seen.add(e.ev);
    out.push([e.ev, Date.parse(e.ts) - t0]);
  }
  return out;
}

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

export default {
  name: "_cold-turn",
  source: "cold reply time (docs/04 §2.7 first turn warm-up)",
  rule: "probe: prints startupz-to-first-reply and second-reply times; fails only when no reply comes in 120 s",
  needs: ["m1", "configRender"],
  timeoutMs: 1_800_000,
  async run(t) {
    const runs = Number(process.env.OCM1_RUNS || 3);
    const env = { OC_ANTHROPIC_KEY: "sk-ant-m1-cold-0000" };
    if (process.env.OCM1_WARM !== undefined) env.OCRT_WARMUP = process.env.OCM1_WARM;
    if (process.env.OCM1_WARM_MODE) env.OCRT_WARMUP_MODE = process.env.OCM1_WARM_MODE;
    let doc = {
      ...tgDoc({ dmPolicy: "open", allowFrom: ["*"] }),
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
      models: { providers: { anthropic: { apiKey: "${OC_ANTHROPIC_KEY}" } } },
    };
    if (process.env.OCM1_DOC) {
      const real = JSON.parse(fs.readFileSync(process.env.OCM1_DOC, "utf8"));
      real.models.providers.cfgw = {
        baseUrl: `http://${IP.llm}/v1`,
        api: "openai-completions",
        apiKey: "x",
        models: real.models.providers.cfgw.models,
      };
      doc = { ...real, channels: tgDoc({ dmPolicy: "open", allowFrom: ["*"] }).channels };
    }
    await t.ctl("/_ctl/config", { ver: 1, doc });
    const out = [];
    let snap = null; // OCM1_FROM_SNAP=1: run i boots from run i-1's rootfs (a wake: warm compile cache)
    for (let i = 0; i < runs; i++) {
      const b = t.box({
        name: `c${i}`,
        gen: 1 + i,
        plan: { configVer: 1 },
        env,
        ...(snap ? { image: snap } : {}),
      });
      const seq0 = (await t.records({})).at(-1)?.seq ?? 0;
      await b.start();
      const ms = await b.startupz();
      if (!t.check(`run ${i} startupz`, ms !== null)) return;
      const ev = b.ev("startupz")[0];
      const tz = ev?.ts ? Date.parse(ev.ts) : Date.now();
      const sent = [];
      const replies = [];
      for (const id of [100 + i * 10, 101 + i * 10]) {
        const r = JSON.parse(b.sh(["node", "-e", SEND, String(id)], { timeoutMs: 180_000 }).out || "{}");
        sent.push(r);
        const end = Date.now() + 120_000;
        let hit = null;
        while (!hit && Date.now() < end) {
          const recs = await t.records({ since: seq0, plane: "tg", route: "sendMessage" });
          hit = recs.find((x) => x.ts >= r.t0 && !replies.includes(x.ts));
          if (!hit) await t.sleep(100);
        }
        replies.push(hit?.ts ?? null);
        await t.sleep(1500);
      }
      const llm = await t.records({ since: seq0, plane: "llm" });
      const row = {
        run: i,
        startupzMs: ms,
        // webhook 200 after /startupz: the Telegram channel is up
        ingressMs: sent[0].t200 - tz,
        firstReplyMs: replies[0] === null ? null : replies[0] - tz,
        firstTurnMs: replies[0] === null ? null : replies[0] - sent[0].t200,
        secondTurnMs: replies[1] === null ? null : replies[1] - sent[1].t0,
        llmCalls: llm.filter((x) => x.route !== "models").length,
        phases: phasesOf(b.events()),
        warm: b.ev("warmup").map((e) => ({ ok: e.ok, ms: e.ms, mode: e.mode, tail: e.tail })),
      };
      out.push(row);
      t.note(JSON.stringify(row));
      if (process.env.OCM1_FROM_SNAP === "1") {
        b.sigterm();
        await b.waitExit(120_000);
        snap = b.snapshot();
      }
      b.rm();
    }
    t.measure("runs", out);
    for (const k of ["startupzMs", "ingressMs", "firstReplyMs", "firstTurnMs", "secondTurnMs"]) {
      const v = out.map((r) => r[k]).filter((x) => x !== null);
      t.measure(`${k}.median`, v.length ? med(v) : null);
    }
    t.check(
      "every run got a reply",
      out.every((r) => r.firstReplyMs !== null),
    );
  },
};
