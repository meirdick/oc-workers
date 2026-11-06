// Shared helpers for the M4 sleep drills (worker/test/live/<key>/run.mjs). Each drill runs on a live
// oc-host install with OC_TEST=1, waits on state, asserts, and writes <key>/result.json plus raw files under
// worker/test/results/raw/M4-sleep/. env: U (origin), T (CONTROL_TOKEN), GW (gateway token), WH (Telegram
// webhook secret). Optional: RAW (raw dir), RESULT (result path).
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const U = (process.env.U ?? "").replace(/\/$/, "");
export const T = process.env.T;
export const GW = process.env.GW;
export const WH = process.env.WH;
export const OWNER_CHAT = 71000001;
export const MOCK = process.env.MOCK ?? "oc-m4-sleep mock reply";
const HERE = dirname(fileURLToPath(import.meta.url));
export const RAW = process.env.RAW ?? join(HERE, "../results/raw/M4-sleep");
mkdirSync(RAW, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => Date.now();
export const iso = (t) => (t ? new Date(t).toISOString() : null);
let rawName = "drill";
export function rawFile(name) {
  rawName = name;
}
export function note(msg, o) {
  const l = `${new Date().toISOString()} ${msg} ${o === undefined ? "" : JSON.stringify(o)}`;
  console.error(l);
  appendFileSync(join(RAW, `${rawName}.log`), `${l}\n`);
}

/** Write the drill result: <key>/result.json and RAW/<key>.json. pass = every check true. */
export function result(key, r) {
  const checks = r.checks ?? {};
  const pass = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean);
  const out = { drill: key, at: iso(now()), target: U, pass, ...r };
  const s = `${JSON.stringify(out, null, 1)}\n`;
  writeFileSync(join(HERE, key, "result.json"), s);
  writeFileSync(join(RAW, `${key}.json`), s);
  console.log(JSON.stringify({ drill: key, pass, checks }));
  return out;
}

export async function ops(method, path, body) {
  const t0 = now();
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${U}${path}`, {
        method,
        headers: { authorization: `Bearer ${T}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(150_000),
      });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: r.status, json, text, ms: now() - t0 };
    } catch (e) {
      if (i >= 4) return { status: 0, json: null, text: String(e), ms: now() - t0 };
      await sleep(1500);
    }
  }
}
export const status = async () => (await ops("GET", "/ops/status")).json ?? {};
export const fault = (name, params = {}) => ops("POST", "/ops/fault", { name, params });

export const det = (e) => {
  try {
    return typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail;
  } catch {
    return e.detail;
  }
};
/** Control DO ring since t0, oldest first (cap 500 newest; the collector keeps the full copy). */
export async function ring(t0, limit = 500) {
  const ev = ((await ops("GET", `/ops/events?limit=${limit}`)).json?.events ?? []).reverse();
  return ev.filter((e) => e.at >= t0).map((e) => ({ ...e, d: det(e) }));
}
export async function alerts(t0) {
  const r = await ops("GET", "/ops/alerts");
  const list = r.json?.alerts ?? r.json?.rows ?? [];
  return list.filter((a) => (a.last_sent_at ?? a.at ?? a.created_at ?? 0) >= t0);
}
export async function waitFor(fn, timeoutMs, everyMs = 2000) {
  const t0 = now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return { v, ms: now() - t0 };
    if (now() - t0 > timeoutMs) return { v: null, ms: now() - t0, timeout: true };
    await sleep(everyMs);
  }
}
export const waitState = (states, timeoutMs, everyMs = 2000) =>
  waitFor(
    async () => {
      const s = await status();
      return [].concat(states).includes(s.state) ? s : null;
    },
    timeoutMs,
    everyMs,
  );

export async function exec(cmd, timeoutMs = 60_000) {
  const r = await ops("POST", "/ops/fault", { name: "exec", params: { cmd, timeoutMs } });
  return r.json ?? { ok: false, error: r.text.slice(0, 300), status: r.status };
}
export const asNode = (args) => ["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", ...args];

// ---- SQLite writer (M2/M3 live shape): 20 rows/s into the state DB ----
export const DB = "/home/node/.openclaw/state/openclaw.sqlite";
const WRITER = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(DB)});
db.exec("PRAGMA busy_timeout=5000");
db.exec("CREATE TABLE IF NOT EXISTS m4s_w(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, run TEXT)");
const ins = db.prepare("INSERT INTO m4s_w(ts, run) VALUES (?, ?)");
const run = process.argv[2] || "r";
const ms = Number(process.argv[3] || 120000);
const t = setInterval(() => { try { ins.run(Date.now(), run); } catch {} }, 50);
setTimeout(() => { clearInterval(t); db.close(); process.exit(0); }, ms);
`;
const QUERY = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(DB)}, { readOnly: true });
db.exec("PRAGMA busy_timeout=5000");
let r = null;
try { r = db.prepare("SELECT max(id) AS maxId, max(ts) AS maxTs, count(*) AS n FROM m4s_w").get(); } catch (e) { r = { error: String(e) }; }
console.log(JSON.stringify({ now: Date.now(), ...r }));
`;
export async function writerStart(run, ms = 120_000) {
  const b64 = Buffer.from(WRITER).toString("base64");
  return exec(
    asNode([
      "sh",
      "-c",
      `echo ${b64} | base64 -d > /tmp/m4s-writer.mjs && setsid nohup /usr/local/bin/node --no-warnings /tmp/m4s-writer.mjs ${run} ${ms} >/tmp/m4s-writer.log 2>&1 < /dev/null & echo started`,
    ]),
  );
}
export async function writerQ() {
  const r = await exec(
    asNode(["/usr/local/bin/node", "--no-warnings", "--input-type=module", "-e", QUERY]),
    60_000,
  );
  try {
    return JSON.parse((r.stdout ?? "").trim().split("\n").pop());
  } catch {
    return { err: (r.stderr ?? r.error ?? "").slice(0, 300) };
  }
}

// ---- Telegram update + replies at the fake ----
let seq = 0;
export async function update(text, chat = OWNER_CHAT) {
  seq++;
  const upd = 800000000 + (Math.floor(now() / 100) % 10000000) * 10 + (seq % 10);
  const body = {
    update_id: upd,
    message: {
      message_id: upd % 2000000000,
      date: Math.floor(now() / 1000),
      chat: { id: chat, type: "private", first_name: "m4s" },
      from: { id: chat, is_bot: false, first_name: "m4s", username: "m4s_user" },
      text,
    },
  };
  const t0 = now();
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${U}/telegram-webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WH },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      await r.text();
      return { updateId: upd, text, status: r.status, ackMs: now() - t0, t0 };
    } catch (e) {
      if (i >= 3) return { updateId: upd, text, status: 0, err: String(e), ackMs: now() - t0, t0 };
      await sleep(1000);
    }
  }
}
/** sendMessage calls at the fake Telegram for the chat since t0 (ring src telegram). */
export const sends = async (t0, chat = OWNER_CHAT) =>
  (await ring(t0)).filter(
    (e) => e.src === "telegram" && e.kind === "sendMessage" && String(e.d?.chatId) === String(chat),
  );
/** Agent replies to a given update text: the mock LLM reply sent after t0. */
export async function repliesSince(t0) {
  return (await sends(t0)).filter((e) => String(e.d?.text ?? "").includes(MOCK));
}

// ---- sleep / wake ----
export async function ensureRunning(maxMs = 8 * 60_000) {
  const s = await status();
  if (s.state === "running") return s;
  if (["asleep", "stopped", "new"].includes(s.state))
    await ops("POST", s.state === "stopped" ? "/ops/start" : "/ops/wake");
  const w = await waitState("running", maxMs, 2000);
  return w.v ?? (await status());
}
/** Force sleep (skips idle and min-awake) until `asleep`; returns ms or null. */
export async function forceSleep(maxMs = 6 * 60_000) {
  const t0 = now();
  while (now() - t0 < maxMs) {
    const s = await status();
    if (s.state === "asleep") return now() - t0;
    if (s.state === "running") await ops("POST", "/ops/sleep?force=1");
    await sleep(2000);
  }
  return null;
}
export const genOf = (s) => s.gen?.gen ?? null;
export const planOf = (s) => s.gen?.planKind ?? null;

/** Gens issued in the ring since t0 (src gen, kind begin-boot or issued). */
export function gensIn(ev) {
  const g = new Set();
  for (const e of ev) {
    const n = e.d?.gen;
    if (e.src === "gen" && typeof n === "number") g.add(n);
  }
  return [...g].sort((a, b) => a - b);
}
/** Runtime state transitions seen in the ring since t0. */
export const transitions = (ev) =>
  ev
    .filter((e) => e.src === "rt" && e.kind === "row" && e.d?.to && e.d.to !== e.d.from)
    .map((e) => `${e.d.from}>${e.d.to}`);

/** Drill read of the Control DO rows (snapshots, gens, markers, archives, wake log). */
export const rows = async (limit = 30) => (await fault("rows", { limit })).json ?? {};
/** Force sleep from running, wait asleep; or wake by update and wait running. */
export async function toAsleep() {
  await ensureRunning();
  return forceSleep();
}
/** Write a file in the agent workspace (uid 1000) and list a name there. */
export const wsWrite = (name, text) =>
  exec(asNode(["sh", "-c", `printf %s '${text}' > /home/node/.openclaw/workspace/${name} && echo ok`]));
export async function wsHas(name) {
  const r = await exec(["sh", "-c", `test -f /home/node/.openclaw/workspace/${name} && echo yes || echo no`]);
  return String(r.stdout ?? "").trim() === "yes";
}
/** Boot rows in the ring: gate boot-bound per gen and the end of each boot (gateway exit, exit, settle). */
export function bootSpans(ev) {
  const spans = new Map();
  for (const e of ev) {
    const g = e.d?.gen;
    if (typeof g !== "number") continue;
    const sp = spans.get(g) ?? { gen: g, bound: null, startupz: null, end: null };
    if (e.src === "gate" && e.kind === "boot-bound") sp.bound = e.at;
    if (e.src === "ocsup" && e.kind === "startupz") sp.startupz = e.at;
    if (
      (e.src === "ocsup" && (e.kind === "gateway-exit" || e.kind === "exit")) ||
      (e.src === "gen" && e.kind === "end-boot")
    )
      sp.end = sp.end ?? e.at;
    spans.set(g, sp);
  }
  return [...spans.values()].sort((a, b) => a.gen - b.gen);
}
/** Two gateways at once: a boot bound before the previous gen's gateway ended. */
export function overlaps(spans) {
  const out = [];
  for (let i = 1; i < spans.length; i++) {
    const a = spans[i - 1];
    const b = spans[i];
    if (a.startupz && b.bound && (a.end === null || b.bound < a.end)) out.push({ prev: a.gen, next: b.gen });
  }
  return out;
}
