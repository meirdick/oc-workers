// Shared helpers for the M4 loss drills (worker/test/live/{setup,loss50,K,L,S7}). Each drill runs against one
// live install with OC_TEST=1 (the /ops/fault routes), waits on state, asserts, and writes a JSON result plus
// raw lines. env: U (origin), T (CONTROL_TOKEN), WH (TELEGRAM_WEBHOOK_SECRET), GW (gateway password), RAW (raw
// dir, default worker/test/results/raw/M4-loss), RING (collector file, default $RAW/ring.jsonl).
// (lib.mjs and collect.mjs in this dir belong to the M4 sleep drills.)
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const U = (process.env.U ?? "").replace(/\/$/, "");
export const T = process.env.T ?? "";
export const WH = process.env.WH ?? "";
export const GW = process.env.GW ?? "";
export const RAW = process.env.RAW ?? join(HERE, "../results/raw/M4-loss");
export const RING = process.env.RING ?? join(RAW, "ring.jsonl");
mkdirSync(RAW, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => Date.now();
export const iso = (t) => (t ? new Date(t).toISOString() : null);
export const note = (msg, o) =>
  console.error(`${new Date().toISOString()} ${msg} ${o === undefined ? "" : JSON.stringify(o)}`);
export const rnd = (lo, hi) => lo + Math.random() * (hi - lo);

/** Append one raw JSON line to $RAW/<file>.jsonl. */
export function raw(file, o) {
  appendFileSync(join(RAW, `${file}.jsonl`), `${JSON.stringify({ at: iso(now()), ...o })}\n`);
}
/** Final result of a drill: $RAW/<key>.json, and stdout. pass = every check true. */
export function result(key, r) {
  const checks = r.checks ?? {};
  const pass = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean);
  const out = { drill: key, at: iso(now()), pass, ...r };
  writeFileSync(join(RAW, `${key}.json`), `${JSON.stringify(out, null, 1)}\n`);
  console.log(JSON.stringify({ drill: key, pass, checks }));
  return pass;
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
      if (i >= 3) return { status: 0, json: null, text: String(e), ms: now() - t0 };
      await sleep(1000);
    }
  }
}
export const status = async () => (await ops("GET", "/ops/status")).json ?? {};
export const det = (e) => {
  try {
    return typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail;
  } catch {
    return e.detail;
  }
};

/** Ring rows since t0 from the collector file (no 500-row cap); else /ops/events. */
export async function ringSince(t0) {
  if (existsSync(RING)) {
    return readFileSync(RING, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => !e.gap && e.at >= t0);
  }
  const ev = ((await ops("GET", "/ops/events?limit=500")).json?.events ?? []).reverse();
  return ev.filter((e) => e.at >= t0);
}
export const rtRows = (ev) =>
  ev.filter((e) => e.src === "rt" && e.kind === "row").map((e) => ({ at: e.at, ...det(e) }));

export async function waitFor(fn, timeoutMs, everyMs = 2000) {
  const t0 = now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return { v, ms: now() - t0 };
    if (now() - t0 > timeoutMs) return { v: null, ms: now() - t0, timeout: true };
    await sleep(everyMs);
  }
}

// ---- exec in the container (root) through /ops/fault exec ----
export async function exec(cmd, timeoutMs = 60_000) {
  const r = await ops("POST", "/ops/fault", { name: "exec", params: { cmd, timeoutMs } });
  return r.json ?? { ok: false, error: r.text.slice(0, 300), status: r.status };
}
export const sh = (s, t) => exec(["/bin/sh", "-c", s], t);
const AS1000 = ["setpriv", "--reuid=1000", "--regid=1000", "--init-groups", "env", "HOME=/home/node"];
/** node -e as uid 1000 (ESM); returns the parsed last stdout line or {err}. */
export async function node1000(js, args = [], t = 60_000) {
  const r = await exec(
    [...AS1000, "/usr/local/bin/node", "--no-warnings", "--input-type=module", "-e", js, ...args],
    t,
  );
  try {
    return JSON.parse((r.stdout ?? "").trim().split("\n").pop());
  } catch {
    return { err: `${r.error ?? ""} ${(r.stderr ?? "").slice(0, 300)}`.trim(), exit: r.exitCode };
  }
}

export const state = async () => (await status()).state ?? null;
export async function running(timeoutMs = 600_000) {
  return waitFor(async () => ((await state()) === "running" ? true : null), timeoutMs, 3000);
}
/** Running with a gen other than `gen0`. Returns the status. */
export async function runningNewGen(gen0, timeoutMs = 900_000) {
  return waitFor(
    async () => {
      const s = await status();
      return s.state === "running" && s.gen?.gen !== gen0 ? s : null;
    },
    timeoutMs,
    3000,
  );
}
export async function sigkill() {
  const t = now();
  const r = await ops("POST", "/ops/fault", { name: "sigkill" });
  return { at: t, ackMs: r.ms, ok: r.json?.ok === true, err: r.json?.error ?? null };
}

// ---- Telegram updates (fake channel 1) ----
let seq = 0;
/** One DM from `chat` through the public webhook. Unique update_id and message_id per call. */
export async function dm(chat, text) {
  seq++;
  const upd = 800000000 + (Math.floor(now() / 100) % 10000000) * 10 + (seq % 10);
  const body = {
    update_id: upd,
    message: {
      message_id: upd % 2000000000,
      date: Math.floor(now() / 1000),
      chat: { id: chat, type: "private", first_name: "m4l" },
      from: { id: chat, is_bot: false, first_name: "m4l", username: `m4l_${chat}` },
      text,
    },
  };
  const t0 = now();
  try {
    const r = await fetch(`${U}/telegram-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WH },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    await r.text();
    return { chat, updateId: upd, status: r.status, ackMs: now() - t0, t0 };
  } catch (e) {
    return { chat, updateId: upd, status: 0, ackMs: now() - t0, t0, err: String(e).slice(0, 120) };
  }
}
/** sendMessage calls at the fake Bot API to `chat` since t0. */
export async function sends(chat, t0, ev = null) {
  return (ev ?? (await ringSince(t0))).filter(
    (e) =>
      e.at >= t0 &&
      e.src === "telegram" &&
      e.kind === "sendMessage" &&
      String(det(e)?.chatId) === String(chat),
  );
}

// ---- fake second channel ("fakewa"): a Baileys-shaped socket channel in the container ----
// One uid-1000 process per awake period. Every tick it plays one inbound message of a socket channel:
//  - managed SQLite: 20 rows/s into state/openclaw.sqlite table m4l_w (Litestream class, RPO 1-3 s)
//  - non-managed SQLite: 1 row/s into fakewa/store.sqlite, journal DELETE (shadow class, RPO ≤ 15 min)
//  - creds: credentials/whatsapp/default/creds.json rewritten every 2 s (identity fixed at link, counters move),
//    pre-key-<k mod 40>.json written every 2 s, the one 10 keys back deleted every 4 s, session-<j>.json every
//    3 s (≤ 46 paths: the CredStore caps paths at 500, tombstones included)
//  - workspace: workspace/m4loss/state.json {k, ts} every 2 s, a new note n-<k>.md every 10 s (rootfs bulk)
// It never links: without creds.json it exits "relink-needed" (counted as a relink).
export const ST = "/home/node/.openclaw";
export const FAKEWA = `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const ST = ${JSON.stringify(ST)};
const run = process.argv[2] || "r";
const lifeMs = Number(process.argv[3] || 1800000);
const CD = ST + "/credentials/whatsapp/default";
const W = ST + "/workspace/m4loss";
const log = (m) => fs.appendFileSync("/tmp/m4l-fakewa.log", new Date().toISOString() + " " + m + "\\n");
if (!fs.existsSync(CD + "/creds.json")) { log("relink-needed"); process.exit(3); }
const ident = JSON.parse(fs.readFileSync(CD + "/creds.json", "utf8")).identity;
fs.mkdirSync(W, { recursive: true });
fs.mkdirSync(ST + "/fakewa", { recursive: true });
const db = new DatabaseSync(ST + "/state/openclaw.sqlite");
db.exec("PRAGMA busy_timeout=5000");
db.exec("CREATE TABLE IF NOT EXISTS m4l_w(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, run TEXT)");
const ins = db.prepare("INSERT INTO m4l_w(ts, run) VALUES (?, ?)");
const nm = new DatabaseSync(ST + "/fakewa/store.sqlite");
nm.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000");
nm.exec("CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, run TEXT)");
const nmIns = nm.prepare("INSERT INTO msgs(ts, run) VALUES (?, ?)");
const atomic = (p, s) => { fs.writeFileSync(p + ".tmp", s, { mode: 0o600 }); fs.renameSync(p + ".tmp", p); };
let k = 0;
try { k = JSON.parse(fs.readFileSync(CD + "/creds.json", "utf8")).nextPreKeyId || 0; } catch {}
let tick = 0;
setInterval(() => { try { ins.run(Date.now(), run); } catch {} }, 50);
setInterval(() => {
  tick++;
  const ts = Date.now();
  try { nmIns.run(ts, run); } catch (e) { log("nm " + e); }
  if (tick % 2 === 0) {
    k++;
    try {
      atomic(CD + "/pre-key-" + (k % 40) + ".json", JSON.stringify({ keyId: k, pub: (ts * 7919).toString(36), ts }));
      atomic(CD + "/creds.json", JSON.stringify({ identity: ident, nextPreKeyId: k, lastWriteTs: ts, run }));
      atomic(W + "/state.json", JSON.stringify({ k, ts, run }));
    } catch (e) { log("w " + e); }
  }
  if (tick % 4 === 0) { try { fs.rmSync(CD + "/pre-key-" + ((k + 30) % 40) + ".json", { force: true }); } catch {} }
  if (tick % 3 === 0) { try { atomic(CD + "/session-" + (tick % 5) + ".json", JSON.stringify({ chain: tick, ts })); } catch {} }
  if (tick % 10 === 0) { try { atomic(W + "/n-" + k + ".md", "m4 loss note " + k + " " + ts + "\\n"); } catch {} }
}, 1000);
setTimeout(() => process.exit(0), lifeMs);
log("start " + run);
`;
/** "Link" fakewa once: identity written to creds.json (never rewritten by the channel after this). */
export const LINK = `
import fs from "node:fs"; import crypto from "node:crypto";
const CD = ${JSON.stringify(`${ST}/credentials/whatsapp/default`)};
fs.mkdirSync(CD, { recursive: true, mode: 0o700 });
let r = "exists";
if (!fs.existsSync(CD + "/creds.json")) {
  const identity = { noiseKey: crypto.randomBytes(32).toString("base64"), signedIdentityKey: crypto.randomBytes(32).toString("base64"),
    registrationId: crypto.randomInt(1, 16380), me: { id: "15550000001:1@s.whatsapp.net" } };
  fs.writeFileSync(CD + "/creds.json", JSON.stringify({ identity, nextPreKeyId: 0, lastWriteTs: Date.now(), run: "link" }), { mode: 0o600 });
  r = "linked";
}
const c = JSON.parse(fs.readFileSync(CD + "/creds.json", "utf8"));
console.log(JSON.stringify({ r, identity: crypto.createHash("sha256").update(JSON.stringify(c.identity)).digest("hex").slice(0, 16) }));
`;
export async function fakewaStart(run, lifeMs = 1_800_000) {
  const b64 = Buffer.from(FAKEWA).toString("base64");
  return exec([
    ...AS1000,
    "sh",
    "-c",
    `kill $(cat /tmp/m4l-fakewa.pid 2>/dev/null) 2>/dev/null; echo ${b64} | base64 -d > /tmp/m4l-fakewa.mjs && { setsid nohup /usr/local/bin/node --no-warnings /tmp/m4l-fakewa.mjs ${run} ${lifeMs} >>/tmp/m4l-fakewa.out 2>&1 < /dev/null & echo $! > /tmp/m4l-fakewa.pid; } && echo started`,
  ]);
}
export const fakewaStop = () =>
  exec(["sh", "-c", "kill $(cat /tmp/m4l-fakewa.pid) 2>/dev/null; echo stopped"]);

/**
 * Probe of every state class the drills measure, read as uid 1000 in one exec:
 * managed rows (max id/ts), non-managed rows, creds dir (path → sha256, ts), identity hash, workspace state.
 */
export const PROBE = `
import fs from "node:fs"; import crypto from "node:crypto"; import { DatabaseSync } from "node:sqlite";
const ST = ${JSON.stringify(ST)};
const out = { now: Date.now() };
const q = (file, sql) => { try { const d = new DatabaseSync(file, { readOnly: true }); d.exec("PRAGMA busy_timeout=5000"); const r = d.prepare(sql).get(); d.close(); return r; } catch (e) { return { error: String(e).slice(0, 120) }; } };
out.sql = q(ST + "/state/openclaw.sqlite", "SELECT max(id) AS maxId, max(ts) AS maxTs, count(*) AS n FROM m4l_w");
out.nm = q(ST + "/fakewa/store.sqlite", "SELECT max(id) AS maxId, max(ts) AS maxTs, count(*) AS n FROM msgs");
const CD = ST + "/credentials/whatsapp/default";
out.creds = {};
try { for (const f of fs.readdirSync(CD)) { if (f.endsWith(".tmp")) continue; const b = fs.readFileSync(CD + "/" + f);
  let ts = null; try { const j = JSON.parse(b); ts = j.lastWriteTs ?? j.ts ?? null; } catch {}
  out.creds[f] = { sha: crypto.createHash("sha256").update(b).digest("hex").slice(0, 16), ts }; } } catch (e) { out.credsErr = String(e).slice(0, 120); }
try { const c = JSON.parse(fs.readFileSync(CD + "/creds.json", "utf8")); out.identity = crypto.createHash("sha256").update(JSON.stringify(c.identity)).digest("hex").slice(0, 16); out.credsTs = c.lastWriteTs; out.preKey = c.nextPreKeyId; } catch { out.identity = null; }
try { const w = JSON.parse(fs.readFileSync(ST + "/workspace/m4loss/state.json", "utf8")); out.ws = { k: w.k, ts: w.ts }; } catch { out.ws = null; }
try { out.wsNotes = fs.readdirSync(ST + "/workspace/m4loss").filter((f) => f.startsWith("n-")).length; } catch { out.wsNotes = 0; }
console.log(JSON.stringify(out));
`;
export async function probe() {
  const t0 = now();
  const j = await node1000(PROBE, [], 60_000);
  const t1 = now();
  return { ...j, sentAt: t0, laptopMid: Math.round((t0 + t1) / 2), probeMs: t1 - t0 };
}

/** Compare the creds dir before a kill with the dir after the restore. */
export function credsDiff(before, after) {
  const b = before?.creds ?? {};
  const a = after?.creds ?? {};
  const missing = Object.keys(b).filter((f) => !(f in a));
  const extra = Object.keys(a).filter((f) => !(f in b));
  const changed = Object.keys(b).filter((f) => f in a && a[f].sha !== b[f].sha);
  return { before: Object.keys(b).length, after: Object.keys(a).length, missing, extra, changed };
}
