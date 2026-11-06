// Drill backup-shadow (plan §4.11 "Shadow", §6.1 row 5; scope M4 exit "non-managed SQLite loss ≤ 15 min").
// Two non-managed SQLite files under $STATE/plugin-data/m4bk/: j.sqlite (rollback journal) and w.sqlite (WAL,
// no checkpoint by the writer). The driver inserts one row per minute into both for WRITE1_MIN minutes, stays
// quiet for QUIET_MIN, then writes again for WRITE2_MIN. Every minute it reads the newest row time in each
// file and in ocsup's newest local shadow copy (/var/lib/ocrt/shadow/, the bytes sent to R2 on success), and
// counts shadow-backup rounds in ocsup.log. Checks: lag (newest row − newest shadowed row) stays ≤ 15 min +
// one round; no upload of an unchanged file during the quiet window (after the catch-up round).
// env: U, T. usage: node run.mjs | node run.mjs recompute <raw log> (re-analysis of a past run)
import { readFileSync } from "node:fs";
import { iso, nodeAs, note, now, rawFile, result, STATE, sh, sleep, status } from "../backup/lib.mjs";

const KEY = "backup-shadow";
rawFile(KEY);
const W1 = Number(process.env.WRITE1_MIN ?? 35);
const Q = Number(process.env.QUIET_MIN ?? 35);
const W2 = Number(process.env.WRITE2_MIN ?? 20);
const TAIL = Number(process.env.TAIL_MIN ?? 17);
const DIR = `${STATE}/plugin-data/m4bk`;
const FILES = { j: `${DIR}/j.sqlite`, w: `${DIR}/w.sqlite` };

// j.sqlite: open, insert, close (rollback journal; every write lands in the main file).
const WRITE = `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
fs.mkdirSync(${JSON.stringify(DIR)}, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(${JSON.stringify(FILES.j)});
db.exec("CREATE TABLE IF NOT EXISTS m4b(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, pad TEXT)");
const ts = Date.now();
db.prepare("INSERT INTO m4b(ts, pad) VALUES (?, ?)").run(ts, "x".repeat(200));
db.close();
fs.writeFileSync("/tmp/m4b-w.go", String(ts));
console.log(JSON.stringify({ j: ts }));
`;
// w.sqlite: one long-lived WAL connection (like a plugin DB held open by the gateway), autocheckpoint off, so
// rows stay in -wal and the main file's mtime/size do not move. Inserts when the driver drops /tmp/m4b-w.go.
const WAL_WRITER = `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
fs.mkdirSync(${JSON.stringify(DIR)}, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(${JSON.stringify(FILES.w)});
db.exec("PRAGMA journal_mode=WAL"); db.exec("PRAGMA wal_autocheckpoint=0");
db.exec("CREATE TABLE IF NOT EXISTS m4b(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, pad TEXT)");
const ins = db.prepare("INSERT INTO m4b(ts, pad) VALUES (?, ?)");
const end = Date.now() + Number(process.argv[2]);
const iv = setInterval(() => {
  try { if (fs.existsSync("/tmp/m4b-w.go")) { fs.unlinkSync("/tmp/m4b-w.go"); ins.run(Date.now(), "x".repeat(200)); } } catch (e) { fs.appendFileSync("/tmp/m4b-w.err", String(e) + "\\n"); }
  if (Date.now() > end) { clearInterval(iv); db.close(); }
}, 1000);
`;
// Read as root (shadow copies are root-only); read-only opens, newest row per file.
const READ = `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const q = (f) => { try { if (!fs.existsSync(f)) return null; const st = fs.statSync(f); const db = new DatabaseSync(f, { readOnly: true });
  const r = db.prepare("SELECT max(ts) AS ts, count(*) AS n FROM m4b").get(); db.close(); return { ...r, mtimeMs: Math.round(st.mtimeMs), size: st.size }; }
  catch (e) { return { err: String(e).slice(0, 120) }; } };
const sh = fs.existsSync("/var/lib/ocrt/shadow") ? fs.readdirSync("/var/lib/ocrt/shadow") : [];
const pick = (k) => sh.filter((n) => n.includes("m4bk_" + k + "-") && !n.endsWith(".tmp")).map((n) => "/var/lib/ocrt/shadow/" + n)[0];
const log = fs.readFileSync("/var/lib/ocrt/ocsup.log", "utf8").split("\\n").filter((l) => l.includes('"shadow-backup"')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log(JSON.stringify({ at: Date.now(), j: q(${JSON.stringify(FILES.j)}), w: q(${JSON.stringify(FILES.w)}), sj: q(pick("j")), sw: q(pick("w")), shadowFiles: sh, rounds: log.map((l) => ({ ts: l.ts, why: l.why, n: l.n, bad: l.bad })) }));
`;

async function measure() {
  const t0 = now();
  const s0 = await status();
  note("start", { state: s0.state, gen: s0.gen?.gen });
  const samples = [];
  const writes = [];
  const total = W1 + Q + W2 + TAIL;
  const wb64 = Buffer.from(WAL_WRITER).toString("base64");
  note(
    "wal-writer",
    await sh(
      `mkdir -p ${DIR} && chown 1000:1000 ${STATE}/plugin-data ${DIR} 2>/dev/null; echo ${wb64} | base64 -d > /tmp/m4b-wal.mjs && chmod 644 /tmp/m4b-wal.mjs && setpriv --reuid=1000 --regid=1000 --clear-groups setsid nohup /usr/local/bin/node --no-warnings /tmp/m4b-wal.mjs ${(total + 2) * 60_000} >/tmp/m4b-wal.log 2>&1 < /dev/null & echo started`,
    ),
  );
  await sleep(3000);
  let last = null;
  for (let m = 0; m < total; m++) {
    const tick = now();
    const writing = m < W1 || (m >= W1 + Q && m < W1 + Q + W2);
    if (writing) {
      const w = await nodeAs(WRITE);
      if (w.j) writes.push({ m, ...w });
      else note("write-error", w);
      await sleep(2500); // the WAL writer inserts within 1 s of the go file
    }
    const r = await nodeAs(READ, [], 60_000, true);
    if (r.at) {
      last = r;
      const row = {
        m,
        at: iso(r.at),
        writing,
        jTs: r.j?.ts,
        wTs: r.w?.ts,
        sjTs: r.sj?.ts ?? null,
        swTs: r.sw?.ts ?? null,
        jLagS: r.j?.ts && r.sj?.ts ? Math.round((r.j.ts - r.sj.ts) / 1000) : null,
        wLagS: r.w?.ts && r.sw?.ts ? Math.round((r.w.ts - r.sw.ts) / 1000) : null,
        wMainMtime: r.w?.mtimeMs,
        rounds: r.rounds.length,
      };
      samples.push(row);
      note("sample", row);
    } else note("read-error", r);
    await sleep(Math.max(0, 60_000 - (now() - tick)));
  }

  const s1 = await status();
  return { t0, s0, s1, samples, writes, last, end: now() };
}

/** Rebuild the run from its raw log (sample lines), for a re-analysis without a new 107 min run. */
function fromLog(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const samples = lines
    .filter((l) => l.includes(" sample "))
    .map((l) => JSON.parse(l.slice(l.indexOf(" sample ") + 8)));
  const start = lines.find((l) => l.includes(" start "));
  const t0 = Date.parse(start.slice(0, 24));
  const prev = JSON.parse(readFileSync(new URL("./result.json", import.meta.url), "utf8"));
  return {
    t0,
    s0: { gen: { gen: 0 } },
    s1: { gen: { gen: 0 }, state: prev.stateAtEnd },
    samples,
    writes: samples.filter((x) => x.writing).map((x) => ({ m: x.m, j: x.jTs })),
    last: { rounds: prev.rounds },
    end: Date.parse(samples.at(-1).at),
  };
}

const run = process.argv[2] === "recompute" ? fromLog(process.argv[3]) : await measure();
const { t0, s0, s1, samples, writes, last } = run;

// Rounds that uploaded our files, and the quiet window.
const rounds = (last?.rounds ?? []).filter((r) => Date.parse(r.ts) >= t0);
const quietFrom = t0 + W1 * 60_000;
const quietTo = t0 + (W1 + Q) * 60_000;
// Uploads of our files: the shadow copy row time changed between samples.
const uploads = [];
for (let i = 1; i < samples.length; i++)
  for (const k of ["sj", "sw"])
    if (samples[i][`${k}Ts`] && samples[i][`${k}Ts`] !== samples[i - 1][`${k}Ts`])
      uploads.push({
        file: k === "sj" ? "j" : "w",
        m: samples[i].m,
        at: samples[i].at,
        rowTs: samples[i][`${k}Ts`],
      });
const lastWriteBeforeQuiet = writes.filter((w) => w.m < W1).at(-1);
const quietUploads = uploads.filter(
  (u) => Date.parse(u.at) > quietFrom + 16 * 60_000 && Date.parse(u.at) < quietTo,
);
// Loss window at each sample: age of the oldest row on disk that the newest shadow copy does not hold
// (0 when the shadow holds every row). A crash at that moment loses rows this old at most.
function unshadowedAges(rowKey, shKey) {
  const rows = [...new Set(samples.map((x) => x[rowKey]).filter(Boolean))].sort((a, b) => a - b);
  return samples
    .filter((x) => x[shKey] !== null)
    .map((x) => {
      const at = Date.parse(x.at);
      const oldest = rows.find((r) => r > x[shKey] && r <= at);
      return oldest ? Math.round((at - oldest) / 1000) : 0;
    });
}
const lagJ = unshadowedAges("jTs", "sjTs");
const lagW = unshadowedAges("wTs", "swTs");
const firstShadow = (k) => samples.find((s) => s[`${k}Ts`])?.m ?? null;
const LIMIT_S = 15 * 60 + 120;
result(KEY, {
  window: { from: iso(t0), to: iso(run.end), writeMin: [W1, W2], quietMin: Q },
  writes: writes.length,
  rounds: rounds.map((r) => ({ ts: r.ts, why: r.why, n: r.n, bad: r.bad })),
  uploads,
  firstShadowMin: { j: firstShadow("sj"), w: firstShadow("sw") },
  maxUnshadowedAgeS: { j: lagJ.length ? Math.max(...lagJ) : null, w: lagW.length ? Math.max(...lagW) : null },
  quietUploads,
  lastWriteBeforeQuiet: lastWriteBeforeQuiet ? iso(lastWriteBeforeQuiet.j) : null,
  stateAtEnd: s1.state,
  checks: {
    journalShadowed: lagJ.length > 0,
    walShadowed: lagW.length > 0,
    journalLagWithin15m: lagJ.length > 0 && Math.max(...lagJ) <= LIMIT_S,
    walLagWithin15m: lagW.length > 0 && Math.max(...lagW) <= LIMIT_S,
    noUploadWhenUnchanged: quietUploads.length === 0,
    sameGen: s1.gen?.gen === s0.gen?.gen,
  },
});
