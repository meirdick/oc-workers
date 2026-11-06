// Drill backup-creds (plan §4.10, §6.1 row 2; scope M4 exit "after 24 h of Baileys churn, CredStore equals
// the disk", here CHURN_MIN minutes, default 120). A churn process in the container (uid 1000) writes a
// Baileys useMultiFileAuthState tree under credentials/whatsapp/m4bk/: creds.json rewrites, session-*.json
// updates, pre-key-*.json consumed one by one and refilled in batches of 30, sender-key-* and
// app-state-sync-key-* creates, app-state-sync-version-* updates. Plain writeFile (no rename), as Baileys does.
// Every PROBE_MIN minutes the driver writes a probe file and times how long until the CredStore has its sha256
// (creds loss window, exit target ≤ 30 s) and counts disk/CredStore differences. At the end the churn stops,
// the driver waits SETTLE_S and the CredStore must equal the disk (same path set, same sha256 and mode).
// env: U, T. usage: node run.mjs
import {
  credsManifest,
  iso,
  nodeAs,
  note,
  now,
  ops,
  rawFile,
  result,
  STATE,
  sh,
  sleep,
  status,
} from "../backup/lib.mjs";

const KEY = "backup-creds";
rawFile(KEY);
const CHURN_MIN = Number(process.env.CHURN_MIN ?? 120);
const PROBE_MIN = Number(process.env.PROBE_MIN ?? 5);
const SETTLE_S = Number(process.env.SETTLE_S ?? 60);
const DIR = "credentials/whatsapp/m4bk";

const CHURN = `
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const root = process.argv[2], ms = Number(process.argv[3]);
const dir = path.join(root, ${JSON.stringify(DIR)});
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const rnd = (n) => crypto.randomBytes(n).toString("base64");
const w = (f, o) => { fs.writeFileSync(path.join(dir, f), JSON.stringify(o), { mode: 0o600 }); st.writes++; };
const del = (f) => { try { fs.unlinkSync(path.join(dir, f)); st.deletes++; } catch {} };
const st = { writes: 0, deletes: 0, prekeyNext: 1, prekeys: [], start: Date.now() };
const contacts = Array.from({ length: 25 }, (_, i) => "1555000" + String(i).padStart(4, "0") + ".0");
const creds = () => w("creds.json", { noiseKey: { private: rnd(32), public: rnd(32) }, signedIdentityKey: { private: rnd(32), public: rnd(32) },
  registrationId: 4242, advSecretKey: rnd(32), nextPreKeyId: st.prekeyNext, firstUnuploadedPreKeyId: st.prekeyNext,
  account: { details: rnd(120), accountSignature: rnd(64) }, me: { id: "15550009999:7@s.whatsapp.net" }, pad: rnd(1800), t: Date.now() });
const refill = () => { for (let i = 0; i < 30; i++) { const id = st.prekeyNext++; w("pre-key-" + id + ".json", { keyPair: { private: rnd(32), public: rnd(33) }, keyId: id }); st.prekeys.push(id); } creds(); };
refill(); creds();
for (const c of contacts) w("session-" + c + ".json", { _sessions: { [rnd(33)]: { chain: rnd(400 + Math.floor(Math.random() * 3000)) } }, version: "v1" });
w("app-state-sync-version-regular.json", { version: 1, hash: rnd(96) });
let tick = 0, ver = 1;
const iv = setInterval(() => {
  try {
    tick++;
    if (tick % 2 === 0) creds();
    const c = contacts[Math.floor(Math.random() * contacts.length)];
    w("session-" + c + ".json", { _sessions: { [rnd(33)]: { chain: rnd(400 + Math.floor(Math.random() * 3000)) } }, version: "v1", t: Date.now() });
    if (tick % 12 === 0) { const id = st.prekeys.shift(); if (id) del("pre-key-" + id + ".json"); if (st.prekeys.length < 10) refill(); }
    if (tick % 6 === 0) w("app-state-sync-version-regular.json", { version: ++ver, hash: rnd(96) });
    if (tick % 60 === 0) w("sender-key-" + crypto.randomBytes(6).toString("hex") + "@g.us--15550009999--0.json", { k: rnd(200) });
    if (tick % 240 === 0) w("app-state-sync-key-" + crypto.randomBytes(5).toString("hex") + ".json", { keyData: rnd(32), timestamp: Date.now() });
    if (tick % 30 === 0) fs.writeFileSync("/tmp/m4b-churn.json", JSON.stringify({ ...st, prekeys: st.prekeys.length, tick, at: Date.now() }));
  } catch (e) { fs.appendFileSync("/tmp/m4b-churn.err", String(e) + "\\n"); }
  if (Date.now() - st.start > ms || fs.existsSync("/tmp/m4b-churn.stop")) {
    clearInterval(iv);
    fs.writeFileSync("/tmp/m4b-churn.json", JSON.stringify({ ...st, prekeys: st.prekeys.length, tick, at: Date.now(), done: true }));
  }
}, 5000);
`;

const DISK = `
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const root = process.argv[2];
const out = {};
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p); else if (e.isFile()) { const b = fs.readFileSync(p);
    out[path.relative(root, p)] = { sha256: crypto.createHash("sha256").update(b).digest("hex"), mode: fs.statSync(p).mode & 0o777, size: b.length }; } } };
walk(path.join(root, "credentials"));
console.log(JSON.stringify({ at: Date.now(), files: out }));
`;

const norm = (p) => p.replace(/^\/+/, "").replace(/^\.openclaw\//, "");
function diff(disk, man) {
  const store = new Map((man.files ?? []).map((f) => [norm(f.path), f]));
  const d = new Map(Object.entries(disk.files ?? {}).map(([k, v]) => [norm(k), v]));
  const onlyDisk = [];
  const onlyStore = [];
  const shaDiff = [];
  const modeDiff = [];
  for (const [k, v] of d) {
    const s = store.get(k);
    if (!s) onlyDisk.push(k);
    else {
      if (s.sha256 !== v.sha256) shaDiff.push(k);
      if (s.mode !== v.mode) modeDiff.push(k);
    }
  }
  for (const k of store.keys()) if (!d.has(k)) onlyStore.push(k);
  return { disk: d.size, store: store.size, onlyDisk, onlyStore, shaDiff, modeDiff };
}

const t0 = now();
const s0 = await status();
note("start", { state: s0.state, gen: s0.gen?.gen });
const b64 = Buffer.from(CHURN).toString("base64");
const started = await sh(
  `echo ${b64} | base64 -d > /tmp/m4b-churn.mjs && chmod 644 /tmp/m4b-churn.mjs && rm -f /tmp/m4b-churn.stop && setpriv --reuid=1000 --regid=1000 --clear-groups setsid nohup /usr/local/bin/node --no-warnings /tmp/m4b-churn.mjs ${STATE} ${CHURN_MIN * 60_000} >/tmp/m4b-churn.log 2>&1 < /dev/null & echo started`,
);
note("churn", started);
const probes = [];
const samples = [];
let n = 0;
while (now() - t0 < CHURN_MIN * 60_000) {
  await sleep(PROBE_MIN * 60_000);
  n++;
  // Probe: a new file with a unique body; time until the CredStore holds its sha256.
  const name = `${DIR}/m4-probe.json`;
  const w = await nodeAs(
    `import fs from "node:fs"; import crypto from "node:crypto"; const b = JSON.stringify({ probe: ${n}, at: Date.now(), r: crypto.randomBytes(16).toString("hex") });
     fs.writeFileSync(process.argv[2], b, { mode: 0o600 }); console.log(JSON.stringify({ at: Date.now(), sha256: crypto.createHash("sha256").update(b).digest("hex") }));`,
    [`${STATE}/${name}`],
  );
  let seenMs = null;
  const pt = now();
  while (now() - pt < 120_000) {
    const m = await credsManifest();
    const f = (m.files ?? []).find((x) => norm(x.path) === name);
    if (f && f.sha256 === w.sha256) {
      seenMs = now() - (w.at ?? pt);
      break;
    }
    await sleep(500);
  }
  const disk = await nodeAs(DISK, [STATE], 60_000);
  const man = await credsManifest();
  const d = diff(disk, man);
  const churn = (
    await sh("cat /tmp/m4b-churn.json 2>/dev/null; echo; cat /tmp/m4b-churn.err 2>/dev/null | tail -3")
  ).stdout;
  const s = await status();
  const row = {
    n,
    at: iso(now()),
    probeMs: seenMs,
    disk: d.disk,
    store: d.store,
    onlyDisk: d.onlyDisk.length,
    onlyStore: d.onlyStore.length,
    shaDiff: d.shaDiff.length,
    state: s.state,
    gen: s.gen?.gen,
    churn: churn.slice(0, 300),
  };
  probes.push(seenMs);
  samples.push(row);
  note("sample", row);
}
await sh("touch /tmp/m4b-churn.stop");
await sleep(SETTLE_S * 1000);
const disk = await nodeAs(DISK, [STATE], 60_000);
const man = await credsManifest();
const d = diff(disk, man);
const churn = (await sh("cat /tmp/m4b-churn.json; echo; wc -l < /tmp/m4b-churn.err 2>/dev/null || echo 0"))
  .stdout;
const credRows = await ops("GET", "/ops/status");
const al = (await ops("GET", "/ops/alerts")).json?.alerts ?? [];
note("final", { d, churn });
const okProbes = probes.filter((x) => x !== null);
result(KEY, {
  churnMin: CHURN_MIN,
  window: { from: iso(t0), to: iso(now()) },
  churn: (() => {
    try {
      return JSON.parse(churn.split("\n")[0]);
    } catch {
      return churn.slice(0, 300);
    }
  })(),
  probes: {
    n: probes.length,
    seenMs: probes,
    maxMs: Math.max(...okProbes),
    missed: probes.length - okProbes.length,
  },
  final: {
    disk: d.disk,
    store: d.store,
    onlyDisk: d.onlyDisk.slice(0, 20),
    onlyStore: d.onlyStore.slice(0, 20),
    shaDiff: d.shaDiff.slice(0, 20),
    modeDiff: d.modeDiff.slice(0, 20),
    storeSeq: man.seq,
  },
  samples,
  alerts: al
    .filter((a) => /^creds|credsync/.test(a.class))
    .map((a) => ({ class: a.class, detail: a.last_detail ?? a.detail, count: a.count })),
  stateAtEnd: credRows.json?.state,
  checks: {
    churnRan: /"writes":\d{3,}/.test(churn),
    storeEqualsDisk:
      d.onlyDisk.length === 0 &&
      d.onlyStore.length === 0 &&
      d.shaDiff.length === 0 &&
      d.modeDiff.length === 0 &&
      d.disk > 0,
    probeEveryTime: okProbes.length === probes.length && probes.length > 0,
    probeWithin30s: okProbes.length > 0 && Math.max(...okProbes) <= 30_000,
  },
});
