// ocio helper (uid 1000): read-only facts for sleep check and the post-exit read (add §2.5 rule 6,
// §2.6 phases 1 and 4). Usage: node sleep-read.mjs <state-db> [nowMs] -> one JSON line:
// {ok, cronRunning, openIngress, pendingDelivery, a2aWorking, nextWakeAtMs, eventJobs:[{id, kind}],
//  lastActivityAtMs, activeRuns}
// lastActivityAtMs (spec 08 §10.1 rule 3, M3 B3): newest of session_state_events.occurred_at,
// channel_ingress_events received/updated/completed, cron_run_receipts started/finished,
// delivery_queue_entries updated, task_runs last_event_at. activeRuns: task_runs not ended plus sessions whose
// newest event is a run start (guess: kind names match /start|begin|running/ and not /end|complete|fail|abort/).
// Tables from OpenClaw main 44e6b1b8 (src/state schema): cron_run_receipts(status, started_at_ms),
// channel_ingress_events(status), delivery_queue_entries(status), cron_jobs(enabled, job_json, state_json).
// guess: 2026.10.9 has the same columns; a missing table or column counts 0 and is listed in `missing`.
// guess: ingress rows are done when status is completed|failed|dead|dropped; an event job is a job
// whose schedule kind is not cron|every|at.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

process.on("SIGTERM", () => {});
const [db, nowArg, ignoreArg] = process.argv.slice(2);
const now = Number(nowArg) || Date.now();
// N11 (M4b): job classes left out of nextWakeAtMs (plan.wakeIgnore from the Control DO, JSON array).
let ignore = [];
try {
  ignore = JSON.parse(ignoreArg || "[]");
  if (!Array.isArray(ignore)) ignore = [];
} catch {
  ignore = [];
}
const PROACTIVE_PROMPT_HEAD = "Review your automation scratch checklist";
/** heartbeat: id or name heartbeat*, or payload kind heartbeat. proactive: name "Proactive check" or its prompt. */
function jobClass(id, job) {
  const name = String(job?.name ?? "");
  const pk = String(job?.payload?.kind ?? "");
  if (/^heartbeat[-:]/i.test(String(id)) || /^heartbeat\b/i.test(name) || pk === "heartbeat")
    return "heartbeat";
  if (/^Proactive check/i.test(name) || String(job?.payload?.message ?? "").startsWith(PROACTIVE_PROMPT_HEAD))
    return "proactive";
  return null;
}
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const missing = [];
function q(c, name, sql, dflt) {
  try {
    return c.prepare(sql).all();
  } catch (e) {
    if (/no such table|no such column/.test(String(e.message))) {
      missing.push(name);
      return dflt;
    }
    throw e;
  }
}
try {
  const st = fs.lstatSync(db, { throwIfNoEntry: false });
  if (!st) {
    out({
      ok: true,
      absent: true,
      cronRunning: 0,
      openIngress: 0,
      pendingDelivery: 0,
      a2aWorking: 0,
      nextWakeAtMs: null,
      eventJobs: [],
    });
    process.exit(0);
  }
  if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) throw new Error("unsafe db path");
  const c = new DatabaseSync(db, { readOnly: true });
  const cronRunning =
    q(
      c,
      "cron_run_receipts",
      `SELECT count(*) n FROM cron_run_receipts WHERE status='running' AND started_at_ms > ${now - 6 * 3600_000}`,
      [{ n: 0 }],
    )[0]?.n ?? 0;
  const openIngress =
    q(
      c,
      "channel_ingress_events",
      "SELECT count(*) n FROM channel_ingress_events WHERE status NOT IN ('completed','failed','dead','dropped')",
      [{ n: 0 }],
    )[0]?.n ?? 0;
  const pendingDelivery =
    q(c, "delivery_queue_entries", "SELECT count(*) n FROM delivery_queue_entries WHERE status='pending'", [
      { n: 0 },
    ])[0]?.n ?? 0;
  // M4 A1: rows of an ocsup staging copy (Doctor in /var/lib/ocrt/stage-u) are never scheduled by the gateway.
  // A past nextRunAtMs (stale or overdue) is not a wake time; it must not hide the next live job.
  let jobs = q(
    c,
    "cron_jobs.store_key",
    "SELECT job_id, job_json, state_json FROM cron_jobs WHERE enabled=1 AND coalesce(store_key,'') NOT LIKE '/var/lib/ocrt/%'",
    null,
  );
  if (jobs === null)
    jobs = q(c, "cron_jobs", "SELECT job_id, job_json, state_json FROM cron_jobs WHERE enabled=1", []);
  let nextWakeAtMs = null;
  const eventJobs = [];
  const ignored = [];
  for (const j of jobs) {
    let job = {};
    let state = {};
    try {
      job = JSON.parse(j.job_json);
      state = JSON.parse(j.state_json || "{}");
    } catch {}
    const kind = job?.schedule?.kind;
    if (kind && !["cron", "every", "at"].includes(kind)) eventJobs.push({ id: j.job_id, kind });
    const n = Number(state?.nextRunAtMs);
    const cls = jobClass(j.job_id, job);
    if (cls && ignore.includes(cls)) {
      if (ignored.length < 20)
        ignored.push({ id: String(j.job_id).slice(0, 64), cls, nextRunAtMs: n || null });
      continue;
    }
    if (Number.isFinite(n) && n > now - 60_000 && (nextWakeAtMs === null || n < nextWakeAtMs))
      nextWakeAtMs = n;
  }
  // Activity (B3). Timestamps may be ms, s or ISO text (guess: OpenClaw mixes them); toMs normalizes.
  const toMs = (v) => {
    if (v === null || v === undefined) return 0;
    if (typeof v === "number" || typeof v === "bigint") {
      const n = Number(v);
      return n > 1e12 ? n : n > 1e9 ? n * 1000 : 0;
    }
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? t : 0;
  };
  const maxOf = (name, sql) => {
    const r = q(c, name, sql, [])[0] || {};
    return Math.max(0, ...Object.values(r).map(toMs));
  };
  let lastActivityAtMs = Math.max(
    maxOf("session_state_events", "SELECT max(occurred_at) a FROM session_state_events"),
    maxOf(
      "channel_ingress_events",
      "SELECT max(received_at) a, max(updated_at) b, max(completed_at) c FROM channel_ingress_events",
    ),
    maxOf("cron_run_receipts", "SELECT max(started_at_ms) a, max(finished_at_ms) b FROM cron_run_receipts"),
    maxOf("delivery_queue_entries", "SELECT max(updated_at) a FROM delivery_queue_entries"),
    maxOf("task_runs", "SELECT max(last_event_at) a, max(started_at) b, max(ended_at) c FROM task_runs"),
  );
  if (lastActivityAtMs > now + 60_000) lastActivityAtMs = now; // clock skew or a bad unit guess
  const openTasks =
    q(
      c,
      "task_runs",
      `SELECT count(*) n FROM task_runs WHERE ended_at IS NULL AND started_at IS NOT NULL AND status NOT IN ('completed','failed','cancelled','canceled','done')`,
      [{ n: 0 }],
    )[0]?.n ?? 0;
  const heads = q(
    c,
    "session_state_events",
    `SELECT e.kind k, e.occurred_at t FROM session_state_events e
       JOIN (SELECT session_key, max(sequence) m FROM session_state_events GROUP BY session_key) h
         ON h.session_key = e.session_key AND h.m = e.sequence`,
    [],
  );
  const openSessions = heads.filter(
    (h) =>
      /start|begin|running|accepted|queued/i.test(String(h.k)) &&
      !/end|complete|finish|fail|abort|cancel|error|idle/i.test(String(h.k)) &&
      now - toMs(h.t) < 30 * 60_000,
  ).length;
  const activeRuns = Number(openTasks) + openSessions;
  if (activeRuns > 0 || cronRunning > 0 || openIngress > 0) lastActivityAtMs = now;
  c.close();
  out({
    lastActivityAtMs: lastActivityAtMs || null,
    activeRuns,
    ok: true,
    cronRunning,
    openIngress,
    pendingDelivery,
    a2aWorking: 0,
    nextWakeAtMs,
    eventJobs,
    ignored,
    missing,
  });
} catch (e) {
  out({ ok: false, error: String(e.message || e).slice(0, 300) });
  process.exitCode = 1;
}
