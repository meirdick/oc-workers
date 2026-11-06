// Drill backup-ttl (spec 08 §15.3 snapshot TTL, §11.2 ttlGuard; plan §6.1: a snapshot handle past its TTL is
// never planned; the boot takes image + archive + gen). TTL tracking: ttlEnd = max(created, lastRestored) + TTL.
// The plan uses a snapshot while ttlEnd − 1 d > now; the asleep alarm wakes at ttlEnd − 2 d (ttlGuard), so a
// sleeping install refreshes its snapshot before the plan would drop it. The test install runs
// snapshotTtlMs = 2 d + GUARD_MIN, so the guard fires GUARD_MIN after the sleep snapshot. (A TTL ≤ 2 d gives a
// wake at once after each sleep: sleep/wake loop, seen live with 1 d + 25 min.)
// Steps:
//   guard    write a workspace marker + DB rows, force sleep, no owner call: the Runtime DO wakes by itself at
//            snapshot + GUARD_MIN (reason wake:maint, ttl), boots from that snapshot, marker and rows are back.
//   handle   (expired platform handle) force sleep (fresh snapshot, inside TTL), arm snapshot-not-found for
//            MISSES start() calls, wake: the op replans to image + archive + gen within the replan cap.
// env: U, T; GUARD_MIN (default 12). usage: node run.mjs guard|handle
import {
  archives,
  DB,
  fault,
  forceSleep,
  iso,
  nodeAs,
  note,
  now,
  ops,
  rawFile,
  result,
  ring,
  STATE,
  sleep,
  status,
  waitState,
} from "../backup/lib.mjs";

const KEY = "backup-ttl";
rawFile(KEY);
const step = process.argv[2];
const GUARD_MIN = Number(process.env.GUARD_MIN ?? 12);
const MISSES = Number(process.env.MISSES ?? 5);

const MARK = `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const tag = process.argv[2];
fs.writeFileSync(${JSON.stringify(`${STATE}/workspace/`)} + "m4b-ttl-" + tag + ".md", "m4b ttl " + tag + "\\n");
const db = new DatabaseSync(${JSON.stringify(DB)});
db.exec("PRAGMA busy_timeout=5000");
db.exec("CREATE TABLE IF NOT EXISTS m4b_ttl(tag TEXT PRIMARY KEY, ts INTEGER)");
db.prepare("INSERT OR REPLACE INTO m4b_ttl(tag, ts) VALUES (?, ?)").run(tag, Date.now());
db.close();
console.log(JSON.stringify({ ok: true, tag, at: Date.now() }));
`;
const CHECK = `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const tag = process.argv[2];
const ws = fs.existsSync(${JSON.stringify(`${STATE}/workspace/`)} + "m4b-ttl-" + tag + ".md");
let row = null;
try { const db = new DatabaseSync(${JSON.stringify(DB)}, { readOnly: true }); row = db.prepare("SELECT * FROM m4b_ttl WHERE tag = ?").get(tag) ?? null; db.close(); } catch (e) { row = { err: String(e) }; }
console.log(JSON.stringify({ ws, row }));
`;

async function wake() {
  const t = now();
  const r = await ops("POST", "/ops/wake?wait=1");
  const w =
    r.json?.state === "running" ? { v: await status() } : await waitState("running", 10 * 60_000, 3000);
  return { ms: now() - t, s: w.v ?? (await status()), status: r.status };
}

const t0 = now();
const s0 = await status();
if (s0.state !== "running") {
  await ops("POST", "/ops/wake?wait=1");
  await waitState("running", 10 * 60_000);
}
const tag = `${step}-${t0}`;
const mk = await nodeAs(MARK, [tag]);
note("mark", mk);
await sleep(15_000); // Litestream lag + the gen upload
const sleptMs = await forceSleep(15 * 60_000);
const sAsleep = await status();
note("asleep", { sleptMs, gen: sAsleep.gen?.gen, sleep: sAsleep.rt?.sleep });
const archBefore = (await archives(5)).archives?.[0];

let guardWake = null;
if (step === "guard") {
  // No owner call: wait for the Runtime DO's own alarm.
  const ta = now();
  const w = await waitState(["starting", "running"], (GUARD_MIN + 8) * 60_000, 10_000);
  guardWake = {
    leftAsleepAt: w.v ? iso(now()) : null,
    afterMin: +((now() - ta) / 60_000).toFixed(1),
    timeout: !!w.timeout,
  };
  note("guard-wake", guardWake);
} else if (step === "handle") {
  const f = await fault("snapshot-not-found", { count: MISSES });
  note("fault", f.json);
} else throw new Error("usage: run.mjs guard|handle");

const tw = now();
const w =
  step === "guard"
    ? {
        ...(await (async () => {
          const t = now();
          const r = await waitState("running", 10 * 60_000, 3000);
          return { ms: now() - t, s: r.v ?? (await status()) };
        })()),
      }
    : await wake();
const s1 = w.s;
const chk = s1.state === "running" ? await nodeAs(CHECK, [tag]) : null;
if (step === "handle") await fault("clear");
const ev = await ring(tw);
const misses = ev.filter((e) => e.src === "snapshot" && /miss/.test(e.kind)).length;
const plan = s1.gen?.plan ?? {};
note("woke", { ms: w.ms, state: s1.state, plan, chk });
const wakeRow = ev.find((e) => e.src === "rt" && e.kind === "row" && e.d?.row === 44);
const startRing = ev
  .filter((e) => /wake|start/.test(e.kind))
  .slice(0, 8)
  .map((e) => ({ at: iso(e.at), src: e.src, kind: e.kind, d: e.d }));
result(`${KEY}${step === "handle" ? "-handle" : ""}`, {
  step,
  guardMin: GUARD_MIN,
  sleepRec: sAsleep.rt?.sleep,
  plannedWakeAt: iso(sAsleep.rt?.sleep?.wakeAt),
  guardWake,
  startRing,
  marker: mk,
  asleepAt: iso(t0 + (sleptMs ?? 0)),
  asleepForMin: +((tw - (t0 + (sleptMs ?? 0))) / 60_000).toFixed(1),
  sleepGen: sAsleep.gen?.gen,
  newestArchiveBeforeWake: archBefore ? { id: archBefore.id, created: iso(archBefore.created_at) } : null,
  wakeMs: w.ms,
  state: s1.state,
  gen: s1.gen?.gen,
  planKind: s1.gen?.planKind,
  plan,
  ladder: s1.ladder,
  restored: chk,
  misses,
  ringKinds: [...new Set(ev.map((e) => `${e.src}/${e.kind}`))].slice(0, 60),
  checks: {
    running: s1.state === "running",
    ...(step === "guard"
      ? {
          wakeAtIsGuard:
            !!sAsleep.rt?.sleep?.wakeAt &&
            Math.abs(sAsleep.rt.sleep.wakeAt - (t0 + (sleptMs ?? 0) + GUARD_MIN * 60_000)) < 3 * 60_000,
          wokeByItself: !!guardWake && !guardWake.timeout && guardWake.afterMin >= GUARD_MIN - 3,
          bootFromSnapshot: plan.rootfs === "snapshot",
        }
      : {
          rootfsImage: plan.rootfs === "image" && !plan.snapshotId,
          archivePlanned: !!plan.archiveId,
          sqliteFromGen: plan.sqlite === "gen",
        }),
    workspaceBack: chk?.ws === true,
    rowsBack: !!chk?.row?.ts,
    ...(step === "handle" ? { missed: misses >= 1 } : {}),
    noWakeLoop: !wakeRow || step !== "guard" || wakeRow.at - (t0 + (sleptMs ?? 0)) > 60_000,
  },
});
