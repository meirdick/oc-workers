// Node snippets the soak steps run in the container through the Runtime fault `exec` (OC_TEST only).
// Ported from worker/test/live/{lib,loss-lib,backup-*}.mjs. Each prints one JSON line.

export const ST = "/home/node/.openclaw";
export const STATE_DB = `${ST}/state/openclaw.sqlite`;
export const FILL_DIR = "/home/node/soak-fill";
export const CREDS_DIR = `${ST}/credentials/whatsapp/default`;

/**
 * pgrep/pkill -f pattern for a soak script that does not match the `sh -c` running the check. A plain
 * `pgrep -f soak-churn.mjs` matched its own shell, so churn always looked alive and never started; a plain
 * `pkill -f` killed its own shell before the next command (M7 soak).
 */
export const procPat = (name: string) => `'[${name.slice(0, 1)}]${name.slice(1)}'`;

/**
 * Writer: managed SQLite 20 rows/s (table soak_w, the row counter), non-managed SQLite 1 row/s (journal DELETE,
 * the shadow class) and a workspace state file every 2 s (rootfs bulk). argv: run, lifeMs.
 */
export const WRITER = `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const ST = ${JSON.stringify(ST)};
const run = process.argv[2] || "r";
const life = Number(process.argv[3] || 1800000);
const db = new DatabaseSync(ST + "/state/openclaw.sqlite");
db.exec("PRAGMA busy_timeout=5000");
db.exec("CREATE TABLE IF NOT EXISTS soak_w(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, run TEXT)");
const ins = db.prepare("INSERT INTO soak_w(ts, run) VALUES (?, ?)");
fs.mkdirSync(ST + "/plugin-data/soak", { recursive: true });
const nm = new DatabaseSync(ST + "/plugin-data/soak/store.sqlite");
nm.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000");
nm.exec("CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, run TEXT)");
const nmIns = nm.prepare("INSERT INTO msgs(ts, run) VALUES (?, ?)");
fs.mkdirSync(ST + "/workspace/soak", { recursive: true });
let k = 0, tick = 0;
setInterval(() => { try { ins.run(Date.now(), run); } catch {} }, 50);
setInterval(() => {
  tick++;
  const ts = Date.now();
  try { nmIns.run(ts, run); } catch {}
  if (tick % 2 === 0) { k++; try { fs.writeFileSync(ST + "/workspace/soak/state.tmp", JSON.stringify({ k, ts, run })); fs.renameSync(ST + "/workspace/soak/state.tmp", ST + "/workspace/soak/state.json"); } catch {} }
}, 1000);
setTimeout(() => process.exit(0), life);
`;

/** Newest row per state class, as uid 1000. */
export const PROBE = `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const ST = ${JSON.stringify(ST)};
const q = (file, sql) => { try { const d = new DatabaseSync(file, { readOnly: true }); d.exec("PRAGMA busy_timeout=5000"); const r = d.prepare(sql).get(); d.close(); return r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? null : Number(v)])) : null; } catch (e) { return { error: String(e).slice(0, 120) }; } };
const out = { now: Date.now() };
out.sql = q(ST + "/state/openclaw.sqlite", "SELECT max(id) AS maxId, max(ts) AS maxTs, count(*) AS n FROM soak_w");
out.nm = q(ST + "/plugin-data/soak/store.sqlite", "SELECT max(id) AS maxId, max(ts) AS maxTs, count(*) AS n FROM msgs");
try { const w = JSON.parse(fs.readFileSync(ST + "/workspace/soak/state.json", "utf8")); out.ws = { k: w.k, ts: w.ts }; } catch { out.ws = null; }
console.log(JSON.stringify(out));
`;

/** Credential churn (Baileys-shaped): creds.json every 2 s, pre-key rotation, session files; at most 46 paths. */
export const CHURN = `
import fs from "node:fs";
const CD = ${JSON.stringify(CREDS_DIR)};
const life = Number(process.argv[2] || 3600000);
fs.mkdirSync(CD, { recursive: true, mode: 0o700 });
const atomic = (p, s) => { fs.writeFileSync(p + ".tmp", s, { mode: 0o600 }); fs.renameSync(p + ".tmp", p); };
let ident = "id-" + Math.random().toString(36).slice(2);
try { ident = JSON.parse(fs.readFileSync(CD + "/creds.json", "utf8")).identity || ident; } catch {}
let k = 0, tick = 0;
try { k = JSON.parse(fs.readFileSync(CD + "/creds.json", "utf8")).nextPreKeyId || 0; } catch {}
setInterval(() => {
  tick++; const ts = Date.now();
  if (tick % 2 === 0) { k++;
    try { atomic(CD + "/pre-key-" + (k % 40) + ".json", JSON.stringify({ keyId: k, ts })); atomic(CD + "/creds.json", JSON.stringify({ identity: ident, nextPreKeyId: k, lastWriteTs: ts })); } catch {} }
  if (tick % 4 === 0) { try { fs.rmSync(CD + "/pre-key-" + ((k + 30) % 40) + ".json", { force: true }); } catch {} }
  if (tick % 3 === 0) { try { atomic(CD + "/session-" + (tick % 5) + ".json", JSON.stringify({ chain: tick, ts })); } catch {} }
}, 1000);
setTimeout(() => process.exit(0), life);
`;

/** Disk side of the CredStore compare: sha256 per file (hex) under the creds dir. */
export const CREDS_DISK = `
import fs from "node:fs"; import crypto from "node:crypto";
const CD = ${JSON.stringify(CREDS_DIR)};
const files = {};
for (const f of fs.readdirSync(CD)) { if (f.endsWith(".tmp")) continue; files[f] = crypto.createHash("sha256").update(fs.readFileSync(CD + "/" + f)).digest("hex"); }
console.log(JSON.stringify({ now: Date.now(), files }));
`;

/** One pass of rows from a table for the PITR steps. argv: phase, count. */
export const PITR_WRITE = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(STATE_DB)});
db.exec("PRAGMA busy_timeout=5000");
db.exec("CREATE TABLE IF NOT EXISTS soak_pitr(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, phase TEXT)");
const ins = db.prepare("INSERT INTO soak_pitr(ts, phase) VALUES (?, ?)");
// argv[1] is the script path; the args start at argv[2] (M7 soak: argv[1] gave n = NaN, 0 rows written).
const phase = process.argv[2] || "a";
const n = Number(process.argv[3] || 100);
for (let i = 0; i < n; i++) { ins.run(Date.now(), phase); await new Promise((r) => setTimeout(r, 50)); }
const r = db.prepare("SELECT count(*) n, max(ts) m FROM soak_pitr").get();
console.log(JSON.stringify({ n: Number(r.n), max: Number(r.m) }));
`;

export const PITR_COUNT = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(STATE_DB)}, { readOnly: true });
let r; try { r = db.prepare("SELECT sum(phase='a') a, sum(phase='b') b, count(*) n FROM soak_pitr").get(); r = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v ?? 0)])); } catch (e) { r = { error: String(e).slice(0, 120) }; }
console.log(JSON.stringify(r));
`;

/** Poison: a schema newer than the build; OpenClaw refuses to start, Litestream ships it (drill D). */
export const POISON = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(STATE_DB)});
db.exec("PRAGMA busy_timeout=5000");
const before = db.prepare("PRAGMA user_version").get().user_version;
db.exec("PRAGMA user_version = 999999");
const after = db.prepare("PRAGMA user_version").get().user_version;
db.close();
console.log(JSON.stringify({ before, after }));
`;

export const USER_VERSION = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(STATE_DB)}, { readOnly: true });
console.log(JSON.stringify({ uv: db.prepare("PRAGMA user_version").get().user_version }));
`;

/** Drill G: a new agent DB (managed path), written and left; the caller kills the container at once. */
export const NEW_AGENT_DB = `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const dir = ${JSON.stringify(ST)} + "/agents/soakg/agent";
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(dir + "/openclaw-agent.sqlite");
db.exec("CREATE TABLE IF NOT EXISTS soak_g(id INTEGER PRIMARY KEY, ts INTEGER)");
db.prepare("INSERT INTO soak_g(ts) VALUES (?)").run(Date.now());
db.close();
console.log(JSON.stringify({ ok: true }));
`;

/** Scrub check (scrub-live): as uid 1000, try to read environ and mem of the gateway and ocio processes. */
export const SCRUB_SH = `
for p in $(ps -eo pid=,args= | grep -E 'openclaw|ocio' | grep -v grep | awk '{print $1}'); do
  name=$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-60)
  env=$(setpriv --reuid=1000 --regid=1000 --clear-groups sh -c "head -c 16 /proc/$p/environ >/dev/null 2>&1; echo \\$?")
  mem=$(setpriv --reuid=1000 --regid=1000 --clear-groups sh -c "head -c 16 /proc/$p/mem >/dev/null 2>&1; echo \\$?")
  echo "SCRUB $p|$name|$env|$mem"
done
`;
