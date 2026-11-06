// Probe (not in `all`): Telegram calls one agent turn produces per channels.telegram.streaming mode.
// Mock LLM streams a 40-word reply in 20 deltas over 10 s. Counts Bot API calls from the webhook update to
// 3 s after the last sendMessage. Env: OCM1_MODES (default "unset,partial,off,block"; "unset" = no key).

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

const WORDS = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");

export default {
  name: "_stream-edits",
  source: "scope addition B: how many edits a 10 s turn produces",
  rule: "probe: prints Bot API call counts per streaming mode; fails only when no reply comes",
  needs: ["m1", "configRender"],
  timeoutMs: 1_800_000,
  async run(t) {
    const modes = (process.env.OCM1_MODES || "unset,partial,off,block").split(",");
    const rows = [];
    for (const [i, mode] of modes.entries()) {
      const extra = {
        dmPolicy: "open",
        allowFrom: ["*"],
        ...(mode === "unset" ? {} : { streaming: { mode } }),
      };
      const doc = {
        ...tgDoc(extra),
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
        models: { providers: { anthropic: { apiKey: "${OC_ANTHROPIC_KEY}" } } },
      };
      await t.ctl("/_ctl/config", { ver: 1 + i, doc });
      const b = t.box({
        name: `s${i}`,
        gen: 1 + i,
        plan: { configVer: 1 + i },
        env: { OC_ANTHROPIC_KEY: "sk-ant-m1-0000" },
      });
      await b.start();
      if (!t.check(`${mode} startupz`, (await b.startupz()) !== null)) return;
      b.sh([
        "node",
        "-e",
        `fetch("http://${IP.llm}:9000/_reply",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:${JSON.stringify(WORDS)},delayMs:10000,chunks:20})})`,
      ]);
      await t.sleep(2000);
      const seq0 = (await t.records({})).at(-1)?.seq ?? 0;
      const r = JSON.parse(b.sh(["node", "-e", SEND, String(500 + i)], { timeoutMs: 180_000 }).out || "{}");
      const end = Date.now() + 90_000;
      let last = 0;
      while (Date.now() < end) {
        const recs = await t.records({ since: seq0, plane: "tg" });
        const sends = recs.filter((x) => x.route === "sendMessage" && x.ts >= r.t0);
        if (sends.length) {
          if (!last) last = Date.now();
          if (Date.now() - last > 3000) break;
        }
        await t.sleep(500);
      }
      const recs = (await t.records({ since: seq0, plane: "tg" })).filter((x) => x.ts >= r.t0);
      const n = {};
      for (const x of recs) n[x.route] = (n[x.route] || 0) + 1;
      const row = {
        mode,
        calls: n,
        firstSendMs: (recs.find((x) => x.route === "sendMessage")?.ts ?? 0) - r.t0,
      };
      rows.push(row);
      t.note(JSON.stringify(row));
      b.rm();
    }
    t.measure("rows", rows);
    t.check(
      "every mode replied",
      rows.every((r) => (r.calls.sendMessage ?? 0) > 0),
    );
  },
};
