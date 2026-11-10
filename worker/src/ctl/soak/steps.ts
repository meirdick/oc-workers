// Soak step types. Each handler is a small state machine: it runs from `x.phase`, mutates `x.d` (persisted by
// the runner) and returns `wait` (call me again) or `done` (checks and measures). Handlers never block longer
// than one exec call; the Control DO alarm calls them again. Assertions are computed here, in the Worker, from
// status, ring/tables, R2 and probes of the container.

import type { Handler } from "./lib";
import {
  BOUND,
  exec,
  finish,
  genOf,
  HOUR,
  MIN,
  measure,
  nodeBg,
  nodeJs,
  POISON_WATCH_MS,
  pct,
  probe,
  SEC,
  type StepCtx,
  sh,
  wait,
} from "./lib";
import {
  CHURN,
  CREDS_DISK,
  FILL_DIR,
  NEW_AGENT_DB,
  PITR_COUNT,
  PITR_WRITE,
  POISON,
  procPat,
  SCRUB_SH,
  USER_VERSION,
  WRITER,
} from "./scripts";
import type { Measure } from "./types";

type Any = Record<string, any>;

/** Bring the install to `running`: wake or start as needed, at most one nudge per 30 s. */
async function ensureUp(x: StepCtx, tag = "up"): Promise<{ ok: boolean; s: Any }> {
  const s = await x.port.status();
  if (s.state === "running") return { ok: true, s };
  const key = `${tag}NudgeAt`;
  if (x.now - (x.d[key] ?? 0) >= 30_000) {
    if (["asleep", "new", "asleep-unconfirmed"].includes(s.state)) await x.port.ops("wake");
    else if (s.state === "stopped") await x.port.ops("start");
    x.d[key] = x.now;
  }
  return { ok: false, s };
}

/**
 * Steps that count replies need a Telegram channel. With no bot token the gateway has no Telegram route: every
 * update stays `pending` until inbox.deadHours (23 h), nothing is replied, and rule 5 (pending rows) refuses
 * every sleep in that time (M7 soak: telegram-60, drill-a, s4-500). Fail at once with the fix.
 */
const NO_TELEGRAM = {
  checks: { telegramChannel: false },
  data: { why: "no bot token: ochost channels add telegram" },
};
const noTelegram = (x: StepCtx) => !x.port.c.secrets.botToken;

const alertCounts = async (x: StepCtx): Promise<Record<string, number>> => {
  const r = await x.port.ops("alerts", "GET");
  const list: Any[] = r.body?.alerts ?? [];
  return Object.fromEntries(list.map((a) => [String(a.class), Number(a.count ?? 0)]));
};
const alertDelta = (a: Record<string, number>, b: Record<string, number>, re: RegExp) =>
  Object.keys(b).filter((k) => re.test(k) && (b[k] ?? 0) > (a[k] ?? 0));

const lastGenRow = (x: StepCtx): Any | null =>
  x.port.c.db.one<Any>("SELECT gen, reason, plan_kind, state FROM gens ORDER BY gen DESC LIMIT 1");

const newGenRunning = (s: Any, g0: number | null) =>
  s.state === "running" && genOf(s) !== null && genOf(s) !== g0;

const iso = (t: number) => new Date(t).toISOString();

// ---------------------------------------------------------------- generic steps

const note: Handler = async (x) =>
  finish({ skipped: String(x.p.why ?? "not scripted"), data: { why: x.p.why } });

const waitStep: Handler = async (x) => {
  x.d.until ??= x.now + Number(x.p.ms ?? MIN);
  if (x.now < x.d.until) return wait(Math.min(15_000, x.d.until - x.now));
  return finish({ checks: { waited: true }, data: { ms: x.p.ms } });
};

/** Hold the install awake (settings sleep.mode off) or give the sleep mode back. */
const awake: Handler = async (x) => {
  const c = x.port.c;
  const cur = c.settings().sleep.mode;
  if (x.p.on !== false) {
    if (cur !== "off") {
      if (!c.db.meta("soak:sleepWas")) c.db.setMeta("soak:sleepWas", cur);
      await x.port.ops("settings", "POST", { set: { "sleep.mode": "off" }, source: "soak" });
    }
  } else {
    const was = c.db.meta("soak:sleepWas");
    if (was) {
      await x.port.ops("settings", "POST", { set: { "sleep.mode": was }, source: "soak" });
      c.db.delMeta("soak:sleepWas");
    }
  }
  return finish({ checks: { set: true }, data: { was: cur } });
};

const up: Handler = async (x) => {
  const u = await ensureUp(x);
  if (!u.ok) return wait(5000);
  return finish({ checks: { running: true }, data: { gen: genOf(u.s) } });
};

const writer: Handler = async (x) => {
  const u = await ensureUp(x);
  if (!u.ok) return wait(5000);
  const life = Number(x.p.lifeMs ?? 30 * MIN);
  x.d.tries = (x.d.tries ?? 0) + 1;
  const ok = await nodeBg(x.port, "writer", WRITER, [`w${x.step.idx}`, life]);
  if (!ok && x.d.tries < 3) return wait(5000);
  x.port.c.db.setMeta(`soak:ref:${x.plan.name}`, x.now);
  return finish({ checks: { started: ok }, data: { lifeMs: life } });
};

// ---------------------------------------------------------------- kill (sqlite-loss, non-managed, crash-loop)

/**
 * Wake to running, optional writer, wait `upMs`, optional owner archive until it runs, one fault, wait for the
 * restart, probe. Loss windows are the newest surviving write against the newest write before the kill (`ref`):
 * the kill time when the writer ran, else the last time any writer ran in this plan (crash-loop lives without
 * a writer). Test timers and one container clock: the DO and the container share Cloudflare time.
 */
const kill: Handler = async (x) => {
  const { port, d, p } = x;
  const fault = String(p.fault ?? "sigkill");
  // SIGTERM to the main process is the platform drain (plan §4.5): ocsup drains, takes the final snapshot and
  // exits 0, so a new gen follows. Only `abort` (deploy stand-in) keeps the gen. Plans set `newGen` per step.
  const newGen = typeof p.newGen === "boolean" ? p.newGen : fault === "sigkill" || fault === "destroy";
  const upMs = Number(p.upMs ?? 60 * SEC);
  const refKey = `soak:ref:${x.plan.name}`;
  switch (x.phase) {
    case "start": {
      const u = await ensureUp(x);
      if (!u.ok) return wait(5000, "start");
      d.g0 = genOf(u.s);
      if (p.writer !== false) {
        d.wtries = (d.wtries ?? 0) + 1;
        const ok = await nodeBg(port, "writer", WRITER, [`k${x.step.idx}`, upMs + 180 * SEC]);
        if (!ok && d.wtries < 3) return wait(5000, "start");
        d.writer = ok;
      }
      d.upAt = x.now + upMs;
      return wait(0, "up");
    }
    case "up":
      if (x.now < d.upAt) return wait(Math.min(5000, d.upAt - x.now), "up");
      return wait(0, p.arch ? "arm" : "fire");
    case "arm": {
      if (!d.archReq) {
        const r = await port.ops("archive", "POST", { reason: "owner" });
        d.archReq = r.body?.request?.id ?? "?";
        d.armAt = x.now;
      }
      const a = await port.ops("archive", "GET");
      const req = a.body?.request;
      if (req?.id === d.archReq && req?.state === "running") d.archSeen = true;
      if (d.archSeen || x.now - d.armAt > 3 * MIN) return wait(0, "fire");
      return wait(2000, "arm");
    }
    case "fire": {
      d.pre = await probe(port);
      const params: Any =
        fault === "signal" ? { sig: p.sig ?? 15 } : fault === "abort" ? { ms: p.ms ?? 2000 } : {};
      const r = await port.rtFault(fault, params);
      d.killAt = port.c.now();
      d.faultOk = r.ok !== false;
      d.faultErr = r.error ?? null;
      if (d.writer !== false && p.writer !== false) port.c.db.setMeta(refKey, d.killAt);
      if (!d.faultOk) return finish({ checks: { faultOk: false }, data: { error: d.faultErr } });
      return wait(newGen ? 5000 : 0, "restart");
    }
    case "restart": {
      const s = await port.status();
      if (newGen) {
        if (!newGenRunning(s, d.g0)) return wait(5000, "restart");
        d.runMs = x.now - d.killAt;
        d.gen1 = genOf(s);
        d.plan = s.gen?.planKind ?? null;
        d.settleAt = x.now + 10 * SEC;
        return wait(0, "settle");
      }
      if (x.now - d.killAt < Number(p.settleMs ?? 90 * SEC) || s.state !== "running")
        return wait(5000, "restart");
      d.runMs = x.now - d.killAt;
      d.gen1 = genOf(s);
      return wait(0, "post");
    }
    case "settle":
      if (x.now < d.settleAt) return wait(2000, "settle");
      return wait(0, "post");
    default: {
      const post = await probe(port);
      const ref = port.c.db.metaNum(refKey, d.killAt);
      const win = (v: any) => (typeof v?.maxTs === "number" ? ref - v.maxTs : null);
      const w = {
        sql: win(post.sql),
        nm: win(post.nm),
        ws: typeof post.ws?.ts === "number" ? ref - post.ws.ts : null,
      };
      const rowsLost =
        typeof d.pre?.sql?.maxId === "number" && typeof post.sql?.maxId === "number"
          ? Math.max(0, d.pre.sql.maxId - post.sql.maxId)
          : null;
      const data = {
        fault,
        g0: d.g0,
        gen1: d.gen1,
        runMs: d.runMs,
        planKind: d.plan ?? null,
        killAt: d.killAt,
        refAt: ref,
        windowsMs: w,
        rowsLost,
        pre: d.pre,
        post,
        archSeen: d.archSeen ?? null,
      };
      if (!newGen) {
        const grew = typeof post.sql?.maxId === "number" && post.sql.maxId > (d.pre?.sql?.maxId ?? 0);
        return finish({
          checks: {
            faultOk: true,
            running: true,
            genKept: d.gen1 === d.g0,
            writerSurvived: p.writer === false || grew,
          },
          data,
        });
      }
      const items = (p.items ?? {}) as Record<string, string>;
      const ms: Measure[] = [];
      const clamp = (v: number | null) => (v === null ? null : Math.max(0, v));
      if (items.sql && clamp(w.sql) !== null)
        ms.push(
          measure(
            items.sql,
            "sqlite window",
            (clamp(w.sql) as number) / 1000,
            "s",
            "≤ 3 s per kill",
            BOUND.sqliteMs / 1000,
          ),
        );
      if (items.nm && clamp(w.nm) !== null)
        ms.push(
          measure(
            items.nm,
            "shadow age",
            (clamp(w.nm) as number) / 1000,
            "s",
            "≤ 15 min",
            BOUND.nonManagedMs / 1000,
          ),
        );
      if (items.ws && clamp(w.ws) !== null)
        ms.push(
          measure(items.ws, "bulk age", (clamp(w.ws) as number) / 1000, "s", "≤ 60 min", BOUND.bulkMs / 1000),
        );
      if (items.rows && rowsLost !== null)
        ms.push(measure(items.rows, "rows lost", rowsLost, "rows", "info (20 rows/s)"));
      if (items.run && d.runMs) ms.push(measure(items.run, "kill to running", d.runMs / 1000, "s", "info"));
      return finish({
        checks: {
          faultOk: true,
          restarted: d.gen1 !== null && d.gen1 !== d.g0,
          probeOk: typeof post.sql?.maxTs === "number" || p.writer === false,
          ...(p.arch ? { archiveInFlight: d.archSeen === true } : {}),
        },
        measures: ms,
        data,
      });
    }
  }
};

// ---------------------------------------------------------------- telegram-60

/** n fake updates from n chats; every killEvery-th is killed between accept and send; unreplied must be 0. */
const tgBatch: Handler = async (x) => {
  const { port, d, p } = x;
  const n = Number(p.n ?? 60);
  const killEvery = Number(p.killEvery ?? 10);
  const kills = Number(p.kills ?? 6);
  const gap = Number(p.gapMs ?? 5 * SEC);
  d.i ??= 0;
  d.killed ??= 0;
  d.acked ??= 0;
  d.chat0 ??= 760_000_000 + (Math.floor(x.now / 1000) % 100_000) * 100;
  const db = port.c.db;
  switch (x.phase) {
    case "start":
      if (noTelegram(x)) return finish(NO_TELEGRAM);
      return (await ensureUp(x)).ok ? wait(0, "inject") : wait(5000, "start");
    case "inject": {
      if (x.now < (d.nextAt ?? 0)) return wait(Math.min(2000, d.nextAt - x.now), "inject");
      if (d.i >= n) {
        d.settleUntil = x.now + Number(p.settleMs ?? 10 * MIN);
        return wait(0, "settle");
      }
      const s = await port.status();
      if (s.state !== "running") return wait(5000, "inject");
      const chat = d.chat0 + d.i;
      const slow = d.killed < kills && (d.i + 1) % killEvery === 0;
      const text = `soak tg ${d.i}${slow ? " m4b-slow" : ""}`;
      const r = await port.inject(chat, text, { plan: x.plan.name, step: x.spec.id });
      if (r.status === 200) d.acked++;
      d.i++;
      d.nextAt = x.now + gap;
      if (slow) {
        d.killChat = chat;
        d.g0 = genOf(s);
        d.armAt = x.now;
        return wait(1000, "kill");
      }
      return wait(0, "inject");
    }
    case "kill": {
      // accepted by the gateway (inbox row accepted) and not replied yet; kill then (the slow LLM keeps the window open)
      const row = db.one<Any>(
        "SELECT state, replied_at FROM inbox WHERE chat_id = ? ORDER BY received_at DESC LIMIT 1",
        String(d.killChat),
      );
      const accepted = row && (row.state === "accepted" || row.state === "replicated");
      if (!accepted && x.now - d.armAt < 90 * SEC) return wait(1000, "kill");
      const sends = db.one<Any>("SELECT n FROM soak_send WHERE chat_id = ?", String(d.killChat))?.n ?? 0;
      d.kills ??= [];
      d.kills.push({ chat: d.killChat, accepted: !!accepted, sendsBefore: sends });
      const r = await port.rtFault("sigkill");
      d.killed++;
      d.killErr = r.ok === false ? r.error : null;
      return wait(5000, "restart");
    }
    case "restart": {
      const s = await port.status();
      if (!newGenRunning(s, d.g0)) return wait(5000, "restart");
      return wait(0, "inject");
    }
    default: {
      const rows = db.all<Any>(
        "SELECT c.chat_id, COALESCE(s.n, 0) AS n FROM soak_chat c LEFT JOIN soak_send s ON s.chat_id = c.chat_id WHERE c.plan = ? AND c.step = ?",
        x.plan.name,
        x.spec.id,
      );
      const unreplied = rows.filter((r) => r.n === 0).length;
      if (unreplied > 0 && x.now < d.settleUntil) return wait(10_000, "settle");
      const dup = rows.reduce((a, r) => a + Math.max(0, r.n - 1), 0);
      const ks = (d.kills ?? []) as Any[];
      return finish({
        checks: {
          allAcked: d.acked === n,
          killsDone: d.killed === kills,
          killsBeforeSend: ks.every((k) => k.sendsBefore === 0),
          unreplied0: unreplied === 0,
        },
        measures: [
          measure("telegram-60", "unreplied", unreplied, "updates", "0 unreplied", 0),
          measure("telegram-60", "duplicate replies", dup, "messages", "counted, no bound"),
        ],
        data: { updates: rows.length, acked: d.acked, kills: ks, unreplied, duplicates: dup },
      });
    }
  }
};

// ---------------------------------------------------------------- sleep/wake cycles (s4-500)

/** `n` cycles: force sleep, one update wakes it, wait for the reply. Lost and repeated replies per step. */
const cycles: Handler = async (x) => {
  const { port, d, p } = x;
  const n = Number(p.n ?? 10);
  d.done ??= 0;
  d.rows ??= [];
  d.chat0 ??= 770_000_000 + (Math.floor(x.now / 1000) % 100_000) * 100 + x.step.idx * 1000;
  const chat = d.chat0 + d.done;
  const s = await port.status();
  switch (x.phase) {
    case "start": {
      if (d.done === 0 && noTelegram(x)) return finish(NO_TELEGRAM);
      if (d.done >= n) return wait(0, "end");
      if (s.state !== "running" && s.state !== "asleep") {
        await ensureUp(x);
        return wait(5000, "start");
      }
      d.t = x.now;
      return wait(0, "sleep");
    }
    case "sleep":
      if (s.state === "asleep") {
        d.sleepMs = x.now - d.t;
        return wait(0, "inject");
      }
      if (x.now - d.t > 8 * MIN)
        return finish({
          checks: { sleptEveryCycle: false },
          data: { stuckAt: d.done, state: s.state, refused: d.refused ?? {}, inbox: s.inbox ?? null },
        });
      if (s.state === "running" && x.now - (d.sleepAt ?? 0) >= 15_000) {
        // Keep the gate's answer (rule, e.g. "5:inbox"): M7 soak dropped it and 50 steps failed with no reason.
        const r = await port.ops("sleep", "POST", {}, { force: "1" });
        if (r.status !== 200) {
          const why = String(r.body?.reason ?? r.body?.error ?? r.status);
          d.refused = { ...(d.refused ?? {}), [why]: (d.refused?.[why] ?? 0) + 1 };
        }
        d.sleepAt = x.now;
      }
      return wait(3000, "sleep");
    case "inject": {
      const t0 = port.c.now();
      const r = await port.inject(chat, `soak s4 ${x.step.idx}.${d.done}`, {
        plan: x.plan.name,
        step: x.spec.id,
      });
      d.ack = port.c.now() - t0;
      d.ackStatus = r.status;
      d.t = x.now;
      return wait(2000, "run");
    }
    case "run":
      if (s.state === "running") {
        d.runMs = x.now - d.t;
        return wait(0, "reply");
      }
      if (x.now - d.t > 10 * MIN) return finish({ checks: { woke: false }, data: { atCycle: d.done } });
      return wait(2000, "run");
    case "reply": {
      const n1 = port.c.db.one<Any>("SELECT n FROM soak_send WHERE chat_id = ?", String(chat))?.n ?? 0;
      if (n1 === 0 && x.now - d.t < 10 * MIN) return wait(2000, "reply");
      d.rows.push([d.ack, d.runMs, x.now - d.t, d.ackStatus]);
      d.done++;
      return wait(0, "start");
    }
    default: {
      const rows = port.c.db.all<Any>(
        "SELECT c.chat_id, COALESCE(s.n, 0) AS n FROM soak_chat c LEFT JOIN soak_send s ON s.chat_id = c.chat_id WHERE c.plan = ? AND c.step = ?",
        x.plan.name,
        x.spec.id,
      );
      const lost = rows.filter((r) => r.n === 0).length;
      const repeated = rows.filter((r) => r.n >= 2).length;
      const acks = (d.rows as number[][]).map((r) => r[0] ?? 0);
      const runs = (d.rows as number[][]).map((r) => r[1] ?? 0);
      return finish({
        checks: { allCycles: d.done === n, allAcked200: (d.rows as number[][]).every((r) => r[3] === 200) },
        measures: [
          measure("s4-lost-replies", "lost replies", lost, "replies", "0 lost", 0),
          measure("s4-repeated-replies", "repeated replies", repeated, "replies", "0 on clean cycles", 0),
          measure("s4-ack", "ack max", Math.max(0, ...acks), "ms", "info"),
          measure("s4-wake", "ack to running p50", (pct(runs, 50) ?? 0) / 1000, "s", "info"),
        ],
        data: { cycles: d.done, rows: d.rows },
      });
    }
  }
};

/** R2 bytes, snapshot sizes and rebase count after the cycles. */
/** R2 bytes of the install (the soak's own prefixes left out). */
async function installR2(x: StepCtx) {
  const u = await x.port.ctlFault("r2-usage");
  const by: Record<string, { n: number; bytes: number }> = u.body?.by ?? {};
  const own = ["results", "soak-resume", "soak-hold"];
  const bytes = Object.entries(by)
    .filter(([k]) => !own.includes(k))
    .reduce((a, [, v]) => a + v.bytes, 0);
  return { ok: u.status === 200, bytes, by };
}
const r2StartKey = (plan: string) => `soak:r2start:${plan}`;

/** First step of s4-500: R2 bytes before the cycles, for the growth measure in s4-final. */
const r2Mark: Handler = async (x) => {
  const r = await installR2(x);
  if (r.ok) x.port.c.db.setMeta(r2StartKey(x.plan.name), r.bytes);
  return finish({ checks: { usageRead: r.ok }, data: { r2Bytes: r.bytes, byPrefix: r.by } });
};

const s4Final: Handler = async (x) => {
  const db = x.port.c.db;
  const u0 = await installR2(x);
  const by = u0.by;
  const r2 = u0.bytes;
  // Owner decision (M7 soak): the bound is growth over the plan ("gen GC keeps R2 bytes flat", addendum S4),
  // not R2 over state (that mixes in every gen of earlier plans; M7 6.28x, M4 2.65-4.85x). Ratio kept as info.
  const start = db.metaNum(r2StartKey(x.plan.name), 0);
  const snaps = db.all<Any>(
    "SELECT id, size, kind, chain_base, created_at FROM snapshots ORDER BY created_at DESC LIMIT 60",
  );
  const newest = snaps[0]?.size ?? 0;
  const s = await x.port.status();
  const g = genOf(s);
  const gdb =
    g === null ? 0 : (db.one<Any>("SELECT COALESCE(SUM(bytes), 0) AS b FROM gendb WHERE gen = ?", g)?.b ?? 0);
  const state = Math.max(1, newest + gdb);
  const bases = new Set(snaps.map((r) => r.chain_base)).size;
  return finish({
    checks: { usageRead: u0.ok, r2StartRead: start > 0 },
    measures: [
      ...(start > 0
        ? [
            measure(
              "s4-r2-growth",
              "R2 bytes end over start",
              +(r2 / start).toFixed(2),
              "x",
              "≤ 1.5x start (guess)",
              1.5,
            ),
            measure("s4-r2-growth-mb", "R2 growth", +((r2 - start) / 1e6).toFixed(1), "MB", "info"),
          ]
        : []),
      measure("s4-r2-bytes", "R2 bytes over state", +(r2 / state).toFixed(2), "x", "info"),
      measure(
        "s4-rebases",
        "chain roots seen",
        Math.max(0, bases - 1),
        "rebases",
        "≥ 1 over 500 cycles",
        undefined,
        1,
      ),
    ],
    data: {
      r2Bytes: r2,
      r2StartBytes: start || null,
      byPrefix: by,
      stateBytes: state,
      snapshotSizes: snaps.map((r) => ({ at: r.created_at, size: r.size, kind: r.kind })),
      chainRoots: bases,
      note: "rebases = distinct chain_base among the newest 60 snapshots minus 1 (lower bound)",
    },
  });
};

// ---------------------------------------------------------------- creds churn (baileys-24h)

const sameCreds = async (x: StepCtx) => {
  const disk = await nodeJs(x.port, CREDS_DISK);
  const files: Record<string, string> = disk.files ?? {};
  const store = x.port.c.db.all<Any>(
    "SELECT path, sha256, deleted FROM creds WHERE path LIKE '%credentials/whatsapp/default/%'",
  );
  const live = new Map(
    store.filter((r) => !r.deleted).map((r) => [String(r.path).split("/").pop() as string, r.sha256]),
  );
  const missing = Object.keys(files).filter((f) => !live.has(f));
  const extra = [...live.keys()].filter((f) => !(f in files));
  const changed = Object.keys(files).filter((f) => live.has(f) && live.get(f) !== files[f]);
  return {
    ok: !disk.err && missing.length + extra.length + changed.length === 0,
    err: disk.err,
    disk: Object.keys(files).length,
    store: live.size,
    missing,
    extra,
    changed,
  };
};

/** Credential churn for `ms`; restarts it after a container restart. Hourly CredStore vs disk samples. */
const churnHold: Handler = async (x) => {
  const { port, d, p } = x;
  d.until ??= x.now + Number(p.ms ?? 24 * HOUR);
  d.restarts ??= 0;
  d.samples ??= [];
  const u = await ensureUp(x);
  if (!u.ok) return wait(10_000);
  const alive = await exec(
    port,
    ["sh", "-c", `pgrep -f ${procPat("soak-churn.mjs")} >/dev/null && echo alive || echo dead`],
    20_000,
  );
  if (!/alive/.test(String(alive.stdout))) {
    if (await nodeBg(port, "churn", CHURN, [Math.max(MIN, Math.min(d.until - x.now + MIN, 24 * HOUR + MIN))]))
      d.restarts++;
  }
  if (x.now - (d.sampleAt ?? 0) >= Number(p.sampleMs ?? HOUR)) {
    d.sampleAt = x.now;
    const c = await sameCreds(x);
    d.samples.push({
      at: iso(x.now),
      equal: c.ok,
      disk: c.disk,
      store: c.store,
      diff: c.missing.length + c.extra.length + c.changed.length,
    });
  }
  if (x.now < d.until) return wait(Math.min(5 * MIN, d.until - x.now));
  return finish({
    checks: { churned: d.restarts >= 1 },
    data: { restarts: d.restarts, samples: d.samples },
  });
};

/** Stop the churn, then CredStore must equal the disk within `settleMs` (creds bound 30 s). */
const credsCompare: Handler = async (x) => {
  if (!x.d.stopAt) {
    await sh(x.port, `pkill -f ${procPat("soak-churn.mjs")}; echo stopped`, 20_000);
    x.d.stopAt = x.now;
    return wait(5000);
  }
  const c = await sameCreds(x);
  if (!c.ok && x.now - x.d.stopAt < Number(x.p.settleMs ?? 90 * SEC)) return wait(5000);
  const lag = (x.now - x.d.stopAt) / 1000;
  // A lag exists only when the two sides met. Without that, the wait cap (settleMs) is not a lag (M7 soak:
  // 91 s reported while the creds dir did not exist).
  return finish({
    checks: { credStoreEqualsDisk: c.ok, credsOnDisk: c.disk > 0 },
    measures: c.ok
      ? [measure("baileys-24h", "CredStore lag after stop", lag, "s", "≤ 30 s", BOUND.credsMs / 1000)]
      : [],
    data: { ...c, waitedS: lag },
  });
};

// ---------------------------------------------------------------- scrub-live

const scrub: Handler = async (x) => {
  const u = await ensureUp(x);
  if (!u.ok) return wait(5000);
  const r = await sh(x.port, SCRUB_SH, 45_000);
  const rows = String(r.stdout ?? "")
    .split("\n")
    .filter((l) => l.startsWith("SCRUB "))
    .map((l) => {
      const [pid, name, env, mem] = l.slice(6).split("|");
      return { pid, name, envDenied: env !== "0", memDenied: mem !== "0" };
    });
  const gw = rows.filter((r1) => /gateway/.test(r1.name ?? ""));
  const io = rows.filter((r1) => /ocio/.test(r1.name ?? ""));
  return finish({
    checks: {
      foundGateway: gw.length > 0,
      foundOcio: io.length > 0,
      environDenied: rows.length > 0 && rows.every((r1) => r1.envDenied),
      memDenied: rows.length > 0 && rows.every((r1) => r1.memDenied),
    },
    data: { procs: rows },
  });
};

// ---------------------------------------------------------------- pitr-boot and drill D

const restoreAndWait = async (x: StepCtx, stamp: string) => {
  const r = await x.port.ops("restore", "POST", { sqlite: `pitr:${stamp}`, acceptLoss: true });
  x.d.restore = {
    status: r.status,
    lossWindowMs: r.body?.lossWindowMs ?? null,
    error: r.body?.error ?? null,
  };
  return r.status === 202;
};

/**
 * The running gen is the PITR boot. A PITR boot shows in status as planKind `gen` and plan.sqlite `gen`, never
 * `l5` or `pitr` (ctl/gens.ts sets plan_kind = plan.sqlite.kind), so the old test never held (M7 soak). The
 * Control DO records the boot in meta `l5Done` {bootGen} at onStarted.
 */
const bootFlag = (x: StepCtx, s: Any) => {
  const done = x.port.c.db.metaJson<{ bootGen?: number } | null>("l5Done", null);
  return done?.bootGen !== undefined && done.bootGen === genOf(s);
};

/** Write rows, note a time, write more, restore to the noted time: rows match, boot flag set. */
const pitr: Handler = async (x) => {
  const { port, d } = x;
  switch (x.phase) {
    case "start": {
      const u = await ensureUp(x);
      if (!u.ok) return wait(5000, "start");
      d.g0 = genOf(u.s);
      d.a = await nodeJs(port, PITR_WRITE, ["a", 100], { timeoutMs: 45_000 });
      d.shipAt = x.now + 8 * SEC;
      return wait(8000, "mark");
    }
    case "mark":
      if (x.now < d.shipAt) return wait(2000, "mark");
      d.mark = port.c.now();
      d.bAt = x.now + 3 * SEC;
      return wait(3000, "b");
    case "b":
      if (x.now < d.bAt) return wait(1000, "b");
      d.b = await nodeJs(port, PITR_WRITE, ["b", 100], { timeoutMs: 45_000 });
      d.restoreAt = x.now + 8 * SEC;
      return wait(8000, "restore");
    case "restore":
      if (x.now < d.restoreAt) return wait(2000, "restore");
      d.accepted = await restoreAndWait(x, iso(d.mark));
      d.restoreFiredAt = x.now;
      return d.accepted
        ? wait(5000, "boot")
        : finish({ checks: { restoreAccepted: false }, data: { restore: d.restore } });
    case "boot": {
      const s = await port.status();
      if (!newGenRunning(s, d.g0)) {
        if (x.now - d.restoreFiredAt > 20 * MIN)
          return finish({ checks: { restoreAccepted: true, running: false }, data: d });
        return wait(5000, "boot");
      }
      d.flag = bootFlag(x, s);
      d.runMs = x.now - d.restoreFiredAt;
      d.settleAt = x.now + 8 * SEC;
      return wait(8000, "count");
    }
    default: {
      if (x.now < d.settleAt) return wait(2000, "count");
      const c = await nodeJs(port, PITR_COUNT);
      return finish({
        checks: {
          restoreAccepted: true,
          running: true,
          bootFlag: d.flag === true,
          rowsWritten: (d.a?.n ?? 0) > 0 && (d.b?.n ?? 0) > (d.a?.n ?? 0),
          rowsMatch: c.a === d.a?.n && c.b === 0,
        },
        measures: [measure("pitr-boot", "restore to running", d.runMs / 1000, "s", "info")],
        data: { restore: d.restore, rows: c, written: { a: d.a, b: d.b }, mark: d.mark, bootFlag: d.flag },
      });
    }
  }
};

/** Drill D: poison the state DB, kill, wait for l5-pending, restore pitr to before the poison. */
const poison: Handler = async (x) => {
  const { port, d, p } = x;
  switch (x.phase) {
    case "start": {
      const u = await ensureUp(x);
      if (!u.ok) return wait(5000, "start");
      d.g0 = genOf(u.s);
      d.uv0 = (await nodeJs(port, USER_VERSION)).uv;
      d.a = await nodeJs(port, PITR_WRITE, ["a", 100], { timeoutMs: 45_000 });
      d.base = await alertCounts(x);
      d.markAt = x.now + 8 * SEC;
      return wait(8000, "mark");
    }
    case "mark":
      if (x.now < d.markAt) return wait(2000, "mark");
      d.mark = port.c.now();
      d.poisoned = await nodeJs(port, POISON);
      d.killAt0 = x.now + 15 * SEC;
      return wait(15_000, "kill");
    case "kill":
      if (x.now < d.killAt0) return wait(2000, "kill");
      d.killAt = x.now;
      d.kill = await port.rtFault("sigkill");
      return wait(10_000, "watch");
    case "watch": {
      const al = await alertCounts(x);
      const l5 = alertDelta(d.base, al, /^l5-pending/);
      const s = await port.status();
      d.levels = [...new Set([...(d.levels ?? []), String(s.ladder?.level)])];
      if (l5.length) {
        d.l5Min = +((x.now - d.killAt) / MIN).toFixed(1);
        return wait(0, "restore");
      }
      if (x.now - d.killAt > Number(p.watchMs ?? POISON_WATCH_MS)) return wait(0, "restore");
      return wait(15_000, "watch");
    }
    case "restore":
      d.accepted = await restoreAndWait(x, iso(d.mark));
      d.restoreFiredAt = x.now;
      if (d.accepted) await port.ops("start");
      return d.accepted
        ? wait(10_000, "boot")
        : finish({ checks: { l5Pending: d.l5Min !== undefined, restoreAccepted: false }, data: d });
    case "boot": {
      const s = await port.status();
      if (s.state !== "running" || genOf(s) === d.g0) {
        if (x.now - d.restoreFiredAt > 20 * MIN)
          return finish({
            checks: { l5Pending: d.l5Min !== undefined, restoreAccepted: true, running: false },
            data: d,
          });
        return wait(10_000, "boot");
      }
      d.flag = bootFlag(x, s);
      d.settleAt = x.now + 8 * SEC;
      return wait(8000, "end");
    }
    default: {
      if (x.now < d.settleAt) return wait(2000, "end");
      const uv = (await nodeJs(port, USER_VERSION)).uv;
      const c = await nodeJs(port, PITR_COUNT);
      return finish({
        checks: {
          poisoned: d.poisoned?.after === 999999,
          l5Pending: d.l5Min !== undefined,
          restoreAccepted: true,
          bootFlag: d.flag === true,
          userVersionRestored: uv === d.uv0,
          rowsWritten: (d.a?.n ?? 0) > 0,
          rowsKept: c.a === d.a?.n,
        },
        measures:
          d.l5Min !== undefined ? [measure("drill-d", "kill to l5-pending", d.l5Min, "min", "info")] : [],
        data: { levels: d.levels, uv: { before: d.uv0, after: uv }, rows: c, restore: d.restore },
      });
    }
  }
};

// ---------------------------------------------------------------- faults with their own assertions

/** Fill the disk to `pct` and check the alerts and that the gateway stays up (plan §4.12). */
const diskFill: Handler = async (x) => {
  const { port, d, p } = x;
  const pctWant = Number(p.pct ?? 96);
  switch (x.phase) {
    case "start": {
      const u = await ensureUp(x);
      if (!u.ok) return wait(5000, "start");
      d.g0 = genOf(u.s);
      d.base = await alertCounts(x);
      const df = await sh(port, "df -B1 --output=size,avail / | tail -1", 20_000);
      const [size, avail] = String(df.stdout).trim().split(/\s+/).map(Number);
      d.usedBefore = usedPctOf(size, avail);
      const want =
        pctWant >= 100
          ? (avail ?? 0) - 1_048_576
          : Math.floor((avail ?? 0) - (1 - pctWant / 100) * (size ?? 0));
      if (want <= 0) return finish({ checks: { filled: true }, data: { already: true } });
      const top =
        pctWant >= 100
          ? `; dd if=/dev/urandom of=${FILL_DIR}/r bs=1M count=64 2>/dev/null; dd if=/dev/urandom of=${FILL_DIR}/s bs=4k 2>/dev/null`
          : "";
      const r = await sh(
        port,
        // One file per step: fallocate on the existing `f` with a smaller length allocates nothing, so disk-96
        // after disk-82 filled no byte (M7 soak).
        `setpriv --reuid=1000 --regid=1000 --clear-groups sh -c 'mkdir -p ${FILL_DIR} && fallocate -l ${want} ${FILL_DIR}/f${pctWant}${top}'; echo done`,
        50_000,
      );
      d.fillAt = x.now;
      const df2 = await sh(port, "df -B1 --output=size,avail / | tail -1", 20_000);
      const [size2, avail2] = String(df2.stdout).trim().split(/\s+/).map(Number);
      d.usedAfterFill = usedPctOf(size2, avail2);
      d.fill = { want, out: String(r.stdout).slice(0, 100) };
      return wait(Number(p.waitMs ?? 75 * SEC), "check");
    }
    default: {
      const s = await port.status();
      const al = await alertCounts(x);
      const high = alertDelta(d.base, al, /^disk-high/).length > 0;
      const full = alertDelta(d.base, al, /^disk-full/).length > 0;
      // ocsup raises disk-high once per excursion (diskwatch.mjs: only on the ok → alert edge) and disk-full once
      // per degraded spell. A step that starts above a threshold expects no new alert for it.
      const before = typeof d.usedBefore === "number" ? d.usedBefore : 0;
      return finish({
        checks: {
          running: s.state === "running",
          noRestart: genOf(s) === d.g0,
          filled: typeof d.usedAfterFill === "number" && d.usedAfterFill >= Math.min(pctWant, 99) - 1,
          ...(pctWant >= 80 && before < 80 ? { diskHighAlert: high } : {}),
          ...(pctWant >= 95 && before < 95 ? { diskFullAlert: full } : {}),
          noReplicaDownAlert: alertDelta(d.base, al, /^replica-down/).length === 0,
        },
        data: {
          pct: pctWant,
          usedBefore: d.usedBefore ?? null,
          usedAfterFill: d.usedAfterFill ?? null,
          fill: d.fill,
          degraded: s.degraded,
          newAlerts: { high, full },
        },
      });
    }
  }
};

const usedPctOf = (size?: number, avail?: number): number | null =>
  size ? +(100 * (1 - (avail ?? 0) / size)).toFixed(1) : null;

const diskFree: Handler = async (x) => {
  const { port, d } = x;
  if (!d.freedAt) {
    await sh(port, `rm -rf ${FILL_DIR}; echo ok`, 45_000);
    d.freedAt = x.now;
    return wait(Number(x.p.waitMs ?? 60 * SEC));
  }
  const df = await sh(port, "df -B1 --output=size,avail / | tail -1", 20_000);
  const [size, avail] = String(df.stdout).trim().split(/\s+/).map(Number);
  const s = await port.status();
  const usedPct = size ? +(100 * (1 - (avail ?? 0) / size)).toFixed(1) : null;
  return finish({
    checks: {
      running: s.state === "running",
      freed: usedPct !== null && usedPct < 90,
      notDegraded: s.degraded !== true,
    },
    data: { usedPct },
  });
};

/** Litestream throttle: ReplicaGate delays each write; the gateway stays up and the RPO recovers after. */
const throttle: Handler = async (x) => {
  const { port, d, p } = x;
  switch (x.phase) {
    case "start": {
      const u = await ensureUp(x);
      if (!u.ok) return wait(5000, "start");
      d.g0 = genOf(u.s);
      d.base = await alertCounts(x);
      const r = await port.ctlFault("replica-throttle", { delayMs: p.delayMs ?? 3000, ms: p.ms ?? 5 * MIN });
      d.on = r.status === 200;
      d.until = x.now + Number(p.holdMs ?? 2 * MIN);
      return wait(10_000, "hold");
    }
    case "hold": {
      const s = await port.status();
      if (s.state !== "running") d.leftRunning = true;
      if (x.now < d.until) return wait(10_000, "hold");
      await port.ctlFault("replica-unthrottle");
      d.offAt = x.now;
      return wait(10_000, "recover");
    }
    default: {
      const s = await port.status();
      const ok = s.rpo === "ok" && s.state === "running";
      if (!ok && x.now - d.offAt < 3 * MIN) return wait(10_000, "recover");
      const al = await alertCounts(x);
      return finish({
        checks: {
          throttled: d.on === true,
          stayedRunning: d.leftRunning !== true,
          noRestart: genOf(s) === d.g0,
          rpoRecovered: ok,
          noReplicaDownAlert: alertDelta(d.base, al, /^replica-down/).length === 0,
        },
        measures: [
          measure("litestream-throttle", "rpo recovery", (x.now - d.offAt) / 1000, "s", "≤ 180 s", 180),
        ],
        data: { rpo: s.rpo },
      });
    }
  }
};

/** Control DO wipe through the test route (drills J, L). The plan survives through R2 `soak-resume/dump.json`. */
const ctlWipe: Handler = async (x) => {
  const { port, d } = x;
  switch (x.phase) {
    case "start": {
      const u = await ensureUp(x);
      if (!u.ok) return wait(5000, "start");
      d.g0 = genOf(u.s);
      d.before = {
        gens: port.c.db.one<Any>("SELECT COUNT(*) AS n FROM gens")?.n,
        archives: port.c.db.one<Any>("SELECT COUNT(*) AS n FROM archives")?.n,
        config: port.c.db.one<Any>("SELECT COUNT(*) AS n FROM config")?.n,
        creds: port.c.db.one<Any>("SELECT COUNT(*) AS n FROM creds WHERE deleted = 0")?.n,
      };
      d.sleepAt = x.now + 70 * SEC; // one creds and config copy tick after the last write
      return wait(70_000, "wipe");
    }
    case "wipe": {
      if (x.now < d.sleepAt) return wait(5000, "wipe");
      d.wipeAt = x.now;
      x.save?.("wiped");
      await x.dumpSoak?.();
      const r = await port.ctlFault("ctl-wipe");
      d.wipeStatus = r.status;
      return wait(15_000, "wiped");
    }
    default: {
      const c = port.c.db;
      const rows = c.one<Any>("SELECT COUNT(*) AS n FROM gens")?.n ?? 0;
      const s = await port.status();
      if (s.state !== "running" || genOf(s) === d.g0) {
        if (x.now - d.wipeAt > 25 * MIN)
          return finish({ checks: { running: false }, data: { state: s.state, ctlState: s.ctlState } });
        // an owner wake after the wipe starts the rebuild and the boot
        if (x.now - (d.nudgeAt ?? 0) > 30_000) {
          await port.ops("wake");
          d.nudgeAt = x.now;
        }
        return wait(10_000, "wiped");
      }
      // M7 soak: before.creds was 0 (the churn never ran), and `max(1, before - 1)` failed a drill that had
      // nothing to rebuild. credsTested says whether the drill exercised the creds path at all.
      const credsBefore = Number(d.before.creds ?? 0);
      const credsAfter = c.one<Any>("SELECT COUNT(*) AS n FROM creds WHERE deleted = 0")?.n ?? 0;
      return finish({
        checks: {
          running: true,
          notRewoundBlocked: s.ctlState !== "ctl-rewound" || genOf(s) !== d.g0,
          gensRebuilt: rows >= 1,
          credsTested: credsBefore > 0,
          credsBack: credsAfter >= credsBefore - (credsBefore > 0 ? 1 : 0),
        },
        measures: [measure("drill-j-l", "wipe to running", (x.now - d.wipeAt) / 1000, "s", "info")],
        data: { before: d.before, credsAfter, ctlState: s.ctlState },
      });
    }
  }
};

// ---------------------------------------------------------------- drills A, C+H, E, G

/** Drill A: destroy() mid-chat; the restart takes the snapshot path, the workspace marker stays, the update is replied. */
const drillA: Handler = async (x) => {
  const { port, d } = x;
  switch (x.phase) {
    case "start": {
      const u = await ensureUp(x);
      if (!u.ok) return wait(5000, "start");
      d.g0 = genOf(u.s);
      if (noTelegram(x)) return finish(NO_TELEGRAM);
      await sh(
        port,
        `setpriv --reuid=1000 --regid=1000 --clear-groups sh -c 'mkdir -p /home/node/.openclaw/workspace/soak && echo a > /home/node/.openclaw/workspace/soak/a.marker'; echo ok`,
        20_000,
      );
      d.markAt = port.c.now();
      d.chat = 780_000_000 + (Math.floor(x.now / 1000) % 1_000_000);
      const r = await port.inject(d.chat, "soak drill A m4b-slow", { plan: x.plan.name, step: x.spec.id });
      d.ack = r.status;
      d.armAt = x.now;
      return wait(1000, "destroy");
    }
    case "destroy": {
      const row = port.c.db.one<Any>(
        "SELECT state FROM inbox WHERE chat_id = ? ORDER BY received_at DESC LIMIT 1",
        String(d.chat),
      );
      if (!(row?.state === "accepted" || row?.state === "replicated") && x.now - d.armAt < 90 * SEC)
        return wait(1000, "destroy");
      d.destroy = await port.rtFault("destroy");
      d.destroyAt = x.now;
      return wait(5000, "restart");
    }
    case "restart": {
      const s = await port.status();
      if (!newGenRunning(s, d.g0)) {
        if (x.now - d.destroyAt > 15 * MIN) return finish({ checks: { restarted: false }, data: d });
        return wait(5000, "restart");
      }
      d.plan = s.gen?.plan ?? null;
      d.runMs = x.now - d.destroyAt;
      d.replyBy = x.now + 10 * MIN;
      return wait(0, "reply");
    }
    default: {
      const n = port.c.db.one<Any>("SELECT n FROM soak_send WHERE chat_id = ?", String(d.chat))?.n ?? 0;
      if (n === 0 && x.now < d.replyBy) return wait(5000, "reply");
      const has = await sh(
        port,
        "test -f /home/node/.openclaw/workspace/soak/a.marker && echo yes || echo no",
        20_000,
      );
      const kept = /yes/.test(String(has.stdout));
      // destroy() is an unplanned stop: rootfs writes after the restored snapshot are lost by design (plan §1:
      // rootfs bulk ≤ 60 min). The marker is written seconds before the destroy, so it survives only when the
      // restored snapshot is newer. The check is the bound, not the marker (M7 soak: workspaceKept false).
      const snapAt =
        port.c.db.one<Any>("SELECT created_at FROM snapshots WHERE id = ?", String(d.plan?.snapshotId ?? ""))
          ?.created_at ?? null;
      const bulkAgeMs = typeof snapAt === "number" ? d.destroyAt - snapAt : null;
      return finish({
        checks: {
          acked: d.ack === 200,
          destroyOk: d.destroy?.ok !== false,
          restarted: true,
          snapshotPath: d.plan?.rootfs === "snapshot",
          workspaceInBound:
            kept || (bulkAgeMs !== null && snapAt < (d.markAt ?? 0) && bulkAgeMs <= BOUND.bulkMs),
          replied: n >= 1,
        },
        measures: [
          measure("drill-a", "destroy to running", d.runMs / 1000, "s", "info"),
          ...(bulkAgeMs !== null
            ? [
                measure(
                  "drill-a-bulk",
                  "rootfs age at destroy",
                  bulkAgeMs / 1000,
                  "s",
                  "≤ 60 min",
                  BOUND.bulkMs / 1000,
                ),
              ]
            : []),
        ],
        data: { plan: d.plan, replies: n, workspaceKept: kept, snapshotAt: snapAt },
      });
    }
  }
};

/** Drills H and C: kill, R2 down for `ms` (crash loop), then up. Ladder stays L1, no L5, older complete gen used. */
const r2Outage: Handler = async (x) => {
  const { port, d, p } = x;
  const ms = Number(p.ms ?? 30 * MIN);
  switch (x.phase) {
    case "start": {
      const u = await ensureUp(x);
      if (!u.ok) return wait(5000, "start");
      d.g0 = genOf(u.s);
      d.base = await alertCounts(x);
      const g = port.c.db.one<Any>("SELECT MAX(gen) AS g FROM gens WHERE state = 'complete'")?.g;
      d.gComplete = g ?? d.g0;
      await port.ctlFault("r2-down", { ms: ms + 2 * MIN });
      d.downAt = x.now;
      d.kill = await port.rtFault("sigkill");
      d.levels = [];
      return wait(10_000, "outage");
    }
    case "outage": {
      const s = await port.status();
      const lv = s.ladder?.level;
      if (lv !== undefined && !d.levels.includes(String(lv))) d.levels.push(String(lv));
      if (x.now - d.downAt < ms) return wait(15_000, "outage");
      await port.ctlFault("r2-up");
      d.upAt = x.now;
      return wait(10_000, "recover");
    }
    default: {
      const s = await port.status();
      if (!(s.state === "running" && genOf(s) !== d.g0)) {
        if (x.now - d.upAt > 20 * MIN)
          return finish({ checks: { recovered: false }, data: { levels: d.levels, state: s.state } });
        return wait(10_000, "recover");
      }
      const al = await alertCounts(x);
      const db = port.c.db;
      const used = s.gen?.plan?.sqliteGen ?? null;
      const outageGens = db.all<Any>(
        "SELECT gen, state FROM gens WHERE gen > ? AND gen < ?",
        d.g0,
        genOf(s) ?? 0,
      );
      const lvOk = d.levels.every((l: string) => l === "1" || l === "0" || l === "undefined");
      return finish({
        checks: {
          recovered: true,
          ladderL1Only: lvOk,
          noL5: alertDelta(d.base, al, /^l5-pending/).length === 0,
          olderCompleteGen: used === null || used <= d.gComplete,
          outageGensNotComplete: outageGens.every((g) => g.state !== "complete"),
        },
        measures: [measure("drill-h", "outage to running", (x.now - d.upAt) / 1000, "s", "info")],
        data: { levels: d.levels, usedGen: used, completeBefore: d.gComplete, outageGens },
      });
    }
  }
};

/** Drill E: the replica prefix gone on an initialized install: restore-blocked, never an empty boot. Objects are moved and put back. */
const drillE: Handler = async (x) => {
  const { port, d } = x;
  const b = port.rawBucket();
  const prefix = `r/${port.c.inst}/`;
  const hold = (k: string) => `soak-hold/${k}`;
  const CH = 40;
  switch (x.phase) {
    case "start": {
      const u = await ensureUp(x);
      if (!u.ok) return wait(5000, "start");
      d.g0 = genOf(u.s);
      await port.ops("stop");
      return wait(5000, "stopped");
    }
    case "stopped": {
      const s = await port.status();
      if (s.state !== "stopped") {
        d.t0 ??= x.now;
        if (x.now - d.t0 > 10 * MIN) return finish({ checks: { stopped: false }, data: { state: s.state } });
        return wait(5000, "stopped");
      }
      const keys: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const r = await b.list({ prefix, cursor, limit: 1000 });
        keys.push(...r.objects.map((o) => o.key));
        if (!r.truncated) break;
        cursor = r.cursor;
      }
      if (keys.length > 3000)
        return finish({
          skipped: `replica prefix has ${keys.length} objects (> 3000); move-and-restore skipped`,
          data: { objects: keys.length },
        });
      d.keys = keys;
      d.moved = 0;
      return wait(0, "move");
    }
    case "move": {
      const slice = (d.keys as string[]).slice(d.moved, d.moved + CH);
      for (const k of slice) {
        const o = await b.get(k);
        if (o) await b.put(hold(k), await o.arrayBuffer());
        await b.delete(k);
      }
      d.moved += slice.length;
      if (d.moved < d.keys.length) return wait(0, "move");
      d.startAt = x.now;
      await port.ops("start");
      d.states = [];
      return wait(10_000, "watch");
    }
    case "watch": {
      const s = await port.status();
      const row = port.c.db.one<Any>("SELECT plan_kind FROM gens ORDER BY gen DESC LIMIT 1");
      if (!d.states.includes(s.state)) d.states.push(s.state);
      if (/restore-blocked/.test(String(row?.plan_kind ?? s.gen?.planKind ?? "")))
        d.blocked = row?.plan_kind ?? s.gen?.planKind;
      if (s.state === "running") d.ranEmpty = true;
      if (x.now - d.startAt < 3 * MIN && !d.ranEmpty) return wait(10_000, "watch");
      d.back = 0;
      return wait(0, "back");
    }
    case "back": {
      const slice = (d.keys as string[]).slice(d.back, d.back + CH);
      for (const k of slice) {
        const o = await b.get(hold(k));
        if (o) await b.put(k, await o.arrayBuffer());
        await b.delete(hold(k));
      }
      d.back += slice.length;
      if (d.back < d.keys.length) return wait(0, "back");
      await port.ops("stop");
      await port.ops("start");
      d.backAt = x.now;
      return wait(10_000, "recover");
    }
    default: {
      const s = await port.status();
      if (s.state !== "running") {
        if (x.now - d.backAt > 20 * MIN)
          return finish({
            checks: { blocked: !!d.blocked, noEmptyBoot: !d.ranEmpty, recovered: false },
            data: d,
          });
        if (x.now - (d.nudge ?? 0) > 60_000) {
          await port.ops("start");
          d.nudge = x.now;
        }
        return wait(10_000, "recover");
      }
      return finish({
        checks: { blocked: !!d.blocked, noEmptyBoot: !d.ranEmpty, recovered: true },
        data: { objects: d.keys.length, blockedPlan: d.blocked, states: d.states },
      });
    }
  }
};

/** Drill G: a new agent DB, killed before its first upload: the boot goes on, no restore-blocked. */
const drillG: Handler = async (x) => {
  const { port, d } = x;
  switch (x.phase) {
    case "start": {
      const u = await ensureUp(x);
      if (!u.ok) return wait(5000, "start");
      d.g0 = genOf(u.s);
      d.base = await alertCounts(x);
      d.db = await nodeJs(port, NEW_AGENT_DB);
      d.kill = await port.rtFault("sigkill");
      d.killAt = x.now;
      return wait(10_000, "restart");
    }
    default: {
      const s = await port.status();
      const row = lastGenRow(x);
      if (/restore-blocked/.test(String(row?.plan_kind))) d.blocked = true;
      if (!newGenRunning(s, d.g0)) {
        if (x.now - d.killAt > 15 * MIN)
          return finish({ checks: { running: false, notBlocked: !d.blocked }, data: d });
        return wait(10_000, "restart");
      }
      const al = await alertCounts(x);
      return finish({
        checks: { dbWritten: d.db?.ok === true, running: true, notBlocked: !d.blocked },
        measures: [measure("drill-g", "kill to running", (x.now - d.killAt) / 1000, "s", "info")],
        data: { dbLostAlerts: alertDelta(d.base, al, /^db-lost/) },
      });
    }
  }
};

export const HANDLERS: Record<string, Handler> = {
  note,
  wait: waitStep,
  awake,
  up,
  writer,
  kill,
  "tg-batch": tgBatch,
  cycles,
  "r2-mark": r2Mark,
  "s4-final": s4Final,
  "churn-hold": churnHold,
  "creds-compare": credsCompare,
  scrub,
  pitr,
  poison,
  "disk-fill": diskFill,
  "disk-free": diskFree,
  throttle,
  "ctl-wipe": ctlWipe,
  "drill-a": drillA,
  "r2-outage": r2Outage,
  "drill-e": drillE,
  "drill-g": drillG,
};

/** Step timeout (ms): `params.timeoutMs`, else a default per type. */
export function timeoutOf(type: string, p: Record<string, any>): number {
  if (typeof p.timeoutMs === "number") return p.timeoutMs;
  switch (type) {
    case "churn-hold":
      return Number(p.ms ?? 24 * HOUR) + 30 * MIN;
    case "kill":
      return Number(p.upMs ?? MIN) + 25 * MIN;
    case "tg-batch":
      return 60 * MIN;
    case "r2-outage":
      return Number(p.ms ?? 30 * MIN) + 40 * MIN;
    case "poison":
      return Number(p.watchMs ?? POISON_WATCH_MS) + 40 * MIN;
    case "wait":
      return Number(p.ms ?? MIN) + 5 * MIN;
    case "cycles":
      return Number(p.n ?? 10) * 25 * MIN;
    default:
      return 45 * MIN;
  }
}
