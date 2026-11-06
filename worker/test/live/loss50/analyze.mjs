// Summary of a loss50 run from its raw files: $RAW/loss50-kills.jsonl, loss50-updates.jsonl, ring.jsonl.
// Writes $RAW/loss50.json (result). Corrections over the per-kill lines:
//  - kill → running from the ring: the first `→ running` row after the first `→ starting` row after the kill;
//  - a kill counts for the loss bounds only when the writer ran (the pre-kill probe saw a row ≤ 5 s old);
//  - replies per update = sendMessage calls to its chat (one chat per update).
// usage: node analyze.mjs [N]   (env RAW, RING as loss-lib.mjs)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { det, RAW, result, ringSince, rtRows } from "../loss-lib.mjs";

const B = { sqlMs: 3000, nmMs: 15 * 60_000, credsMs: 30_000 };
const BULK_BOUND_MS = Number(process.env.BULK_BOUND_MS ?? 60 * 60_000);
const lines = (f) =>
  existsSync(join(RAW, f))
    ? readFileSync(join(RAW, f), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

export async function analyze(n = null) {
  const kills = lines("loss50-kills.jsonl");
  const updates = lines("loss50-updates.jsonl");
  const t0 = Math.min(...kills.map((k) => Date.parse(k.kill.at)), ...updates.map((u) => u.t0));
  const ev = await ringSince(t0 - 5 * 60_000);
  const rows = rtRows(ev);
  const sm = ev.filter((e) => e.src === "telegram" && e.kind === "sendMessage");
  const byChat = new Map();
  for (const e of sm) {
    const c = String(det(e)?.chatId);
    byChat.set(c, (byChat.get(c) ?? 0) + 1);
  }
  const perUpdate = updates.map((u) => ({
    kill: u.kill,
    chat: u.chat,
    ack: u.status,
    replies: byChat.get(String(u.chat)) ?? 0,
  }));
  for (const k of kills) {
    const at = Date.parse(k.kill.at);
    const st = rows.find((x) => x.at > at && x.to === "starting");
    const run = st ? rows.find((x) => x.at > st.at && x.to === "running") : null;
    k.killToRestartMs = st ? st.at - at : null;
    k.killToRunningMs = run ? run.at - at : null;
    const b = k.sql.before;
    k.writerActive = !!(b?.maxTs && k.probeNow && k.probeNow - b.maxTs <= 5000) || k.writerActive === true;
    if (k.writerActive === undefined || k.probeNow === undefined)
      k.writerActive = !!(b?.maxTs && at - b.maxTs <= 8000);
    const us = perUpdate.filter((u) => u.kill === k.i);
    k.tg = {
      sent: us.length,
      acked: us.filter((u) => u.ack === 200).length,
      zero: us.filter((u) => u.replies === 0).length,
      twice: us.filter((u) => u.replies >= 2).length,
    };
  }
  const valid = kills.filter((k) => k.writerActive);
  const col = (a, f) => a.map(f).filter((x) => x !== null && x !== undefined);
  const max = (a) => (a.length ? Math.max(...a) : null);
  const pct = (a, p) => {
    const s2 = [...a].sort((x, y) => x - y);
    return s2.length ? s2[Math.min(s2.length - 1, Math.floor((p / 100) * s2.length))] : null;
  };
  const sqlW = col(valid, (k) => k.sql.windowMs);
  const nmW = col(valid, (k) => k.nm.windowMs);
  const crW = col(valid, (k) => k.creds.windowMs);
  const wsW = col(valid, (k) => k.ws.windowMs);
  const run = col(kills, (k) => k.killToRunningMs);
  const rowsLost = col(valid, (k) => k.sql.rowsLostMin);
  const relinks = kills.filter((k) => k.creds.relink).length;
  return result("loss50", {
    n: kills.length,
    writerActive: valid.length,
    writerInactive: kills.filter((k) => !k.writerActive).map((k) => k.i),
    bounds: { ...B, bulkMs: BULK_BOUND_MS },
    sqlWindowMs: { max: max(sqlW), p50: pct(sqlW, 50), p95: pct(sqlW, 95) },
    sqlRowsLostMin: { max: max(rowsLost), sum: rowsLost.reduce((a, b) => a + b, 0) },
    nmWindowMs: { max: max(nmW), p50: pct(nmW, 50) },
    credsWindowMs: { max: max(crW), p50: pct(crW, 50) },
    credsFilesMissing: col(kills, (k) => k.creds.diff.missing).reduce((a, b) => a + b, 0),
    credsFilesChanged: col(kills, (k) => k.creds.diff.changed).reduce((a, b) => a + b, 0),
    relinks,
    wsWindowMs: { max: max(wsW), p50: pct(wsW, 50) },
    killToRunningMs: { p50: pct(run, 50), max: max(run), min: run.length ? Math.min(...run) : null },
    timeouts: kills.filter((k) => k.timeout).length,
    plans: Object.fromEntries(
      [...new Set(kills.map((k) => k.plan))].map((p) => [p, kills.filter((k) => k.plan === p).length]),
    ),
    replayedPerBoot: kills.map((k) => k.replayed),
    telegram: {
      updates: perUpdate.length,
      acked: perUpdate.filter((u) => u.ack === 200).length,
      zero: perUpdate.filter((u) => u.replies === 0).length,
      once: perUpdate.filter((u) => u.replies === 1).length,
      twicePlus: perUpdate.filter((u) => u.replies >= 2).length,
    },
    kills: kills.map((k) => ({
      i: k.i,
      writer: k.writerActive,
      plan: k.plan,
      upMs: k.upMs,
      runMs: k.killToRunningMs,
      rows: k.sql.rowsLostMin,
      sqlMs: k.sql.windowMs,
      nmMs: k.nm.windowMs,
      credsMs: k.creds.windowMs,
      credsMissing: k.creds.diff.missing,
      credsChanged: k.creds.diff.changed,
      relink: k.creds.relink,
      wsMs: k.ws.windowMs,
      ckpts: k.checkpointsInPeriod.length,
      replayed: k.replayed,
      tg: k.tg,
      arch: k.archInFlight ?? null,
    })),
    checks: {
      n: n === null || kills.length >= n,
      sqlLe3s: sqlW.length === valid.length && sqlW.every((x) => x <= B.sqlMs),
      nmLe15min: nmW.length === valid.length && nmW.every((x) => x <= B.nmMs),
      credsLe30s: crW.length === valid.length && crW.every((x) => x <= B.credsMs),
      relinks0: relinks === 0,
      bulkLeBound: wsW.length === valid.length && wsW.every((x) => x <= BULK_BOUND_MS),
      noLostReply: perUpdate.every((u) => u.ack !== 200 || u.replies >= 1),
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await analyze(process.argv[2] ? Number(process.argv[2]) : null);
}
