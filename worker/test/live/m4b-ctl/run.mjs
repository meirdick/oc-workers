// M4b ctl live checks (one per fix) on oc-m4b-ctl / oc-m4b-ctl-idle. usage: node run.mjs <step>
// steps: setup, f1a, l3, n1, archive, j, f1b-pre, f1b-wake, idle-setup, idle-start, idle-end
// env: U, T, WH, GW (install), OUT (dir for <step>.json). OC_TEST=1 installs (fake Telegram, mock LLM).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const U = (process.env.U ?? "").replace(/\/$/, "");
const T = process.env.T ?? "";
const WH = process.env.WH ?? "";
const OUT = process.env.OUT ?? ".";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const iso = (t) => (t ? new Date(t).toISOString() : null);
const log = (m, o) => console.error(`${iso(now())} ${m} ${o === undefined ? "" : JSON.stringify(o)}`);

async function ops(method, path, body, timeoutMs = 150_000) {
  const t0 = now();
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${U}${path}`, {
        method,
        headers: { authorization: `Bearer ${T}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: r.status, json, text: text.slice(0, 2000), ms: now() - t0 };
    } catch (e) {
      if (i >= 4) return { status: 0, json: null, text: String(e), ms: now() - t0 };
      await sleep(2000);
    }
  }
}
const status = async () => (await ops("GET", "/ops/status")).json ?? {};
async function waitFor(fn, timeoutMs, everyMs = 3000) {
  const t0 = now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return { v, ms: now() - t0 };
    if (now() - t0 > timeoutMs) return { v: null, ms: now() - t0, timeout: true };
    await sleep(everyMs);
  }
}
const waitState = (states, t) =>
  waitFor(async () => {
    const s = await status();
    return [].concat(states).includes(s.state) ? s : null;
  }, t);
const det = (e) => {
  try {
    return typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail;
  } catch {
    return e.detail;
  }
};
async function ring(t0, limit = 500) {
  const ev = ((await ops("GET", `/ops/events?limit=${limit}`)).json?.events ?? []).reverse();
  return ev.filter((e) => e.at >= t0).map((e) => ({ ...e, d: det(e) }));
}
const exec = async (cmd, timeoutMs = 60_000) =>
  (await ops("POST", "/ops/fault", { name: "exec", params: { cmd, timeoutMs } })).json ?? {};
const asNode = (args) => ["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", ...args];
async function nodeJs(js, timeoutMs = 60_000) {
  const r = await exec(
    asNode(["/usr/local/bin/node", "--no-warnings", "--input-type=module", "-e", js]),
    timeoutMs,
  );
  try {
    return JSON.parse((r.stdout ?? "").trim().split("\n").pop());
  } catch {
    return { err: String(r.stderr ?? r.error ?? JSON.stringify(r)).slice(0, 400) };
  }
}
const DB = "/home/node/.openclaw/state/openclaw.sqlite";
function save(step, r) {
  const out = { step, at: iso(now()), target: U, ...r };
  writeFileSync(join(OUT, `${step}.json`), `${JSON.stringify(out, null, 1)}\n`);
  console.log(JSON.stringify({ step, checks: r.checks ?? null }));
  return out;
}
let seq = 0;
async function dm(chat, text) {
  seq++;
  const upd = 830000000 + (Math.floor(now() / 100) % 10000000) * 10 + (seq % 10);
  const body = {
    update_id: upd,
    message: {
      message_id: upd % 2000000000,
      date: Math.floor(now() / 1000),
      chat: { id: chat, type: "private", first_name: "m4b" },
      from: { id: chat, is_bot: false, first_name: "m4b", username: "m4b_user" },
      text,
    },
  };
  const t0 = now();
  const r = await fetch(`${U}/telegram-webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WH },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  await r.text();
  return { updateId: upd, status: r.status, ackMs: now() - t0, t0 };
}
const sends = async (chat, t0) =>
  (await ring(t0)).filter(
    (e) => e.src === "telegram" && e.kind === "sendMessage" && String(e.d?.chatId) === String(chat),
  );
const inbox = async () => (await ops("GET", "/ops/inbox")).json ?? {};
const rowOf = async (key) => ((await inbox()).rows ?? []).find((r) => String(r.platform_key) === String(key));

const rows = async (limit = 5) =>
  (await ops("POST", "/ops/fault", { name: "rows", params: { limit } })).json ?? null;
const step = process.argv[2];
const t0 = now();

if (step === "setup" || step === "idle-setup") {
  const idle = step === "idle-setup";
  const doc = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-6" },
        // idle install: the OpenClaw heartbeat stays on (30 min), so only the wake filter keeps it asleep.
        ...(idle ? { heartbeat: { every: "30m" } } : {}),
      },
    },
    models: { providers: { anthropic: { apiKey: `\${OC_ANTHROPIC_KEY}` } } },
    channels: idle
      ? {}
      : {
          telegram: {
            enabled: true,
            botToken: "7000000001:AAm4bctlFakeTokenForTheInterceptOnly00",
            dmPolicy: "open",
            allowFrom: ["*"],
            webhookUrl: `${U}/telegram-webhook`,
            webhookSecret: WH,
            webhookPath: "/telegram-webhook",
          },
        },
    ...(idle
      ? {}
      : { bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "default" } }] }),
  };
  const cfg = await ops("POST", "/ops/config", { doc });
  const stored = (await ops("GET", `/ops/config/${cfg.json?.ver ?? 1}`)).json?.doc;
  const w = await ops("POST", "/ops/wake?wait=1", {});
  let up = await waitState("running", 900_000);
  if (!up.v) {
    await ops("POST", "/ops/wake", {});
    up = await waitState("running", 600_000);
  }
  await sleep(15_000);
  const chat = idle ? 74000001 : 73000001;
  const u = idle ? { status: null, t0: now() } : await dm(chat, "m4b hello");
  const rep = idle
    ? { v: true, ms: null }
    : await waitFor(async () => ((await sends(chat, u.t0)).length ? true : null), 300_000);
  const jobs = await nodeJs(`
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(DB)}, { readOnly: true });
let r; try { r = db.prepare("SELECT job_id, enabled, job_json, state_json FROM cron_jobs").all().map((j) => ({ id: j.job_id, enabled: j.enabled, name: JSON.parse(j.job_json).name ?? null, kind: JSON.parse(j.job_json).payload?.kind ?? null, next: JSON.parse(j.state_json || "{}").nextRunAtMs ?? null })); } catch (e) { r = String(e); }
console.log(JSON.stringify({ jobs: r }));`);
  const s = await status();
  save(step, {
    config: {
      status: cfg.status,
      ver: cfg.json?.ver,
      heartbeat: stored?.agents?.defaults?.heartbeat ?? null,
    },
    wake: { status: w.status, ms: w.ms },
    runningMs: up.ms,
    reply: { ack: u.status, ms: rep.v ? rep.ms : null },
    cronJobs: jobs,
    gen: s.gen?.gen ?? s.gen,
    elapsedMs: now() - t0,
    checks: {
      configOk: cfg.status === 200,
      heartbeat: idle
        ? stored?.agents?.defaults?.heartbeat?.every === "30m"
        : stored?.agents?.defaults?.heartbeat?.every === "0m",
      running: !!up.v,
      reply: !!rep.v,
    },
  });
} else if (step === "f1a") {
  // Skew gate: a deploy with a new image is refused while no archive with the workspace is newer than the newest
  // snapshot; after a pre-upgrade archive it passes.
  await ops("POST", "/ops/stop", {});
  const stopped = await waitState("stopped", 300_000);
  const before = await ops("POST", "/ops/deploy-check", { image: true });
  const req = await ops("POST", "/ops/archive", { reason: "pre-upgrade" });
  await ops("POST", "/ops/start", {}); // a stopped install is not woken by the request (desired: stopped)
  const done = await waitFor(
    async () => {
      const a = (await ops("GET", "/ops/archive")).json;
      return a?.request?.id === req.json?.request?.id && a?.request?.state === "done" ? a : null;
    },
    900_000,
    10_000,
  );
  const after = await ops("POST", "/ops/deploy-check", { image: true });
  save(step, {
    before: { status: before.status, body: before.json },
    stoppedMs: stopped.ms,
    request: req.json?.request ?? null,
    archiveMs: done.ms,
    newest: done.v?.archives?.[0] ?? null,
    after: { status: after.status, body: after.json },
    checks: {
      refusedBefore: before.status === 409 && before.json?.error === "archive-stale",
      passAfter: after.status === 200,
    },
  });
} else if (step === "l3") {
  // Kill between the ingress accept and the reply (mock LLM held 30 s for `m4b-slow`), then restart.
  const s0 = (await waitState("running", 600_000)).v ?? (await status());
  const gen0 = s0.gen?.gen ?? s0.gen;
  const chat = 73000002;
  const u = await dm(chat, "m4b-slow please answer");
  const acc = await waitFor(
    async () => {
      const r = await rowOf(u.updateId);
      return r?.state === "accepted" ? r : null;
    },
    120_000,
    1000,
  );
  const slow = await waitFor(
    async () => (await ring(u.t0)).find((e) => e.src === "llm" && e.kind === "slow"),
    120_000,
    1000,
  );
  const ingress = await nodeJs(`
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(DB)}, { readOnly: true });
let r; try { r = db.prepare("SELECT status, count(*) n FROM channel_ingress_events GROUP BY status").all(); } catch (e) { r = String(e); }
console.log(JSON.stringify({ ingress: r }));`);
  const sendsBefore = (await sends(chat, u.t0)).length;
  const kAt = now();
  const kill = await ops("POST", "/ops/fault", { name: "sigkill" });
  log("killed", { status: kill.status });
  const back = await waitFor(
    async () => {
      const s = await status();
      const g = s.gen?.gen ?? s.gen;
      return s.state === "running" && g !== gen0 ? s : null;
    },
    900_000,
    5000,
  );
  const rep = await waitFor(async () => ((await sends(chat, kAt)).length ? true : null), 300_000, 3000);
  await sleep(45_000);
  const ev = await ring(u.t0);
  const replies = await sends(chat, kAt);
  const row = await rowOf(u.updateId);
  save(step, {
    updateId: u.updateId,
    acceptedMs: acc.ms,
    llmSlowAt: slow.v?.at ?? null,
    ingressAtKill: ingress,
    sendsBeforeKill: sendsBefore,
    kill: { status: kill.status, at: iso(kAt) },
    restart: { ms: back.ms, gen: back.v?.gen?.gen ?? back.v?.gen ?? null },
    replyAfterKillMs: rep.v ? rep.ms : null,
    repliesAfterKill: replies.map((e) => ({ at: iso(e.at), text: String(e.d?.text ?? "").slice(0, 80) })),
    replayRing: ev
      .filter((e) => e.src === "driver" || (e.src === "inbox" && e.kind === "replied"))
      .map((e) => ({ at: iso(e.at), kind: e.kind, d: e.d })),
    row,
    checks: {
      killedBeforeReply: sendsBefore === 0 && !!acc.v,
      replayFresh: ev.some((e) => e.src === "driver" && e.kind === "replay-no-reply"),
      replied: replies.length >= 1,
    },
  });
} else if (step === "n1") {
  // Write rows, note the time, write more, restore to the noted time; rows must match.
  await waitState("running", 600_000);
  const W = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(DB)});
db.exec("PRAGMA busy_timeout=5000");
db.exec("CREATE TABLE IF NOT EXISTS m4b_pitr(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, phase TEXT)");
const ins = db.prepare("INSERT INTO m4b_pitr(ts, phase) VALUES (?, ?)");
const phase = process.argv[1] || "a";
for (let i = 0; i < 200; i++) { ins.run(Date.now(), phase); await new Promise((r) => setTimeout(r, 50)); }
const r = db.prepare("SELECT count(*) n, max(ts) m FROM m4b_pitr").get();
console.log(JSON.stringify({ n: Number(r.n), max: Number(r.m) }));`;
  const Q = (cut) => `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(DB)}, { readOnly: true });
let r; try { r = db.prepare("SELECT count(*) n, max(ts) m, sum(phase='a') a, sum(phase='b') b, sum(ts <= ${cut}) le FROM m4b_pitr").get(); r = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])); } catch (e) { r = { err: String(e) }; }
console.log(JSON.stringify(r));`;
  const runW = (phase) => nodeJs(W.replace('process.argv[1] || "a"', JSON.stringify(phase)), 120_000);
  const a = await runW("a");
  await sleep(5000); // Litestream ships the last phase-a txn (1 s sync)
  const ts = now();
  await sleep(3000);
  const b = await runW("b");
  await sleep(5000);
  const pre = await nodeJs(Q(ts));
  const s0 = await status();
  const gen0 = s0.gen?.gen ?? s0.gen;
  const r = await ops("POST", "/ops/restore", { sqlite: `pitr:${iso(ts)}`, acceptLoss: true });
  log("restore", r.json);
  const back = await waitFor(
    async () => {
      const s = await status();
      const g = s.gen?.gen ?? s.gen;
      return s.state === "running" && g !== gen0 ? s : null;
    },
    900_000,
    5000,
  );
  await sleep(5000);
  const post = await nodeJs(Q(ts));
  const ev = await ring(t0);
  save(step, {
    writes: { a, b, ts: iso(ts) },
    beforeRestore: pre,
    restore: { status: r.status, body: r.json },
    restart: { ms: back.ms, gen: back.v?.gen?.gen ?? back.v?.gen ?? null },
    afterRestore: post,
    rows: await rows(4),
    ring: ev
      .filter((e) => ["l5", "gen"].includes(e.src))
      .map((e) => ({ at: iso(e.at), src: e.src, kind: e.kind, d: e.d })),
    checks: {
      accepted: r.status === 202 && typeof r.json?.lossWindowMs === "number",
      rowsMatch: post.n === pre.le && post.b === 0 && post.a === a.n,
    },
  });
} else if (step === "archive") {
  await ops("POST", "/ops/wake", {});
  await waitState("running", 600_000);
  const req = await ops("POST", "/ops/archive", { reason: "owner" });
  const done = await waitFor(
    async () => {
      const a = (await ops("GET", "/ops/archive")).json;
      return a?.request?.id === req.json?.request?.id && a?.request?.state === "done" ? a : null;
    },
    900_000,
    10_000,
  );
  save(step, {
    request: req.json?.request,
    ms: done.ms,
    newest: done.v?.archives?.[0] ?? null,
    checks: { done: !!done.v },
  });
} else if (step === "j") {
  // Wipe the Control DO storage (test route), then wake: index rebuilt from R2, boot from archive + newest gen.
  const Q = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(DB)}, { readOnly: true });
let r; try { r = db.prepare("SELECT count(*) n, max(ts) m FROM m4b_pitr").get(); r = { n: Number(r.n), m: Number(r.m) }; } catch (e) { r = { err: String(e) }; }
console.log(JSON.stringify(r));`;
  await waitState("running", 600_000);
  const pre = await nodeJs(Q);
  const cfg0 = (await ops("GET", "/ops/config")).json?.versions?.length ?? null;
  const s0 = await status();
  // Owner stop (planned snapshot), not sleep: ocsup's sleep check fails on this image (channels-unknown,
  // AUTH_UNAUTHORIZED trusted_proxy_untrusted_source), see the M4b ctl report.
  // J_SLEEP=1 (M4b verify, sleep works again): a forced sleep instead, then `wake` below.
  if (process.env.J_SLEEP) await ops("POST", "/ops/sleep?force=1", {});
  else await ops("POST", "/ops/stop", {});
  const asleep = await waitState(process.env.J_SLEEP ? "asleep" : "stopped", 300_000);
  await sleep(70_000); // one creds/config copy tick (credsCopyMs 60 s) after the last write
  const wipe = await ops("POST", "/ops/fault", { name: "ctl-wipe" });
  await sleep(3000);
  const w1 = await ops("POST", process.env.J_SLEEP ? "/ops/wake" : "/ops/start", {});
  await sleep(5000);
  const w2 = await ops("POST", process.env.J_SLEEP ? "/ops/wake" : "/ops/start", {});
  const up = await waitState("running", 900_000);
  await sleep(10_000);
  const post = await nodeJs(Q);
  const s1 = await status();
  const ev = await ring(t0);
  const cfg1 = (await ops("GET", "/ops/config")).json?.versions?.length ?? null;
  const plan = ev.filter(
    (e) => e.src === "gen" || e.src === "rebuild" || e.src === "creds" || e.src === "hwm",
  );
  save(step, {
    before: { rows: pre, gen: s0.gen?.gen ?? s0.gen, configVersions: cfg0, asleepMs: asleep.ms },
    wipe: { status: wipe.status },
    wake: [w1.json, w2.json],
    runningMs: up.ms,
    after: {
      rows: post,
      gen: s1.gen?.gen ?? s1.gen,
      ctlState: s1.ctlState ?? s1.control?.ctlState ?? null,
      configVersions: cfg1,
    },
    ring: plan.map((e) => ({ at: iso(e.at), src: e.src, kind: e.kind, d: e.d })),
    statusKeys: Object.keys(s1),
    rows: await rows(6),
    checks: {
      rebuilt: ev.some((e) => e.src === "rebuild" && e.kind === "done" && e.d?.ok),
      running: !!up.v,
      rowsKept: post.n === pre.n,
      notRewoundBlocked: !ev.some((e) => JSON.stringify(e).includes("restore-blocked:rewound")),
    },
  });
} else if (step === "f1b-pre") {
  // Before a raw deploy with a new image digest: asleep, newest snapshot newer than any archive with workspace.
  const s = await status();
  if (s.state === "running") await ops("POST", "/ops/sleep?force=1", {});
  const a = await waitState("asleep", 300_000);
  const chk = await ops("POST", "/ops/deploy-check", { image: true });
  save(step, {
    asleep: !!a.v,
    deployCheck: { status: chk.status, body: chk.json },
    checks: { asleep: !!a.v },
  });
} else if (step === "f1b-wake") {
  // After the raw deploy: the wake defers the digest change (snapshot path) and asks for a pre-upgrade archive.
  const w = await ops("POST", "/ops/wake", {});
  const up = await waitState("running", 900_000);
  await sleep(10_000);
  const ev = await ring(t0);
  const arch = await waitFor(
    async () => {
      const a = (await ops("GET", "/ops/archive")).json;
      return a?.request?.reason === "pre-upgrade" && a?.request?.state === "done" ? a : null;
    },
    900_000,
    10_000,
  );
  // Next boot (forced sleep + wake) takes the new digest from the archive.
  await ops("POST", "/ops/sleep?force=1", {});
  await waitState("asleep", 300_000);
  const t1 = now();
  await ops("POST", "/ops/wake", {});
  const up2 = await waitState("running", 900_000);
  const ev2 = await ring(t1);
  save(step, {
    wake: w.json,
    runningMs: up.ms,
    ring1: ev
      .filter((e) => e.src === "epoch" || e.src === "archive" || (e.src === "gen" && e.kind !== "x"))
      .map((e) => ({ at: iso(e.at), src: e.src, kind: e.kind, d: e.d })),
    archive: arch.v?.archives?.[0] ?? null,
    archiveMs: arch.ms,
    ring2: ev2.filter((e) => e.src === "epoch").map((e) => ({ at: iso(e.at), kind: e.kind, d: e.d })),
    running2: !!up2.v,
    rows: await rows(4),
    checks: {
      deferred: ev.some((e) => e.src === "epoch" && e.kind === "digest-deferred"),
      noRestoreBlocked: !JSON.stringify(ev).includes("workspace-missing"),
      archived: !!arch.v,
      switched: ev2.some((e) => e.src === "epoch" && e.kind === "digest-change"),
      running2: !!up2.v,
    },
  });
} else if (step === "idle-start") {
  const s = await status();
  if (s.state === "running") await ops("POST", "/ops/sleep?force=1", {});
  const a = await waitState("asleep", 600_000);
  const st = await status();
  const out = { startAt: now(), gen: st.gen?.gen ?? st.gen, state: st.state, sleep: st.sleep ?? null };
  writeFileSync(join(OUT, "idle-state.json"), JSON.stringify(out));
  save(step, { ...out, asleepMs: a.ms, checks: { asleep: !!a.v } });
} else if (step === "idle-end") {
  const st0 = JSON.parse(readFileSync(join(OUT, "idle-state.json"), "utf8"));
  const st = await status();
  const ev = await ring(st0.startAt);
  const wakes = ev.filter((e) => /wake|starting|begin-boot/i.test(e.kind) && e.src !== "fault");
  const hours = (now() - st0.startAt) / 3_600_000;
  save(step, {
    windowH: Number(hours.toFixed(3)),
    start: st0,
    end: { state: st.state, gen: st.gen?.gen ?? st.gen, sleep: st.sleep ?? null },
    ringKinds: [...new Set(ev.map((e) => `${e.src}/${e.kind}`))],
    wakes: wakes.map((e) => ({ at: iso(e.at), src: e.src, kind: e.kind })),
    checks: {
      stayedAsleep: st.state === "asleep" && (st.gen?.gen ?? st.gen) === st0.gen,
      window2h: hours >= Number(process.env.MIN_H ?? 2),
    },
  });
} else {
  console.error("unknown step");
  process.exit(2);
}
process.exit(0);
